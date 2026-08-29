'use strict';
/* 服务端契约:思考预算分档、端点白名单、请求校验、模式字段透传保护 */
const assert = require('assert');
const path = require('path');
process.env.BEICHEN_NO_LISTEN = '1';
const relay = require(path.join(__dirname, '..', 'scf-relay.js'));

/* 思考预算:星图轮 4096 / 日常轮 2048 / 各自环境变量可覆盖 */
const reportBody = relay.validateChatBody({
  messages: [{role: 'user', content: 'contract'}], max_tokens: 12000, temperature: 0.25, stream: true
});
const reportUpstream = relay.buildUpstreamBody(reportBody, {name: 'qianfan', model: 'glm-5.2'});
assert.deepEqual(reportUpstream.thinking, {type: 'enabled'});
assert.equal(reportUpstream.reasoning_effort, 'max');
assert.equal(reportUpstream.thinking_budget, 4096, 'report turn keeps deep thinking at a brisker budget');

const casualBody = relay.validateChatBody({
  messages: [{role: 'user', content: 'x'}], max_tokens: 3500, stream: true
});
assert.equal(relay.buildUpstreamBody(casualBody, {name: 'qianfan', model: 'glm-5.2'}).thinking_budget, 2048,
  'casual rounds think briefly so replies stay quick');

process.env.QIANFAN_THINKING_BUDGET = '512';
assert.equal(relay.buildUpstreamBody(casualBody, {name: 'qianfan', model: 'glm-5.2'}).thinking_budget, 512);
assert.equal(relay.buildUpstreamBody(reportBody, {name: 'qianfan', model: 'glm-5.2'}).thinking_budget, 4096,
  'casual override must not leak into the report tier');
delete process.env.QIANFAN_THINKING_BUDGET;

process.env.QIANFAN_REPORT_THINKING_BUDGET = '8192';
assert.equal(relay.buildUpstreamBody(reportBody, {name: 'qianfan', model: 'glm-5.2'}).thinking_budget, 8192);
delete process.env.QIANFAN_REPORT_THINKING_BUDGET;

/* mode 仅用于统计:客户端可带,绝不透传上游 */
const modeBody = relay.validateChatBody({
  messages: [{role: 'user', content: 'x'}], max_tokens: 3500, stream: true, mode: 'open'
});
const modeUpstream = relay.buildUpstreamBody(modeBody, {name: 'qianfan', model: 'glm-5.2'});
assert.equal(modeUpstream.mode, undefined, 'mode must never reach the upstream');

/* 上限校验 */
assert.throws(
  () => relay.validateChatBody({messages: [{role: 'user', content: 'too much'}], max_tokens: 16385}),
  /BEICHEN_BAD_REQUEST/
);
assert.throws(
  () => relay.validateChatBody({messages: [{role: 'user', content: 'no stream'}], max_tokens: 100, stream: false}),
  /BEICHEN_STREAM_REQUIRED/
);
/* 契约严格性:模型名服务端说了算,携带 model 字段一律拒绝 */
assert.throws(
  () => relay.validateChatBody({model: 'glm-5.2', messages: [{role: 'user', content: 'x'}], max_tokens: 100, stream: true}),
  /BEICHEN_BAD_REQUEST/
);

/* 服务端额度纪律:星图档受 runs 门槛,单会话总轮数有终身上限 */
const fakeAuth = (runs, turns) => ({ state: { runs, turns } });
assert.throws(
  () => relay.enforceSessionQuota(fakeAuth(3, 0), reportBody),
  /BEICHEN_QUOTA_EXHAUSTED/,
  'report-scale request must be refused once runs are exhausted'
);
relay.enforceSessionQuota(fakeAuth(2, 0), reportBody);   /* 额度未满:放行 */
const smallBody = relay.validateChatBody({messages: [{role: 'user', content: 'x'}], max_tokens: 3500, stream: true});
relay.enforceSessionQuota(fakeAuth(3, 0), smallBody);    /* 日常档不受 runs 门槛(追问设计) */
for (let i = 0; i < 300; i++) relay.enforceSessionQuota(fakeAuth(0, i), smallBody);
assert.throws(
  () => relay.enforceSessionQuota(fakeAuth(0, 300), smallBody),
  /BEICHEN_SESSION_TURNS_EXHAUSTED/,
  'session lifetime turn cap must kick in'
);

/* 端点白名单:个人版专属端点放行,coding 系与野地址拒绝 */
const personal = relay.upstreamUrl({name: 'qianfan', key: 'k', model: 'glm-5.2', url: 'https://qianfan.baidubce.com/v2/tokenplan/personal'});
assert.equal(personal.pathname, '/v2/tokenplan/personal/chat/completions');
assert.throws(
  () => relay.upstreamUrl({name: 'qianfan', key: 'k', model: 'glm-5.2', url: 'https://qianfan.baidubce.com/v2/coding/chat/completions'}),
  /BEICHEN_QIANFAN_STANDARD_ENDPOINT_REQUIRED/
);
assert.throws(
  () => relay.upstreamUrl({name: 'qianfan', key: 'k', model: 'glm-5.2', url: 'https://evil.example.com/v2/chat/completions'}),
  /BEICHEN_QIANFAN_HOST_NOT_ALLOWED/
);

/* 旧 OpenCode 线路已删除 */
const fs = require('fs');
const src = fs.readFileSync(path.join(__dirname, '..', 'scf-relay.js'), 'utf8');
assert.doesNotMatch(src, /OPENCODE/i, 'unused opencode provider must stay deleted');

/* 客户端真实 IP:CLB 把真实 IP 追加在 XFF 末尾,取最后一个合法条目;解析不出回退 TCP 对端 */
assert.equal(relay.pickClientIp('203.0.113.7', '10.0.0.1'), '203.0.113.7', 'single entry wins');
assert.equal(relay.pickClientIp('203.0.113.7, 198.51.100.9', '10.0.0.1'), '198.51.100.9',
  'multiple entries take the last');
assert.equal(relay.pickClientIp('6.6.6.6, 6.6.6.6, 198.51.100.9', '10.0.0.1'), '198.51.100.9',
  'forged leading entries must not win over the CLB-appended tail');
assert.equal(relay.pickClientIp('', '10.0.0.1'), '10.0.0.1', 'empty XFF falls back to socket peer');
assert.equal(relay.pickClientIp(undefined, '10.0.0.1'), '10.0.0.1', 'missing XFF falls back to socket peer');
assert.equal(relay.pickClientIp(undefined, undefined), 'unknown', 'nothing to key on degrades to unknown');
assert.equal(relay.pickClientIp('garbage, 198.51.100.9, junk', '10.0.0.1'), '198.51.100.9',
  'invalid entries are skipped, last valid one wins');
assert.equal(relay.pickClientIp('garbage, <script>', '10.0.0.1'), '10.0.0.1', 'all-invalid XFF falls back');
assert.equal(relay.pickClientIp('2001:db8::1, ::ffff:203.0.113.7', '10.0.0.1'), '::ffff:203.0.113.7',
  'IPv6 forms accepted');

/* 提示词上限口径:默认 4 万字符,中文 3 字节/字约 120KB,先于 128KiB 正文上限触发 */
assert.equal(relay.maxPromptChars, 40000, 'prompt char cap default must align with the 128KiB body cap');
assert.throws(
  () => relay.validateChatBody({messages: [
    {role: 'user', content: '中'.repeat(14000)},
    {role: 'user', content: '中'.repeat(14000)},
    {role: 'user', content: '中'.repeat(14001)}
  ]}),
  /BEICHEN_PROMPT_TOO_LARGE/,
  'prompt beyond 40000 chars must be refused'
);
const atPromptCap = relay.validateChatBody({messages: [
  {role: 'user', content: '中'.repeat(13333)},
  {role: 'user', content: '中'.repeat(13333)},
  {role: 'user', content: '中'.repeat(13334)}
], stream: true});
assert.equal(atPromptCap.messages.length, 3, 'exactly 40000 chars stays within the cap');

/* 最近完成表有界:超过 8 条按插入序淘汰最旧,最新一条保留供并发双提交幂等重放 */
const replayMap = new Map();
for (let i = 0; i < 12; i++) relay.recordCompletion(replayMap, 'jti' + i, {ok: true, runs: i});
assert.ok(replayMap.size <= 8, 'completion replay map must stay bounded');
assert.equal(replayMap.has('jti0'), false, 'oldest completions evicted first');
assert.equal(replayMap.has('jti11'), true, 'most recent completion kept for idempotent replay');
assert.deepEqual(replayMap.get('jti11'), {ok: true, runs: 11});

console.log('relay contract tests passed');
