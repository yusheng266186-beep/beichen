/* ═══════════════════════════════════════════════════════════════════
   北辰 · 选科谈心中转服务（腾讯云 SCF Web Function 入口）
   ------------------------------------------------------------------
   1. 星门：TOTP 动态码验证 → HMAC 会话票据
   2. 额度：星图生成成功后由服务端原子结算；失败释放预占
   3. 对话：严格校验请求 → 百度千帆 → SSE 原样回流
   4. 边界：固定 CORS、请求/响应上限、超时、共享状态、防重放

   前端请求格式保持兼容：现有页面用 max_tokens≥10000 表示星图档，用
   X-Request-ID 调 /run/complete；页面只增加版本展示、验证码提醒和
   /readyz 就绪检查，不改变聊天请求流程。

   生产状态必须进入共享 Redis。STATE_STORE=memory 只用于本地测试，
   绝不会作为 Redis 故障时的自动降级路径。
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const {
  MemoryStateStore,
  createStateStoreFromEnv
} = require('./state-store');

/* ── 常量与环境 ─────────────────────────────────────────────────── */
const BACKEND_VERSION = 'v2.7.0';
const FRONTEND_VERSION = 'v2.7.0';
const MAX_BODY_BYTES = 128 * 1024;
const MAX_MESSAGE_COUNT = 24;
const MAX_MESSAGE_CHARS = 16000;
/* 默认 4 万字符：中文按 3 字节/字约 120KB，先于正文上限触发 */
const MAX_PROMPT_CHARS = boundedInt(process.env.MAX_PROMPT_CHARS, 40000, 2000, 200000);
const MAX_COMPLETION_TOKENS = 16384;
const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024;
const CLOCK_SKEW_MS = 60 * 1000;
const DEFAULT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RUNS = 3;
const REPORT_SCALE_TOKENS = 10000;
/* 正式页面日常请求为 5000，≥10000 是星图请求；中间档禁止，避免伪装 */
const NORMAL_MAX_TOKENS = boundedInt(process.env.NORMAL_MAX_TOKENS, 5000, 100, REPORT_SCALE_TOKENS - 1);
const MAX_SESSION_TURNS = boundedInt(process.env.MAX_SESSION_TURNS, 300, 20, 5000);
const REPORT_ATTEMPTS = boundedInt(process.env.REPORT_ATTEMPTS, 6, 1, 20);
const REPORT_REPAIR_ATTEMPTS = boundedInt(process.env.REPORT_REPAIR_ATTEMPTS, 2, 0, 5);
const DEFAULT_UPSTREAM_TIMEOUT_MS = 540 * 1000;

const QIANFAN_BASE_URL = 'https://qianfan.baidubce.com/v2/tokenplan/personal';
const QIANFAN_ALLOWED_HOSTS = new Set(['qianfan.baidubce.com']);
const QIANFAN_ENDPOINT_BASES = ['/v2/tokenplan/personal'];
const DEFAULT_QIANFAN_MODEL = 'qianfan-code-latest';

const TOKEN_TTL_MS = boundedInt(process.env.GATE_TOKEN_TTL_MS, DEFAULT_TOKEN_TTL_MS, 60 * 1000, MAX_TOKEN_TTL_MS);
const UPSTREAM_TIMEOUT_MS = boundedInt(process.env.UPSTREAM_TIMEOUT_MS, DEFAULT_UPSTREAM_TIMEOUT_MS, 30 * 1000, 570 * 1000);
const TURN_LEASE_MS = boundedInt(process.env.TURN_LEASE_MS, Math.min(900000, UPSTREAM_TIMEOUT_MS + 60000), 60000, 900000);
const REPORT_LEASE_MS = boundedInt(process.env.REPORT_LEASE_MS, Math.min(900000, UPSTREAM_TIMEOUT_MS + 60000), 60000, 900000);
const CORS_ALLOWED_ORIGINS = String(process.env.CORS_ALLOWED_ORIGINS || 'https://yusheng266186-beep.github.io')
  .split(',').map(s => s.trim()).filter(Boolean);

function boundedInt(raw, fallback, min, max) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/* ── 小工具 ─────────────────────────────────────────────────────── */
function httpError(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let rejected = false;
    req.on('data', chunk => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) {
        rejected = true;
        req.pause();
        reject(httpError(413, 'BEICHEN_PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (_) { reject(httpError(400, 'BEICHEN_BAD_JSON')); }
    });
    req.on('error', reject);
  });
}

function onlyKeys(obj, keys) {
  return obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).every(key => keys.includes(key));
}

function errorStatus(code, fallback = 500) {
  const statuses = {
    BEICHEN_AUTH_NOT_CONFIGURED: 503,
    BEICHEN_STATE_STORE_UNAVAILABLE: 503,
    BEICHEN_PROVIDER_NOT_CONFIGURED: 503,
    BEICHEN_QIANFAN_HOST_NOT_ALLOWED: 503,
    BEICHEN_QIANFAN_STANDARD_ENDPOINT_REQUIRED: 503,
    BEICHEN_AUTH_REQUIRED: 401,
    BEICHEN_AUTH_EXPIRED: 401,
    BEICHEN_AUTH_REPLAY: 401,
    BEICHEN_AUTH_INVALID_CODE: 401,
    BEICHEN_AUTH_RATE_LIMIT: 429,
    BEICHEN_RATE_LIMIT: 429,
    BEICHEN_QUOTA_EXHAUSTED: 409,
    BEICHEN_REPORT_NOT_READY: 409,
    BEICHEN_REPORT_IN_PROGRESS: 429,
    BEICHEN_REPORT_ATTEMPTS_EXHAUSTED: 409,
    BEICHEN_SESSION_TURNS_EXHAUSTED: 409,
    BEICHEN_REPORT_SCALE_REQUIRED: 400,
    BEICHEN_MAX_TOKENS_LIMIT: 400,
    BEICHEN_UPSTREAM_TIMEOUT: 504,
    BEICHEN_UPSTREAM_ERROR: 502,
    BEICHEN_CLIENT_ABORTED: 499
  };
  return statuses[code] || fallback;
}

function sendError(req, res, error, fallbackCode = 'BEICHEN_INTERNAL_ERROR') {
  const code = error && error.code ? error.code : fallbackCode;
  if (res.headersSent) return res.destroy();
  return json(req, res, errorStatus(code, error && error.status ? error.status : 500), { error: { message: code } });
}

/* ── CORS 与响应 ────────────────────────────────────────────────── */
function allowedOrigin(req) {
  const origin = String(req.headers.origin || '');
  return !origin || CORS_ALLOWED_ORIGINS.includes(origin);
}

function securityHeaders(req, extra) {
  const headers = Object.assign({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
  }, extra || {});
  if (req.headers.origin && CORS_ALLOWED_ORIGINS.includes(req.headers.origin)) {
    headers['Access-Control-Allow-Origin'] = req.headers.origin;
    headers['Vary'] = 'Origin';
    headers['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'content-type, authorization, x-request-id';
    headers['Access-Control-Max-Age'] = '600';
  }
  return headers;
}

function json(req, res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, securityHeaders(req, { 'Content-Type': 'application/json; charset=utf-8' }));
  res.end(payload);
}

function text(req, res, status, body) {
  res.writeHead(status, securityHeaders(req, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment' }));
  res.end(body);
}

/* 宽松 IP 形态校验，只用于限流键取粒度。 */
function looksLikeIp(value) {
  const input = String(value || '').trim().replace(/^\[(.+)\]$/, '$1');
  if (!input || input.length > 45) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(input)) return input.split('.').every(part => Number(part) <= 255);
  const mapped = input.match(/^::ffff:(\d{1,3}(\.\d{1,3}){3})$/i);
  if (mapped) return mapped[1].split('.').every(part => Number(part) <= 255);
  if (/^([0-9a-fA-F]{8}|[0-9a-fA-F]{32})$/.test(input)) return true;
  return /^([0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}$/.test(input);
}

/* CLB 把真实客户端 IP 追加在 XFF 末尾，前面的条目可能被伪造。 */
function pickClientIp(xffHeader, fallbackIp) {
  const raw = Array.isArray(xffHeader) ? xffHeader.join(',') : String(xffHeader || '');
  const entries = raw.split(',');
  for (let i = entries.length - 1; i >= 0; i--) {
    const candidate = entries[i].trim();
    if (looksLikeIp(candidate)) return candidate;
  }
  return (fallbackIp && String(fallbackIp).trim()) || 'unknown';
}

function clientKey(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* 仅为历史契约/离线自检保留的有界重放表工具；线上收据由 stateStore 管理。 */
function pruneMap(map, limit) {
  if (map.size <= limit) return;
  const iterator = map.keys();
  while (map.size > Math.floor(limit * 0.9)) map.delete(iterator.next().value);
}

function recordCompletion(map, key, response) {
  map.set(key, response);
  pruneMap(map, 8);
}

/* ── TOTP（RFC 6238，SHA1/30s/6 位，允许 ±1 窗口） ────────────── */
function base32Decode(value) {
  const clean = String(value || '').replace(/[\s-]/g, '').toUpperCase();
  if (clean.length < 16 || !/^[A-Z2-7]+$/.test(clean)) return Buffer.alloc(0);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let buffer = 0;
  const output = [];
  for (const ch of clean) {
    buffer = (buffer << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function totpCode(counter, secretBytes) {
  const message = Buffer.alloc(8);
  let value = counter;
  for (let i = 7; i >= 0; i--) {
    message[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  const digest = crypto.createHmac('sha1', secretBytes).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const number = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(number % 1000000).padStart(6, '0');
}

function matchingTotpCounter(code, now = Date.now()) {
  if (!/^\d{6}$/.test(code) || !process.env.GATE_TOTP_SECRET) return null;
  const secretBytes = base32Decode(process.env.GATE_TOTP_SECRET);
  if (secretBytes.length < 10) return null;
  const counter = Math.floor(now / 30000);
  for (const candidate of [counter - 1, counter, counter + 1]) {
    if (constantTimeEqual(code, totpCode(candidate, secretBytes))) return candidate;
  }
  return null;
}

/* ── 会话票据：v1.payload.base64url + HMAC-SHA256 ──────────────── */
function sessionSecretReady() {
  return Buffer.byteLength(String(process.env.GATE_SESSION_SECRET || ''), 'utf8') >= 32;
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', String(process.env.GATE_SESSION_SECRET)).update(body).digest('base64url');
  return body + '.' + signature;
}

function decodeToken(token) {
  try {
    const [body, signature] = String(token || '').split('.');
    if (!body || !signature || !sessionSecretReady()) return null;
    const expected = crypto.createHmac('sha256', String(process.env.GATE_SESSION_SECRET)).update(body).digest('base64url');
    if (!constantTimeEqual(signature, expected)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const now = Date.now();
    if (payload.v !== 1 || !/^[a-f0-9]{32}$/.test(payload.sid) || !/^[a-f0-9]{32}$/.test(payload.jti)) return null;
    if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat > now + CLOCK_SKEW_MS || payload.exp <= now) return null;
    if (payload.exp - payload.iat > TOKEN_TTL_MS + CLOCK_SKEW_MS || !Number.isInteger(payload.runs) || payload.runs < 0 || payload.runs > MAX_RUNS) return null;
    if (!Number.isInteger(payload.seq) || payload.seq < 0) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function bearerPayload(req) {
  const authorization = String(req.headers.authorization || '');
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  return decodeToken(token);
}

function newSession() {
  const now = Date.now();
  return {
    schema: 1,
    sid: crypto.randomBytes(16).toString('hex'),
    jti: crypto.randomBytes(16).toString('hex'),
    seq: 0,
    iat: now,
    exp: now + TOKEN_TTL_MS,
    runs: 0,
    turns: 0,
    report: { id: null, status: 'idle', attemptsUsed: 0, retries: 0, startedAt: 0, readyAt: 0, leaseExp: 0 }
  };
}

function tokenForState(state) {
  return signToken({ v: 1, sid: state.sid, jti: state.jti, seq: state.seq, iat: state.iat, exp: state.exp, runs: state.runs });
}

let stateStore = createStateStoreFromEnv();

async function allowRate(key, limit, windowMs) {
  return stateStore.consumeRate(key, limit, windowMs);
}

async function authenticate(req, options = {}) {
  if (!sessionSecretReady()) return { error: 'BEICHEN_AUTH_NOT_CONFIGURED' };
  const payload = bearerPayload(req);
  if (!payload) return { error: 'BEICHEN_AUTH_REQUIRED' };
  const state = await stateStore.getSession(payload.sid);
  if (!state || state.exp <= Date.now()) return { error: 'BEICHEN_AUTH_EXPIRED', payload };
  const stale = state.jti !== payload.jti || state.seq !== payload.seq || state.runs !== payload.runs;
  if (stale && !options.allowStale) return { error: 'BEICHEN_AUTH_REPLAY', payload, state, stale: true };
  return { payload, state, stale };
}

/* ── 路由：星门验证 ───────────────────────────────────────────── */
async function handleVerify(req, res) {
  if (!process.env.GATE_TOTP_SECRET || !sessionSecretReady()) {
    return json(req, res, 503, { error: { message: 'BEICHEN_AUTH_NOT_CONFIGURED' } });
  }
  const clientIp = pickClientIp(req.headers['x-forwarded-for'], req.socket && req.socket.remoteAddress);
  if (!await allowRate('verify:' + clientIp, 8, 60000)) {
    return json(req, res, 429, { error: { message: 'BEICHEN_AUTH_RATE_LIMIT' } });
  }
  const body = await readJson(req, 8 * 1024);
  if (!onlyKeys(body, ['code']) || typeof body.code !== 'string') {
    return json(req, res, 401, { error: { message: 'BEICHEN_AUTH_INVALID_CODE' } });
  }
  const counter = matchingTotpCounter(body.code);
  if (counter === null) return json(req, res, 401, { error: { message: 'BEICHEN_AUTH_INVALID_CODE' } });
  /* Redis SET NX/PX 让多实例只能消费同一组 counter+验证码一次。 */
  const consumed = await stateStore.consumeTotp(counter + ':' + crypto.createHash('sha256').update(body.code).digest('hex'), 120000);
  if (!consumed) return json(req, res, 401, { error: { message: 'BEICHEN_AUTH_INVALID_CODE' } });

  const state = newSession();
  await stateStore.createSession(state);
  return json(req, res, 200, { ok: true, token: tokenForState(state), runs: 0, maxRuns: MAX_RUNS, expiresIn: TOKEN_TTL_MS });
}

/* ── 路由：额度结算（服务端原子、按请求号幂等） ──────────────── */
function validRequestId(value) {
  return /^[A-Za-z0-9._~-]{8,96}$/.test(value);
}

async function handleRunComplete(req, res) {
  const requestId = String(req.headers['x-request-id'] || '').trim();
  if (!validRequestId(requestId)) return json(req, res, 400, { error: { message: 'BEICHEN_BAD_REQUEST' } });
  const payload = bearerPayload(req);
  if (!payload) return json(req, res, sessionSecretReady() ? 401 : 503, { error: { message: sessionSecretReady() ? 'BEICHEN_AUTH_REQUIRED' : 'BEICHEN_AUTH_NOT_CONFIGURED' } });
  if (!await allowRate('run:' + clientKey(req) + ':' + payload.sid, 6, 60000)) {
    return json(req, res, 429, { error: { message: 'BEICHEN_RATE_LIMIT' } });
  }
  const body = await readJson(req, 4 * 1024);
  /* 兼容现有页面：确认请求就是空对象，不让客户端传“是否扣额”的指令。 */
  if (!onlyKeys(body, []) || Object.keys(body).length) return json(req, res, 400, { error: { message: 'BEICHEN_BAD_REQUEST' } });

  /* 先查收据：旧票据、更新后的票据、网络重试都拿到同一份响应。 */
  const replay = await stateStore.getCompletion(payload.sid, requestId);
  if (replay) return json(req, res, 200, replay);

  const auth = await authenticate(req);
  if (auth.error) return json(req, res, errorStatus(auth.error, 401), { error: { message: auth.error } });
  if (auth.state.report.status !== 'ready') return json(req, res, 409, { error: { message: 'BEICHEN_REPORT_NOT_READY' } });
  if (auth.payload.runs >= MAX_RUNS) return json(req, res, 409, { error: { message: 'BEICHEN_QUOTA_EXHAUSTED' } });

  const next = {
    jti: crypto.randomBytes(16).toString('hex'),
    seq: auth.state.seq + 1,
    runs: auth.state.runs + 1
  };
  const response = {
    ok: true,
    token: tokenForState(Object.assign({}, auth.state, next)),
    runs: next.runs,
    remaining: MAX_RUNS - next.runs,
    expiresIn: Math.max(0, auth.state.exp - Date.now())
  };
  const result = await stateStore.completeRun({
    sid: auth.payload.sid,
    requestId,
    expected: { jti: auth.payload.jti, seq: auth.payload.seq, runs: auth.payload.runs, exp: auth.state.exp },
    next,
    response,
    maxRuns: MAX_RUNS,
    receiptTtlMs: Math.max(1000, auth.state.exp - Date.now())
  });
  if (!result.ok) return json(req, res, errorStatus(result.code, 409), { error: { message: result.code } });
  return json(req, res, 200, result.response);
}

/* ── 路由：对话转发 ───────────────────────────────────────────── */
function validateChatBody(input) {
  const allowed = ['messages', 'max_tokens', 'temperature', 'stream', 'thinking', 'mode'];
  if (!onlyKeys(input, allowed) || !Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > MAX_MESSAGE_COUNT) {
    throw httpError(400, 'BEICHEN_BAD_REQUEST');
  }
  let promptChars = 0;
  const messages = input.messages.map(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message) || !onlyKeys(message, ['role', 'content'])) throw httpError(400, 'BEICHEN_BAD_REQUEST');
    if (!['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || message.content.length > MAX_MESSAGE_CHARS) throw httpError(400, 'BEICHEN_BAD_REQUEST');
    promptChars += message.content.length;
    return { role: message.role, content: message.content };
  });
  if (promptChars > MAX_PROMPT_CHARS) throw httpError(413, 'BEICHEN_PROMPT_TOO_LARGE');
  const maxTokens = input.max_tokens === undefined ? 3500 : input.max_tokens;
  const temperature = input.temperature === undefined ? 1 : input.temperature;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_COMPLETION_TOKENS || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw httpError(400, 'BEICHEN_BAD_REQUEST');
  if (input.stream !== undefined && input.stream !== true) throw httpError(400, 'BEICHEN_STREAM_REQUIRED');
  const body = { messages, max_tokens: maxTokens, temperature, stream: true };
  if (input.thinking !== undefined) {
    if (!input.thinking || typeof input.thinking !== 'object' || Array.isArray(input.thinking) || !onlyKeys(input.thinking, ['type']) || !['enabled', 'disabled'].includes(input.thinking.type)) throw httpError(400, 'BEICHEN_BAD_REQUEST');
    body.thinking = { type: input.thinking.type };
  }
  if (input.mode !== undefined) body.mode = input.mode;
  return body;
}

function providerConfig() {
  const key = String(process.env.QIANFAN_API_KEY || '').trim();
  const model = String(process.env.QIANFAN_MODEL || DEFAULT_QIANFAN_MODEL).trim();
  if (!key || !model) return null;
  const url = String(process.env.QIANFAN_BASE_URL || QIANFAN_BASE_URL).trim();
  return { name: 'qianfan', key, model, url };
}

function upstreamUrl(config) {
  let url;
  try { url = new URL(config.url); }
  catch (_) { throw httpError(503, 'BEICHEN_PROVIDER_NOT_CONFIGURED'); }
  if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password) throw httpError(503, 'BEICHEN_PROVIDER_NOT_CONFIGURED');
  if (!QIANFAN_ALLOWED_HOSTS.has(url.hostname.toLowerCase()) || (url.port && url.port !== '443')) throw httpError(503, 'BEICHEN_QIANFAN_HOST_NOT_ALLOWED');
  let path = url.pathname.replace(/\/+$/, '');
  if (/coding/i.test(path)) throw httpError(503, 'BEICHEN_QIANFAN_STANDARD_ENDPOINT_REQUIRED');
  let matched = false;
  for (const base of QIANFAN_ENDPOINT_BASES) {
    if (!path || path === base) { path = base + '/chat/completions'; matched = true; break; }
    if (path === base + '/chat/completions') { matched = true; break; }
  }
  if (!matched) throw httpError(503, 'BEICHEN_QIANFAN_STANDARD_ENDPOINT_REQUIRED');
  url.pathname = path;
  return url;
}

function buildUpstreamBody(body, config) {
  const upstreamBody = Object.assign({}, body, { model: config.model });
  if (config.name === 'qianfan') {
    upstreamBody.thinking = { type: 'enabled' };
    upstreamBody.reasoning_effort = 'max';
    const reportScale = Number(body.max_tokens || 0) >= REPORT_SCALE_TOKENS;
    const budget = reportScale
      ? boundedInt(process.env.QIANFAN_REPORT_THINKING_BUDGET, 4096, 100, MAX_COMPLETION_TOKENS)
      : boundedInt(process.env.QIANFAN_THINKING_BUDGET, 2048, 100, MAX_COMPLETION_TOKENS);
    upstreamBody.thinking_budget = budget;
  }
  delete upstreamBody.mode;
  return upstreamBody;
}

/* 纯函数保留给旧契约测试；线上次数预占/回退走 stateStore，不在 auth.state 上直接加一。 */
function enforceSessionQuota(auth, body) {
  if (Number(body.max_tokens) >= REPORT_SCALE_TOKENS && auth.state.runs >= MAX_RUNS) throw httpError(409, 'BEICHEN_QUOTA_EXHAUSTED');
  auth.state.turns = (Number(auth.state.turns) || 0) + 1;
  if (auth.state.turns > MAX_SESSION_TURNS) throw httpError(409, 'BEICHEN_SESSION_TURNS_EXHAUSTED');
}

function requestKind(body) {
  const maxTokens = Number(body.max_tokens || 0);
  if (maxTokens >= REPORT_SCALE_TOKENS) return 'report';
  if (maxTokens > NORMAL_MAX_TOKENS) throw httpError(400, 'BEICHEN_MAX_TOKENS_LIMIT');
  return 'normal';
}

/* 允许测试替换 HTTP 上游；生产默认使用 https.request。 */
let upstreamRequester;

function proxyChat(req, res, body, config) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let responseEnded = false;
    let upstreamResponse;
    let upstream;
    const payload = JSON.stringify(buildUpstreamBody(body, config));

    const fail = error => {
      if (settled) return;
      settled = true;
      if (upstream && !upstream.destroyed) upstream.destroy();
      if (res.headersSent && !res.writableEnded) res.destroy();
      reject(error);
    };
    const success = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    try {
      const url = upstreamUrl(config);
      upstream = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        timeout: UPSTREAM_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream, application/json',
          'Authorization': 'Bearer ' + config.key,
          'Content-Length': Buffer.byteLength(payload)
        }
      }, response => {
        upstreamResponse = response;
        const status = Number(response.statusCode || 502);
        if (status < 200 || status >= 300) {
          let bytes = 0;
          response.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > 64 * 1024) response.destroy();
          });
          response.on('end', () => fail(httpError(status >= 400 && status < 500 ? status : 502, 'BEICHEN_UPSTREAM_ERROR')));
          response.on('error', () => fail(httpError(502, 'BEICHEN_UPSTREAM_ERROR')));
          return;
        }
        const contentType = String(response.headers['content-type'] || '').toLowerCase();
        res.writeHead(status, securityHeaders(req, {
          'Content-Type': contentType.startsWith('text/event-stream') ? 'text/event-stream' : 'application/json; charset=utf-8',
          'X-Accel-Buffering': 'no'
        }));
        let bytes = 0;
        res.on('drain', () => response.resume());
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_UPSTREAM_BYTES) return fail(httpError(502, 'BEICHEN_UPSTREAM_ERROR'));
          if (!res.write(chunk)) response.pause();
        });
        response.on('end', () => {
          responseEnded = true;
          if (!res.writableEnded) res.end();
          success();
        });
        response.on('aborted', () => fail(httpError(502, 'BEICHEN_UPSTREAM_ERROR')));
        response.on('error', () => fail(httpError(502, 'BEICHEN_UPSTREAM_ERROR')));
      });
      upstream.on('timeout', () => {
        upstream.destroy();
        fail(httpError(504, 'BEICHEN_UPSTREAM_TIMEOUT'));
      });
      upstream.on('error', () => fail(httpError(502, 'BEICHEN_UPSTREAM_ERROR')));
      req.on('aborted', () => {
        if (upstream && !settled) { upstream.destroy(); fail(httpError(499, 'BEICHEN_CLIENT_ABORTED')); }
      });
      res.on('close', () => {
        if (!responseEnded && upstream && !settled) { upstream.destroy(); fail(httpError(499, 'BEICHEN_CLIENT_ABORTED')); }
      });
      upstream.write(payload);
      upstream.end();
    } catch (error) {
      if (upstreamResponse) upstreamResponse.destroy();
      fail(error.code ? error : httpError(502, 'BEICHEN_UPSTREAM_ERROR'));
    }
  });
}

upstreamRequester = proxyChat;

function mapStoreResult(req, res, result) {
  if (result.ok) return null;
  return json(req, res, errorStatus(result.code, 409), { error: { message: result.code } });
}

async function handleChat(req, res) {
  const auth = await authenticate(req);
  if (auth.error) return json(req, res, errorStatus(auth.error, 401), { error: { message: auth.error } });
  if (!await allowRate('chat:' + clientKey(req) + ':' + auth.payload.sid, 10, 60000)) {
    return json(req, res, 429, { error: { message: 'BEICHEN_RATE_LIMIT' } });
  }
  const config = providerConfig();
  if (!config) return json(req, res, 503, { error: { message: 'BEICHEN_PROVIDER_NOT_CONFIGURED' } });
  const input = await readJson(req, MAX_BODY_BYTES);
  const body = validateChatBody(input);
  const kind = requestKind(body);
  const reservation = await stateStore.startChat(auth.payload.sid, {
    report: kind === 'report',
    maxRuns: MAX_RUNS,
    maxTurns: MAX_SESSION_TURNS,
    maxReportAttempts: REPORT_ATTEMPTS,
    maxReportRetries: REPORT_REPAIR_ATTEMPTS,
    leaseMs: kind === 'report' ? REPORT_LEASE_MS : TURN_LEASE_MS,
    expected: { jti: auth.payload.jti, seq: auth.payload.seq, runs: auth.payload.runs }
  });
  const storeError = mapStoreResult(req, res, reservation);
  if (storeError) return storeError;

  let upstreamError = null;
  let upstreamSucceeded = false;
  try {
    await upstreamRequester(req, res, body, config);
    upstreamSucceeded = true;
  } catch (error) {
    upstreamError = error;
  }
  /* 流完成才结算；超时、上游错误、客户端中断都释放日常轮/报告预占。 */
  try {
    await stateStore.finishChat(auth.payload.sid, reservation.reservationId, upstreamSucceeded, kind === 'report');
  } catch (error) {
    /* 状态层短暂故障时不把故障细节/请求内容写日志；租约会负责回收。 */
    if (!upstreamSucceeded) upstreamError = upstreamError || error;
  }
  if (upstreamError) throw upstreamError;
}

/* ── 健康检查 ──────────────────────────────────────────────────── */
async function handleHealth(req, res, ready) {
  let storeReachable = false;
  try { storeReachable = await stateStore.ping(); }
  catch (_) { storeReachable = false; }
  const configured = Boolean(process.env.QIANFAN_API_KEY && sessionSecretReady() && process.env.GATE_TOTP_SECRET);
  const ok = configured && storeReachable;
  return json(req, res, ready && !ok ? 503 : 200, {
    ok: ready ? ok : true,
    ready: ok,
    version: BACKEND_VERSION,
    frontendVersion: FRONTEND_VERSION,
    providerConfigured: Boolean(providerConfig()),
    stateStore: stateStore.name,
    stateStoreReachable: storeReachable,
    maxRuns: MAX_RUNS
  });
}

/* ── HTTP 入口 ──────────────────────────────────────────────────── */
async function handle(req, res) {
  if (!allowedOrigin(req)) return json(req, res, 403, { error: { message: 'BEICHEN_ORIGIN_NOT_ALLOWED' } });
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const postPaths = ['/verify', '/run/complete', '/chat/completions'];
  if (req.method === 'OPTIONS') {
    if (!postPaths.includes(path) || url.search || String(req.headers['access-control-request-method'] || '') !== 'POST') return text(req, res, 404, 'beichen relay');
    res.writeHead(204, securityHeaders(req));
    return res.end();
  }
  if (req.method === 'GET' && path === '/healthz' && !url.search) return handleHealth(req, res, false);
  if (req.method === 'GET' && path === '/readyz' && !url.search) return handleHealth(req, res, true);
  if (req.method === 'POST' && path === '/verify') return handleVerify(req, res);
  if (req.method === 'POST' && path === '/run/complete') return handleRunComplete(req, res);
  if (req.method === 'POST' && path === '/chat/completions') return handleChat(req, res);
  return text(req, res, 404, 'beichen relay');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(error => sendError(req, res, error));
});
server.headersTimeout = 20000;
server.requestTimeout = 20000;
if (!process.env.BEICHEN_NO_LISTEN) {
  server.listen(Number(process.env.PORT || 9000), '0.0.0.0', () => console.log('beichen relay listening'));
}

function setStateStore(next) {
  if (!next || typeof next.getSession !== 'function') throw new TypeError('state store is incomplete');
  stateStore = next;
}

function setUpstreamRequester(next) {
  if (typeof next !== 'function') throw new TypeError('upstream requester must be a function');
  upstreamRequester = next;
}

/* 兼容旧契约测试与运维自检；生产环境永不导出秘钥或内部状态。 */
if (typeof module !== 'undefined') {
  module.exports = {
    BACKEND_VERSION,
    FRONTEND_VERSION,
    MAX_RUNS,
    REPORT_SCALE_TOKENS,
    validateChatBody,
    buildUpstreamBody,
    upstreamUrl,
    enforceSessionQuota,
    pickClientIp,
    matchingTotpCounter,
    tokenForState,
    setStateStore,
    setUpstreamRequester,
    getStateStore: () => stateStore,
    handle,
    server,
    MemoryStateStore,
    recordCompletion,
    maxPromptChars: MAX_PROMPT_CHARS,
    normMaxTokens: MAX_COMPLETION_TOKENS
  };
}
