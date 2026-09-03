'use strict';

const assert = require('assert');
const test = require('node:test');
const { MemoryStateStore, RedisStateStore } = require('../state-store');

function session(now = Date.now()) {
  return {
    sid: 'a'.repeat(32),
    jti: 'b'.repeat(32),
    seq: 0,
    iat: now,
    exp: now + 3600000,
    runs: 0,
    turns: 0,
    report: { status: 'idle', attemptsUsed: 0, retries: 0 }
  };
}

test('并发日常请求最多占用会话总轮数，失败会退回', async () => {
  const store = new MemoryStateStore();
  await store.createSession(session());
  const options = { report: false, maxRuns: 3, maxTurns: 2, maxReportAttempts: 6, maxReportRetries: 2, leaseMs: 60000 };
  const reservations = await Promise.all(Array.from({length: 4}, () => store.startChat('a'.repeat(32), options)));
  assert.equal(reservations.filter(item => item.ok).length, 2);
  const first = reservations.find(item => item.ok);
  const second = reservations.find(item => item.ok && item.reservationId !== first.reservationId);
  await store.finishChat('a'.repeat(32), first.reservationId, false, false);
  await store.finishChat('a'.repeat(32), second.reservationId, true, false);
  const after = await store.getSession('a'.repeat(32));
  assert.equal(after.turns, 1);
  assert.equal(after.activeTurns, 0);
  const retry = await store.startChat('a'.repeat(32), options);
  assert.equal(retry.ok, true, 'released failed reservation can be used again');
});

test('报告先占名额，完成按 request id 幂等且不会被新票据重复结算', async () => {
  const store = new MemoryStateStore();
  await store.createSession(session());
  const options = { report: true, maxRuns: 3, maxTurns: 300, maxReportAttempts: 6, maxReportRetries: 2, leaseMs: 60000 };
  const reserved = await store.startChat('a'.repeat(32), options);
  assert.equal(reserved.ok, true);
  await store.finishChat('a'.repeat(32), reserved.reservationId, true, true);
  const ready = await store.getSession('a'.repeat(32));
  assert.equal(ready.report.status, 'ready');

  const response = { ok: true, token: 'next-token', runs: 1, remaining: 2, expiresIn: 3600000 };
  const first = await store.completeRun({
    sid: ready.sid,
    requestId: 'report-request-1',
    expected: { jti: ready.jti, seq: ready.seq, runs: ready.runs, exp: ready.exp },
    next: { jti: 'c'.repeat(32), seq: 1, runs: 1 },
    response,
    maxRuns: 3,
    receiptTtlMs: 3600000
  });
  assert.equal(first.replayed, false);
  assert.deepEqual(first.response, response);

  const replay = await store.getCompletion(ready.sid, 'report-request-1');
  assert.deepEqual(replay, response);
  const second = await store.completeRun({
    sid: ready.sid,
    requestId: 'report-request-1',
    expected: { jti: ready.jti, seq: ready.seq, runs: ready.runs, exp: ready.exp },
    next: { jti: 'd'.repeat(32), seq: 1, runs: 1 },
    response: { ok: true, token: 'must-not-replace', runs: 1 },
    maxRuns: 3,
    receiptTtlMs: 3600000
  });
  assert.equal(second.replayed, true);
  assert.deepEqual(second.response, response);
  const after = await store.getSession(ready.sid);
  assert.equal(after.runs, 1);
  assert.equal(after.report.status, 'idle');
});

test('报告修复失败保留已生成结果，首次失败则释放预占', async () => {
  const store = new MemoryStateStore();
  await store.createSession(session());
  const options = { report: true, maxRuns: 3, maxTurns: 300, maxReportAttempts: 6, maxReportRetries: 2, leaseMs: 60000 };
  const first = await store.startChat('a'.repeat(32), options);
  await store.finishChat('a'.repeat(32), first.reservationId, false, true);
  assert.equal((await store.getSession('a'.repeat(32))).report.status, 'idle');
  const second = await store.startChat('a'.repeat(32), options);
  await store.finishChat('a'.repeat(32), second.reservationId, true, true);
  const repair = await store.startChat('a'.repeat(32), options);
  assert.equal(repair.attempt, 'repair');
  await store.finishChat('a'.repeat(32), repair.reservationId, false, true);
  const preserved = await store.getSession('a'.repeat(32));
  assert.equal(preserved.report.status, 'ready');
  assert.equal(preserved.runs, 0, 'provider failures never spend a completed run');
});

test('进程崩溃留下的过期普通租约按保守方式结算一次', async () => {
  let now = 1000000;
  const store = new MemoryStateStore({now: () => now});
  const record = session(now);
  record.exp = now + 100000;
  await store.createSession(record);
  const options = { report: false, maxRuns: 3, maxTurns: 2, maxReportAttempts: 6, maxReportRetries: 2, leaseMs: 1000 };
  const reservation = await store.startChat(record.sid, options);
  now += 1001;
  const after = await store.getSession(record.sid);
  assert.equal(after.turns, 1);
  assert.equal(after.activeTurns, 0);
  const next = await store.startChat(record.sid, options);
  assert.equal(next.ok, true, 'expired lease is removed after its conservative settlement');
  await store.finishChat(record.sid, next.reservationId, false, false);
  assert.ok(reservation.reservationId);
});

test('Redis 实现通过同一套并发与幂等检查', {skip: !process.env.STATE_STORE_TEST}, async t => {
  const prefix = `beichen:test:${process.pid}:${Date.now()}`;
  const store = new RedisStateStore({prefix});
  t.after(async () => {
    await store.clear().catch(() => {});
    await store.close();
  });
  assert.equal(await store.ping(), true);
  const sid = 'e'.repeat(31) + '1';
  const readySession = session();
  readySession.sid = sid;
  readySession.exp = Date.now() + 3600000;
  await store.createSession(readySession);
  const options = { report: false, maxRuns: 3, maxTurns: 2, maxReportAttempts: 6, maxReportRetries: 2, leaseMs: 60000 };
  const reservations = await Promise.all(Array.from({length: 4}, () => store.startChat(sid, options)));
  assert.equal(reservations.filter(item => item.ok).length, 2);
  const successful = reservations.filter(item => item.ok);
  await store.finishChat(sid, successful[0].reservationId, false, false);
  await store.finishChat(sid, successful[1].reservationId, true, false);
  assert.equal((await store.getSession(sid)).turns, 1);

  const reportOptions = Object.assign({}, options, {report: true, maxTurns: 300});
  const report = await store.startChat(sid, reportOptions);
  await store.finishChat(sid, report.reservationId, true, true);
  const current = await store.getSession(sid);
  const response = {ok: true, token: 'redis-token', runs: 1, remaining: 2, expiresIn: 3600000};
  const input = {
    sid,
    requestId: 'redis-request-1',
    expected: {jti: current.jti, seq: current.seq, runs: current.runs, exp: current.exp},
    next: {jti: 'f'.repeat(32), seq: current.seq + 1, runs: current.runs + 1},
    response,
    maxRuns: 3,
    receiptTtlMs: 3600000
  };
  const first = await store.completeRun(input);
  const second = await store.completeRun(Object.assign({}, input, {response: {ok: true, token: 'different'}}));
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.response, response);
});
