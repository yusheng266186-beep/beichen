'use strict';

/*
 * 北辰共享状态层。
 *
 * 生产环境只允许使用 Redis（或兼容 Redis 协议的托管服务）。内存实现
 * 只给本地契约测试使用，且由 BEICHEN_NO_LISTEN/STATE_STORE=memory 显式选中。
 * 额度、TOTP、防重放和正在进行的上游请求不能依赖某一个函数实例。
 */
const crypto = require('crypto');

const DEFAULT_REDIS_PREFIX = 'beichen:v27';
const COMPLETION_LIMIT = 16;

class StateStoreUnavailableError extends Error {
  constructor(cause) {
    super('BEICHEN_STATE_STORE_UNAVAILABLE');
    this.name = 'StateStoreUnavailableError';
    this.code = 'BEICHEN_STATE_STORE_UNAVAILABLE';
    this.cause = cause;
  }
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function id() {
  return crypto.randomBytes(16).toString('hex');
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function emptyReport() {
  return {
    id: null,
    status: 'idle',
    attemptsUsed: 0,
    retries: 0,
    startedAt: 0,
    readyAt: 0,
    leaseExp: 0
  };
}

function normalizeReport(input) {
  const report = Object.assign(emptyReport(), input || {});
  if (!['idle', 'running', 'repairing', 'ready'].includes(report.status)) report.status = 'idle';
  report.id = report.id || null;
  for (const key of ['attemptsUsed', 'retries', 'startedAt', 'readyAt', 'leaseExp']) report[key] = number(report[key]);
  return report;
}

function normalizeSession(input) {
  const session = Object.assign({
    schema: 1,
    sid: '',
    jti: '',
    seq: 0,
    iat: 0,
    exp: 0,
    runs: 0,
    turns: 0,
    report: emptyReport()
  }, clone(input) || {});
  session.schema = 1;
  session.seq = number(session.seq);
  session.iat = number(session.iat);
  session.exp = number(session.exp);
  session.runs = number(session.runs);
  session.turns = number(session.turns);
  session.report = normalizeReport(session.report);
  return session;
}

function sessionView(session, activeTurns = 0) {
  if (!session) return null;
  const view = normalizeSession(session);
  view.activeTurns = activeTurns;
  return view;
}

class KeyLock {
  constructor() {
    this.tails = new Map();
  }

  async run(key, fn) {
    const previous = this.tails.get(key) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    this.tails.set(key, current);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}

class MemoryStateStore {
  constructor(options = {}) {
    this.name = 'memory';
    this.kind = 'memory';
    this.now = options.now || (() => Date.now());
    this.sessions = new Map();
    this.turns = new Map();
    this.rates = new Map();
    this.totp = new Map();
    this.completions = new Map();
    this.lock = new KeyLock();
  }

  async ping() {
    return true;
  }

  async close() {}

  async clear() {
    this.sessions.clear();
    this.turns.clear();
    this.rates.clear();
    this.totp.clear();
    this.completions.clear();
  }

  _reap(sid, now = this.now()) {
    const session = this.sessions.get(sid);
    if (!session) return null;
    if (session.exp <= now) {
      this.sessions.delete(sid);
      this.turns.delete(sid);
      this.completions.delete(sid);
      return null;
    }

    const active = this.turns.get(sid);
    if (active) {
      for (const [reservationId, reservation] of active) {
        if (reservation.exp <= now) {
          /* 进程在请求结束前崩溃时无法知道上游结果，过期租约按已占用处理，避免成功流被白送。 */
          session.turns += 1;
          active.delete(reservationId);
        }
      }
      if (!active.size) this.turns.delete(sid);
    }

    const report = session.report;
    if ((report.status === 'running' || report.status === 'repairing') && report.leaseExp <= now) {
      if (report.status === 'repairing') {
        report.status = 'ready';
        report.startedAt = 0;
        report.leaseExp = 0;
      } else {
        session.report = Object.assign(emptyReport(), { attemptsUsed: report.attemptsUsed });
      }
    }
    const receipts = this.completions.get(sid);
    if (receipts) {
      for (const [requestId, receipt] of receipts) {
        if (receipt.exp <= now) receipts.delete(requestId);
      }
      if (!receipts.size) this.completions.delete(sid);
    }
    return session;
  }

  async consumeRate(key, limit, windowMs) {
    return this.lock.run('rate:' + key, async () => {
      const now = this.now();
      const current = this.rates.get(key);
      if (!current || current.exp <= now) {
        this.rates.set(key, { count: 1, exp: now + windowMs });
        return true;
      }
      if (current.count >= limit) return false;
      current.count += 1;
      return true;
    });
  }

  async consumeTotp(key, ttlMs) {
    return this.lock.run('totp:' + key, async () => {
      const now = this.now();
      const exp = this.totp.get(key);
      if (exp && exp > now) return false;
      this.totp.set(key, now + ttlMs);
      return true;
    });
  }

  async createSession(input) {
    const session = normalizeSession(input);
    this.sessions.set(session.sid, session);
    this.turns.delete(session.sid);
    this.completions.delete(session.sid);
    return sessionView(session, 0);
  }

  async getSession(sid) {
    const session = this._reap(sid);
    if (!session) return null;
    return sessionView(session, this.turns.get(sid)?.size || 0);
  }

  async getCompletion(sid, requestId) {
    const session = this._reap(sid);
    const receipts = this.completions.get(sid);
    const receipt = receipts && receipts.get(requestId);
    if (!receipt || (session && receipt.exp > this.now())) return receipt ? clone(receipt.response) : null;
    if (receipts) receipts.delete(requestId);
    return null;
  }

  async startChat(sid, options) {
    return this.lock.run('session:' + sid, async () => {
      const now = this.now();
      const session = this._reap(sid, now);
      if (!session) return { ok: false, code: 'BEICHEN_AUTH_EXPIRED' };
      if (options.expected && (session.jti !== options.expected.jti || session.seq !== options.expected.seq || session.runs !== options.expected.runs)) {
        return { ok: false, code: 'BEICHEN_AUTH_REPLAY' };
      }

      if (options.report) {
        const report = session.report;
        if (report.attemptsUsed >= options.maxReportAttempts) {
          return { ok: false, code: 'BEICHEN_REPORT_ATTEMPTS_EXHAUSTED' };
        }
        if (report.status === 'running' || report.status === 'repairing') {
          return { ok: false, code: 'BEICHEN_REPORT_IN_PROGRESS' };
        }
        if (report.status === 'ready') {
          if (report.retries >= options.maxReportRetries) {
            return { ok: false, code: 'BEICHEN_REPORT_ATTEMPTS_EXHAUSTED' };
          }
          report.status = 'repairing';
          report.retries += 1;
          report.attemptsUsed += 1;
          report.startedAt = now;
          report.leaseExp = now + options.leaseMs;
          return { ok: true, report: true, reservationId: report.id, attempt: 'repair' };
        }
        if (session.runs >= options.maxRuns) {
          return { ok: false, code: 'BEICHEN_QUOTA_EXHAUSTED' };
        }
        report.id = id();
        report.status = 'running';
        report.attemptsUsed += 1;
        report.retries = 0;
        report.startedAt = now;
        report.readyAt = 0;
        report.leaseExp = now + options.leaseMs;
        return { ok: true, report: true, reservationId: report.id, attempt: 'new' };
      }

      const active = this.turns.get(sid) || new Map();
      if (session.turns + active.size >= options.maxTurns) {
        return { ok: false, code: 'BEICHEN_SESSION_TURNS_EXHAUSTED' };
      }
      const reservationId = id();
      active.set(reservationId, { exp: now + options.leaseMs });
      this.turns.set(sid, active);
      return { ok: true, report: false, reservationId, attempt: 'normal' };
    });
  }

  async finishChat(sid, reservationId, success, isReport) {
    return this.lock.run('session:' + sid, async () => {
      const session = this._reap(sid);
      if (!session) return { ok: false, settled: false };
      if (isReport) {
        const report = session.report;
        if (report.id !== reservationId || !['running', 'repairing'].includes(report.status)) {
          return { ok: true, settled: false };
        }
        if (success) {
          report.status = 'ready';
          report.startedAt = 0;
          report.leaseExp = 0;
          report.readyAt = this.now();
        } else if (report.status === 'repairing') {
          report.status = 'ready';
          report.startedAt = 0;
          report.leaseExp = 0;
        } else {
          session.report = Object.assign(emptyReport(), { attemptsUsed: report.attemptsUsed });
        }
        return { ok: true, settled: true };
      }
      const active = this.turns.get(sid);
      if (!active || !active.has(reservationId)) return { ok: true, settled: false };
      active.delete(reservationId);
      if (!active.size) this.turns.delete(sid);
      if (success) session.turns += 1;
      return { ok: true, settled: true };
    });
  }

  async completeRun(input) {
    return this.lock.run('session:' + input.sid, async () => {
      const now = this.now();
      const receipts = this.completions.get(input.sid);
      const existing = receipts && receipts.get(input.requestId);
      if (existing && existing.exp > now) return { ok: true, replayed: true, response: clone(existing.response) };
      if (receipts) receipts.delete(input.requestId);

      const session = this._reap(input.sid, now);
      if (!session) return { ok: false, code: 'BEICHEN_AUTH_EXPIRED' };
      if (session.jti !== input.expected.jti || session.seq !== input.expected.seq || session.runs !== input.expected.runs) {
        return { ok: false, code: 'BEICHEN_AUTH_REPLAY' };
      }
      if (session.runs >= input.maxRuns) return { ok: false, code: 'BEICHEN_QUOTA_EXHAUSTED' };
      if (session.report.status !== 'ready') return { ok: false, code: 'BEICHEN_REPORT_NOT_READY' };

      session.jti = input.next.jti;
      session.seq = input.next.seq;
      session.runs = input.next.runs;
      session.report = emptyReport();
      let sessionReceipts = this.completions.get(input.sid);
      if (!sessionReceipts) {
        sessionReceipts = new Map();
        this.completions.set(input.sid, sessionReceipts);
      }
      sessionReceipts.set(input.requestId, { response: clone(input.response), exp: session.exp });
      while (sessionReceipts.size > COMPLETION_LIMIT) sessionReceipts.delete(sessionReceipts.keys().next().value);
      return { ok: true, replayed: false, response: clone(input.response) };
    });
  }
}

const RATE_LUA = `
local current = redis.call('GET', KEYS[1])
if not current then
  redis.call('SET', KEYS[1], '1', 'PX', ARGV[2])
  return 1
end
if tonumber(current) >= tonumber(ARGV[1]) then return 0 end
redis.call('INCR', KEYS[1])
return 1
`;

const TOTP_LUA = `
if redis.call('SET', KEYS[1], '1', 'NX', 'PX', ARGV[1]) then return 1 end
return 0
`;

const START_CHAT_LUA = `
local session = KEYS[1]
local turns = KEYS[2]
local now = tonumber(ARGV[1])
if redis.call('EXISTS', session) == 0 then return {'ERR', 'BEICHEN_AUTH_EXPIRED'} end
local exp = tonumber(redis.call('HGET', session, 'exp') or '0')
if exp <= now then return {'ERR', 'BEICHEN_AUTH_EXPIRED'} end
local expired = redis.call('ZCOUNT', turns, '-inf', now)
if expired > 0 then redis.call('HINCRBY', session, 'turns', expired) end
redis.call('ZREMRANGEBYSCORE', turns, '-inf', now)
local isReport = ARGV[2] == '1'
local maxTurns = tonumber(ARGV[3])
local maxRuns = tonumber(ARGV[4])
local maxAttempts = tonumber(ARGV[5])
local maxRetries = tonumber(ARGV[6])
local leaseMs = tonumber(ARGV[7])
if ARGV[8] ~= '' and ((redis.call('HGET', session, 'jti') or '') ~= ARGV[8]
  or tonumber(redis.call('HGET', session, 'seq') or '-1') ~= tonumber(ARGV[9])
  or tonumber(redis.call('HGET', session, 'runs') or '-1') ~= tonumber(ARGV[10])) then
  return {'ERR', 'BEICHEN_AUTH_REPLAY'}
end

if isReport then
  local status = redis.call('HGET', session, 'report_status') or 'idle'
  local reportId = redis.call('HGET', session, 'report_id') or ''
  local leaseExp = tonumber(redis.call('HGET', session, 'report_lease_exp') or '0')
  local attempts = tonumber(redis.call('HGET', session, 'report_attempts') or '0')
  local retries = tonumber(redis.call('HGET', session, 'report_retries') or '0')
  if (status == 'running' or status == 'repairing') and leaseExp <= now then
    if status == 'repairing' then
      status = 'ready'
      redis.call('HSET', session, 'report_status', 'ready', 'report_started_at', '0', 'report_lease_exp', '0')
    else
      status = 'idle'
      reportId = ''
      retries = 0
      redis.call('HSET', session, 'report_status', 'idle', 'report_id', '', 'report_retries', '0', 'report_started_at', '0', 'report_ready_at', '0', 'report_lease_exp', '0')
    end
  end
  if attempts >= maxAttempts then return {'ERR', 'BEICHEN_REPORT_ATTEMPTS_EXHAUSTED'} end
  if status == 'running' or status == 'repairing' then return {'ERR', 'BEICHEN_REPORT_IN_PROGRESS'} end
  if status == 'ready' then
    if retries >= maxRetries then return {'ERR', 'BEICHEN_REPORT_ATTEMPTS_EXHAUSTED'} end
    redis.call('HINCRBY', session, 'report_attempts', 1)
    redis.call('HINCRBY', session, 'report_retries', 1)
    redis.call('HSET', session, 'report_status', 'repairing', 'report_started_at', tostring(now), 'report_lease_exp', tostring(now + leaseMs))
    return {'OK', reportId, 'repair'}
  end
  if tonumber(redis.call('HGET', session, 'runs') or '0') >= maxRuns then return {'ERR', 'BEICHEN_QUOTA_EXHAUSTED'} end
  reportId = ARGV[11]
  redis.call('HINCRBY', session, 'report_attempts', 1)
  redis.call('HSET', session, 'report_status', 'running', 'report_id', reportId, 'report_retries', '0', 'report_started_at', tostring(now), 'report_ready_at', '0', 'report_lease_exp', tostring(now + leaseMs))
  return {'OK', reportId, 'new'}
end

local active = redis.call('ZCARD', turns)
local used = tonumber(redis.call('HGET', session, 'turns') or '0')
if used + active >= maxTurns then return {'ERR', 'BEICHEN_SESSION_TURNS_EXHAUSTED'} end
local reservationId = ARGV[11]
redis.call('ZADD', turns, now + leaseMs, reservationId)
redis.call('PEXPIREAT', turns, exp)
return {'OK', reservationId, 'normal'}
`;

const FINISH_CHAT_LUA = `
local session = KEYS[1]
local turns = KEYS[2]
if redis.call('EXISTS', session) == 0 then return 0 end
local now = tonumber(ARGV[1])
local isReport = ARGV[2] == '1'
local reservationId = ARGV[3]
local success = ARGV[4] == '1'
if isReport then
  local currentId = redis.call('HGET', session, 'report_id') or ''
  local status = redis.call('HGET', session, 'report_status') or 'idle'
  if currentId ~= reservationId or (status ~= 'running' and status ~= 'repairing') then return 0 end
  if success then
    redis.call('HSET', session, 'report_status', 'ready', 'report_started_at', '0', 'report_ready_at', tostring(now), 'report_lease_exp', '0')
  elseif status == 'repairing' then
    redis.call('HSET', session, 'report_status', 'ready', 'report_started_at', '0', 'report_lease_exp', '0')
  else
    redis.call('HSET', session, 'report_status', 'idle', 'report_id', '', 'report_retries', '0', 'report_started_at', '0', 'report_ready_at', '0', 'report_lease_exp', '0')
  end
  return 1
end
local removed = redis.call('ZREM', turns, reservationId)
if removed == 1 and success then redis.call('HINCRBY', session, 'turns', 1) end
return removed
`;

const COMPLETE_RUN_LUA = `
local session = KEYS[1]
local receipt = KEYS[2]
local existing = redis.call('GET', receipt)
if existing then return {'REPLAY', existing} end
local now = tonumber(ARGV[1])
if redis.call('EXISTS', session) == 0 then return {'ERR', 'BEICHEN_AUTH_EXPIRED'} end
local exp = tonumber(redis.call('HGET', session, 'exp') or '0')
if exp <= now then return {'ERR', 'BEICHEN_AUTH_EXPIRED'} end
if (redis.call('HGET', session, 'jti') or '') ~= ARGV[2]
  or tonumber(redis.call('HGET', session, 'seq') or '-1') ~= tonumber(ARGV[3])
  or tonumber(redis.call('HGET', session, 'runs') or '-1') ~= tonumber(ARGV[4]) then
  return {'ERR', 'BEICHEN_AUTH_REPLAY'}
end
if tonumber(redis.call('HGET', session, 'runs') or '0') >= tonumber(ARGV[10]) then return {'ERR', 'BEICHEN_QUOTA_EXHAUSTED'} end
if (redis.call('HGET', session, 'report_status') or 'idle') ~= 'ready' then return {'ERR', 'BEICHEN_REPORT_NOT_READY'} end
redis.call('HSET', session,
  'jti', ARGV[5], 'seq', ARGV[6], 'runs', ARGV[7],
  'report_status', 'idle', 'report_id', '', 'report_attempts', '0', 'report_retries', '0',
  'report_started_at', '0', 'report_ready_at', '0', 'report_lease_exp', '0')
redis.call('SET', receipt, ARGV[8], 'PX', ARGV[9])
return {'OK', ARGV[8]}
`;

function redisHash(session) {
  const report = normalizeReport(session.report);
  return {
    schema: '1',
    sid: session.sid,
    jti: session.jti,
    seq: String(session.seq),
    iat: String(session.iat),
    exp: String(session.exp),
    runs: String(session.runs),
    turns: String(session.turns),
    report_status: report.status,
    report_id: report.id || '',
    report_attempts: String(report.attemptsUsed),
    report_retries: String(report.retries),
    report_started_at: String(report.startedAt),
    report_ready_at: String(report.readyAt),
    report_lease_exp: String(report.leaseExp)
  };
}

function sessionFromRedis(hash) {
  if (!hash || !hash.sid) return null;
  return normalizeSession({
    schema: number(hash.schema, 1),
    sid: hash.sid,
    jti: hash.jti,
    seq: number(hash.seq),
    iat: number(hash.iat),
    exp: number(hash.exp),
    runs: number(hash.runs),
    turns: number(hash.turns),
    report: {
      status: hash.report_status || 'idle',
      id: hash.report_id || null,
      attemptsUsed: number(hash.report_attempts),
      retries: number(hash.report_retries),
      startedAt: number(hash.report_started_at),
      readyAt: number(hash.report_ready_at),
      leaseExp: number(hash.report_lease_exp)
    }
  });
}

class RedisStateStore {
  constructor(options = {}) {
    let redis;
    try {
      redis = require('redis');
    } catch (error) {
      throw new StateStoreUnavailableError(error);
    }
    this.name = 'redis';
    this.kind = 'redis';
    this.prefix = options.prefix || process.env.BEICHEN_REDIS_PREFIX || DEFAULT_REDIS_PREFIX;
    this.connectTimeout = number(options.connectTimeout || process.env.REDIS_CONNECT_TIMEOUT_MS, 3000);
    const url = options.url || process.env.REDIS_URL || '';
    const socket = { connectTimeout: this.connectTimeout };
    if (url) {
      this.client = redis.createClient({ url, socket });
    } else {
      this.client = redis.createClient({
        socket: Object.assign(socket, {
          host: process.env.REDIS_HOST || '127.0.0.1',
          port: number(process.env.REDIS_PORT, 6379),
          tls: String(process.env.REDIS_TLS || '').toLowerCase() === 'true'
        }),
        username: process.env.REDIS_USERNAME || undefined,
        password: process.env.REDIS_PASSWORD || undefined,
        database: number(process.env.REDIS_DB, 0)
      });
    }
    this.connectPromise = null;
    this.client.on('error', () => {});
  }

  _sessionKey(sid) { return `${this.prefix}:session:{${sid}}`; }
  _turnsKey(sid) { return `${this.prefix}:turns:{${sid}}`; }
  _completionKey(sid, requestId) { return `${this.prefix}:completion:{${sid}}:${requestId}`; }
  _hashedKey(kind, value) {
    return `${this.prefix}:${kind}:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
  }

  async _ready() {
    if (this.client.isReady || this.client.isOpen) return;
    if (!this.connectPromise) {
      this.connectPromise = this.client.connect().catch(error => {
        throw new StateStoreUnavailableError(error);
      });
    }
    try {
      await this.connectPromise;
    } catch (error) {
      if (error instanceof StateStoreUnavailableError) throw error;
      throw new StateStoreUnavailableError(error);
    } finally {
      this.connectPromise = null;
    }
  }

  async _eval(script, keys, args) {
    await this._ready();
    try {
      return await this.client.eval(script, { keys, arguments: args.map(String) });
    } catch (error) {
      throw new StateStoreUnavailableError(error);
    }
  }

  async ping() {
    await this._ready();
    try {
      return (await this.client.ping()) === 'PONG';
    } catch (error) {
      throw new StateStoreUnavailableError(error);
    }
  }

  async close() {
    if (this.client.isOpen) await this.client.quit().catch(() => this.client.disconnect());
  }

  async clear() {
    await this._ready();
    let cursor = 0;
    do {
      const page = await this.client.scan(cursor, { MATCH: `${this.prefix}:*`, COUNT: 100 });
      cursor = Number(page.cursor);
      if (page.keys.length) await this.client.del(page.keys);
    } while (cursor !== 0);
  }

  async consumeRate(key, limit, windowMs) {
    const result = await this._eval(RATE_LUA, [this._hashedKey('rate', key)], [limit, windowMs]);
    return Number(result) === 1;
  }

  async consumeTotp(key, ttlMs) {
    const result = await this._eval(TOTP_LUA, [this._hashedKey('totp', key)], [ttlMs]);
    return Number(result) === 1;
  }

  async createSession(input) {
    await this._ready();
    const session = normalizeSession(input);
    const key = this._sessionKey(session.sid);
    const turnsKey = this._turnsKey(session.sid);
    try {
      await this.client.del(turnsKey);
      await this.client.hSet(key, redisHash(session));
      await this.client.pExpireAt(key, session.exp);
      await this.client.pExpireAt(turnsKey, session.exp);
      return sessionView(session, 0);
    } catch (error) {
      throw new StateStoreUnavailableError(error);
    }
  }

  async getSession(sid) {
    await this._ready();
    try {
      const hash = await this.client.hGetAll(this._sessionKey(sid));
      const session = sessionFromRedis(hash);
      if (!session || session.exp <= Date.now()) return null;
      const activeTurns = await this.client.zCard(this._turnsKey(sid));
      return sessionView(session, activeTurns);
    } catch (error) {
      throw new StateStoreUnavailableError(error);
    }
  }

  async getCompletion(sid, requestId) {
    await this._ready();
    try {
      const raw = await this.client.get(this._completionKey(sid, requestId));
      return raw ? parseReceipt(raw) : null;
    } catch (error) {
      if (error instanceof StateStoreUnavailableError) throw error;
      throw new StateStoreUnavailableError(error);
    }
  }

  async startChat(sid, options) {
    const result = await this._eval(START_CHAT_LUA, [this._sessionKey(sid), this._turnsKey(sid)], [
      Date.now(), options.report ? 1 : 0, options.maxTurns, options.maxRuns,
      options.maxReportAttempts, options.maxReportRetries, options.leaseMs,
      options.expected ? options.expected.jti : '', options.expected ? options.expected.seq : '',
      options.expected ? options.expected.runs : '', id()
    ]);
    if (!Array.isArray(result) || result[0] !== 'OK') return { ok: false, code: result && result[1] ? result[1] : 'BEICHEN_STATE_STORE_UNAVAILABLE' };
    return { ok: true, report: result[2] !== 'normal', reservationId: result[1], attempt: result[2] };
  }

  async finishChat(sid, reservationId, success, isReport) {
    const result = await this._eval(FINISH_CHAT_LUA, [this._sessionKey(sid), this._turnsKey(sid)], [
      Date.now(), isReport ? 1 : 0, reservationId, success ? 1 : 0
    ]);
    return { ok: true, settled: Number(result) === 1 };
  }

  async completeRun(input) {
    const ttl = Math.max(1000, Math.min(input.expected.exp - Date.now(), input.receiptTtlMs || input.expected.exp - Date.now()));
    const result = await this._eval(COMPLETE_RUN_LUA, [
      this._sessionKey(input.sid), this._completionKey(input.sid, input.requestId)
    ], [
      Date.now(), input.expected.jti, input.expected.seq, input.expected.runs,
      input.next.jti, input.next.seq, input.next.runs, JSON.stringify(input.response), ttl, input.maxRuns
    ]);
    if (!Array.isArray(result)) return { ok: false, code: 'BEICHEN_STATE_STORE_UNAVAILABLE' };
    if (result[0] === 'REPLAY') return { ok: true, replayed: true, response: parseReceipt(result[1]) };
    if (result[0] !== 'OK') return { ok: false, code: result[1] || 'BEICHEN_STATE_STORE_UNAVAILABLE' };
    return { ok: true, replayed: false, response: parseReceipt(result[1]) };
  }
}

function parseReceipt(raw) {
  try { return JSON.parse(raw); }
  catch (error) { throw new StateStoreUnavailableError(error); }
}

class UnavailableStateStore {
  constructor(error) {
    this.name = 'unavailable';
    this.kind = 'unavailable';
    this.error = error;
  }

  _fail() { throw new StateStoreUnavailableError(this.error); }
  async ping() { this._fail(); }
  async close() {}
  async consumeRate() { this._fail(); }
  async consumeTotp() { this._fail(); }
  async createSession() { this._fail(); }
  async getSession() { this._fail(); }
  async getCompletion() { this._fail(); }
  async startChat() { this._fail(); }
  async finishChat() { this._fail(); }
  async completeRun() { this._fail(); }
}

function createStateStoreFromEnv(options = {}) {
  const requested = String(process.env.STATE_STORE || '').trim().toLowerCase();
  if (requested === 'memory' && process.env.BEICHEN_NO_LISTEN) return new MemoryStateStore(options);
  if (!requested && process.env.BEICHEN_NO_LISTEN) return new MemoryStateStore(options);
  if (requested === 'memory') return new UnavailableStateStore(new Error('memory state store is disabled outside tests'));
  if (requested && requested !== 'redis') return new UnavailableStateStore(new Error('unsupported state store'));
  try {
    return new RedisStateStore(options);
  } catch (error) {
    return new UnavailableStateStore(error);
  }
}

module.exports = {
  MemoryStateStore,
  RedisStateStore,
  UnavailableStateStore,
  StateStoreUnavailableError,
  createStateStoreFromEnv,
  emptyReport,
  normalizeSession
};
