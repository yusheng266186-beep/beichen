'use strict';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const test = require('node:test');

process.env.BEICHEN_NO_LISTEN = '1';
process.env.GATE_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
process.env.GATE_SESSION_SECRET = 'local-test-session-secret-that-is-long-enough';
process.env.QIANFAN_API_KEY = 'local-test-provider-key';
process.env.QIANFAN_MODEL = 'qianfan-code-latest';
process.env.QIANFAN_BASE_URL = 'https://qianfan.baidubce.com/v2/tokenplan/personal';
process.env.CORS_ALLOWED_ORIGINS = 'https://yusheng266186-beep.github.io';

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

test('现有页面协议下，普通轮回退、星图结算和重复提交都由服务端控制', async t => {
  const store = new relay.MemoryStateStore();
  await store.clear();
  relay.setStateStore(store);
  relay.setUpstreamRequester(async (req, res, body) => {
    if (body.messages[0].content === 'provider-fails') {
      const error = new Error('test upstream failure');
      error.code = 'BEICHEN_UPSTREAM_ERROR';
      error.status = 502;
      throw error;
    }
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
  });
  const server = relay.server;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  const verified = await request(port, '/verify', {body: {code: totp(Math.floor(Date.now() / 30000), process.env.GATE_TOTP_SECRET)}});
  assert.equal(verified.status, 200);
  let token = verified.body.token;
  const initial = tokenPayload(token);

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
  const store = new relay.MemoryStateStore();
  relay.setStateStore(store);
  const server = relay.server;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await request(port, '/healthz', {method: 'GET'});
  assert.equal(response.status, 200);
  assert.equal(response.body.version, relay.BACKEND_VERSION);
  assert.equal(response.body.stateStore, 'memory');
  assert.equal(response.body.providerConfigured, true);
  assert.doesNotMatch(response.raw, /local-test-session-secret/);
  assert.doesNotMatch(response.raw, /local-test-provider-key/);
});
