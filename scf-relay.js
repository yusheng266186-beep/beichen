/* ═══════════════════════════════════════════════════════════════════
   北辰 · 选科谈心 中转服务(腾讯云 SCF Web Function 入口)
   ------------------------------------------------------------------
   职责(仅此四件事):
     1. 星门:TOTP 动态码验证 → 签发短生命周期的会话令牌(HMAC 签名)
     2. 额度:一次验证 3 次完整谈心;/run/complete 原子记账(幂等)
     3. 对话:校验请求 → 附加思考档位 → 转发百度千帆并回流 SSE
     4. 边界:固定 CORS、严格路由、请求体/响应体上限、上游超时

   设计原则:
   - 页面零密钥:千帆 Key 只存在本服务环境变量
   - 模型参数服务端说了算:模型名、思考档位、预算上限客户端不可指定
   - 会话/额度/TOTP 防重放为单实例内存实现(P0 待办:外部持久化)
   ═══════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const crypto = require('crypto');

/* ── 常量与环境 ─────────────────────────────────────────────────── */
const MAX_BODY_BYTES = 128 * 1024;
const MAX_MESSAGE_COUNT = 24;
const MAX_MESSAGE_CHARS = 16000;
/* 默认 4 万字符:中文按 3 字节/字约 120KB,先于 128KiB 正文上限触发,两道口径一致 */
const MAX_PROMPT_CHARS = boundedInt(process.env.MAX_PROMPT_CHARS, 40000, 2000, 200000);
/* GLM-5.2 的思考与正文共用 completion_tokens 预算,给足余量防截断 */
const MAX_COMPLETION_TOKENS = 16384;
const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024;
const CLOCK_SKEW_MS = 60 * 1000;
const DEFAULT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RUNS = 3;
/* 单会话(一次验证)终身对话轮数上限:聊天接口不做次数记账,用总轮数兜底防脚本烧上游额度 */
const MAX_SESSION_TURNS = boundedInt(process.env.MAX_SESSION_TURNS, 300, 20, 5000);
/* 星图档判定阈值,与思考预算分档共用:≥ 此值的请求受额度门槛约束 */
const REPORT_SCALE_TOKENS = 10000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 540 * 1000;

const QIANFAN_BASE_URL = 'https://qianfan.baidubce.com/v2/tokenplan/personal';
const QIANFAN_ALLOWED_HOSTS = new Set(['qianfan.baidubce.com']);
/* Token Plan 个人版专属端点;coding 系端点一律拒绝 */
const QIANFAN_ENDPOINT_BASES = ['/v2/tokenplan/personal'];
const DEFAULT_QIANFAN_MODEL = 'glm-5.2';

const TOKEN_TTL_MS = boundedInt(process.env.GATE_TOKEN_TTL_MS, DEFAULT_TOKEN_TTL_MS, 60 * 1000, MAX_TOKEN_TTL_MS);
const UPSTREAM_TIMEOUT_MS = boundedInt(process.env.UPSTREAM_TIMEOUT_MS, DEFAULT_UPSTREAM_TIMEOUT_MS, 30 * 1000, 570 * 1000);
const CORS_ALLOWED_ORIGINS = String(process.env.CORS_ALLOWED_ORIGINS || 'https://yusheng266186-beep.github.io')
  .split(',').map(s => s.trim()).filter(Boolean);

function boundedInt(raw, fallback, min, max) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/* ── 小工具 ─────────────────────────────────────────────────────── */
function httpError(status, code) { const e = new Error(code); e.status = status; e.code = code; return e; }
function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function pruneMap(map, limit) {
  if (map.size <= limit) return;
  const it = map.keys();
  while (map.size > limit * 0.9) map.delete(it.next().value);
}
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      /* 超限:只暂停读取,把错误交给外层 catch 写出 413;立即 destroy 会抢在响应送达前断连 */
      if (size > limit) { reject(httpError(413, 'BEICHEN_PAYLOAD_TOO_LARGE')); req.pause(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (_) { reject(httpError(400, 'BEICHEN_BAD_JSON')); }
    });
    req.on('error', reject);
  });
}
function onlyKeys(obj, keys) { return Object.keys(obj).every(k => keys.includes(k)); }

/* ── CORS 与响应 ────────────────────────────────────────────────── */
function allowedOrigin(req) {
  const origin = String(req.headers.origin || '');
  return !origin || CORS_ALLOWED_ORIGINS.includes(origin);
}
function securityHeaders(req, extra) {
  const h = Object.assign({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
  }, extra || {});
  if (req.headers.origin && CORS_ALLOWED_ORIGINS.includes(req.headers.origin)) {
    h['Access-Control-Allow-Origin'] = req.headers.origin;
    h['Vary'] = 'Origin';
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'content-type, authorization, x-request-id';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
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
/* 宽松 IP 形态校验:IPv4 点分十进制 / IPv6 冒号十六进制(含 ::ffff: 映射、方括号包裹)/ 纯十六进制串。
   只用于限流键取粒度,不做严格语义校验。 */
function looksLikeIp(value) {
  const s = String(value || '').trim().replace(/^\[(.+)\]$/, '$1');
  if (!s || s.length > 45) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s.split('.').every(n => Number(n) <= 255);
  const mapped = s.match(/^::ffff:(\d{1,3}(\.\d{1,3}){3})$/i);
  if (mapped) return mapped[1].split('.').every(n => Number(n) <= 255);
  if (/^([0-9a-fA-F]{8}|[0-9a-fA-F]{32})$/.test(s)) return true;
  return /^([0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}$/.test(s);
}
/* CLB 把真实客户端 IP 追加在 X-Forwarded-For 末尾,前面的条目客户端可伪造:
   从末尾往前取第一个合法条目;XFF 为空或全不合法时回退 TCP 对端。 */
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
  /* 业务限流维度(键已含 sid):TCP 对端即可;verify 限流改用 pickClientIp 应对 CLB 共享出口 */
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
const attempts = new Map();      /* verify 失败限流 */
const requestLimits = new Map(); /* 业务限流 */
const usedTotp = new Map();      /* TOTP 防重放:counter:code → 过期时间 */
const sessions = new Map();      /* sid → {runs, seq, jti, exp, lastCompletion} */
/* 并发双提交的幂等重放表:旧 jti → 完成时的完整响应,有界防膨胀 */
const recentCompletions = new Map();
const COMPLETION_REPLAY_LIMIT = 8;
function allowRate(map, key, limit, windowMs) {
  const now = Date.now();
  const cur = map.get(key);
  if (!cur || now > cur.exp) { map.set(key, { n: 1, exp: now + windowMs }); pruneMap(map, 5000); return true; }
  if (cur.n >= limit) return false;
  cur.n += 1; return true;
}

/* ── TOTP(RFC 6238,SHA1/30s/6位,允许 ±1 窗口且一次性消费) ─────── */
function base32Decode(value) {
  const clean = String(value || '').replace(/[\s-]/g, '').toUpperCase();
  if (clean.length < 16 || !/^[A-Z2-7]+$/.test(clean)) return Buffer.alloc(0);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, buffer = 0; const out = [];
  for (const ch of clean) {
    buffer = (buffer << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((buffer >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpCode(counter, secretBytes) {
  const message = Buffer.alloc(8);
  let value = counter;
  for (let i = 7; i >= 0; i--) { message[i] = value & 0xff; value = Math.floor(value / 256); }
  const digest = crypto.createHmac('sha1', secretBytes).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const number = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(number % 1000000).padStart(6, '0');
}
function consumeTotp(code) {
  if (!/^\d{6}$/.test(code) || !process.env.GATE_TOTP_SECRET) return false;
  const secretBytes = base32Decode(process.env.GATE_TOTP_SECRET);
  if (secretBytes.length < 10) return false;
  const counter = Math.floor(Date.now() / 30000);
  for (const candidate of [counter - 1, counter, counter + 1]) {
    if (!constantTimeEqual(code, totpCode(candidate, secretBytes))) continue;
    const key = candidate + ':' + code;
    const now = Date.now();
    if (usedTotp.has(key)) return false;
    usedTotp.set(key, now + 120000);
    for (const [k, exp] of usedTotp) if (exp <= now) usedTotp.delete(k);
    pruneMap(usedTotp, 5000);
    return true;
  }
  return false;
}

/* ── 会话令牌:v1.payload.base64url + HMAC-SHA256 签名 ───────────── */
function sessionSecretReady() {
  return Buffer.byteLength(String(process.env.GATE_SESSION_SECRET || ''), 'utf8') >= 32;
}
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', String(process.env.GATE_SESSION_SECRET)).update(body).digest('base64url');
  return body + '.' + sig;
}
function decodeToken(token) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const expected = crypto.createHmac('sha256', String(process.env.GATE_SESSION_SECRET)).update(body).digest('base64url');
    if (!constantTimeEqual(sig, expected)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const now = Date.now();
    if (payload.v !== 1 || !/^[a-f0-9]{32}$/.test(payload.sid) || !/^[a-f0-9]{32}$/.test(payload.jti)) return null;
    if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat > now + CLOCK_SKEW_MS || payload.exp <= now) return null;
    if (payload.exp - payload.iat > TOKEN_TTL_MS + CLOCK_SKEW_MS || !Number.isInteger(payload.runs) || payload.runs < 0 || payload.runs > MAX_RUNS) return null;
    if (!Number.isInteger(payload.seq) || payload.seq < 0) return null;
    return payload;
  } catch (_) { return null; }
}
function newToken(runs, sid, seq = 0) {
  const now = Date.now();
  const sessionId = sid || crypto.randomBytes(16).toString('hex');
  const jti = crypto.randomBytes(16).toString('hex');
  const exp = now + TOKEN_TTL_MS;
  sessions.set(sessionId, { runs, seq, jti, exp, lastCompletion: null });
  pruneMap(sessions, 5000);
  return { token: signToken({ v: 1, sid: sessionId, jti, seq, iat: now, exp, runs }), sid: sessionId, jti, seq, exp };
}
function authenticate(req) {
  if (!sessionSecretReady()) return { error: 'BEICHEN_AUTH_NOT_CONFIGURED' };
  const authorization = String(req.headers.authorization || '');
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const payload = decodeToken(token);
  if (!payload) return { error: 'BEICHEN_AUTH_REQUIRED' };
  const state = sessions.get(payload.sid);
  if (!state || state.exp <= Date.now()) return { error: 'BEICHEN_AUTH_EXPIRED', payload };
  if (state.jti !== payload.jti || state.seq !== payload.seq || state.runs !== payload.runs) {
    return { error: 'BEICHEN_AUTH_REPLAY', payload, state };
  }
  return { payload, state };
}

/* ── 路由:星门验证 ─────────────────────────────────────────────── */
function handleVerify(req, res) {
  if (!process.env.GATE_TOTP_SECRET || !sessionSecretReady()) return json(req, res, 503, { error: { message: 'BEICHEN_AUTH_NOT_CONFIGURED' } });
  if (!allowRate(attempts, 'verify:' + pickClientIp(req.headers['x-forwarded-for'], req.socket && req.socket.remoteAddress), 8, 60000)) return json(req, res, 429, { error: { message: 'BEICHEN_AUTH_RATE_LIMIT' } });
  readJson(req, 8 * 1024).then(body => {
    if (!onlyKeys(body, ['code']) || typeof body.code !== 'string' || !consumeTotp(body.code)) {
      return json(req, res, 401, { error: { message: 'BEICHEN_AUTH_INVALID_CODE' } });
    }
    const token = newToken(0);
    return json(req, res, 200, { ok: true, token: token.token, runs: 0, maxRuns: MAX_RUNS, expiresIn: TOKEN_TTL_MS });
  }).catch(error => json(req, res, error.status || 400, { error: { message: error.code || 'BEICHEN_BAD_JSON' } }));
}

/* ── 路由:额度记账(幂等) ───────────────────────────────────────── */
/* 重放表写入:超限按插入序淘汰最旧(与 pruneMap 同品格) */
function recordCompletion(map, jti, response) {
  map.set(jti, response);
  pruneMap(map, COMPLETION_REPLAY_LIMIT);
}
function completeRun(req, res, auth) {
  const requestId = String(req.headers['x-request-id'] || '').trim();
  if (!/^[A-Za-z0-9._~-]{8,96}$/.test(requestId)) return json(req, res, 400, { error: { message: 'BEICHEN_BAD_REQUEST' } });
  if (auth.payload.runs >= MAX_RUNS) return json(req, res, 409, { error: { message: 'BEICHEN_QUOTA_EXHAUSTED' } });
  const state = auth.state;
  if (state.jti !== auth.payload.jti) {
    /* 并发双提交:处理到此刻本请求的 jti 已被更晚的完成覆盖 → 查重放表返回当初存的同形响应 */
    const replayed = recentCompletions.get(auth.payload.jti);
    if (replayed) return json(req, res, 200, replayed);
    return json(req, res, 409, { error: { message: 'BEICHEN_AUTH_REPLAY' } });
  }
  const next = newToken(auth.payload.runs + 1, auth.payload.sid, auth.payload.seq + 1);
  state.runs = auth.payload.runs + 1;
  state.seq = auth.payload.seq + 1;
  state.jti = next.jti;
  const response = { ok: true, token: next.token, runs: state.runs, remaining: MAX_RUNS - state.runs, expiresIn: Math.max(0, state.exp - Date.now()) };
  state.lastCompletion = { requestId, priorJti: auth.payload.jti, response };
  recordCompletion(recentCompletions, auth.payload.jti, response);
  return json(req, res, 200, response);
}
function handleRunComplete(req, res) {
  const auth = authenticate(req, true);
  if (auth.error && !auth.state) return json(req, res, auth.error === 'BEICHEN_AUTH_NOT_CONFIGURED' ? 503 : 401, { error: { message: auth.error } });
  if (!allowRate(requestLimits, 'run:' + clientKey(req) + ':' + auth.payload.sid, 6, 60000)) return json(req, res, 429, { error: { message: 'BEICHEN_RATE_LIMIT' } });
  readJson(req, 4 * 1024).then(body => {
    if (Object.keys(body).length) return json(req, res, 400, { error: { message: 'BEICHEN_BAD_REQUEST' } });
    if (auth.error === 'BEICHEN_AUTH_REPLAY') {
      const requestId = String(req.headers['x-request-id'] || '').trim();
      const prior = auth.state.lastCompletion;
      if (!prior || prior.requestId !== requestId || prior.priorJti !== auth.payload.jti) {
        return json(req, res, 401, { error: { message: 'BEICHEN_AUTH_REPLAY' } });
      }
      return json(req, res, 200, prior.response);
    }
    return completeRun(req, res, auth);
  }).catch(error => json(req, res, error.status || 400, { error: { message: error.code || 'BEICHEN_BAD_JSON' } }));
}

/* ── 路由:对话转发 ─────────────────────────────────────────────── */
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
  try { url = new URL(config.url); } catch (_) { throw httpError(503, 'BEICHEN_PROVIDER_NOT_CONFIGURED'); }
  if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password) throw httpError(503, 'BEICHEN_PROVIDER_NOT_CONFIGURED');
  if (!QIANFAN_ALLOWED_HOSTS.has(url.hostname.toLowerCase()) || (url.port && url.port !== '443')) throw httpError(503, 'BEICHEN_QIANFAN_HOST_NOT_ALLOWED');
  let path = url.pathname.replace(/\/+$/, '');
  /* 只放行官方 Token Plan 个人版专属端点;coding 系地址一律拒绝 */
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
/* 思考档位:服务端固定 max;预算按轮型分档(星图轮更深,日常轮更快) */
function buildUpstreamBody(body, config) {
  const upstreamBody = Object.assign({}, body, { model: config.model });
  if (config.name === 'qianfan') {
    upstreamBody.thinking = { type: 'enabled' };
    upstreamBody.reasoning_effort = 'max';
    const reportScale = Number(body.max_tokens || 0) >= REPORT_SCALE_TOKENS;
    /* 星图轮预算独立可调：4096 仍是深思考档（日常轮 2048 的两倍），比 6144 缩短约
       三分之一等待；结构与格式质量由提示词契约保证，不受影响。两档都可覆盖。 */
    const budget = reportScale
      ? boundedInt(process.env.QIANFAN_REPORT_THINKING_BUDGET, 4096, 100, MAX_COMPLETION_TOKENS)
      : boundedInt(process.env.QIANFAN_THINKING_BUDGET, 2048, 100, MAX_COMPLETION_TOKENS);
    if (Number.isInteger(budget) && budget >= 100) upstreamBody.thinking_budget = budget;
  }
  delete upstreamBody.mode; /* mode 只用于统计,不透传上游 */
  return upstreamBody;
}
function proxyChat(req, res, auth, body, config) {
  const url = upstreamUrl(config);
  const payload = JSON.stringify(buildUpstreamBody(body, config));
  const upstream = https.request({
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
  }, upstreamResponse => {
    const status = Number(upstreamResponse.statusCode || 502);
    if (status < 200 || status >= 300) {
      let bytes = 0;
      upstreamResponse.on('data', chunk => { bytes += chunk.length; });
      upstreamResponse.on('end', () => {
        if (!res.headersSent) json(req, res, status >= 400 && status < 500 ? status : 502, { error: { message: 'BEICHEN_UPSTREAM_ERROR' } });
      });
      return;
    }
    const contentType = String(upstreamResponse.headers['content-type'] || '').toLowerCase();
    res.writeHead(status, securityHeaders(req, {
      'Content-Type': contentType.startsWith('text/event-stream') ? 'text/event-stream' : 'application/json; charset=utf-8',
      'X-Accel-Buffering': 'no'
    }));
    let bytes = 0;
    /* 背压:res 写不进时暂停读上游(响应流用 pause),等 drain 再续传;2MB 上限不因背压改变 */
    res.on('drain', () => upstreamResponse.resume());
    upstreamResponse.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_UPSTREAM_BYTES) { upstream.destroy(); res.destroy(); return; }
      if (!res.write(chunk)) upstreamResponse.pause();
    });
    upstreamResponse.on('end', () => res.end());
    upstreamResponse.on('error', () => res.destroy());
  });
  upstream.on('timeout', () => { upstream.destroy(); if (!res.headersSent) json(req, res, 504, { error: { message: 'BEICHEN_UPSTREAM_TIMEOUT' } }); else res.destroy(); });
  upstream.on('error', () => { if (!res.headersSent) json(req, res, 502, { error: { message: 'BEICHEN_UPSTREAM_ERROR' } }); else res.destroy(); });
  req.on('aborted', () => upstream.destroy());
  upstream.write(payload);
  upstream.end();
}
/* 额度纪律的服务端强制(纯函数,便于契约测试):
   1. 星图档请求(max_tokens≥REPORT_SCALE_TOKENS)在额度用尽后拒绝——否则记账可被
      "直接对 /chat 发星图提示词"整体绕过;
   2. 单会话终身轮数上限——聊天本身不限次,用总量兜底,防挂机脚本烧上游额度。 */
function enforceSessionQuota(auth, body) {
  if (Number(body.max_tokens) >= REPORT_SCALE_TOKENS && auth.state.runs >= MAX_RUNS) {
    throw httpError(409, 'BEICHEN_QUOTA_EXHAUSTED');
  }
  auth.state.turns = (Number(auth.state.turns) || 0) + 1;
  if (auth.state.turns > MAX_SESSION_TURNS) throw httpError(409, 'BEICHEN_SESSION_TURNS_EXHAUSTED');
}
function handleChat(req, res) {
  const auth = requireSession(req, res);
  if (!auth) return;
  if (!allowRate(requestLimits, 'chat:' + clientKey(req) + ':' + auth.payload.sid, 10, 60000)) return json(req, res, 429, { error: { message: 'BEICHEN_RATE_LIMIT' } });
  const config = providerConfig();
  if (!config) return json(req, res, 503, { error: { message: 'BEICHEN_PROVIDER_NOT_CONFIGURED' } });
  validateChatBodyAsync(req, res, config, auth);
}
function requireSession(req, res) {
  const auth = authenticate(req);
  if (auth.error) { json(req, res, auth.error === 'BEICHEN_AUTH_NOT_CONFIGURED' ? 503 : 401, { error: { message: auth.error } }); return null; }
  return auth;
}
function validateChatBodyAsync(req, res, config, auth) {
  readJson(req, MAX_BODY_BYTES).then(input => {
    const body = validateChatBody(input);
    if (auth) enforceSessionQuota(auth, body);
    return proxyChat(req, res, null, body, config);
  }).catch(error => json(req, res, error.status || 400, { error: { message: error.code || 'BEICHEN_BAD_REQUEST' } }));
}

/* ── HTTP 入口 ──────────────────────────────────────────────────── */
const https = require('https');
const server = http.createServer((req, res) => {
  handle(req, res).catch(error => {
    if (!res.headersSent) json(req, res, error.status || 500, { error: { message: error.code || 'BEICHEN_INTERNAL_ERROR' } });
    else res.destroy();
  });
});
async function handle(req, res) {
  if (!allowedOrigin(req)) return json(req, res, 403, { error: { message: 'BEICHEN_ORIGIN_NOT_ALLOWED' } });
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '');
  const supported = ['/verify', '/run/complete', '/chat/completions'];
  if (req.method === 'OPTIONS') {
    if (!supported.includes(path) || url.search || String(req.headers['access-control-request-method'] || '') !== 'POST') return text(req, res, 404, 'beichen relay');
    res.writeHead(204, securityHeaders(req));
    return res.end();
  }
  if (req.method === 'POST' && path === '/verify') return handleVerify(req, res);
  if (req.method === 'POST' && path === '/run/complete') return handleRunComplete(req, res);
  if (req.method === 'POST' && path === '/chat/completions') return handleChat(req, res);
  return text(req, res, 404, 'beichen relay');
}
server.headersTimeout = 20000;
server.requestTimeout = 20000;
if (!process.env.BEICHEN_NO_LISTEN) {
  /* SCF 平台不保证回环可用,必须显式绑定对外接口 */
  server.listen(Number(process.env.PORT || 9000), '0.0.0.0', () => console.log('beichen relay listening'));
}
/* 测试导出;生产环境永不设置 BEICHEN_NO_LISTEN */
if (typeof module !== 'undefined') {
  module.exports = { validateChatBody, buildUpstreamBody, upstreamUrl, enforceSessionQuota, pickClientIp, recordCompletion, maxPromptChars: MAX_PROMPT_CHARS, normMaxTokens: MAX_COMPLETION_TOKENS };
}
