'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.BEICHEN_NO_LISTEN = '1';
const relay = require('../scf-relay');

test('官方与中转服务固定路由，并拒绝跨域、端口及任意路径', () => {
  for (const [name, url, host, path] of [
    ['deepseek', 'https://api.deepseek.com', 'api.deepseek.com', '/chat/completions'],
    ['deepseek', 'https://api.deepseek.com/v1/', 'api.deepseek.com', '/v1/chat/completions'],
    ['wefucke', 'https://www.wefucke.top/v1', 'www.wefucke.top', '/v1/chat/completions'],
    ['wefucke-gpt', 'https://www.wefucke.top/v1', 'www.wefucke.top', '/v1/chat/completions']
  ]) {
    const resolved = relay.upstreamUrl({name, url});
    assert.equal(resolved.hostname, host);
    assert.equal(resolved.pathname, path);
    for (const bad of ['https://evil.example/v1', url + '?key=x', url.replace('https:', 'http:'),
      url.replace(host, host + ':444'), 'https://' + host + '/unexpected']) {
      assert.throws(() => relay.upstreamUrl({name, url: bad}), /BEICHEN_PROVIDER_NOT_CONFIGURED/);
    }
  }
});

test('各 API 的密钥与模型独立读取，错误配置不回退到过期千帆', t => {
  const saved = {...process.env};
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  process.env.AI_PROVIDER = 'deepseek';
  process.env.DEEPSEEK_API_KEY = 'test-official-key';
  process.env.DEEPSEEK_MODEL = 'deepseek-v4-pro';
  let config = relay.providerConfig();
  assert.equal(config.model, 'deepseek-v4-pro');
  assert.deepEqual(relay.upstreamAuthHeaders(config), {Authorization: 'Bearer test-official-key'});
  process.env.AI_PROVIDER = 'wefucke';
  process.env.WEFUCKE_API_KEY = 'test-relay-key';
  process.env.WEFUCKE_MODEL = 'glm-5.3';
  config = relay.providerConfig();
  assert.equal(config.model, 'glm-5.3');
  assert.deepEqual(relay.upstreamAuthHeaders(config), {Authorization: 'Bearer test-relay-key'});
  delete process.env.WEFUCKE_API_KEY;
  assert.equal(relay.providerConfig(), null);
  process.env.AI_PROVIDER = 'wefucke-gpt';
  process.env.WEFUCKE_GPT_API_KEY = 'test-gpt-key';
  assert.equal(relay.providerConfig().model, 'gpt-6-sol');
  assert.deepEqual(relay.upstreamAuthHeaders(relay.providerConfig()), {Authorization: 'Bearer test-gpt-key'});
  process.env.AI_PROVIDER = 'unknown';
  assert.equal(relay.providerConfig(), null);
  assert.throws(() => relay.upstreamAuthHeaders({name: 'wefucke', auth: 'account', key: 'test'}));
});

test('沿用页面的思考强度，分别生成官方与 Harness 中转格式', () => {
  for (const [effort, expected] of [['eco', 'low'], ['standard', 'high'], ['deep', 'max']]) {
    const body = {messages: [{role: 'user', content: 'test'}], stream: true, max_tokens: 12000, temperature: 0.8, mode: 'open', effort};
    const official = relay.buildUpstreamBody(body, {name: 'deepseek', model: 'deepseek-flash'});
    assert.equal(official.model, 'deepseek-flash');
    assert.equal(official.reasoning_effort, expected);
    assert.deepEqual(official.thinking, {type: 'enabled'});
    assert.equal(official.temperature, undefined);
    const proxy = relay.buildUpstreamBody(body, {name: 'wefucke', model: 'glm-5.3-flash'});
    assert.deepEqual(proxy.reasoning, {enabled: true, effort: expected});
    for (const output of [official, proxy]) {
      assert.equal(output.mode, undefined);
      assert.equal(output.effort, undefined);
      assert.equal(output.thinking_budget, undefined);
    }
    const gpt = relay.buildUpstreamBody(body, {name: 'wefucke-gpt', model: 'gpt-6-sol'});
    assert.equal(gpt.reasoning_effort, expected);
    assert.equal(gpt.temperature, undefined);
    assert.equal(gpt.reasoning, undefined);
    assert.equal(gpt.thinking, undefined);
  }
});
