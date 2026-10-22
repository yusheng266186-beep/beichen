'use strict';

// A deliberately small wrapper around the official Codex app-server stdio
// protocol. It owns one temporary CODEX_HOME per runtime, never reads the
// user's real ~/.codex, and refuses every server-initiated tool/approval
// request. The runtime is intentionally text-only: tool item notifications are
// treated as a protocol violation and interrupt the turn.

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { randomUUID } = require('node:crypto');

const CLIENT_INFO = Object.freeze({ name: 'jianwei_observatory', version: '1.0.0' });
const DEFAULT_TIMEOUT_MS = 840000;
const PROBE_TIMEOUT_MS = 45000;
const INIT_TIMEOUT_MS = 60000;
const LOGIN_TIMEOUT_MS = 900000;
const AUTH_POLL_MS = 250;
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const ALLOWED_PROXY = 'http://127.0.0.1:18080';
const DEVICE_ORIGIN = 'https://auth.openai.com';
const DEVICE_PATH = '/codex/device';

// These must be present and disabled. `unified_exec` is deliberately not in
// this list: in 0.163.x it is an execution backend which remains enabled, while
// the model-facing shell tool is gated by `shell_tool`.
const REQUIRED_OFF_FEATURES = Object.freeze(['shell_tool', 'multi_agent']);
const OPTIONAL_OFF_FEATURES = Object.freeze([
  'unified_exec_tty',
  'view_image',
  'image_generation',
  'apps',
  'multi_agent_v2',
  'standalone_web_search',
  'tool_suggest',
  'hooks',
  'browser_use',
  'computer_use',
  'request_permissions_tool',
  'deferred_executor',
  'plugins',
]);

const DISABLED_FEATURES = Object.freeze([
  'shell_tool',
  'unified_exec',
  'unified_exec_tty',
  'view_image',
  'image_generation',
  'apps',
  'multi_agent',
  'multi_agent_v2',
  'standalone_web_search',
  'tool_suggest',
  'hooks',
  'browser_use',
  'computer_use',
  'code_mode',
  'request_permissions_tool',
  'deferred_executor',
  'sleep_tool',
  'plugins',
]);

const SAFE_ITEM_TYPES = new Set([
  'userMessage',
  'agentMessage',
  'reasoning',
  'plan',
  'contextCompaction',
  'enteredReviewMode',
  'exitedReviewMode',
]);

const SECRET_KEY = /^(?:auth|auth_?token|tokens?|access_?token|refresh_?token|id_?token|authorization|api[_-]?key|secret|password|credentials?)$/i;
const states = new WeakMap();

function fail(code, diagnostic) {
  const error = new Error(code);
  if (diagnostic && typeof diagnostic === 'object') error.diagnostic = diagnostic;
  return error;
}

function cancelledError() {
  const error = fail('MODEL_CANCELLED', { kind: 'complete' });
  error.name = 'AbortError';
  return error;
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function timeoutValue(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), 24 * 60 * 60 * 1000);
}

function redactText(value, limit = 2000) {
  let out = value === undefined || value === null ? '' : String(value);
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  out = out.replace(/\bsk-[A-Za-z0-9_-]+/gi, 'sk-[REDACTED]');
  out = out.replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]');
  return out.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function sanitize(value, depth = 0, seen = new Set()) {
  if (depth > 12) return '[TRUNCATED]';
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 10000).map((entry) => sanitize(entry, depth + 1, seen));
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? '[REDACTED]' : sanitize(entry, depth + 1, seen);
  }
  return out;
}

function checkedProxy(proxyUrl) {
  if (proxyUrl === undefined || proxyUrl === null || proxyUrl === '') return null;
  if (proxyUrl !== ALLOWED_PROXY) throw fail('OPENAI_PROXY_CONFIG_INVALID', { kind: 'proxy' });
  let url;
  try {
    url = new URL(proxyUrl);
  } catch {
    throw fail('OPENAI_PROXY_CONFIG_INVALID', { kind: 'proxy' });
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '18080' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw fail('OPENAI_PROXY_CONFIG_INVALID', { kind: 'proxy' });
  }
  return proxyUrl;
}

function checkedAuth(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw fail('MODEL_AUTH_FAILED', { kind: 'auth', reason: 'not-an-object' });
  if (auth.OPENAI_API_KEY || auth.openai_api_key) throw fail('MODEL_AUTH_FAILED', { kind: 'auth', reason: 'api-key-not-supported' });
  if (auth.auth_mode !== undefined && auth.auth_mode !== 'chatgpt') throw fail('MODEL_AUTH_FAILED', { kind: 'auth', reason: 'chatgpt-required' });
  if (auth.auth_mode === 'chatgpt' && (!auth.tokens || typeof auth.tokens !== 'object')) throw fail('MODEL_AUTH_FAILED', { kind: 'auth', reason: 'missing-tokens' });
  if (auth.auth_mode === undefined && (!auth.tokens || typeof auth.tokens !== 'object')) throw fail('MODEL_AUTH_FAILED', { kind: 'auth', reason: 'missing-tokens' });
}

function checkedDeviceUrl(value) {
  if (typeof value !== 'string') return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.port || url.username || url.password || url.hash) return null;
  if (url.pathname !== DEVICE_PATH && url.pathname !== `${DEVICE_PATH}/`) return null;
  if (url.origin !== DEVICE_ORIGIN) return null;
  return url.href;
}

function childEnvironment(state, proxyUrl) {
  const environment = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: state.dir,
    CODEX_HOME: state.dir,
    TMPDIR: state.tmpDir,
    NO_COLOR: '1',
    TERM: 'dumb',
    RUST_BACKTRACE: '0',
  };
  if (proxyUrl) {
    environment.HTTP_PROXY = proxyUrl;
    environment.HTTPS_PROXY = proxyUrl;
    environment.ALL_PROXY = proxyUrl;
    environment.http_proxy = proxyUrl;
    environment.https_proxy = proxyUrl;
    environment.all_proxy = proxyUrl;
    environment.NO_PROXY = 'localhost,127.0.0.1,::1';
    environment.no_proxy = environment.NO_PROXY;
  }
  return environment;
}

function serverArguments() {
  const args = [
    'app-server',
    '-c', 'cli_auth_credentials_store="file"',
    '-c', 'web_search="disabled"',
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_mode="read-only"',
    '-c', 'project_doc_max_bytes=0',
    '-c', 'check_for_update_on_startup=false',
    '-c', 'analytics.enabled=false',
  ];
  for (const feature of DISABLED_FEATURES) args.push('-c', `features.${feature}=false`);
  return args;
}

async function writeSecure(file, content, mode = 0o600) {
  await fsp.writeFile(file, content, { mode });
  await fsp.chmod(file, mode);
}

function runtimeReason(reason) {
  const error = fail(reason && reason.code ? reason.code : 'MODEL_CONNECTION_LOST', {
    kind: 'runtime',
    ...(reason && reason.cause ? { cause: reason.cause } : {}),
    ...(reason && reason.exitCode !== undefined ? { exitCode: reason.exitCode } : {}),
    ...(reason && reason.signal !== undefined ? { signal: reason.signal } : {}),
  });
  if (reason && reason.code === 'MODEL_CANCELLED') error.name = 'AbortError';
  return error;
}

function rejectPending(state, reason) {
  if (!state.pending.size) return;
  for (const pending of state.pending.values()) {
    clearTimeout(pending.timer);
    try {
      pending.reject(runtimeReason(reason));
    } catch {}
  }
  state.pending.clear();
}

function notifyClose(state, reason) {
  for (const handler of [...state.closeHandlers]) {
    try {
      handler(reason);
    } catch {}
  }
  state.closeHandlers.clear();
}

function onClose(state, handler) {
  state.closeHandlers.add(handler);
  return () => state.closeHandlers.delete(handler);
}

function onServerRequest(state, handler) {
  state.serverRequestHandlers.add(handler);
  return () => state.serverRequestHandlers.delete(handler);
}

function send(state, message) {
  if (state.closed || !state.child || !state.child.stdin) throw fail('MODEL_CONNECTION_LOST', { kind: 'runtime', cause: 'stdin-closed' });
  if (state.child.stdin.writable === false) throw fail('MODEL_CONNECTION_LOST', { kind: 'runtime', cause: 'stdin-closed' });
  try {
    state.child.stdin.write(`${JSON.stringify(message)}\n`);
  } catch {
    throw fail('MODEL_CONNECTION_LOST', { kind: 'runtime', cause: 'stdin-write' });
  }
}

function callWithState(state, method, params, options = {}) {
  if (state.closed) return Promise.reject(fail('MODEL_CONNECTION_LOST', { kind: 'runtime', cause: 'closed' }));
  const timeoutMs = timeoutValue(options.timeoutMs, state.timeoutMs);
  return new Promise((resolve, reject) => {
    const id = ++state.nextId;
    const timer = setTimeout(() => {
      if (!state.pending.has(id)) return;
      state.pending.delete(id);
      reject(fail('MODEL_UPSTREAM_TIMEOUT', { kind: 'rpc', method, timeoutMs }));
    }, timeoutMs);
    // A pending RPC owns its deadline even when a mocked or closing child has
    // no referenced I/O handles. Keep the timer alive until reply/timeout.
    state.pending.set(id, { resolve, reject, timer, method });
    try {
      send(state, { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    } catch (error) {
      clearTimeout(timer);
      state.pending.delete(id);
      reject(error);
    }
  });
}

function dispatchNotification(state, method, params) {
  const safe = sanitize(params);
  if (state.onNotification) {
    try {
      state.onNotification(method, safe);
    } catch {}
  }
  const listeners = state.listeners.get(method);
  if (!listeners) return;
  for (const listener of [...listeners]) {
    try {
      listener(safe);
    } catch {}
  }
}

function handleResponse(state, message) {
  const pending = state.pending.get(message.id);
  if (!pending) return;
  state.pending.delete(message.id);
  clearTimeout(pending.timer);
  if (Object.hasOwn(message, 'error')) {
    const error = message.error && typeof message.error === 'object' ? message.error : {};
    pending.reject(fail('CODEX_RPC_ERROR', {
      kind: 'rpc',
      method: pending.method,
      ...(Number.isInteger(error.code) ? { rpcCode: error.code } : {}),
      ...(error.message ? { message: redactText(error.message) } : {}),
    }));
    return;
  }
  pending.resolve(message.result);
}

function handleServerRequest(state, message) {
  const method = typeof message.method === 'string' ? message.method : 'unknown';
  state.serverRequests.add(method);
  if (state.serverRequests.size > 50) state.serverRequests.delete(state.serverRequests.values().next().value);
  try {
    send(state, {
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: 'Codex runtime rejects server-initiated tool and permission requests' },
    });
  } catch {}
  for (const handler of [...state.serverRequestHandlers]) {
    try {
      handler(method);
    } catch {}
  }
}

function handleLine(state, line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  if (message.id !== undefined && typeof message.method !== 'string' && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
    handleResponse(state, message);
    return;
  }
  if (message.id !== undefined && typeof message.method === 'string') {
    handleServerRequest(state, message);
    return;
  }
  if (typeof message.method === 'string') dispatchNotification(state, message.method, message.params);
}

function onStdout(state, chunk) {
  if (state.closed) return;
  state.buffer += typeof chunk === 'string' ? chunk : state.decoder.write(chunk);
  if (Buffer.byteLength(state.buffer, 'utf8') > MAX_LINE_BYTES) {
    finalize(state, { code: 'MODEL_BAD_RESPONSE', cause: 'line-too-large' }).catch(() => {});
    return;
  }
  let index;
  while ((index = state.buffer.indexOf('\n')) >= 0) {
    let line = state.buffer.slice(0, index);
    state.buffer = state.buffer.slice(index + 1);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line.trim()) continue;
    handleLine(state, line);
  }
}

function wireChild(state) {
  const child = state.child;
  child.stdout?.setEncoding?.('utf8');
  child.stdout?.on('data', (chunk) => onStdout(state, chunk));
  child.stdout?.once?.('end', () => handleConnectionLost(state, 'stdout-end'));
  child.stdout?.on?.('error', () => handleConnectionLost(state, 'stdout-error'));
  child.stderr?.on?.('data', () => {});
  child.stderr?.resume?.();
  child.stdin?.on?.('error', () => handleConnectionLost(state, 'stdin-error'));
  child.once?.('error', () => handleConnectionLost(state, 'spawn-error'));
  child.once?.('exit', (code, signal) => {
    if (state.exited) return;
    state.exited = true;
    state.exitCode = code;
    state.exitSignal = signal;
    for (const waiter of [...state.exitWaiters]) waiter();
    if (!state.closed) finalize(state, { code: 'MODEL_CONNECTION_LOST', cause: 'exit', exitCode: code, signal }).catch(() => {});
  });
}

function handleConnectionLost(state, cause) {
  if (state.closed) return;
  finalize(state, { code: 'MODEL_CONNECTION_LOST', cause }).catch(() => {});
}

function waitExit(state, timeoutMs) {
  if (state.exited) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      state.exitWaiters.delete(finish);
      resolve(state.exited);
    };
    const timer = setTimeout(finish, timeoutMs);
    state.exitWaiters.add(finish);
  });
}

async function stopChild(state) {
  const child = state.child;
  if (!child || state.exited) return;
  try {
    child.stdin?.end();
  } catch {}
  if (await waitExit(state, 1500)) return;
  try {
    child.kill('SIGTERM');
  } catch {}
  if (await waitExit(state, 1500)) return;
  try {
    child.kill('SIGKILL');
  } catch {}
  await waitExit(state, 1000);
}

function refreshAuth(state) {
  state.authChain = state.authChain.catch(() => {}).then(() => readAuth(state));
  return state.authChain;
}

async function readAuth(state) {
  let text;
  try {
    text = await fsp.readFile(state.authPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return state.auth;
    throw fail('CODEX_AUTH_PERSIST_FAILED', { kind: 'auth', reason: 'unreadable' });
  }
  if (!text || !text.trim()) return state.auth;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return state.auth;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return state.auth;
  const serialized = JSON.stringify(parsed);
  if (serialized === state.lastObservedSerialized && serialized === state.lastPersistedSerialized) return state.auth;
  state.lastObservedSerialized = serialized;
  state.auth = parsed;
  if (state.onAuth && serialized !== state.lastPersistedSerialized) {
    try {
      await state.onAuth(clone(parsed));
    } catch (error) {
      state.authError = fail('CODEX_AUTH_PERSIST_FAILED', { kind: 'auth', reason: redactText(error && error.message, 200) });
      throw state.authError;
    }
    state.lastPersistedSerialized = serialized;
    state.authError = null;
  } else {
    state.lastPersistedSerialized = serialized;
    state.authError = null;
  }
  return state.auth;
}

async function waitForAuth(state, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  do {
    await refreshAuth(state);
    if (state.auth) return clone(state.auth);
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (true);
  return null;
}

function finalize(state, reason) {
  if (state.finalizePromise) return state.finalizePromise;
  state.closed = true;
  state.finalizeReason = reason;
  if (state.authTimer) clearInterval(state.authTimer);
  if (state.abortListener && state.signal) {
    try {
      state.signal.removeEventListener('abort', state.abortListener);
    } catch {}
  }
  // Install the promise before notifying handlers. A close handler is allowed
  // to call close() again; it must observe the same in-flight finalization.
  state.finalizePromise = (async () => {
    let authFailure = null;
    try {
      await refreshAuth(state);
    } catch (error) {
      authFailure = error;
    }
    await stopChild(state);
    try {
      await refreshAuth(state);
      authFailure = null;
    } catch (error) {
      authFailure = error;
    }
    await fsp.rm(state.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    if (authFailure) throw authFailure;
    if (state.authError) throw state.authError;
    return true;
  })();
  notifyClose(state, reason);
  rejectPending(state, reason);
  return state.finalizePromise;
}

async function assertCodexHome(state, reported) {
  const expected = await fsp.realpath(state.dir).catch(() => state.dir);
  const actual = await fsp.realpath(reported).catch(() => reported);
  if (path.resolve(actual) !== path.resolve(expected)) throw fail('CODEX_HOME_ESCAPED', { kind: 'isolation' });
}

async function verifyToolLockdown(state) {
  const features = new Map();
  let cursor = null;
  let pages = 0;
  try {
    do {
      const page = await callWithState(state, 'experimentalFeature/list', {
        limit: 250,
        ...(cursor ? { cursor } : {}),
      }, { timeoutMs: Math.min(state.timeoutMs, INIT_TIMEOUT_MS) });
      if (!page || !Array.isArray(page.data)) throw fail('CODEX_TOOLS_UNSUPPORTED', { kind: 'feature-list' });
      for (const feature of page.data) {
        if (feature && typeof feature.name === 'string') features.set(feature.name, feature.enabled === true);
      }
      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null;
    } while (cursor && ++pages < 20);
  } catch (error) {
    if (error && error.message === 'CODEX_RPC_ERROR') throw fail('CODEX_TOOLS_UNSUPPORTED', { kind: 'feature-list', reason: 'unavailable' });
    throw error;
  }
  for (const name of REQUIRED_OFF_FEATURES) {
    if (features.get(name) !== false) {
      throw fail('CODEX_TOOLS_UNSUPPORTED', { kind: 'feature-list', feature: name, ...(features.has(name) ? { enabled: true } : { missing: true }) });
    }
  }
  for (const name of OPTIONAL_OFF_FEATURES) {
    if (features.get(name) === true) throw fail('CODEX_TOOLS_UNSUPPORTED', { kind: 'feature-list', feature: name, enabled: true });
  }
  let config;
  try {
    config = await callWithState(state, 'config/read', { cwd: state.dir }, { timeoutMs: Math.min(state.timeoutMs, INIT_TIMEOUT_MS) });
  } catch (error) {
    if (error && error.message === 'CODEX_RPC_ERROR') throw fail('CODEX_TOOLS_UNSUPPORTED', { kind: 'config', reason: 'unavailable' });
    throw error;
  }
  const value = config && config.config;
  if (!value || value.web_search !== 'disabled') throw fail('CODEX_TOOLS_UNSUPPORTED', { kind: 'config', field: 'web_search' });
  if (value.sandbox_mode !== 'read-only') throw fail('CODEX_TOOLS_UNSUPPORTED', { kind: 'config', field: 'sandbox_mode' });
  if (value.approval_policy !== 'never') throw fail('CODEX_TOOLS_UNSUPPORTED', { kind: 'config', field: 'approval_policy' });
}

async function createRuntime(options = {}) {
  const {
    binaryPath,
    auth = null,
    proxyUrl = null,
    onAuth = null,
    onNotification = null,
    spawnImpl = spawn,
    signal = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options || {};
  if (typeof binaryPath !== 'string' || !binaryPath) throw new TypeError('binaryPath is required');
  if (typeof spawnImpl !== 'function') throw new TypeError('spawnImpl must be a function');
  if (onAuth !== null && onAuth !== undefined && typeof onAuth !== 'function') throw new TypeError('onAuth must be a function');
  if (onNotification !== null && onNotification !== undefined && typeof onNotification !== 'function') throw new TypeError('onNotification must be a function');
  const proxy = checkedProxy(proxyUrl);
  const deadline = timeoutValue(timeoutMs, DEFAULT_TIMEOUT_MS);
  if (signal && signal.aborted) throw cancelledError();
  if (auth !== null && auth !== undefined) checkedAuth(auth);

  let dir = null;
  let tmpDir = null;
  try {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-runtime-'));
    await fsp.chmod(dir, 0o700);
    tmpDir = path.join(dir, 'tmp');
    await fsp.mkdir(tmpDir, { mode: 0o700 });
    await fsp.chmod(tmpDir, 0o700);
  } catch (error) {
    if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const authPath = path.join(dir, 'auth.json');
  const state = {
    dir,
    tmpDir,
    authPath,
    child: null,
    decoder: new StringDecoder('utf8'),
    buffer: '',
    nextId: 0,
    pending: new Map(),
    listeners: new Map(),
    onNotification: onNotification || null,
    onAuth: onAuth || null,
    auth: null,
    lastObservedSerialized: null,
    lastPersistedSerialized: null,
    authChain: Promise.resolve(),
    authError: null,
    authTimer: null,
    closed: false,
    exited: false,
    exitCode: undefined,
    exitSignal: undefined,
    exitWaiters: new Set(),
    closeHandlers: new Set(),
    serverRequestHandlers: new Set(),
    serverRequests: new Set(),
    finalizePromise: null,
    finalizeReason: null,
    timeoutMs: deadline,
    signal,
    abortListener: null,
    binaryPath,
  };

  try {
    if (auth !== null && auth !== undefined) {
      const serialized = JSON.stringify(auth);
      await writeSecure(authPath, serialized, 0o600);
      state.auth = clone(auth);
      state.lastObservedSerialized = serialized;
      state.lastPersistedSerialized = serialized;
    }

    const args = serverArguments();
    state.child = spawnImpl(binaryPath, args, {
      cwd: dir,
      env: childEnvironment(state, proxy),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (!state.child || !state.child.stdin || !state.child.stdout || !state.child.stderr) throw fail('MODEL_CONNECTION_LOST', { kind: 'spawn' });
    wireChild(state);

    state.authTimer = setInterval(() => {
      refreshAuth(state).catch(() => {});
    }, AUTH_POLL_MS);
    state.authTimer.unref?.();

    if (signal) {
      state.abortListener = () => {
        if (!state.closed) finalize(state, { code: 'MODEL_CANCELLED', cause: 'signal' }).catch(() => {});
      };
      signal.addEventListener('abort', state.abortListener, { once: true });
      if (signal.aborted) throw cancelledError();
    }

    const initialized = await callWithState(state, 'initialize', {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, { timeoutMs: Math.min(deadline, INIT_TIMEOUT_MS) });
    if (!initialized || typeof initialized !== 'object' || typeof initialized.codexHome !== 'string') {
      throw fail('MODEL_BAD_RESPONSE', { kind: 'initialize' });
    }
    await assertCodexHome(state, initialized.codexHome);
    send(state, { jsonrpc: '2.0', method: 'initialized' });
    await verifyToolLockdown(state);
  } catch (error) {
    const reason = {
      code: error && error.name === 'AbortError' ? 'MODEL_CANCELLED' : 'MODEL_CONNECTION_LOST',
      cause: 'initialization',
    };
    try {
      await finalize(state, reason);
    } catch {}
    throw error;
  }

  const runtime = {
    call(method, params, options) {
      if (typeof method !== 'string' || !method) return Promise.reject(new TypeError('method is required'));
      return callWithState(state, method, params, options || {});
    },
    on(method, listener) {
      if (typeof method !== 'string' || !method) throw new TypeError('method is required');
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      let listeners = state.listeners.get(method);
      if (!listeners) {
        listeners = new Set();
        state.listeners.set(method, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) state.listeners.delete(method);
      };
    },
    close() {
      return finalize(state, { code: 'MODEL_CANCELLED', cause: 'close' });
    },
    getAuth() {
      return state.auth === null ? null : clone(state.auth);
    },
  };
  states.set(runtime, state);
  return runtime;
}

async function cancelLogin(state, loginId) {
  if (!loginId) return;
  try {
    await callWithState(state, 'account/login/cancel', { loginId }, { timeoutMs: 10000 });
  } catch {}
}

async function checkCancelled(isCancelled) {
  if (typeof isCancelled !== 'function') return false;
  try {
    return !!(await isCancelled());
  } catch {
    return false;
  }
}

async function waitForLoginOutcome(completed, isCancelled, timeoutMs, state, onPoll) {
  const deadline = Date.now() + timeoutMs;
  let stopped = false;
  let timer = null;
  let closeOff = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ type: 'timeout' }), timeoutMs);
  });
  const closed = new Promise((resolve) => {
    closeOff = onClose(state, (reason) => {
      closeOff();
      resolve({ type: 'closed', reason });
    });
  });
  const poll = (async () => {
    while (!stopped) {
      if (state.closed) return { type: 'closed' };
      if (await checkCancelled(isCancelled)) return { type: 'cancel' };
      if (onPoll) await onPoll();
      if (Date.now() >= deadline) return { type: 'timeout' };
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { type: 'poll-ended' };
  })();
  try {
    const outcome = await Promise.race([
      completed.then((value) => (value && value.__closed ? { type: 'closed', reason: value.reason } : { type: 'complete', value })),
      timeout,
      closed,
      poll,
    ]);
    return outcome;
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (closeOff) closeOff();
  }
}

async function login(runtime, options = {}) {
  const state = states.get(runtime);
  if (!state) throw fail('MODEL_NOT_CONFIGURED', { kind: 'runtime' });
  const { onReady = null, onStage = null, isCancelled = null, readCallback = null, flow = 'browser', deadlineMs = LOGIN_TIMEOUT_MS } = options || {};
  if (onReady !== null && typeof onReady !== 'function') throw new TypeError('onReady must be a function');
  if (isCancelled !== null && typeof isCancelled !== 'function') throw new TypeError('isCancelled must be a function');
  if (readCallback !== null && typeof readCallback !== 'function') throw new TypeError('readCallback must be a function');
  if (!['browser','device'].includes(flow)) throw new TypeError('flow must be browser or device');
  if (state.closed) throw fail('MODEL_CONNECTION_LOST', { kind: 'login' });
  const waitMs = timeoutValue(deadlineMs, LOGIN_TIMEOUT_MS);
  const deadlineAt = Date.now() + waitMs;
  let loginId = null;
  let resolveCompleted;
  const completed = new Promise((resolve) => {
    resolveCompleted = resolve;
  });
  const cleanups = [];
  const safeCleanup = (fn) => {
    try {
      fn();
    } catch {}
  };
  try {
    const unsubscribe = runtime.on('account/login/completed', (params) => {
      if (!params || typeof params !== 'object') return;
      if (params.loginId && loginId && params.loginId !== loginId) return;
      resolveCompleted(params);
    });
    cleanups.push(unsubscribe);
    const unsubscribeClose = onClose(state, (reason) => resolveCompleted({ __closed: true, reason }));
    cleanups.push(unsubscribeClose);

    let started;
    try {
      started = await callWithState(state, 'account/login/start', { type: flow==='browser'?'chatgpt':'chatgptDeviceCode' }, { timeoutMs: 30000 });
    } catch (error) {
      if (error && (error.name === 'AbortError' || error.message === 'MODEL_CONNECTION_LOST')) throw error;
      const wrapped = fail('LOGIN_FAILED', { kind: 'login', phase: 'start' });
      wrapped.cause = error;
      throw wrapped;
    }
    if (!started || typeof started.loginId !== 'string' || (flow==='device'?(started.type!=='chatgptDeviceCode'||typeof started.userCode!=='string'||typeof started.verificationUrl!=='string'):(started.type!=='chatgpt'||typeof started.authUrl!=='string'))) {
      throw fail('LOGIN_FAILED', { kind: 'login', reason: 'invalid-start-response' });
    }
    loginId = started.loginId;
    let ready;
    try {
      if(flow==='browser')ready={flow,authorizationUrl:require('./browser-oauth.cjs').authorization(started.authUrl).authorizationUrl,loginId};
      else {
        const verificationUrl=checkedDeviceUrl(started.verificationUrl);
        if(!verificationUrl)throw fail('LOGIN_URL_UNTRUSTED',{kind:'login'});
        ready={flow,verificationUrl,userCode:started.userCode,loginId};
      }
    }catch(e){await cancelLogin(state,loginId);throw e;}
    if (onReady) {
      try {
        await onReady(ready);
      } catch (error) {
        await cancelLogin(state, loginId);
        throw error;
      }
    }
    if (await checkCancelled(isCancelled)) {
      await cancelLogin(state, loginId);
      throw fail('LOGIN_CANCELLED', { kind: 'login' });
    }
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      await cancelLogin(state, loginId);
      throw fail('LOGIN_TIMEOUT', { kind: 'login', timeoutMs: waitMs });
    }
    let delivered=false;
    const pollCallback=flow==='browser'&&readCallback?async()=>{
      if(delivered)return;
      const callbackUrl=await readCallback();
      if(!callbackUrl)return;
      delivered=true;
      try{await onStage?.('exchanging');await require('./browser-oauth.cjs').deliver(callbackUrl,ready.authorizationUrl,{signal:state.signal,onStage});}
      catch(e){await cancelLogin(state,loginId);throw e;}
    }:null;
    const outcome = await waitForLoginOutcome(completed, isCancelled, remaining, state,pollCallback);
    if (outcome.type === 'cancel') {
      await cancelLogin(state, loginId);
      throw fail('LOGIN_CANCELLED', { kind: 'login' });
    }
    if (outcome.type === 'timeout') {
      await cancelLogin(state, loginId);
      throw fail('LOGIN_TIMEOUT', { kind: 'login', timeoutMs: waitMs });
    }
    if (outcome.type === 'closed') {
      throw fail('MODEL_CONNECTION_LOST', { kind: 'login' });
    }
    const result = outcome.value;
    if (!result || result.success !== true) {
      throw fail('LOGIN_FAILED', { kind: 'login', reason: redactText(result && result.error ? result.error : 'login-rejected', 200) });
    }
    let accountResult;
    try {
      accountResult = await callWithState(state, 'account/read', {}, { timeoutMs: 30000 });
    } catch (error) {
      if (error && (error.name === 'AbortError' || error.message === 'MODEL_CONNECTION_LOST')) throw error;
      const wrapped = fail('MODEL_AUTH_FAILED', { kind: 'login', reason: 'account-read-failed' });
      wrapped.cause = error;
      throw wrapped;
    }
    const account = accountResult && accountResult.account;
    if (!account || account.type !== 'chatgpt') throw fail('MODEL_AUTH_FAILED', { kind: 'login', reason: 'chatgpt-account-required' });
    const auth = await waitForAuth(state, 2000);
    if (!auth) throw fail('MODEL_AUTH_FAILED', { kind: 'login', reason: 'auth-not-written' });
    await onStage?.('saving');
    return { account, auth };
  } finally {
    for (const cleanup of cleanups.splice(0)) safeCleanup(cleanup);
  }
}

async function readQuota(runtime) {
  const state = states.get(runtime);
  if (!state) throw fail('MODEL_NOT_CONFIGURED', { kind: 'runtime' });
  if (state.closed) throw fail('MODEL_CONNECTION_LOST', { kind: 'quota' });
  let result;
  try {
    result = await callWithState(state, 'account/rateLimits/read', {}, { timeoutMs: state.timeoutMs });
  } catch (error) {
    throw mapCallError(error, 'account/rateLimits/read');
  }
  refreshAuth(state).catch(() => {});
  return result;
}

function prepareImage(image) {
  if (!image || typeof image !== 'object') throw fail('MODEL_CONTENT_INVALID', { kind: 'image' });
  const mime = image.mime;
  if (!['image/png', 'image/jpeg'].includes(mime) || typeof image.data !== 'string') throw fail('MODEL_CONTENT_INVALID', { kind: 'image' });
  if (image.data.length > 5200000 || image.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw fail('MODEL_CONTENT_INVALID', { kind: 'image' });
  const buffer = Buffer.from(image.data, 'base64');
  if (buffer.length < 33 || buffer.length > 3900000) throw fail('MODEL_CONTENT_INVALID', { kind: 'image' });
  if (mime === 'image/png' && buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw fail('MODEL_CONTENT_INVALID', { kind: 'image' });
  if (mime === 'image/jpeg' && buffer.subarray(0, 3).toString('hex') !== 'ffd8ff') throw fail('MODEL_CONTENT_INVALID', { kind: 'image' });
  return { mime, buffer, extension: mime === 'image/png' ? 'png' : 'jpg' };
}

function isUnsafeItem(item) {
  return !item || typeof item.type !== 'string' || !SAFE_ITEM_TYPES.has(item.type);
}

function usageNumbers(value) {
  const input = value && Number.isFinite(Number(value.inputTokens)) ? Math.max(0, Math.floor(Number(value.inputTokens))) : 0;
  const output = value && Number.isFinite(Number(value.outputTokens)) ? Math.max(0, Math.floor(Number(value.outputTokens))) : 0;
  const thinking = value && Number.isFinite(Number(value.reasoningOutputTokens)) ? Math.max(0, Math.floor(Number(value.reasoningOutputTokens))) : 0;
  return { input, output, thinking };
}

function turnFailure(turn) {
  const error = turn && turn.error && typeof turn.error === 'object' ? turn.error : {};
  const raw = [error.codexErrorInfo, error.message, error.additionalDetails]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
    .join(' ')
    .toLowerCase();
  let code = 'MODEL_REQUEST_FAILED';
  if (/subscription[^.]{0,40}(?:expired|inactive)/.test(raw)) code = 'MODEL_SUBSCRIPTION_EXPIRED';
  else if (/insufficient|balance|credits|billing|quota/.test(raw)) code = 'MODEL_BALANCE_REQUIRED';
  else if (/unauthorized|authentication|invalid[^.]{0,20}token|sign.?in|401|403/.test(raw)) code = 'MODEL_AUTH_FAILED';
  else if (/rate.?limit|usage.?limit|too many requests|429/.test(raw)) code = 'MODEL_RATE_LIMIT';
  else if (/timeout|timed out|deadline/.test(raw)) code = 'MODEL_UPSTREAM_TIMEOUT';
  else if (/context[^.]{0,20}(?:window|length)|maximum[^.]{0,20}token|too long/.test(raw)) code = 'MODEL_OUTPUT_LIMIT';
  const diagnostic = { kind: 'turn', status: turn && turn.status ? turn.status : 'failed' };
  if (error.codexErrorInfo !== undefined) {
    diagnostic.codexErrorInfo = redactText(typeof error.codexErrorInfo === 'string' ? error.codexErrorInfo : JSON.stringify(error.codexErrorInfo), 160);
  }
  if (error.message) diagnostic.message = redactText(error.message, 2000);
  return fail(code, diagnostic);
}

function pickOutput(itemMap, deltas) {
  const messages = [...itemMap.values()].filter((item) => item && item.type === 'agentMessage' && typeof item.text === 'string');
  const final = [...messages].reverse().find((item) => item.phase === 'final_answer' && item.text.trim());
  if (final) return final.text;
  const last = messages.at(-1);
  if (last) return last.text;
  if (deltas.size) {
    const values = [...deltas.values()];
    return values.at(-1) || values.join('');
  }
  return '';
}

function mapCallError(error, phase) {
  if (!error || error.message !== 'CODEX_RPC_ERROR') return error;
  const diagnostic = error.diagnostic && typeof error.diagnostic === 'object' ? error.diagnostic : {};
  const message = String(diagnostic.message || '').toLowerCase();
  let code = 'MODEL_REQUEST_FAILED';
  if (/unauthorized|authentication|invalid[^.]{0,20}token|sign.?in|401|403/.test(message)) code = 'MODEL_AUTH_FAILED';
  else if (/rate.?limit|usage.?limit|too many requests|429/.test(message)) code = 'MODEL_RATE_LIMIT';
  else if (/model|effort|reasoning/.test(message)) code = 'MODEL_SELECTION_INVALID';
  else if (/timeout|timed out|deadline/.test(message)) code = 'MODEL_UPSTREAM_TIMEOUT';
  const mapped = fail(code, {
    kind: 'rpc',
    phase,
    ...(diagnostic.method ? { method: diagnostic.method } : {}),
    ...(diagnostic.rpcCode !== undefined ? { rpcCode: diagnostic.rpcCode } : {}),
    ...(diagnostic.message ? { message: diagnostic.message } : {}),
  });
  mapped.cause = error;
  return mapped;
}

async function interruptTurn(state, threadId, turnId) {
  if (!threadId || !turnId || state.closed) return;
  try {
    await callWithState(state, 'turn/interrupt', { threadId, turnId }, { timeoutMs: 5000 });
  } catch {}
}

async function complete(runtime, prompt, generation, options = {}) {
  const state = states.get(runtime);
  if (!state) throw fail('MODEL_NOT_CONFIGURED', { kind: 'runtime' });
  if (state.closed) throw fail('MODEL_CONNECTION_LOST', { kind: 'complete' });
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) throw fail('MODEL_CONTENT_INVALID', { kind: 'prompt' });
  if (prompt.system !== undefined && typeof prompt.system !== 'string') throw fail('MODEL_CONTENT_INVALID', { kind: 'system' });
  if (!generation || typeof generation !== 'object' || Array.isArray(generation)) throw fail('MODEL_NOT_CONFIGURED', { kind: 'generation' });
  const model = typeof generation.model === 'string' && generation.model.trim() ? generation.model : null;
  if (!model) throw fail('MODEL_NOT_CONFIGURED', { kind: 'generation' });
  const rawEffort = generation.reasoningEffort === undefined ? (generation.effort === undefined ? null : generation.effort) : generation.reasoningEffort;
  if (rawEffort !== null && (typeof rawEffort !== 'string' || !rawEffort.trim())) throw fail('MODEL_SELECTION_INVALID', { kind: 'effort' });
  const effort = rawEffort === null ? null : rawEffort;
  const { onProgress = null, signal = null, probe = false } = options || {};
  if (onProgress !== null && typeof onProgress !== 'function') throw new TypeError('onProgress must be a function');

  await refreshAuth(state);
  if (!state.auth) throw fail('MODEL_AUTH_FAILED', { kind: 'complete', reason: 'auth-missing' });
  if (signal && signal.aborted) throw cancelledError();

  let inputText;
  if (prompt.inputText !== undefined) {
    if (typeof prompt.inputText !== 'string') throw fail('MODEL_CONTENT_INVALID', { kind: 'prompt-input' });
    inputText = prompt.inputText;
  }
  else if (prompt.input === undefined) inputText = '';
  else {
    try {
      inputText = JSON.stringify(prompt.input);
    } catch {
      throw fail('MODEL_CONTENT_INVALID', { kind: 'prompt-input' });
    }
    if (typeof inputText !== 'string') throw fail('MODEL_CONTENT_INVALID', { kind: 'prompt-input' });
  }

  let imagePath = null;
  if (prompt.image) {
    const image = prepareImage(prompt.image);
    imagePath = path.join(state.dir, `image-${randomUUID()}.${image.extension}`);
    await writeSecure(imagePath, image.buffer, 0o600);
  }

  const input = [{ type: 'text', text: inputText }];
  if (imagePath) input.push({ type: 'localImage', path: imagePath });

  const timeoutMs = probe ? Math.min(PROBE_TIMEOUT_MS, state.timeoutMs) : state.timeoutMs;
  let threadId = null;
  let turnId = null;
  let settled = false;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {});
  const finish = (fn, value) => {
    if (settled) return;
    settled = true;
    fn(value);
  };
  const failNow = (error) => finish(rejectDone, error);

  let canceled = false;
  let timedOut = false;
  let violation = null;
  const itemMap = new Map();
  const deltas = new Map();
  let summary = '';
  let thinkingChars = 0;
  let responseChars = 0;
  let agentText = '';
  let tokenUsage = null;
  let lastError = null;
  const unsubs = [];
  let serverRequestUnsub = null;
  let closeUnsub = null;
  let signalListener = null;
  let deadlineTimer = null;

  const emitProgress = (phase) => {
    if (!onProgress || settled) return;
    try {
      onProgress({
        phase,
        thinkingChars,
        responseChars,
        ...(summary ? { summary } : {}),
        ...(phase === 'writing' && agentText ? { draftSource: agentText.slice(0, 256000) } : {}),
      });
    } catch {}
  };
  const matches = (params) => params && params.threadId === threadId;
  const matchesTurn = (params) => matches(params) && (!turnId || !params.turnId || params.turnId === turnId);
  const toolBlocked = (method) => fail('CODEX_TOOLS_BLOCKED', { kind: 'tool', method: redactText(method, 120) });

  const onAbort = () => {
    canceled = true;
    failNow(cancelledError());
  };

  try {
    const threadParams = {
      cwd: state.dir,
      model,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      ephemeral: true,
    };
    if (prompt.system !== undefined) threadParams.baseInstructions = prompt.system;
    let threadResult;
    try {
      threadResult = await callWithState(state, 'thread/start', threadParams, { timeoutMs: Math.min(timeoutMs, 60000) });
    } catch (error) {
      throw mapCallError(error, 'thread/start');
    }
    if (!threadResult || !threadResult.thread || typeof threadResult.thread.id !== 'string') throw fail('MODEL_BAD_RESPONSE', { kind: 'thread/start' });
    const sandbox = threadResult.sandbox;
    const readOnly = sandbox === 'read-only' || (sandbox && typeof sandbox === 'object' && sandbox.type === 'readOnly');
    if (!readOnly) throw fail('CODEX_TOOLS_UNSUPPORTED', { kind: 'thread', field: 'sandbox' });
    if (sandbox && typeof sandbox === 'object' && sandbox.networkAccess === true) {
      throw fail('CODEX_TOOLS_UNSUPPORTED', { kind: 'thread', field: 'networkAccess' });
    }
    if (threadResult.approvalPolicy !== 'never') throw fail('CODEX_TOOLS_UNSUPPORTED', { kind: 'thread', field: 'approvalPolicy' });
    threadId = threadResult.thread.id;

    serverRequestUnsub = onServerRequest(state, (method) => {
      violation = method;
      failNow(toolBlocked(method));
    });
    closeUnsub = onClose(state, (reason) => {
      if (settled) return;
      if (reason && reason.code === 'MODEL_CANCELLED') failNow(cancelledError());
      else failNow(fail('MODEL_CONNECTION_LOST', { kind: 'complete', cause: reason && reason.cause }));
    });
    unsubs.push(runtime.on('turn/started', (params) => {
      if (!matches(params)) return;
      if (params.turn && typeof params.turn.id === 'string') turnId = params.turn.id;
    }));
    unsubs.push(runtime.on('thread/settings/updated', (params) => {
      if (!matches(params)) return;
      const settings = params.threadSettings && typeof params.threadSettings === 'object' ? params.threadSettings : {};
      const policy = settings.sandboxPolicy || settings.sandbox;
      if (settings.approvalPolicy && settings.approvalPolicy !== 'never') {
        violation = 'approvalPolicy';
        failNow(fail('CODEX_TOOLS_BLOCKED', { kind: 'settings', field: 'approvalPolicy' }));
      }
      if (policy && !(policy === 'read-only' || (typeof policy === 'object' && policy.type === 'readOnly'))) {
        violation = 'sandboxPolicy';
        failNow(fail('CODEX_TOOLS_BLOCKED', { kind: 'settings', field: 'sandboxPolicy' }));
      }
      if (policy && typeof policy === 'object' && policy.networkAccess === true) {
        violation = 'networkAccess';
        failNow(fail('CODEX_TOOLS_BLOCKED', { kind: 'settings', field: 'networkAccess' }));
      }
    }));
    unsubs.push(runtime.on('item/started', (params) => {
      if (!matchesTurn(params)) return;
      if (isUnsafeItem(params.item)) {
        const type = params.item && params.item.type ? params.item.type : 'item';
        violation = type;
        failNow(toolBlocked(type));
      }
    }));
    unsubs.push(runtime.on('item/completed', (params) => {
      if (!matchesTurn(params)) return;
      if (isUnsafeItem(params.item)) {
        const type = params.item && params.item.type ? params.item.type : 'item';
        violation = type;
        failNow(toolBlocked(type));
        return;
      }
      if (params.item && params.item.type === 'agentMessage' && typeof params.item.id === 'string') itemMap.set(params.item.id, params.item);
    }));
    unsubs.push(runtime.on('item/agentMessage/delta', (params) => {
      if (!matchesTurn(params)) return;
      const delta = typeof params.delta === 'string' ? params.delta : '';
      if (!delta) return;
      const id = typeof params.itemId === 'string' ? params.itemId : 'agent';
      const previous = deltas.get(id) || '';
      deltas.set(id, previous + delta);
      agentText += delta;
      responseChars += delta.length;
      emitProgress('writing');
    }));
    unsubs.push(runtime.on('item/reasoning/summaryTextDelta', (params) => {
      if (!matchesTurn(params)) return;
      const delta = typeof params.delta === 'string' ? params.delta : '';
      if (!delta) return;
      summary = (summary + delta).slice(-4000);
      thinkingChars += delta.length;
      emitProgress('thinking');
    }));
    // Raw reasoning text is intentionally ignored: it is not a public summary
    // and must never be forwarded as progress.
    unsubs.push(runtime.on('item/reasoning/textDelta', () => {}));
    unsubs.push(runtime.on('thread/tokenUsage/updated', (params) => {
      if (!matchesTurn(params)) return;
      if (params.tokenUsage && params.tokenUsage.last) tokenUsage = params.tokenUsage.last;
    }));
    unsubs.push(runtime.on('error', (params) => {
      if (!matches(params)) return;
      if (params && params.error) lastError = params.error;
    }));
    unsubs.push(runtime.on('turn/completed', (params) => {
      if (!matches(params)) return;
      const turn = params.turn;
      if (!turn || typeof turn !== 'object') return;
      if (turnId && turn.id && turn.id !== turnId) return;
      if (typeof turn.id === 'string') turnId = turn.id;
      if (turn.items && Array.isArray(turn.items)) {
        for (const item of turn.items) {
          if (item && typeof item.id === 'string') itemMap.set(item.id, item);
        }
      }
      if (turn.status === 'completed') {
        const unsafe = (turn.items || []).find(isUnsafeItem);
        if (unsafe) {
          violation = unsafe.type || 'item';
          failNow(toolBlocked(violation));
          return;
        }
        const output = pickOutput(itemMap, deltas);
        if (!output || !output.trim()) {
          failNow(fail('MODEL_INCOMPLETE', { kind: 'completion', outputChars: output ? output.length : 0 }));
          return;
        }
        if (!settled && onProgress) {
          try {
            onProgress({ phase: 'writing', thinkingChars, responseChars: output.length, draftSource: output.slice(0, 256000), ...(summary ? { summary } : {}) });
          } catch {}
        }
        finish(resolveDone, {
          output,
          model,
          provider: 'openai-codex',
          reasoningEffort: effort,
          usage: usageNumbers(tokenUsage),
        });
      } else if (turn.status === 'failed') {
        failNow(turnFailure(turn));
      } else if (turn.status === 'interrupted') {
        if (canceled) failNow(cancelledError());
        else if (timedOut) failNow(fail('MODEL_UPSTREAM_TIMEOUT', { kind: 'complete', timeoutMs }));
        else failNow(fail('MODEL_REQUEST_FAILED', { kind: 'turn', status: 'interrupted' }));
      }
    }));

    if (signal) {
      signalListener = onAbort;
      signal.addEventListener('abort', signalListener, { once: true });
      if (signal.aborted) throw cancelledError();
    }
    deadlineTimer = setTimeout(() => {
      timedOut = true;
      failNow(fail('MODEL_UPSTREAM_TIMEOUT', { kind: 'complete', timeoutMs }));
    }, timeoutMs);

    const turnParams = {
      threadId,
      input,
      model,
      summary: 'auto',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    };
    if (effort) turnParams.effort = effort;
    let turnResult;
    try {
      turnResult = await callWithState(state, 'turn/start', turnParams, { timeoutMs: Math.min(timeoutMs, 60000) });
    } catch (error) {
      throw mapCallError(error, 'turn/start');
    }
    if (!turnResult || !turnResult.turn || typeof turnResult.turn.id !== 'string') throw fail('MODEL_BAD_RESPONSE', { kind: 'turn/start' });
    turnId = turnResult.turn.id;
    if (turnResult.turn.status === 'failed') failNow(turnFailure(turnResult.turn));
    else if (turnResult.turn.status === 'interrupted') {
      failNow(canceled ? cancelledError() : fail('MODEL_REQUEST_FAILED', { kind: 'turn', status: 'interrupted' }));
    }

    return await done;
  } catch (error) {
    if (!settled) {
      const diagnostic = error && error.diagnostic ? error.diagnostic : {};
      if (lastError && !Object.hasOwn(diagnostic, 'message')) {
        diagnostic.message = redactText(lastError.message, 2000);
        error.diagnostic = diagnostic;
      }
    }
    throw error;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (signalListener && signal) {
      try {
        signal.removeEventListener('abort', signalListener);
      } catch {}
    }
    if (serverRequestUnsub) serverRequestUnsub();
    if (closeUnsub) closeUnsub();
    for (const unsubscribe of unsubs.splice(0)) {
      try {
        unsubscribe();
      } catch {}
    }
    if (imagePath) await fsp.unlink(imagePath).catch(() => {});
    if (!settled) settled = true;
    if (violation || canceled || timedOut) await interruptTurn(state, threadId, turnId);
    try {
      await refreshAuth(state);
    } catch {}
  }
}

module.exports = { createRuntime, login, readQuota, complete };
