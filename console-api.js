'use strict';
require('./runtime-compat');
const crypto=require('node:crypto');
const providers=require('./api-providers.json'),profiles=require('./model-profiles.json');
const {secureStore}=require('./official/codex-accounts.cjs'),{request}=require('./console-github');
const PREFIX='openai-codex/beichen-console/',REPO='yusheng266186-beep/beichen-handover',WORKFLOW='beichen-workbench.yml';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,TTL=8*60*60*1000;
const fail=(code,status=400)=>Object.assign(Error('BEICHEN_CONSOLE_'+code),{code:'BEICHEN_CONSOLE_'+code,status});
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
const same=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y);};
const numbered=n=>PREFIX+'dispatches/'+String(n).padStart(10,'0')+'.json';
function publicRuns(data){return (data.workflow_runs||[]).filter(r=>/^beichen:(status|on|off|switch):[a-f0-9-]{36}$/.test(r.display_title||'')).map(r=>({id:r.id,action:r.display_title.split(':')[1],requestId:r.display_title.split(':')[2],status:r.status,conclusion:r.conclusion,createdAt:r.created_at,updatedAt:r.updated_at}));}
function createConsole({env=process.env,store,transport=request,now=Date.now,matchTotp,probeModel}={}){
 const vault=()=>store||(store=secureStore({env}));
 const sign=body=>crypto.createHmac('sha256',env.GATE_SESSION_SECRET).update('beichen-console\n'+body).digest('base64url');
 const configured=()=>{if(!env.GATE_TOTP_SECRET||Buffer.byteLength(env.GATE_SESSION_SECRET||'')<32||!env.BEICHEN_CONSOLE_GITHUB_TOKEN)throw fail('NOT_CONFIGURED',503);};
 let cached=null,cacheAt=0;
 async function github(path,{method='GET',body}={}){
  const response=await transport('https://api.github.com/repos/'+REPO+path,{method,headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'Beichen-Console/2.0',Authorization:'Bearer '+env.BEICHEN_CONSOLE_GITHUB_TOKEN,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):'',timeout:12000,deadlineMs:12000,maxBytes:2*1024*1024});
  if(response.status<200||response.status>=300)throw Object.assign(fail([401,403].includes(response.status)?'CONNECTION_EXPIRED':'GITHUB_UNAVAILABLE',503),{safeToRetry:true});
  if(response.status===204)return null;
  try{return JSON.parse(response.body);}catch{throw fail('GITHUB_UNAVAILABLE',503);}
 }
 async function auth(req){
  configured();let payload;
  try{const token=String(req.headers.authorization||'').replace(/^Bearer /,''),[body,sig,extra]=token.split('.');if(!body||!sig||extra||!same(sign(body),sig))throw Error();payload=JSON.parse(Buffer.from(body,'base64url').toString());
   if(payload.aud!=='beichen-console'||payload.v!==1||!UUID.test(payload.sid)||!Number.isSafeInteger(payload.iat)||!Number.isSafeInteger(payload.exp)||payload.iat>now()+30000||payload.exp<=now()||payload.exp-payload.iat!==TTL)throw Error();
  }catch{throw fail('AUTH_REQUIRED',401);}
  if(await vault().get(PREFIX+'revoked/'+payload.sid+'.json'))throw fail('AUTH_REQUIRED',401);
  return payload;
 }
 async function login(input,client){
  configured();if(!input||Object.keys(input).length!==1||!/^\d{6}$/.test(input.code||''))throw fail('INVALID_CODE',401);
  const bucket=PREFIX+'login-rate/'+digest(String(client)).slice(0,24)+'/'+Math.floor(now()/60000)+'/';let allowed=false;
  for(let n=0;n<8;n++)if(await vault().create(bucket+n+'.json',{at:now()})){allowed=true;break;}
  if(!allowed)throw fail('RATE_LIMIT',429);
  const counter=matchTotp(input.code,now());if(counter===null)throw fail('INVALID_CODE',401);
  if(!await vault().create(PREFIX+'totp/'+counter+'-'+digest(input.code)+'.json',{at:now()}))throw fail('CODE_USED',401);
  const payload={v:1,aud:'beichen-console',sid:crypto.randomUUID(),iat:now(),exp:now()+TTL},body=Buffer.from(JSON.stringify(payload)).toString('base64url');
  return {token:body+'.'+sign(body),expiresAt:payload.exp};
 }
 function catalog(source={}){
  const old=new Map((source.providers||[]).map(p=>[p.id,p]));
  return Object.entries(providers).map(([id,p])=>{
   const configured=id==='openai-codex'?env.OPENAI_CODEX_ENABLED==='true':!!env[p.key];
   const models=p.catalog.map(model=>{const profile=profiles.providers?.[id]?.[model]||(id==='deepseek'?profiles.models?.[model]:null),reference=old.get(id)?.capabilities?.[model]?.performance;return {id:model,name:profile?.name||model,efforts:profile?.efforts||{},nativeEfforts:profile?.nativeEfforts||[],note:profile?.note||'',...(reference&&Number.isFinite(reference.tps)?{performance:{tps:reference.tps,observedAt:reference.observedAt}}:{})};});
   return {id,label:p.label,configured,models};
  });
 }
 async function runs(){return publicRuns(await github('/actions/workflows/'+WORKFLOW+'/runs?per_page=20'));}
 async function state({fresh=false}={}){
  if(!fresh&&cached&&now()-cacheAt<3000)return cached;
  const [content,list]=await Promise.all([github('/contents/.workbench/state.json?ref=main'),runs()]);let source;
  try{source=JSON.parse(Buffer.from(content.content,'base64').toString());}catch{throw fail('STATE_UNAVAILABLE',503);}
  const api=source.api||{},accounts=(api.officialAccounts||[]).map(a=>({id:a.id,label:a.label||a.emailMasked||'官方账号',status:a.status}));
  const active=list.find(r=>r.status!=='completed')||null,stale=!source.checkedAt||now()-Date.parse(source.checkedAt)>300000;
  cached={checkedAt:source.checkedAt||null,stale,redis:{status:['on','off','isolated','pending'].includes(source.redis?.status)?source.redis.status:'unknown',size:256,replicas:1},monitor:['on','off'].includes(source.monitor)?source.monitor:'unknown',ready:source.ready===true?true:source.ready===false?false:null,warnings:(source.warnings||[]).filter(s=>typeof s==='string').slice(0,5),api:{provider:api.provider,model:api.model,defaultEffort:api.defaultEffort||'standard',providers:catalog(api),accounts,accountId:api.accountId||null},runs:list,active};cacheAt=now();
  return cached;
 }
 function validate(input){
  if(!input||Object.keys(input).some(k=>!['action','provider','model','effort','accountId'].includes(k))||!['status','on','off','switch'].includes(input.action))throw fail('BAD_REQUEST');
  if(['status','on','off'].includes(input.action)){if(Object.keys(input).length!==1)throw fail('BAD_REQUEST');return {action:input.action};}
  const route=providers[input.provider],profile=profiles.providers?.[input.provider]?.[input.model]||(input.provider==='deepseek'?profiles.models?.[input.model]:null);
  if(!route||!route.catalog.includes(input.model)||!Object.hasOwn(profile?.efforts||{},input.effort)||(input.provider==='openai-codex'?env.OPENAI_CODEX_ENABLED!=='true'||!/^[a-f0-9]{32}$/.test(input.accountId||''):!env[route.key]||input.accountId!==undefined))throw fail('BAD_REQUEST');
  return {action:'switch',provider:input.provider,model:input.model,effort:input.effort,...(input.accountId?{accountId:input.accountId}:{})};
 }
 async function latest(){let low=0,high=1;while(await vault().get(numbered(high))){low=high;high=high*2+1;}while(high-low>1){const mid=Math.floor((low+high)/2);if(await vault().get(numbered(mid)))low=mid;else high=mid;}return {revision:low,value:low?(await vault().get(numbered(low))).value:null};}
 async function dispatch(input,id){
  if(!UUID.test(id||''))throw fail('REQUEST_ID_REQUIRED');const value=validate(input),fingerprint=digest(JSON.stringify(value)),base=PREFIX+'tasks/'+id+'/',previous=await vault().get(base+'request.json');
  if(previous){if(previous.value.fingerprint!==fingerprint)throw fail('REQUEST_CONFLICT',409);const closed=await vault().get(base+'closed.json');if(closed)return {id,action:value.action,status:'rejected',reused:true};const accepted=await vault().get(base+'accepted.json');return {id,action:value.action,status:accepted?'submitted':'uncertain',reused:true};}
  const list=await runs();if(list.some(r=>r.status!=='completed'))throw fail('TASK_ACTIVE',409);
  for(let attempt=0;attempt<4;attempt++){
   const last=await latest();
   if(last.value&&now()-last.value.at<20*60000){const task=last.value.id,finished=await vault().get(PREFIX+'tasks/'+task+'/closed.json');if(!finished){const run=list.find(r=>r.requestId===task);if(!run||run.status!=='completed')throw fail('TASK_ACTIVE',409);await vault().create(PREFIX+'tasks/'+task+'/closed.json',{at:now()});}}
   if(await vault().create(numbered(last.revision+1),{id,at:now()}))break;
   if(attempt===3)throw fail('TASK_ACTIVE',409);
  }
  if(!await vault().create(base+'request.json',{fingerprint,input:value,at:now()}))return {id,action:value.action,status:'submitted',reused:true};
  const inputs={action:value.action,request_id:id,...(value.provider?{provider:value.provider}:{}),...(value.model?{model:value.model}:{}),...(value.effort?{effort:value.effort}:{}),...(value.accountId?{account_id:value.accountId}:{})};
  try{await github('/actions/workflows/'+WORKFLOW+'/dispatches',{method:'POST',body:{ref:'main',inputs}});await vault().create(base+'accepted.json',{at:now()});}
  catch(error){if(error.safeToRetry){await vault().create(base+'closed.json',{at:now(),rejected:true});throw error;}throw fail('SUBMISSION_UNCERTAIN',503);}
  cached=null;return {id,action:value.action,status:'submitted'};
 }
 async function task(id){if(!/^\d{1,20}$/.test(String(id)))throw fail('NOT_FOUND',404);const list=await runs(),run=list.find(r=>String(r.id)===String(id));if(!run)throw fail('NOT_FOUND',404);const data=await github('/actions/runs/'+id+'/jobs?per_page=10');return {...run,jobs:(data.jobs||[]).map(j=>({name:j.name,status:j.status,conclusion:j.conclusion,steps:(j.steps||[]).filter(s=>!s.name.startsWith('Post ')).map(s=>({name:s.name,status:s.status,conclusion:s.conclusion}))}))};}
 async function probe(input,context,sid){
  if(!input||Object.keys(input).some(k=>!['provider','model','effort','accountId'].includes(k)))throw fail('BAD_REQUEST');
  const {action,...selection}=validate({action:'switch',...input}),bucket=PREFIX+'probe-rate/'+sid+'/'+Math.floor(now()/60000)+'/';let allowed=false;
  for(let n=0;n<6;n++)if(await vault().create(bucket+n+'.json',{at:now()})){allowed=true;break;}
  if(!allowed)throw fail('PROBE_RATE_LIMIT',429);
  try{const result=await (probeModel||require('./maintenance').runProbe)(selection,context);if(!result.passed)throw Error('PROBE_INCORRECT');return {passed:true,provider:selection.provider,model:selection.model,effort:selection.effort,latencyMs:result.latencyMs};}
  catch(error){const code=String(error.code||error.message||'');throw fail(/AUTH|PERMISSION|CREDENTIAL|REAUTHORIZE/.test(code)?'PROBE_AUTH':/RATE|QUOTA|BALANCE/.test(code)?'PROBE_QUOTA':/TIMEOUT/.test(code)?'PROBE_TIMEOUT':'PROBE_FAILED',502);}
 }
 async function handle(req,res,{headers,read,client='unknown'}={}){
  const path=new URL(req.url,'http://localhost').pathname.replace(/\/+$/,'');
  const json=(status,data)=>{res.writeHead(status,headers(req,{'Content-Type':'application/json; charset=utf-8'}));res.end(JSON.stringify(data));};
  try{
   if(req.method==='OPTIONS'){const method=String(req.headers['access-control-request-method']||''),allowed=path==='/console/session'?['POST','DELETE']:path==='/console/state'||/^\/console\/tasks\/\d{1,20}$/.test(path)?['GET']:['/console/actions','/console/probe'].includes(path)?['POST']:[];if(!allowed.includes(method))return json(404,{error:{message:'BEICHEN_CONSOLE_NOT_FOUND'}});res.writeHead(204,headers(req));return res.end();}
   if(path==='/console/session'&&req.method==='POST')return json(200,await login(await read(req,2048),client));
   const session=await auth(req);
   if(path==='/console/session'&&req.method==='DELETE'){await vault().create(PREFIX+'revoked/'+session.sid+'.json',{at:now()});return json(200,{ok:true});}
   if(path==='/console/state'&&req.method==='GET')return json(200,await state());
   if(path==='/console/actions'&&req.method==='POST')return json(202,await dispatch(await read(req,4096),req.headers['x-request-id']));
   if(path==='/console/probe'&&req.method==='POST')return json(200,await probe(await read(req,4096),{req,res},session.sid));
   const match=path.match(/^\/console\/tasks\/(\d{1,20})$/);if(match&&req.method==='GET')return json(200,await task(match[1]));
   throw fail('NOT_FOUND',404);
  }catch(error){console.warn(JSON.stringify({ev:'console_error',route:path,code:/^[A-Z0-9_]+$/.test(error.code||error.message||'')?(error.code||error.message):error.name,networkStatus:error.diagnostic?.status}));return json(error.code?.startsWith('BEICHEN_CONSOLE_')?error.status:503,{error:{message:error.code?.startsWith('BEICHEN_CONSOLE_')?error.code:'BEICHEN_CONSOLE_UNAVAILABLE',...(!error.code?.startsWith('BEICHEN_CONSOLE_')?{reason:/^[A-Z0-9_]+$/.test(error.code||error.message||'')?(error.code||error.message):error.name}:{}),...(error.safeToRetry?{safeToRetry:true}:{})}});}
 }
 return {handle,login,auth,state,dispatch,task,validate,probe};
}
let instance;
function handle(req,res,{securityHeaders,readJson,matchingTotpCounter,client}={}){instance||=createConsole({matchTotp:matchingTotpCounter});return instance.handle(req,res,{headers:securityHeaders,read:readJson,client});}
module.exports={createConsole,handle,TTL};
