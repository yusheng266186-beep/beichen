'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const test = require('node:test');
const { RedisStateStore } = require('../state-store');

process.env.BEICHEN_NO_LISTEN = '1';
process.env.GATE_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
process.env.GATE_SESSION_SECRET = 'test-session-signing-secret-32-bytes-long';
process.env.STATE_STORE = 'memory';
const relay = require('../scf-relay');

// Independent fixture for the standard 30s Google code, with a fixed test seed.
const secret = Buffer.from('48656c6c6f21deadbeef', 'hex');
function codeFor(counter) {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', secret).update(counterBytes).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

test('Google 的 30 秒码可跨三个换码边界，100 秒整立即失效', () => {
  const counter = 59000000, start = counter * 30000, code = codeFor(counter);
  for (const age of [0, 29999, 30000, 59999, 60000, 89999, 90000, 99999]) {
    assert.equal(relay.matchingTotpCounter(code, start + age), counter, 'age ' + age);
  }
  assert.equal(relay.matchingTotpCounter(code, start + 100000), null);
  assert.equal(relay.matchingTotpCounter(code, start + 120000), null);
});

test('有效期固定从生成起点算，不按收到或验证时间重新延长', () => {
  const counter = 59000000, start = counter * 30000, code = codeFor(counter);
  assert.equal(relay.matchingTotpCounter(code, start - 1), null, 'not-yet-generated code');
  assert.equal(relay.matchingTotpCounter(codeFor(counter + 1), start + 15000), null, 'future code');
  assert.equal(relay.matchingTotpCounter(code, start + 95000), counter);
  assert.equal(relay.matchingTotpCounter(code, start + 100001), null);
  for (const value of ['12345', '1234567', 'abcdef', '', null]) {
    assert.equal(relay.matchingTotpCounter(value, start), null);
  }
});

test('每30秒的前10秒最多4组有效，之后回落到3组', () => {
  const counter = 59000000, start = counter * 30000;
  for (const age of [90000, 99999]) {
    for (let offset = 0; offset <= 3; offset++) {
      assert.equal(relay.matchingTotpCounter(codeFor(counter + offset), start + age), counter + offset);
    }
  }
  assert.equal(relay.matchingTotpCounter(codeFor(counter), start + 100000), null);
  for (let offset = 1; offset <= 3; offset++) {
    assert.equal(relay.matchingTotpCounter(codeFor(counter + offset), start + 100000), counter + offset);
  }
});

function post(port, code) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ code });
    const req = http.request({ port, path: '/verify', method: 'POST', headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)
    } }, res => {
      let raw = ''; res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('延长后的码仍原子单次消费，跨换码重放与100秒过期均被拒绝', async t => {
  const originalNow = Date.now, counter = 59000000, start = counter * 30000;
  let now = start + 35000;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  const store = new relay.MemoryStateStore({ now: () => now });
  relay.setStateStore(store);
  let ttl;
  const originalConsume = store.consumeTotp.bind(store);
  store.consumeTotp = (key, ms) => { ttl = ms; return originalConsume(key, ms); };
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => relay.server.close(resolve)));
  const port = relay.server.address().port, code = codeFor(counter);
  const responses = await Promise.all([post(port, code), post(port, code)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 401]);
  const successful = responses.find(r => r.status === 200);
  assert.equal(successful.body.maxRuns, 3);
  assert.equal(successful.body.expiresIn, 7 * 24 * 60 * 60 * 1000);
  assert.ok(ttl >= 100000, 'replay marker covers the full code life');
  now = start + 99000;
  const replay = await post(port, code);
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error.message, 'BEICHEN_AUTH_REPLAY');
  now = start + 100000;
  const expired = await post(port, code);
  assert.equal(expired.status, 401);
  assert.equal(expired.body.error.message, 'BEICHEN_AUTH_INVALID_CODE');
});

test('真实Redis下60至90秒旧码可验证，并发仅一次成功且重放/过期被拒绝', { skip: !process.env.STATE_STORE_TEST }, async t => {
  const store = new RedisStateStore({ prefix: `beichen:test:totp:${process.pid}:${Date.now()}` });
  relay.setStateStore(store);
  t.after(async () => { await store.clear(); await store.close(); });
  assert.equal(await store.ping(), true);
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => relay.server.close(resolve)));
  const port = relay.server.address().port, counter = Math.floor(Date.now() / 30000) - 2;
  const code = codeFor(counter);
  const responses = await Promise.all([post(port, code), post(port, code)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 401]);
  const successful = responses.find(r => r.status === 200);
  assert.equal(successful.body.maxRuns, 3);
  assert.equal(successful.body.expiresIn, 7 * 24 * 60 * 60 * 1000);
  const replay = await post(port, code);
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error.message, 'BEICHEN_AUTH_REPLAY');
  const expired = await post(port, codeFor(counter - 2));
  assert.equal(expired.status, 401);
  assert.equal(expired.body.error.message, 'BEICHEN_AUTH_INVALID_CODE');
});
