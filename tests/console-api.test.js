'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
const {createConsole,TTL}=require('../console-api'),{MemoryStore}=require('../official/store.cjs');
const env={GATE_TOTP_SECRET:'test-totp-secret',GATE_SESSION_SECRET:'test-session-secret-'.repeat(3),BEICHEN_CONSOLE_GITHUB_TOKEN:'test-private-github-token',CODEBUDDY_API_KEY:'test-codebuddy-key',OPENAI_CODEX_ENABLED:'true'};
function fixture({store=new MemoryStore(),clock={value:1792850000000},dispatchError,probeModel}={}){
 const calls=[],list=[],source={redis:{status:'off'},monitor:'off',ready:false,checkedAt:new Date(clock.value).toISOString(),api:{provider:'codebuddy',model:'deepseek-v4.1-flash',defaultEffort:'max',officialAccounts:[{id:'a'.repeat(32),label:'账号A',status:'ready',access_token:'never-return-me'}]},private:'never-return-me'};
 const api=createConsole({env,store,now:()=>clock.value,probeModel,matchTotp:(code,at)=>code==='123456'?Math.floor(at/30000):null,transport:async(url,opts)=>{calls.push({url,opts});assert(url.startsWith('https://api.github.com/repos/yusheng266186-beep/beichen-handover/'));if(opts.method==='POST'){if(dispatchError)throw dispatchError;return {status:204,body:''};}if(url.includes('/contents/'))return {status:200,body:JSON.stringify({content:Buffer.from(JSON.stringify(source)).toString('base64')})};if(url.includes('/jobs?'))return {status:200,body:JSON.stringify({jobs:[{name:'operate',status:'completed',conclusion:'success',steps:[{name:'执行开关并核实云端结果',status:'completed',conclusion:'success'}],logs_url:'never-return-me'}]})};return {status:200,body:JSON.stringify({workflow_runs:list})};}});
 return {api,store,clock,calls,list,source};
}
const req=token=>({headers:{authorization:'Bearer '+token}});
test('original TOTP creates a separate admin ticket without student Redis; logout and expiry revoke it',async()=>{
 const f=fixture(),session=await f.api.login({code:'123456'},'one');assert.equal(session.expiresAt-f.clock.value,TTL);assert.equal((await f.api.auth(req(session.token))).aud,'beichen-console');
 const payload={v:1,sid:'a'.repeat(32),jti:'b'.repeat(32),iat:f.clock.value,exp:f.clock.value+TTL,runs:0,seq:0},body=Buffer.from(JSON.stringify(payload)).toString('base64url'),signature=crypto.createHmac('sha256',env.GATE_SESSION_SECRET).update(body).digest('base64url');await assert.rejects(f.api.auth(req(body+'.'+signature)),/AUTH_REQUIRED/);
 await assert.rejects(f.api.auth(req(session.token+'x')),/AUTH_REQUIRED/);const auth=await f.api.auth(req(session.token));await f.store.create('openai-codex/beichen-console/revoked/'+auth.sid+'.json',{at:f.clock.value});await assert.rejects(f.api.auth(req(session.token)),/AUTH_REQUIRED/);
 f.clock.value+=30000;const second=await f.api.login({code:'123456'},'one');f.clock.value+=TTL;await assert.rejects(f.api.auth(req(second.token)),/AUTH_REQUIRED/);assert.equal(f.calls.length,0);
});
test('TOTP replay and attempt limits are shared across instances and wrong codes never issue a ticket',async()=>{
 const store=new MemoryStore(),a=fixture({store}),b=fixture({store});await a.api.login({code:'123456'},'a');await assert.rejects(b.api.login({code:'123456'},'b'),/CODE_USED/);
 for(let i=0;i<8;i++)await assert.rejects((i%2?a:b).api.login({code:'000000'},'limited'),/INVALID_CODE/);
 await assert.rejects(a.api.login({code:'123456'},'limited'),/RATE_LIMIT/);await assert.rejects(a.api.login({code:'12',endpoint:'https://example.test'},'x'),/INVALID_CODE/);
});
test('authenticated state contains only public model metadata, masked accounts and fixed workflow runs',async()=>{
 const f=fixture();f.list.push({id:42,display_title:'beichen:status:'+crypto.randomUUID(),status:'completed',conclusion:'success',created_at:'2026-10-24T00:00:00Z',token:'never-return-me'});const state=await f.api.state();assert.equal(state.redis.status,'off');assert(state.api.providers.find(p=>p.id==='codebuddy').configured);assert.equal(state.api.providers.find(p=>p.id==='codebuddy').models.length,14);assert.equal(state.runs.length,1);assert(!JSON.stringify(state).includes('never-return-me'));assert(!JSON.stringify(state).includes(env.CODEBUDDY_API_KEY));assert(!JSON.stringify(state).includes(env.BEICHEN_CONSOLE_GITHUB_TOKEN));await f.api.state();assert.equal(f.calls.length,2);
});
test('only supported actions, models and native efforts can reach the fixed dispatcher',async()=>{
 const f=fixture();for(const input of [{action:'image',provider:'bytecat-image'},{action:'shell',command:'x'},{action:'off',ref:'other'},{action:'switch',provider:'codebuddy',model:'unknown',effort:'max'},{action:'switch',provider:'codebuddy',model:'deepseek-v4.1-flash',effort:'ultra'},{action:'switch',provider:'codebuddy',model:'deepseek-v4.1-flash',effort:'max',accountId:'a'.repeat(32)}])await assert.rejects(f.api.dispatch(input,crypto.randomUUID()),/BAD_REQUEST/);
 assert.equal(f.calls.length,0);const id=crypto.randomUUID(),input={action:'switch',provider:'codebuddy',model:'deepseek-v4.1-flash',effort:'max'};await f.api.dispatch(input,id);await f.api.dispatch(input,id);assert.equal(f.calls.filter(c=>c.opts.method==='POST').length,1);const sent=JSON.parse(f.calls.at(-1).opts.body);assert.equal(sent.ref,'main');assert.deepEqual(sent.inputs,{action:'switch',request_id:id,provider:'codebuddy',model:'deepseek-v4.1-flash',effort:'max'});await assert.rejects(f.api.dispatch({action:'off'},id),/REQUEST_CONFLICT/);
});
test('two browser sessions cannot queue duplicate changes; completion releases the global lease',async()=>{
 const store=new MemoryStore(),a=fixture({store}),b=fixture({store}),id=crypto.randomUUID();await a.api.dispatch({action:'status'},id);await assert.rejects(b.api.dispatch({action:'off'},crypto.randomUUID()),/TASK_ACTIVE/);b.list.push({id:1,display_title:'beichen:status:'+id,status:'completed',conclusion:'success'});await b.api.dispatch({action:'status'},crypto.randomUUID());assert.equal(b.calls.filter(c=>c.opts.method==='POST').length,1);
});
test('an ambiguous upstream dispatch remains pending and is never blindly resent',async()=>{
 const f=fixture({dispatchError:Error('NETWORK_INTERRUPTED')}),id=crypto.randomUUID();await assert.rejects(f.api.dispatch({action:'status'},id),/SUBMISSION_UNCERTAIN/);const reused=await f.api.dispatch({action:'status'},id);assert.equal(reused.status,'uncertain');assert.equal(f.calls.filter(c=>c.opts.method==='POST').length,1);await assert.rejects(f.api.dispatch({action:'on'},crypto.randomUUID()),/TASK_ACTIVE/);
});
test('unrelated workflow details and raw logs are not exposed',async()=>{
 const f=fixture();await assert.rejects(f.api.task('42'),/NOT_FOUND/);f.list.push({id:42,display_title:'beichen:status:'+crypto.randomUUID(),status:'completed'});const details=await f.api.task('42');assert(details.jobs[0].steps.length);assert(!JSON.stringify(details).includes('never-return-me'));await assert.rejects(f.api.task('../secrets'),/NOT_FOUND/);
});
test('HTTP routes reject unauthenticated reads and permit only the matching CORS preflight',async()=>{
 const f=fixture();const response=()=>{const r=new EventEmitter();r.writeHead=(status,headers)=>{r.status=status;r.headers=headers;};r.end=s=>{r.body=s;};return r;};
 const call=async(method,url,headers={})=>{const r=response();await f.api.handle({method,url,headers},r,{headers:()=>({'Cache-Control':'no-store'}),read:async()=>({}),client:'test'});return r;};
 assert.equal((await call('GET','/console/state')).status,401);assert.equal((await call('OPTIONS','/console/session',{'access-control-request-method':'DELETE'})).status,204);assert.equal((await call('OPTIONS','/console/not-real',{'access-control-request-method':'GET'})).status,404);assert.equal((await call('OPTIONS','/console/actions',{'access-control-request-method':'DELETE'})).status,404);
});

test('connectivity probe uses the selected account/model/effort without dispatching a configuration change',async()=>{
 const seen=[],f=fixture({probeModel:async selected=>{seen.push(selected);return {passed:true,latencyMs:12};}}),sid=crypto.randomUUID(),input={provider:'codebuddy',model:'deepseek-v4.1-flash',effort:'max'};
 const result=await f.api.probe(input,{},sid);assert.equal(result.passed,true);assert.equal(result.latencyMs,12);assert.deepEqual(seen,[input]);assert.equal(f.calls.length,0);
 await assert.rejects(f.api.probe({...input,model:'unknown'}, {},sid),/BAD_REQUEST/);assert.equal(seen.length,1);
 for(let n=0;n<5;n++)await f.api.probe(input,{},sid);await assert.rejects(f.api.probe(input,{},sid),/PROBE_RATE_LIMIT/);
 assert.equal(f.calls.length,0);
});

test('the on-demand task transport rejects every unrelated host, path, method and workflow',()=>{
 const {checkedTarget}=require('../console-github'),base='https://api.github.com/repos/yusheng266186-beep/beichen-handover';
 assert(checkedTarget(base+'/contents/.workbench/state.json?ref=main'));assert(checkedTarget(base+'/actions/workflows/beichen-workbench.yml/dispatches','POST'));
 for(const [url,method]of [['https://example.test/','GET'],[base+'/secrets','GET'],[base+'/contents/.workbench/state.json?ref=other','GET'],[base+'/actions/workflows/other.yml/dispatches','POST'],[base+'/actions/workflows/beichen-workbench.yml/dispatches','DELETE']])assert.throws(()=>checkedTarget(url,method),/CONSOLE_DESTINATION_REJECTED/);
});
