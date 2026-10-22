'use strict';
require('./runtime-compat');
// Server-to-server operations for the private GitHub Actions workbench.
// The browser receives only masked account metadata; no OAuth credentials.
const crypto=require('node:crypto'),providers=require('./api-providers.json'),images=require('./image-providers.json'),{modelProfile}=require('./model-adapter');
const {createControl,secureStore}=require('./official/codex-accounts.cjs');
const fail=(code,status=400)=>Object.assign(Error(code),{status,code});
async function relayProbe(input,{req,res}={}){
 const route=providers[input.provider];if(!route||!process.env[route.key])throw fail('BEICHEN_PROVIDER_NOT_CONFIGURED',503);
 const {EventEmitter}=require('node:events'),request=new EventEmitter(),response=new EventEmitter();request.headers={};request.method='POST';let source='',diagnostic={};
 response.headersSent=false;response.destroyed=false;response.writableEnded=false;response.writeHead=()=>{response.headersSent=true;};response.write=chunk=>(source+=chunk,true);response.end=chunk=>{source+=chunk||'';response.writableEnded=true;};
 const abort=()=>{request.emit('aborted');response.emit('close');};req?.once('aborted',abort);res?.once('close',abort);
 try{
  await require('./scf-relay').proxyChat(request,response,{messages:[{role:'system',content:'只回复计算结果的整数，不输出其他内容。'},{role:'user',content:'37×19'}],effort:input.effort,max_tokens:256,stream:true},{name:input.provider,model:input.model,key:process.env[route.key],auth:'bearer',protocol:route.protocol,url:route.url,probe:true,onDiagnostic:row=>{diagnostic={...diagnostic,...row};}});
  let output='',finished=false;for(const line of source.split('\n'))if(line.startsWith('data: ')){const value=line.slice(6);if(value==='[DONE]'){finished=true;continue;}const e=JSON.parse(value);if(e.error)throw fail('BEICHEN_UPSTREAM_ERROR',502);for(const c of e.choices||[])output+=c.delta?.content||'';}
  if(!finished)throw fail('BEICHEN_UPSTREAM_INCOMPLETE',502);return {output};
 }catch(error){error.probeDiagnostic=diagnostic;throw error;}finally{req?.removeListener('aborted',abort);res?.removeListener('close',abort);}
}
function signature(secret,method,path,time,nonce,body){return crypto.createHmac('sha256',secret).update([method,path,time,nonce,crypto.createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');}
async function authorize(req,path,body,{env=process.env,now=Date.now,store}={}){
 const key=env.BEICHEN_WORKBENCH_SECRET,t=req.headers['x-beichen-time'],nonce=req.headers['x-beichen-nonce'],supplied=req.headers['x-beichen-signature'];
 if(typeof key!=='string'||key.length<32||!/^\d{10}$/.test(t||'')||Math.abs(now()/1000-Number(t))>60||!/^[a-f0-9-]{36}$/.test(nonce||'')||!/^[a-f0-9]{64}$/.test(supplied||''))throw fail('BEICHEN_OPERATIONS_UNAUTHORIZED',401);
 const expected=signature(key,req.method,path,t,nonce,body);if(!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(supplied)))throw fail('BEICHEN_OPERATIONS_UNAUTHORIZED',401);
 const vault=store||secureStore({env});if(!await vault.create('openai-codex/beichen-maintenance/nonces/'+nonce+'.json',{at:now(),path}))throw fail('BEICHEN_OPERATIONS_REPLAY',409);
}
function imageCatalog(env=process.env){return Object.entries(images).map(([id,p])=>({id,label:p.label,model:p.model,protocol:p.protocol,configured:!!env[p.credentialRef],selected:env.AI_IMAGE_PROVIDER===id}));}
async function handle(req,res,{securityHeaders,rawBody,control,complete,authOptions}={}){
 const path=new URL(req.url,'http://localhost').pathname,body=rawBody??await new Promise((yes,no)=>{const chunks=[];let size=0;req.on('data',c=>{size+=c.length;if(size>8192){no(fail('BEICHEN_BAD_REQUEST'));req.pause();}else chunks.push(c);});req.once('end',()=>yes(Buffer.concat(chunks).toString('utf8')));req.once('error',no);});
 await authorize(req,path,body,authOptions);const accounts=control||createControl();let data;
 if(req.method==='GET'&&path==='/maintenance/accounts')data={...await accounts.accounts(),selectedAccountId:process.env.OPENAI_CODEX_ACCOUNT_ID||null,imageProviders:imageCatalog()};
 else if(req.method==='POST'&&path==='/maintenance/probe'){
  let input;try{input=JSON.parse(body);}catch{throw fail('BEICHEN_BAD_REQUEST');}
  if(!input||Object.keys(input).some(k=>!['provider','model','effort','accountId'].includes(k))||!Object.hasOwn(providers,input.provider)||!providers[input.provider].catalog.includes(input.model)||!Object.hasOwn(modelProfile({name:input.provider,model:input.model})?.efforts||{},input.effort)||(input.provider==='openai-codex'?!/^[a-f0-9]{32}$/.test(input.accountId||''):!!input.accountId))throw fail('BEICHEN_BAD_REQUEST');
  const started=Date.now();let result;try{result=input.provider==='openai-codex'?await (complete||require('./official-chat').complete)({messages:[{role:'system',content:'只回复计算结果的整数，不输出其他内容。'},{role:'user',content:'37×19'}],effort:input.effort},{name:'openai-codex',model:input.model,accountId:input.accountId},{timeoutMs:170000,control:accounts,probe:true}):await relayProbe(input,{req,res});}catch(error){if(!error.probeDiagnostic)throw error;res.writeHead(error.status||502,securityHeaders?securityHeaders(req,{'Content-Type':'application/json; charset=utf-8'}):{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});return res.end(JSON.stringify({error:{message:error.code||'BEICHEN_UPSTREAM_ERROR'},diagnostic:error.probeDiagnostic}));}
  if(!/^703[。.!]?$/.test(String(result.output).replace(/[*`]/g,'').trim()))throw fail('BEICHEN_PROBE_INCORRECT',502);
  data={passed:true,model:input.model,accountId:input.accountId,effort:input.effort,latencyMs:Date.now()-started,usage:result.usage};
 }else throw fail('BEICHEN_NOT_FOUND',404);
 const headers=securityHeaders?securityHeaders(req,{'Content-Type':'application/json; charset=utf-8'}):{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};res.writeHead(200,headers);res.end(JSON.stringify(data));
}
module.exports={signature,authorize,handle,imageCatalog,relayProbe};
