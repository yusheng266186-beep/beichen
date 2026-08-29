// 北辰 · OpenCode Go 中转（腾讯云函数 Web 函数版）
// 监听 9000 端口；零依赖，原生 Node.js。
// 所有密钥都必须通过腾讯云环境变量注入，不要写回本文件。

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const GO_KEY = process.env.OPENCODE_API_KEY || '';
const GATE_TOTP_SECRET = process.env.GATE_TOTP_SECRET || '';
const GATE_SESSION_SECRET = process.env.GATE_SESSION_SECRET || '';
const UPSTREAM = 'https://opencode.ai/zen/go/v1/chat/completions';
const MODEL = 'deepseek-v4-flash';
const GATE_MAX_RUNS = 3;
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Max-Age': '86400'
};

const attempts = new Map();
const sessions = new Map();

function json(res, status, payload) {
  res.writeHead(status, Object.assign({}, CORS, {'Content-Type': 'application/json'}));
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (_) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function b64url(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromB64url(value) {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function signToken(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', GATE_SESSION_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifyToken(token) {
  if (!GATE_SESSION_SECRET || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', GATE_SESSION_SECRET).update(parts[0]).digest('base64url');
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(fromB64url(parts[0]).toString('utf8'));
    if (!payload.sid || !payload.exp || payload.exp <= Date.now()) return null;
    if (!Number.isInteger(payload.runs) || payload.runs < 0 || payload.runs > GATE_MAX_RUNS) return null;
    const current = sessions.get(payload.sid);
    if (current && current.exp <= Date.now()) return null;
    /* 同一验证可能同时打开多个页面；若另一请求已推进额度，
       采用服务端较新的计数，不把仍然有效的签名令牌误判为失效。 */
    if (current && current.runs !== payload.runs) return {...payload, runs: Math.max(current.runs, payload.runs)};
    return payload;
  } catch (_) { return null; }
}

function authToken(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

function newToken(runs, sid) {
  const now = Date.now();
  sid = sid || crypto.randomBytes(16).toString('hex');
  sessions.set(sid, {runs, exp: now + TOKEN_TTL_MS});
  return signToken({
    v: 1,
    sid,
    iat: now,
    exp: now + TOKEN_TTL_MS,
    runs
  });
}

function base32Decode(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let buffer = 0;
  const out = [];
  for (const ch of String(value).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    buffer = (buffer << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpCode(counter) {
  const msg = Buffer.alloc(8);
  let value = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = value & 0xff; value = Math.floor(value / 256); }
  const digest = crypto.createHmac('sha1', base32Decode(GATE_TOTP_SECRET)).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const number = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(number % 1000000).padStart(6, '0');
}

function validTotp(code) {
  if (!/^\d{6}$/.test(code) || !GATE_TOTP_SECRET) return false;
  const counter = Math.floor(Date.now() / 30000);
  return [counter - 1, counter, counter + 1].some(item => totpCode(item) === code);
}

function allowedAttempt(req) {
  const key = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const item = attempts.get(key) || {start: now, count: 0};
  if (now - item.start > 60 * 1000) { item.start = now; item.count = 0; }
  item.count += 1;
  attempts.set(key, item);
  return item.count <= 8;
}

function requireSession(req, res) {
  const payload = verifyToken(authToken(req));
  if (!payload) {
    json(res, 401, {error: {message: 'BEICHEN_AUTH_REQUIRED'}});
    return null;
  }
  return payload;
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  if (req.method === 'POST' && req.url === '/verify') {
    if (!GATE_TOTP_SECRET || !GATE_SESSION_SECRET) return json(res, 503, {error: {message: 'BEICHEN_AUTH_NOT_CONFIGURED'}});
    if (!allowedAttempt(req)) return json(res, 429, {error: {message: 'BEICHEN_AUTH_RATE_LIMIT'}});
    try {
      const body = await readBody(req);
      if (!validTotp(String(body.code || ''))) return json(res, 401, {error: {message: 'BEICHEN_AUTH_INVALID_CODE'}});
      return json(res, 200, {ok: true, token: newToken(0), runs: 0, maxRuns: GATE_MAX_RUNS, expiresIn: TOKEN_TTL_MS});
    } catch (error) {
      return json(res, 400, {error: {message: error.message || 'bad json'}});
    }
  }

  if (req.method === 'POST' && req.url === '/run/complete') {
    const session = requireSession(req, res);
    if (!session) return;
    if (session.runs >= GATE_MAX_RUNS) return json(res, 429, {error: {message: 'BEICHEN_AUTH_QUOTA_EXCEEDED'}});
    const runs = session.runs + 1;
    return json(res, 200, {ok: true, token: newToken(runs, session.sid), runs, remaining: GATE_MAX_RUNS - runs});
  }

  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
    res.writeHead(404, CORS);
    return res.end('beichen relay');
  }
  if (!GO_KEY) return json(res, 503, {error: {message: 'BEICHEN_RELAY_NOT_CONFIGURED'}});
  if (!requireSession(req, res)) return;

  let body;
  try {
    body = await readBody(req);
    body.model = MODEL;
  } catch (error) {
    return json(res, 400, {error: {message: error.message || 'bad json'}});
  }

  const upstreamUrl = new URL(UPSTREAM);
  const upstream = https.request({
    hostname: upstreamUrl.hostname,
    path: upstreamUrl.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + GO_KEY
    }
  }, upstreamResponse => {
    const headers = Object.assign({}, CORS, {
      'Content-Type': upstreamResponse.headers['content-type'] || 'application/json'
    });
    res.writeHead(upstreamResponse.statusCode, headers);
    upstreamResponse.pipe(res);
  });

  upstream.on('error', error => {
    if (!res.headersSent) res.writeHead(502, CORS);
    res.end('relay error: ' + error.message);
  });
  upstream.end(JSON.stringify(body));
}

http.createServer((req, res) => {
  handle(req, res).catch(error => {
    if (!res.headersSent) res.writeHead(500, CORS);
    res.end('relay error: ' + error.message);
  });
}).listen(9000, () => console.log('beichen relay listening on 9000'));
