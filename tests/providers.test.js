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

test('沿用页面的思考强度，分别生成官方、GLM 与 GPT 原生格式', () => {
  for (const [effort, expected] of [['eco', 'low'], ['standard', 'high'], ['deep', 'max']]) {
    const body = {messages: [{role: 'user', content: 'test'}], stream: true, max_tokens: 12000, temperature: 0.8, thinking:{type:'enabled'}, mode: 'open', effort};
    const official = relay.buildUpstreamBody(body, {name: 'deepseek', model: 'deepseek-flash'});
    assert.equal(official.model, 'deepseek-flash');
    assert.equal(official.reasoning_effort, expected);
    assert.deepEqual(official.thinking, {type: 'enabled'});
    assert.equal(official.temperature, undefined);
    const proxy = relay.buildUpstreamBody(body, {name: 'wefucke', model: 'glm-5.3-flash'});
    assert.equal(proxy.reasoning_effort, expected);
    assert.deepEqual(proxy.thinking, {type:'enabled',clear_thinking:true});
    assert.equal(proxy.reasoning, undefined);
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

// Guard the report/quota intent while assigning reasoning + visible output budgets.
test('max预算、外国协议字段及模型能力边界',()=>{
  const report={messages:[{role:'user',content:'test'}],max_tokens:16384,effort:'deep',stream:true,temperature:0.8,thinking:{type:'enabled'},reasoning:{enabled:true}};
  const gpt=relay.buildUpstreamBody(report,{name:'wefucke-gpt',model:'gpt-6-sol'});
  assert.equal(gpt.max_completion_tokens,65536);assert.equal(gpt.max_tokens,undefined);
  assert.equal(gpt.thinking,undefined);assert.equal(gpt.reasoning,undefined);assert.equal(gpt.temperature,undefined);
  const daily=relay.buildUpstreamBody({...report,max_tokens:5000},{name:'deepseek',model:'deepseek-flash'});
  assert.equal(daily.max_tokens,32768);assert.equal(relay.REPORT_SCALE_TOKENS,10000);
  assert.equal(relay.buildUpstreamBody(report,{name:'wefucke-gpt',model:'gpt-5.5'}).reasoning_effort,'xhigh');
  assert.equal(relay.buildUpstreamBody(report,{name:'wefucke',model:'glm-5.1'}).reasoning_effort,undefined);
  assert.deepEqual(relay.buildUpstreamBody(report,{name:'wefucke',model:'muse-spark-1.3-contributor'}).reasoning,{effort:'max'});
  assert.throws(()=>relay.buildUpstreamBody(report,{name:'bytecat-gpt',model:'glm-5.3'}),/BEICHEN_MODEL_NOT_ADAPTED/);
});

test('同名 GPT 在不同供应商采用各自协议，完整多轮原话及报告预算保持',()=>{
  const messages=[{role:'system',content:'完整指导：保留所有学生证据。'},{role:'user',content:'我喜欢机器人，但家里希望我学医。'},{role:'assistant',content:'能说说具体的动手经历吗？'},{role:'user',content:'我修好了车，暂时没有选科决定。'}];
  const request={messages,max_tokens:16384,effort:'deep'};
  const chat=relay.buildUpstreamBody(request,{name:'wefucke-gpt',model:'gpt-6-sol'});
  const responses=relay.buildUpstreamBody(request,{name:'bytecat-gpt',model:'gpt-6-sol'});
  assert.deepEqual(chat.messages,messages);assert.equal(chat.max_completion_tokens,65536);
  assert.equal(responses.max_output_tokens,65536);assert.equal(responses.store,false);assert.deepEqual(responses.reasoning,{effort:'max',summary:'auto'});
  assert.deepEqual(responses.input.map(m=>({role:m.role,content:m.content[0].text})),messages);
  assert.equal(responses.input[2].content[0].type,'output_text');
  const claude=relay.buildUpstreamBody(request,{name:'bytecat-new-cc',model:'claude-opus-5-5'});
  assert.equal(claude.system,messages[0].content);assert.deepEqual(claude.messages.map(m=>({role:m.role,content:m.content[0].text})),messages.slice(1));
  assert.equal(claude.max_tokens,65536);assert.deepEqual(claude.thinking,{type:'adaptive'});assert.deepEqual(claude.output_config,{effort:'max'});
  const haiku=relay.buildUpstreamBody(request,{name:'bytecat-new-cc',model:'claude-haiku-4-5-20251001'});
  assert.equal(haiku.output_config,undefined);assert(haiku.thinking.budget_tokens<haiku.max_tokens);
});

test('新入口固定路径与认证，不允许向任意地址发送密钥',()=>{
  for(const [name,url,path]of [['bytecat-gpt','https://bytecat.lamclod.cn/v1','/v1/responses'],['bytecat-new-cc','https://bytecat.lamclod.cn','/v1/messages'],['command-code-claude','https://api.commandcode.ai/provider','/provider/v1/messages']]){
    assert.equal(relay.upstreamUrl({name,url}).pathname,path);
    for(const bad of [url+'?key=private',url.replace('https:','http:'),url+'/unexpected','https://evil.example'])assert.throws(()=>relay.upstreamUrl({name,url:bad}));
  }
  assert.deepEqual(relay.upstreamAuthHeaders({name:'bytecat-new-cc',key:'test-only'}),{'x-api-key':'test-only','anthropic-version':'2023-06-01'});
});
