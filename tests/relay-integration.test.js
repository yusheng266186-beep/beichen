'use strict';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { EventEmitter } = require('events');
const test = require('node:test');

process.env.BEICHEN_NO_LISTEN = '1';
process.env.GATE_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
process.env.GATE_SESSION_SECRET = 'local-test-session-secret-that-is-long-enough';
process.env.QIANFAN_API_KEY = 'local-test-provider-key';
process.env.QIANFAN_MODEL = 'qianfan-code-latest';
process.env.QIANFAN_BASE_URL = 'https://qianfan.baidubce.com/v2/tokenplan/personal';
process.env.CORS_ALLOWED_ORIGINS = 'https://yusheng266186-beep.github.io';
process.env.SSE_HEARTBEAT_MS = '1000';

const relay = require('../scf-relay.js');

function totp(counter, secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let buffer = 0;
  const bytes = [];
  for (const ch of secret) {
    buffer = (buffer << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const message = Buffer.alloc(8);
  let value = counter;
  for (let i = 7; i >= 0; i--) {
    message[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  const digest = crypto.createHmac('sha1', Buffer.from(bytes)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const number = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(number % 1000000).padStart(6, '0');
}

function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers = Object.assign({}, options.headers || {});
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const req = http.request({ port, path, method: options.method || 'POST', headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = raw;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (_) {}
        resolve({status: res.statusCode, headers: res.headers, raw, body: parsed});
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function tokenPayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
}

/* 假上游:与 proxyChat 期望的 node https.request 同构——(options, callback) → request。
   end() 后按参数回放一条 SSE 响应;failOn(请求体文本) 命中时以 error 事件失败,
   让 proxyChat 的心跳/背压/内容类型等真实转发逻辑全链路得到覆盖。 */
function makeUpstreamRequester({ delayMs = 0, contentType = 'text/event-stream', payload = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', failOn = null } = {}) {
  return function fakeRequester(requestOptions, callback) {
    const written = [];
    const req = new EventEmitter();
    req.destroyed = false;
    req.write = chunk => { written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true; };
    req.end = () => {
      setImmediate(() => {
        if (req.destroyed) return;
        const bodyText = Buffer.concat(written).toString('utf8');
        if (failOn && failOn(bodyText)) { req.emit('error', new Error('test upstream failure')); return; }
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = { 'content-type': contentType };
        res.pause = () => {};
        res.resume = () => {};
        res.destroy = () => {};
        callback(res);
        const send = () => {
          if (req.destroyed) return;
          res.emit('data', Buffer.from(payload));
          res.emit('end');
        };
        if (delayMs > 0) setTimeout(send, delayMs); else send();
      });
    };
    req.destroy = () => { req.destroyed = true; };
    req.setTimeout = () => req;
    return req;
  };
}

async function captureLogs(fn) {
  const logs = [];
  const original = console.log;
  console.log = (...parts) => logs.push(parts.join(' '));
  try { return { result: await fn(), logs }; }
  finally { console.log = original; }
}

function freshStore() {
  const store = new relay.MemoryStateStore();
  relay.setStateStore(store);
  return store;
}

async function listen() {
  const server = relay.server;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { port, close: () => new Promise(resolve => server.close(resolve)) };
}

test('现有页面协议下，普通轮回退、星图结算和重复提交都由服务端控制', async t => {
  const store = freshStore();
  relay.setUpstreamRequester(makeUpstreamRequester({ failOn: bodyText => bodyText.includes('provider-fails') }));
  const { port, close } = await listen();
  t.after(close);

  const verified = await request(port, '/verify', {body: {code: totp(Math.floor(Date.now() / 30000), process.env.GATE_TOTP_SECRET)}});
  assert.equal(verified.status, 200);
  let token = verified.body.token;
  const initial = tokenPayload(token);

  /* v2.8.1:同窗口重放与"码错误"区分——重放返回 BEICHEN_AUTH_REPLAY */
  const replay = await request(port, '/verify', {body: {code: totp(Math.floor(Date.now() / 30000), process.env.GATE_TOTP_SECRET)}});
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error.message, 'BEICHEN_AUTH_REPLAY');

  const normal = await request(port, '/chat/completions', {
    headers: {authorization: 'Bearer ' + token},
    body: {messages: [{role: 'user', content: 'hello'}], max_tokens: 3500, stream: true}
  });
  assert.equal(normal.status, 200);
  assert.match(normal.raw, /\[DONE\]/);
  assert.equal((await store.getSession(initial.sid)).turns, 1);

  const failedNormal = await request(port, '/chat/completions', {
    headers: {authorization: 'Bearer ' + token},
    body: {messages: [{role: 'user', content: 'provider-fails'}], max_tokens: 3500, stream: true}
  });
  assert.equal(failedNormal.status, 502);
  assert.equal((await store.getSession(initial.sid)).turns, 1, 'failed stream does not consume a turn');

  const beforeReport = await request(port, '/run/complete', {
    headers: {authorization: 'Bearer ' + token, 'x-request-id': 'not-ready-001'},
    body: {}
  });
  assert.equal(beforeReport.status, 409);
  assert.equal(beforeReport.body.error.message, 'BEICHEN_REPORT_NOT_READY');

  const report = await request(port, '/chat/completions', {
    headers: {authorization: 'Bearer ' + token},
    body: {messages: [{role: 'user', content: 'report'}], max_tokens: 16384, stream: true}
  });
  assert.equal(report.status, 200);
  assert.equal((await store.getSession(initial.sid)).report.status, 'ready');

  const requestId = 'report-request-001';
  const completed = await request(port, '/run/complete', {
    headers: {authorization: 'Bearer ' + token, 'x-request-id': requestId},
    body: {}
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.runs, 1);
  token = completed.body.token;

  const oldTokenRetry = await request(port, '/run/complete', {
    headers: {authorization: 'Bearer ' + verified.body.token, 'x-request-id': requestId},
    body: {}
  });
  assert.equal(oldTokenRetry.status, 200);
  assert.deepEqual(oldTokenRetry.body, completed.body);

  const newTokenRetry = await request(port, '/run/complete', {
    headers: {authorization: 'Bearer ' + token, 'x-request-id': requestId},
    body: {}
  });
  assert.equal(newTokenRetry.status, 200);
  assert.deepEqual(newTokenRetry.body, completed.body);
  assert.equal((await store.getSession(initial.sid)).runs, 1, 'same request id cannot double charge');

  const staleChat = await request(port, '/chat/completions', {
    headers: {authorization: 'Bearer ' + verified.body.token},
    body: {messages: [{role: 'user', content: 'stale'}], max_tokens: 3500, stream: true}
  });
  assert.equal(staleChat.status, 401, 'rotated token cannot start another request');

  const unearned = await request(port, '/run/complete', {
    headers: {authorization: 'Bearer ' + token, 'x-request-id': 'different-request-01'},
    body: {}
  });
  assert.equal(unearned.status, 409);
  assert.equal(unearned.body.error.message, 'BEICHEN_REPORT_NOT_READY');
  assert.equal((await store.getSession(initial.sid)).runs, 1);
});

test('健康检查能区分存储可用性，但不返回任何秘钥内容', async t => {
  freshStore();
  const { port, close } = await listen();
  t.after(close);
  const response = await request(port, '/healthz', {method: 'GET'});
  assert.equal(response.status, 200);
  assert.equal(response.body.version, relay.BACKEND_VERSION);
  assert.equal(response.body.frontendVersion, relay.FRONTEND_VERSION);
  assert.equal(response.body.stateStore, 'memory');
  assert.equal(response.body.providerConfigured, true);
  assert.doesNotMatch(response.raw, /local-test-session-secret/);
  assert.doesNotMatch(response.raw, /local-test-provider-key/);

  const ready = await request(port, '/readyz', {method: 'GET'});
  assert.equal(ready.status, 200);
  assert.equal(ready.body.ready, true);
  assert.equal(ready.body.stateStoreReachable, true);
  assert.equal(ready.body.providerConfigured, true);
  assert.doesNotMatch(ready.raw, /local-test-session-secret/);
  assert.doesNotMatch(ready.raw, /local-test-provider-key/);
});

test('安静的长流会发出 SSE 心跳注释行', async t => {
  freshStore();
  relay.setUpstreamRequester(makeUpstreamRequester({ delayMs: 1500 }));
  const { port, close } = await listen();
  t.after(close);
  const verified = await request(port, '/verify', {body: {code: totp(Math.floor(Date.now() / 30000), process.env.GATE_TOTP_SECRET)}});
  assert.equal(verified.status, 200);
  const stream = await request(port, '/chat/completions', {
    headers: {authorization: 'Bearer ' + verified.body.token},
    body: {messages: [{role: 'user', content: 'slow'}], max_tokens: 3500, stream: true}
  });
  assert.equal(stream.status, 200);
  assert.match(stream.raw, /: ping\n\n/, 'quiet stream emits heartbeat comments');
  assert.match(stream.raw, /\[DONE\]/);
});

test('上游返回非流式内容类型时按上游错误处理且不消耗轮次', async t => {
  const store = freshStore();
  relay.setUpstreamRequester(makeUpstreamRequester({ contentType: 'text/html' }));
  const { port, close } = await listen();
  t.after(close);
  const verified = await request(port, '/verify', {body: {code: totp(Math.floor(Date.now() / 30000), process.env.GATE_TOTP_SECRET)}});
  assert.equal(verified.status, 200);
  const sid = tokenPayload(verified.body.token).sid;
  const bad = await request(port, '/chat/completions', {
    headers: {authorization: 'Bearer ' + verified.body.token},
    body: {messages: [{role: 'user', content: 'html'}], max_tokens: 3500, stream: true}
  });
  assert.equal(bad.status, 502);
  assert.equal(bad.body.error.message, 'BEICHEN_UPSTREAM_ERROR');
  const after = await store.getSession(sid);
  assert.equal(after.turns, 0, 'failed stream must not consume a turn');
});

test('验证拒绝与成功都记录脱敏事件日志', async t => {
  freshStore();
  relay.setUpstreamRequester(makeUpstreamRequester());
  const { port, close } = await listen();
  t.after(close);

  const denied = await captureLogs(() => request(port, '/verify', {body: {code: '000000'}}));
  assert.equal(denied.result.status, 401);
  const deniedLine = denied.logs.find(l => l.includes('"ev":"verify_denied"'));
  assert.ok(deniedLine, 'verify_denied event must be logged');
  const deniedParsed = JSON.parse(deniedLine);
  assert.equal(deniedParsed.ev, 'verify_denied');
  assert.deepEqual(Object.keys(deniedParsed).sort(), ['ev', 't'], 'denied event carries no payload fields');

  const ok = await captureLogs(() => request(port, '/verify', {body: {code: totp(Math.floor(Date.now() / 30000), process.env.GATE_TOTP_SECRET)}}));
  assert.equal(ok.result.status, 200);
  const okLine = ok.logs.find(l => l.includes('"ev":"verify_ok"'));
  assert.ok(okLine, 'verify_ok event must be logged');
  assert.deepEqual(Object.keys(JSON.parse(okLine)).sort(), ['ev', 't']);
});
