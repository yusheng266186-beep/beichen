/*
 * 北辰 · OpenCode Go 中转 Worker
 *
 * 部署前在 Variables and Secrets 中添加三个加密 Secret：
 *   OPENCODE_API_KEY、GATE_TOTP_SECRET、GATE_SESSION_SECRET
 * 前端通过 /verify 获取短期 Token，/chat/completions 和 /run/complete 都会校验 Token。
 */

const UPSTREAM = 'https://opencode.ai/zen/go/v1/chat/completions';
const MODEL = 'deepseek-v4-flash';
const MAX_RUNS = 3;
const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000;
const enc = new TextEncoder();
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Max-Age': '86400',
};
const attempts = new Map();
const sessions = new Map();

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {'Content-Type': 'application/json', ...CORS, ...(init.headers || {})},
  });
}

function b64urlBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlText(text) { return b64urlBytes(enc.encode(text)); }

function fromB64url(text) {
  const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
  return Uint8Array.from(raw, ch => ch.charCodeAt(0));
}

async function hmac(secret, text, hash = 'SHA-256') {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name: 'HMAC', hash}, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

async function signToken(payload, secret) {
  const body = b64urlText(JSON.stringify(payload));
  return body + '.' + b64urlBytes(await hmac(secret, body));
}

async function verifyToken(token, secret) {
  if (!secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = b64urlBytes(await hmac(secret, parts[0]));
  if (expected !== parts[1]) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    if (!payload.sid || !payload.exp || payload.exp <= Date.now()) return null;
    if (!Number.isInteger(payload.runs) || payload.runs < 0 || payload.runs > MAX_RUNS) return null;
    const current = sessions.get(payload.sid);
    if (current && current.exp <= Date.now()) return null;
    /* 同一验证可能同时打开多个页面；若另一请求已推进额度，
       采用服务端较新的计数，不把仍然有效的签名令牌误判为失效。 */
    if (current && current.runs !== payload.runs) return {...payload, runs: Math.max(current.runs, payload.runs)};
    return payload;
  } catch (_) { return null; }
}

function base32Decode(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, buffer = 0;
  const out = [];
  for (const ch of String(value).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    buffer = (buffer << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((buffer >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

async function totpCode(counter, secret) {
  const msg = new Uint8Array(8);
  let value = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = value & 255; value = Math.floor(value / 256); }
  const key = await crypto.subtle.importKey('raw', base32Decode(secret), {name: 'HMAC', hash: 'SHA-1'}, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const offset = digest[digest.length - 1] & 15;
  const number = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(number % 1000000).padStart(6, '0');
}

async function validTotp(code, secret) {
  if (!/^\d{6}$/.test(code) || !secret) return false;
  const counter = Math.floor(Date.now() / 30000);
  return (await Promise.all([counter - 1, counter, counter + 1].map(c => totpCode(c, secret)))).includes(code);
}

function allowedAttempt(request) {
  const key = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  const item = attempts.get(key) || {start: now, count: 0};
  if (now - item.start > 60000) { item.start = now; item.count = 0; }
  item.count += 1;
  attempts.set(key, item);
  return item.count <= 8;
}

async function newToken(secret, runs, sid) {
  const now = Date.now();
  sid = sid || crypto.randomUUID();
  sessions.set(sid, {runs, exp: now + TOKEN_TTL});
  return signToken({v: 1, sid, iat: now, exp: now + TOKEN_TTL, runs}, secret);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: CORS});
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/verify') {
      if (!env.GATE_TOTP_SECRET || !env.GATE_SESSION_SECRET) return json({error: {message: 'BEICHEN_AUTH_NOT_CONFIGURED'}}, {status: 503});
      if (!allowedAttempt(request)) return json({error: {message: 'BEICHEN_AUTH_RATE_LIMIT'}}, {status: 429});
      let body;
      try { body = await request.json(); } catch (_) { return json({error: {message: 'bad json'}}, {status: 400}); }
      if (!await validTotp(String(body.code || ''), env.GATE_TOTP_SECRET)) return json({error: {message: 'BEICHEN_AUTH_INVALID_CODE'}}, {status: 401});
      return json({ok: true, token: await newToken(env.GATE_SESSION_SECRET, 0), runs: 0, maxRuns: MAX_RUNS, expiresIn: TOKEN_TTL});
    }

    const auth = request.headers.get('Authorization') || '';
    const session = await verifyToken(auth.startsWith('Bearer ') ? auth.slice(7).trim() : '', env.GATE_SESSION_SECRET);
    if (!session) return json({error: {message: 'BEICHEN_AUTH_REQUIRED'}}, {status: 401});

    if (request.method === 'POST' && url.pathname === '/run/complete') {
      if (session.runs >= MAX_RUNS) return json({error: {message: 'BEICHEN_AUTH_QUOTA_EXCEEDED'}}, {status: 429});
      const runs = session.runs + 1;
      return json({ok: true, token: await newToken(env.GATE_SESSION_SECRET, runs, session.sid), runs, remaining: MAX_RUNS - runs});
    }

    if (request.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) return new Response('beichen relay', {status: 404, headers: CORS});
    if (!env.OPENCODE_API_KEY) return json({error: {message: 'BEICHEN_RELAY_NOT_CONFIGURED'}}, {status: 503});
    let body;
    try { body = await request.json(); } catch (_) { return json({error: {message: 'bad json'}}, {status: 400}); }
    body.model = MODEL;
    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.OPENCODE_API_KEY},
      body: JSON.stringify(body),
    });
    const response = new Response(upstream.body, upstream);
    for (const [key, value] of Object.entries(CORS)) response.headers.set(key, value);
    return response;
  },
};
