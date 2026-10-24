'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
const providers=require('../api-providers.json'),profiles=require('../model-profiles.json'),adapter=require('../model-adapter'),normalizer=require('../upstream-stream'),chat=require('../official-chat'),ops=require('../maintenance');
test('all synced text models have adapters and supported native reasoning; image-only routes stay independent',()=>{
 const sync=require('../model-sync.json');assert.equal(Object.keys(providers).length,sync.providers);assert.equal(Object.values(providers).reduce((n,p)=>n+p.catalog.length,0),155);assert.equal(Object.keys(require('../image-providers.json')).length,4);
 for(const [name,p] of Object.entries(providers))for(const model of p.catalog){const profile=adapter.modelProfile({name,model});assert(profile,name+'/'+model);for(const effort of Object.keys(profile.efforts)){const body=adapter.adaptModelBody({messages:[{role:'system',content:'规则'},{role:'user',content:'37×19'}],max_tokens:16384,effort},{name,model});assert(body);assert(Object.hasOwn(profile.chatBudgets,effort));if(body.thinking?.budget_tokens!==undefined)assert(Number.isFinite(body.thinking.budget_tokens),name+'/'+model+'/'+effort);}}
 assert.deepEqual(profiles.providers['openai-codex']['gpt-6.1-sol'].nativeEfforts,['low','medium','high','xhigh','max','ultra']);assert.deepEqual(profiles.providers['kimi-code'].k3.nativeEfforts,['low','high','max']);
});
test('shared OAuth vault and refresh lease implementation remains byte-identical to its recorded source',()=>{
 const source=require('../official/SOURCE.json');for(const [name,hash] of Object.entries(source.files))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../official',name))).digest('hex'),hash,name);
});
test('native Gemini preserves multi-turn roles and normalizes UTF-8, summaries and a completed finish',()=>{
 const messages=[{role:'system',content:'全部规则'},{role:'user',content:'我喜欢生物'},{role:'assistant',content:'具体经历？'},{role:'user',content:'做实验'}];
 const body=adapter.adaptModelBody({messages,max_tokens:16384,effort:'high'},{name:'cheetah-gemini',model:'gemini-3.8-flash'});
 assert.equal(body.systemInstruction.parts[0].text,'全部规则');assert.deepEqual(body.contents.map(m=>m.role),['user','model','user']);assert.equal(body.generationConfig.thinkingConfig.thinkingLevel,'high');assert.equal(body.generationConfig.responseJsonSchema,undefined);
 const source='data: '+JSON.stringify({candidates:[{content:{parts:[{thought:true,text:'公开摘要'},{text:'收到'}]}}]})+'\n\ndata: '+JSON.stringify({candidates:[{finishReason:'STOP'}]})+'\n\n',reader=normalizer.createStreamNormalizer('gemini'),bytes=Buffer.from(source);let result='';for(const byte of bytes)result+=reader.push(Buffer.from([byte]));result+=reader.end();assert.match(result,/公开摘要/);assert.match(result,/收到/);assert.match(result,/\[DONE\]/);
});
test('official completion pins the selected account, preserves all conversation evidence and sends the requested native effort',async()=>{
 let bound,seen;const control={bind:async g=>(bound=g,{...g,codexAccountId:g.codexAccountId}),withAccount:async(id,fn)=>{assert.equal(id,'b'.repeat(32));return fn('runtime');}};
 const messages=[{role:'system',content:'北辰原始指令'},{role:'user',content:'最早的完整经历'},{role:'assistant',content:'追问'},{role:'user',content:'最近的选择'}];
 const result=await chat.complete({messages,effort:'ultra'},{name:'openai-codex',model:'gpt-6.1-sol',accountId:'b'.repeat(32)},{control,methods:{complete:async(rt,p,g)=>{seen={rt,p,g};return {output:'收到'};}}});
 assert.equal(result.output,'收到');assert.equal(bound.codexAccountId,'b'.repeat(32));assert.equal(seen.p.system,messages[0].content);assert.deepEqual(seen.p.input.messages,messages.slice(1));assert.equal(seen.g.reasoningEffort,'ultra');
});
function stream(){const req=new EventEmitter(),res=new EventEmitter();res.headersSent=false;res.destroyed=false;res.writableEnded=false;res.text='';res.writeHead=()=>{res.headersSent=true;};res.write=text=>(res.text+=text,true);res.end=text=>{res.text+=text||'';res.writableEnded=true;};return {req,res};}
test('official text and public summary form a compatible SSE stream; a failed result never looks complete',async()=>{
 const s=stream();await chat.proxy(s.req,s.res,{},{},{headers:{},completion:async(_,__,o)=>{o.onProgress({summary:'摘要'});o.onProgress({draftSource:'收'});o.onProgress({draftSource:'收到'});return {output:'收到',usage:{input:5,output:2}};}});
 assert.match(s.res.text,/reasoning_content/);assert.match(s.res.text,/\[DONE\]/);assert.equal((s.res.text.match(/"content":"收"/g)||[]).length,1);assert.equal((s.res.text.match(/"content":"到"/g)||[]).length,1);
 const bad=stream();await assert.rejects(chat.proxy(bad.req,bad.res,{},{},{headers:{},completion:async()=>{throw Error('MODEL_AUTH_FAILED');}}),/MODEL_AUTH_FAILED/);assert.doesNotMatch(bad.res.text,/\[DONE\]/);assert.match(bad.res.text,/BEICHEN_OFFICIAL_REAUTHORIZE/);
});
test('private operations signatures bind exact method, path and body, expire, and cannot be replayed',async()=>{
 const env={BEICHEN_WORKBENCH_SECRET:'test-only-control-key-'.repeat(3)},now=1792640000000,time=String(now/1000),nonce=crypto.randomUUID(),body='{"model":"gpt-6.1-sol"}',path='/maintenance/probe',seen=new Set(),store={create:async key=>{if(seen.has(key))return false;seen.add(key);return true;}};
 const req={method:'POST',headers:{'x-beichen-time':time,'x-beichen-nonce':nonce,'x-beichen-signature':ops.signature(env.BEICHEN_WORKBENCH_SECRET,'POST',path,time,nonce,body)}};
 const options={env,store,now:()=>now};await assert.rejects(ops.authorize(req,path,body+' ',options),/UNAUTHORIZED/);await assert.rejects(ops.authorize(req,'/maintenance/accounts',body,options),/UNAUTHORIZED/);await assert.rejects(ops.authorize(req,path,body,{...options,now:()=>now+61000}),/UNAUTHORIZED/);await ops.authorize(req,path,body,options);await assert.rejects(ops.authorize(req,path,body,options),/REPLAY/);
});
test('only the fixed model probe is permitted and account metadata contains no OAuth token',async()=>{
 const now=Date.now(),time=String(Math.floor(now/1000)),nonce=crypto.randomUUID(),secret='test-only-maintenance-signing-key',path='/maintenance/accounts',req={method:'GET',url:path,headers:{'x-beichen-time':time,'x-beichen-nonce':nonce,'x-beichen-signature':ops.signature(secret,'GET',path,time,nonce,'')}},s=stream(),row={id:'a'.repeat(32),emailMasked:'t***@example.test',status:'ready'};
 await ops.handle(req,s.res,{rawBody:'',authOptions:{env:{BEICHEN_WORKBENCH_SECRET:secret},store:{create:async()=>true}},control:{accounts:async()=>({enabled:true,accounts:[row]})}});const data=JSON.parse(s.res.text);assert.deepEqual(data.accounts,[row]);assert.doesNotMatch(s.res.text,/access_token|refresh_token|id_token/);
});
test('historical Node 16 compatibility clones vault records and combines cancellation signals without changing native APIs',()=>{
 const vm=require('node:vm'),source=fs.readFileSync(path.join(__dirname,'../runtime-compat.js'),'utf8');
 class Signal extends EventTarget{constructor(){super();this.aborted=false;}}
 class Controller{constructor(){this.signal=new Signal();}abort(reason){if(this.signal.aborted)return;this.signal.aborted=true;this.signal.reason=reason;this.signal.dispatchEvent(new Event('abort'));}}
 const context={require,AbortSignal:Signal,AbortController:Controller};vm.runInNewContext(source,context);const record={auth:{token:'test-only'},revision:2},copy=context.structuredClone(record);copy.auth.token='changed';assert.equal(record.auth.token,'test-only');const a=new Controller(),b=new Controller(),signal=Signal.any([a.signal,b.signal]);assert.equal(signal.aborted,false);b.abort('stop');assert.equal(signal.aborted,true);assert.equal(signal.reason,'stop');assert.equal(Signal.any([b.signal]).aborted,true);assert.throws(()=>Signal.any([null]),/Expected AbortSignal/);
});
test('closing a student request cancels the official turn and cannot emit a successful terminal',async()=>{
 const s=stream();const pending=chat.proxy(s.req,s.res,{},{},{headers:{},completion:async(_,__,o)=>new Promise((yes,no)=>{o.signal.addEventListener('abort',()=>no(Error('BEICHEN_CLIENT_ABORTED')),{once:true});})});s.req.emit('aborted');await assert.rejects(pending,/BEICHEN_CLIENT_ABORTED/);assert.doesNotMatch(s.res.text,/\[DONE\]/);
});
test('a complete native Gemini JSON response is normalized without requiring a relay to label it SSE',async t=>{
 process.env.BEICHEN_NO_LISTEN='1';const relay=require('../scf-relay'),https=require('node:https');t.after(()=>relay.setUpstreamRequester((...args)=>https.request(...args)));
 const payloads=[{candidates:[{content:{parts:[{text:'703'}]},finishReason:'STOP'}]},[{candidates:[{content:{parts:[{text:'7'}]}}]},{candidates:[{content:{parts:[{text:'03'}]},finishReason:'STOP'}]}]];
 for(const payload of payloads){relay.setUpstreamRequester((options,callback)=>{assert.match(options.path,/alt=sse/);const request=new EventEmitter();request.destroy=()=>{request.destroyed=true;};request.write=()=>{};request.end=()=>setImmediate(()=>{const response=new EventEmitter();Object.assign(response,{statusCode:200,headers:{'content-type':'application/json'},pause(){},resume(){},destroy(){}});callback(response);response.emit('data',Buffer.from(JSON.stringify(payload)));response.emit('end');});return request;});const s=stream();s.req.headers={};await relay.proxyChat(s.req,s.res,{messages:[{role:'user',content:'37×19'}],effort:'high',max_tokens:256},{name:'cheetah-gemini',model:'gemini-3.8-flash',key:'test-only',url:'https://www.wefucke.top'});let text='';for(const line of s.res.text.split('\n'))if(line.startsWith('data: {'))for(const c of JSON.parse(line.slice(6)).choices||[])text+=c.delta?.content||'';assert.equal(text,'703');assert.match(s.res.text,/\[DONE\]/);}
});

test('Kimi K3.1 Pro preserves conversation, sends its exact ID and native thinking at all tiers',()=>{
 const messages=[{role:'system',content:'北辰原始规则'},{role:'user',content:'我的完整经历'},{role:'assistant',content:'继续说说'},{role:'user',content:'最新选择'}];
 assert.equal(providers['kimi-code'].model,'k3');
 assert(providers['kimi-code'].catalog.includes('k3.1-pro'));
 assert.equal(profiles.providers['kimi-code']['k3.1-pro'].name,'Kimi K3.1 Pro');
 assert.deepEqual(profiles.providers['kimi-code']['k3.1-pro'].nativeEfforts,['low','high','max']);
 for(const [effort,native]of Object.entries({eco:'low',standard:'high',deep:'max',low:'low',high:'high',max:'max'})){
  const body=adapter.adaptModelBody({messages,max_tokens:16384,effort,temperature:.2,thinking:{type:'disabled'}},{name:'kimi-code',model:'k3.1-pro'});
  assert.equal(body.model,'k3.1-pro');assert.equal(body.reasoning_effort,native);assert.deepEqual(body.messages,messages);
  assert(body.max_completion_tokens>=16384);assert.equal(body.temperature,undefined);assert.equal(body.thinking,undefined);assert.equal(body.stream,true);
 }
});
