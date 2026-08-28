'use strict';
/* 服务端契约:思考预算分档、端点白名单、请求校验、模式字段透传保护 */
const assert = require('assert');
const path = require('path');
process.env.BEICHEN_NO_LISTEN = '1';
const relay = require(path.join(__dirname, '..', 'scf-relay.js'));

/* 思考预算:星图轮 6144 / 日常轮 2048 / 环境变量可覆盖 */
const reportBody = relay.validateChatBody({
  messages: [{role: 'user', content: 'contract'}], max_tokens: 12000, temperature: 0.25, stream: true
});
const reportUpstream = relay.buildUpstreamBody(reportBody, {name: 'qianfan', model: 'glm-5.2'});
assert.deepEqual(reportUpstream.thinking, {type: 'enabled'});
assert.equal(reportUpstream.reasoning_effort, 'max');
assert.equal(reportUpstream.thinking_budget, 6144, 'report-scale turn keeps deep thinking');
assert.equal(reportUpstream.model, 'glm-5.2');

const casualBody = relay.validateChatBody({
  messages: [{role: 'user', content: 'x'}], max_tokens: 3500, stream: true
});
assert.equal(relay.buildUpstreamBody(casualBody, {name: 'qianfan', model: 'glm-5.2'}).thinking_budget, 2048,
  'casual rounds think briefly so replies stay quick');

process.env.QIANFAN_THINKING_BUDGET = '512';
assert.equal(relay.buildUpstreamBody(casualBody, {name: 'qianfan', model: 'glm-5.2'}).thinking_budget, 512);
delete process.env.QIANFAN_THINKING_BUDGET;

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

console.log('relay contract tests passed');
