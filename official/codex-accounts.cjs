'use strict';
// This vault is deliberately separate from ChatGPT plan/SIWC credentials.
const crypto=require('node:crypto');
const {COSStore}=require('./store.cjs'),{cos}=require('./tencent.cjs');
const prefix='openai-codex/',uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const accountId=/^[a-f0-9]{32}$/;
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const subject=auth=>{try{const value=JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1],'base64url')).sub;return typeof value==='string'?value:null;}catch{return null;}};
const publicQuota=value=>Object.fromEntries(['fetchedAt','rateLimits','rateLimitsByLimitId'].filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
const storageFailure=error=>/^(?:STORE_UNAVAILABLE|CODEX_AUTH_PERSIST_FAILED|NETWORK_|ECONN|ETIMEDOUT|EPIPE|CLOUD_)/.test(error?.message||error?.code||'');
const failure=(code,status=400)=>Object.assign(Error(code),{status});
const numbered=(base,n)=>prefix+base+'/'+String(n).padStart(10,'0')+'.json';
async function latest(store,base){
 let low=0,high=1;
 while(await store.get(numbered(base,high))){low=high;high=high*2+1;}
 while(high-low>1){const mid=Math.floor((high+low)/2);if(await store.get(numbered(base,mid)))low=mid;else high=mid;}
 return {revision:low,value:low?(await store.get(numbered(base,low)))?.value:null};
}
function secureStore({env=process.env,auth}={}){
 const s=new COSStore({bucket:env.TRAINING_BUCKET,region:env.TRAINING_REGION||'ap-chengdu',auth,prefix:'training-control-v1/'});
 const checked=key=>{if(!key.startsWith(prefix)||key.includes('..'))throw failure('CODEX_STORE_KEY_INVALID');return key;};
 return {get:key=>s.get(checked(key)),async create(key,value){
  const r=await cos(s.host,'/'+s.prefix+checked(key),{method:'PUT',body:JSON.stringify(value),headers:{'Content-Type':'application/json','x-cos-forbid-overwrite':'true','x-cos-server-side-encryption':'AES256'},auth:s.auth});
  if(r.status===409)return false;if(r.status!==200)throw Object.assign(failure('CODEX_AUTH_PERSIST_FAILED',503),{diagnostic:{kind:'store',status:r.status}});return true;
 }};
}
function validAuth(auth){return !!auth&&typeof auth==='object'&&!Array.isArray(auth)&&(!auth.auth_mode||auth.auth_mode==='chatgpt')&&!auth.OPENAI_API_KEY&&['access_token','refresh_token','id_token','account_id'].every(k=>typeof auth.tokens?.[k]==='string'&&auth.tokens[k].length>0);}
function identity(account,auth){
 if(account?.type!=='chatgpt'||!validAuth(auth))throw failure('CODEX_ACCOUNT_IDENTITY_INVALID');
 // Official account/read permits a null email. Claims from the official
 // runtime's just-authorized token are used only as a stable storage key,
 // never to bypass the runtime's OAuth validation or infer permissions.
 let claims={};try{claims=JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1],'base64url'));}catch{}
 const email=String(account.email||claims.email||'').trim().toLowerCase(),principal=typeof claims.sub==='string'&&claims.sub?claims.sub:email;
 if(!principal)throw failure('CODEX_ACCOUNT_IDENTITY_INVALID');
 const split=email.indexOf('@'),masked=split>0?email.slice(0,Math.min(2,split))+'***'+email.slice(split):'已授权账号';
 const id=hash(auth.tokens.account_id+'\n'+principal).slice(0,32);
 return {id,emailMasked:masked,label:masked+' · '+id.slice(-4),planType:String(account.planType||'unknown').slice(0,60)};
}
const safeError=error=>{
 const code=error?.message||'';
 if(code==='LOGIN_CANCELLED'||error?.name==='AbortError')return 'JOB_CANCELLED';
 if(code==='LOGIN_TIMEOUT'||code==='LOGIN_FAILED'&&/timed out/i.test(error?.diagnostic?.reason||''))return 'CODEX_AUTHORIZATION_EXPIRED';
 if(code==='LOGIN_FAILED')return 'CODEX_AUTHORIZATION_FAILED';
 if(code==='LOGIN_URL_UNTRUSTED')return 'CODEX_AUTHORIZATION_URL_INVALID';
 return /^(CODEX_[A-Z_]{2,60}|MODEL_(?:AUTH_FAILED|RATE_LIMIT|UPSTREAM_TIMEOUT|REQUEST_FAILED|INCOMPLETE)|JOB_CANCELLED)$/.test(code)?code:'CODEX_RUNTIME_UNAVAILABLE';
};
function diagnostics(error){
 const rows=[];for(let i=0;error&&i<4;i++,error=error.cause){const d=error.diagnostic||{},row={code:/^[A-Z_]{2,70}$/.test(error.message||'')?error.message:'UNCLASSIFIED'};
  for(const k of ['kind','phase','method','field','feature','reason','exitCode','rpcCode','status'])if(typeof d[k]==='number'||typeof d[k]==='string'&&/^[a-zA-Z0-9_/ .-]{1,120}$/.test(d[k]))row[k]=d[k];
  if(typeof d.message==='string')row.message=d.message.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[REDACTED]').replace(/\bsk-[A-Za-z0-9_-]+/g,'[REDACTED]').slice(0,800);
  rows.push(row);
 }return rows;
}
function createControl({store,jobStore,owner,env=process.env,now=Date.now,dispatch=async()=>{},runtimeFactory,runtimeMethods,network}={}){
 const enabled=()=>env.OPENAI_CODEX_ENABLED==='true';
 const vault=()=>store||(store=secureStore({env}));
 const registry=async()=>({revision:0,activeId:null,accounts:[],...(await latest(vault(),'registry')).value});
 const checkEnabled=()=>{if(!enabled())throw failure('CODEX_NOT_ENABLED');};
 const methods=()=>runtimeMethods||require('./codex-runtime.cjs');
 const checkAccount=id=>{if(!accountId.test(id||''))throw failure('CODEX_ACCOUNT_ID_INVALID');};
 const checkUuid=id=>{if(!uuid.test(id||''))throw failure('CODEX_OPERATION_ID_INVALID');};
 async function edit(update,{expectedRevision}={}){
  for(let n=0;n<8;n++){
   const old=await registry();if(expectedRevision!==undefined&&expectedRevision!==old.revision)throw failure('CODEX_REVISION_CONFLICT',409);
   const updated=await update(structuredClone(old));if(updated===null)return old;
   const next={...updated,revision:old.revision+1,updatedAt:now()};
   if(await vault().create(numbered('registry',next.revision),next))return next;
   if(expectedRevision!==undefined)throw failure('CODEX_REVISION_CONFLICT',409);
  }
  throw failure('CODEX_REVISION_CONFLICT',409);
 }
 async function entry(id){checkAccount(id);const value=(await registry()).accounts.find(a=>a.id===id);if(!value)throw failure('CODEX_ACCOUNT_NOT_FOUND',404);return value;}
 async function accounts(){
  if(!enabled())return {enabled:false,revision:0,activeId:null,accounts:[]};
  const current=await registry(),rows=[];
  for(const a of current.accounts){const saved=(await latest(vault(),'quota/'+a.id)).value,quota=saved?.epoch===a.epoch?publicQuota(saved):null;rows.push({id:a.id,label:a.label,emailMasked:a.emailMasked,planType:a.planType,active:current.activeId===a.id,status:a.status||'ready',authorizedAt:a.authorizedAt,...(quota?{quota}:{})});}
  return {enabled:true,revision:current.revision,activeId:current.activeId,accounts:rows};
 }
 async function activate(input){
  checkEnabled();if(!input||Object.keys(input).some(k=>!['accountId','expectedRevision'].includes(k))||!Number.isSafeInteger(input.expectedRevision))throw failure('CODEX_INPUT_INVALID');
  const a=await entry(input.accountId);if(a.status!=='ready')throw failure('CODEX_ACCOUNT_REAUTH_REQUIRED',409);
  await edit(old=>({...old,activeId:a.id}),{expectedRevision:input.expectedRevision});return accounts();
 }
 async function markReauth(a){await edit(old=>({...old,accounts:old.accounts.map(row=>row.id===a.id&&row.epoch===a.epoch?{...row,status:'reauthorize'}:row)}));}
 async function lease(a){
  const base='leases/'+a.id+'/'+a.epoch;
  for(let n=0;n<4;n++){
   const last=await latest(vault(),base);
   const previous=prefix+base+'/'+last.revision+'/';
   if(last.value&&!await vault().get(previous+'released.json')&&await vault().get(previous+'closed.json'))await vault().create(previous+'released.json',{at:now(),recovered:true});
   if(last.value&&!await vault().get(previous+'released.json')){
    // An abandoned runtime could have rotated its refresh token. Never replay
    // that snapshot or steal the lease after a guessed timeout.
    if(now()-last.value.at>900000){await markReauth(a);throw failure('CODEX_ACCOUNT_REAUTH_REQUIRED',409);}
    throw failure('CODEX_ACCOUNT_BUSY',409);
   }
   const revision=last.revision+1;
   if(await vault().create(numbered(base,revision),{at:now(),owner:crypto.randomUUID()}))return async()=>{
    const key=prefix+base+'/'+revision+'/';
    for(let retry=0;retry<3;retry++)try{await vault().create(key+'closed.json',{at:now()});await vault().create(key+'released.json',{at:now()});return;}catch(e){if(await vault().get(key+'released.json').catch(()=>null))return;if(retry===2)throw e;}
   };
  }
  throw failure('CODEX_ACCOUNT_BUSY',409);
 }
 async function runtime(options,fn){
  const create=runtimeFactory||require('./codex-runtime.cjs').createRuntime;
  const run=async()=>{
   let finalAuth=options.auth,rt;const controller=new AbortController(),signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal,timer=setTimeout(()=>controller.abort(),options.timeoutMs||840000);
   try{rt=await create({binaryPath:env.OPENAI_CODEX_BINARY,proxyUrl:'http://127.0.0.1:18080',...options,signal,onAuth:async auth=>{await options.onAuth?.(auth);finalAuth=structuredClone(auth);}});let value,error;try{value=await fn(rt);}catch(e){error=e;}try{await rt.close();}catch(e){error=e;}if(controller.signal.aborted&&!options.signal?.aborted)throw failure('MODEL_UPSTREAM_TIMEOUT');if(error)throw error;if(value?.auth)value.auth=finalAuth||value.auth;return value;}finally{clearTimeout(timer);}
  };
  return (network||require('./openai-proxy.cjs').withProxy)(run);
 }
 async function withAccount(id,fn,{signal,timeoutMs=840000}={}){
  checkEnabled();const a=await entry(id);if(a.status!=='ready')throw failure('CODEX_ACCOUNT_REAUTH_REQUIRED',409);
  const release=await lease(a),base='auth/'+a.id+'/'+a.epoch;let last,digest;
  try{
   const current=await entry(id);if(current.epoch!==a.epoch||current.status!=='ready')throw failure('CODEX_ACCOUNT_BUSY',409);
   last=await latest(vault(),base);digest=last.value?.digest;
   if(!validAuth(last.value?.auth))throw failure('CODEX_ACCOUNT_REAUTH_REQUIRED',409);
   const initialAuth=last.value.auth;let saving=Promise.resolve();
   const save=auth=>saving=saving.then(async()=>{if(!validAuth(auth))throw failure('CODEX_AUTH_PERSIST_FAILED',503);if(auth.tokens.account_id!==initialAuth.tokens.account_id||subject(initialAuth)&&subject(auth)!==subject(initialAuth))throw failure('CODEX_ACCOUNT_IDENTITY_INVALID');const nextDigest=hash(JSON.stringify(auth));if(nextDigest===digest)return;const revision=last.revision+1,key=numbered(base,revision);if(!await vault().create(key,{auth,digest:nextDigest,at:now()})&&(await vault().get(key))?.value.digest!==nextDigest)throw failure('CODEX_AUTH_PERSIST_FAILED',503);last={revision};digest=nextDigest;});
   return await runtime({auth:last.value.auth,onAuth:save,signal,timeoutMs},async rt=>{
    const account=(await rt.call('account/read',{refreshToken:false})).account;
    if(identity(account,rt.getAuth()).id!==id)throw failure('CODEX_ACCOUNT_IDENTITY_INVALID');
    return fn(rt,a);
   });
  }catch(e){if(['CODEX_AUTH_PERSIST_FAILED','CODEX_ACCOUNT_REAUTH_REQUIRED','MODEL_AUTH_FAILED','CODEX_ACCOUNT_IDENTITY_INVALID'].includes(e.message))await markReauth(a);throw e;}
  finally{await release().catch(()=>{});}
 }
 async function enqueue(type,input={},requestId){
  checkEnabled();const id=requestId||crypto.randomUUID();checkUuid(id);
  if(!jobStore||!owner)throw failure('CODEX_JOBS_UNAVAILABLE',503);
  const key='jobs/'+owner+'/'+id,old=(await jobStore.get(key+'/meta.json'))?.value;
  const fingerprint=hash(JSON.stringify({type,input:Object.fromEntries(Object.keys(input).sort().map(k=>[k,input[k]]))}));
  if(old){if(old.fingerprint!==fingerprint)throw failure('REQUEST_ID_CONFLICT',409);return type==='codex-login'?status(id):{id,...await operation(id),expiresAt:old.deadline};}
  const createdAt=now(),deadline=createdAt+(type==='codex-login'?870000:180000);
  if(type==='codex-login'){
   const current=await registry(),key=prefix+'attempts/'+id+'/request.json';
   if(!await vault().create(key,{...input,id,owner,fingerprint,createdAt,deadline,baseActiveId:current.activeId})){const saved=(await vault().get(key))?.value;if(saved?.fingerprint!==fingerprint||saved?.owner!==owner)throw failure('REQUEST_ID_CONFLICT',409);}
  }
  const created=await jobStore.create(key+'/meta.json',{id,type,input,fingerprint,createdAt,deadline,status:'queued'}),saved=(await jobStore.get(key+'/meta.json'))?.value;
  if(saved?.fingerprint!==fingerprint)throw failure('REQUEST_ID_CONFLICT',409);
  if(created)await dispatch(key);
  return {id,status:'queued',expiresAt:deadline};
 }
 async function begin(input={},id){
  checkEnabled();
  if(!plain(input)||Object.keys(input).some(k=>!['mode','accountId','flow'].includes(k))||!['browser','device'].includes(input.flow||'browser')||!['add','reauthorize'].includes(input.mode||'add')||(input.mode||'add')==='add'&&input.accountId)throw failure('CODEX_INPUT_INVALID');
  if(input.mode==='reauthorize')await entry(input.accountId);
  return enqueue('codex-login',{mode:input.mode||'add',flow:input.flow||'browser',...(input.accountId?{accountId:input.accountId}:{})},id);
 }
 async function status(id){
  checkEnabled();checkUuid(id);const base=prefix+'attempts/'+id+'/',request=(await vault().get(base+'request.json'))?.value;if(!request||request.owner!==owner)throw failure('CODEX_OPERATION_NOT_FOUND',404);
  let result=(await vault().get(base+'result.json'))?.value;const terminal=(await vault().get(base+'terminal.json'))?.value;
  if(result?.status==='complete')return {id,expiresAt:request.deadline,...result};
  if(terminal?.status==='cancelled')return {id,status:'cancelled',expiresAt:request.deadline};
  // A verified recovery is separate from the immutable original failure.
  // It must point to a committed, same-owner repair of this exact attempt.
  const recovered=(await vault().get(base+'recovered.json'))?.value;
  if(recovered?.status==='complete'&&recovered.officialQuotaVerified&&uuid.test(recovered.id||'')&&accountId.test(recovered.accountId||'')){
   const repairBase=prefix+'attempts/'+recovered.id+'/',repair=(await vault().get(repairBase+'request.json'))?.value,saved=(await vault().get(repairBase+'result.json'))?.value;
   if(repair?.owner===owner&&repair.sourceAttempt===id&&saved?.status==='complete'&&saved.accountId===recovered.accountId)return {id,status:'complete',accountId:recovered.accountId,finishedAt:saved.finishedAt,expiresAt:request.deadline,recovered:true};
  }
  if(result)return {id,expiresAt:request.deadline,...result};
  if(await vault().get(base+'candidate.json')){await recoverLogin(id,request);result=(await vault().get(base+'result.json'))?.value;if(result)return {id,expiresAt:request.deadline,...result};}
  if(now()>request.deadline)return {id,status:'expired',expiresAt:request.deadline};
  const browser=(await vault().get(base+'browser.json'))?.value;
  if(browser){
   const expiresAt=Number.isFinite(browser.at)?Math.min(request.deadline,browser.at+600000):request.deadline;
   if(now()>expiresAt)return {id,status:'expired',flow:'browser',expiresAt};
   const submitted=(await vault().get(base+'callback.json'))?.value;
   let callbackStage=submitted?'received':null,stageAt=submitted?.at;
   for(const stage of ['exchanging','confirming','saving']){const checkpoint=(await vault().get(base+'stage-'+stage+'.json'))?.value;if(checkpoint){callbackStage=stage;stageAt=checkpoint.at;}}
   return {id,status:'waiting',flow:'browser',expiresAt,authorizationUrl:browser.authorizationUrl,callbackSubmitted:!!submitted,...(callbackStage?{callbackStage,stageAt}:{})};
  }
  const device=(await vault().get(base+'device.json'))?.value;
  return {id,status:device?'waiting':'queued',flow:request.flow||'device',expiresAt:request.deadline,...(device?{verificationUrl:device.verificationUrl,userCode:device.userCode}:{})};
 }
 async function submitCallback(id,input){
  checkEnabled();checkUuid(id);
  if(!plain(input)||Object.keys(input).some(k=>k!=='callbackUrl')||typeof input.callbackUrl!=='string')throw failure('CODEX_INPUT_INVALID');
  const base=prefix+'attempts/'+id+'/',request=(await vault().get(base+'request.json'))?.value;
  if(!request||request.owner!==owner)throw failure('CODEX_OPERATION_NOT_FOUND',404);
  const result=(await vault().get(base+'result.json'))?.value;
  if(result?.status==='complete')return {id,status:'complete'};
  if(result||await vault().get(base+'terminal.json'))throw failure('CODEX_AUTHORIZATION_CONFLICT',409);
  if(now()>request.deadline)throw failure('CODEX_AUTHORIZATION_EXPIRED',410);
  const browser=(await vault().get(base+'browser.json'))?.value;
  if(request.flow!=='browser'||!browser)throw failure('CODEX_CALLBACK_NOT_READY',409);
  const callbackUrl=require('./browser-oauth.cjs').callback(input.callbackUrl,browser.authorizationUrl),key=base+'callback.json';
  const value={callbackUrl,digest:hash(callbackUrl),at:now()};
  if(!await vault().create(key,value)&&(await vault().get(key))?.value.digest!==value.digest)throw failure('CODEX_CALLBACK_ALREADY_SUBMITTED',409);
  return {id,status:'accepted',callbackSubmitted:true};
 }
 async function cancel(id){
  checkEnabled();checkUuid(id);const base=prefix+'attempts/'+id+'/',request=(await vault().get(base+'request.json'))?.value;
  if(!request||request.owner!==owner)throw failure('CODEX_OPERATION_NOT_FOUND',404);
  const result=(await vault().get(base+'result.json'))?.value;if(result?.status==='complete')return {id,expiresAt:request.deadline,...result};
  if(!await vault().create(base+'terminal.json',{status:'cancelled',at:now()})){
   const terminal=(await vault().get(base+'terminal.json'))?.value;if(terminal?.status==='committing')throw failure('CODEX_AUTHORIZATION_IN_PROGRESS',409);
   if(terminal?.status!=='cancelled')throw failure('CODEX_CANCEL_CONFLICT',409);
  }
  return status(id);
 }
 async function operation(id){
  checkEnabled();checkUuid(id);const key='jobs/'+owner+'/'+id,job=(await jobStore.get(key+'/meta.json'))?.value;
  if(!job||!['codex-quota','codex-wake'].includes(job.type))throw failure('CODEX_OPERATION_NOT_FOUND',404);
  const result=(await jobStore.get(key+'/result.json'))?.value;
  if(result)return {id,...result};
  return {id,status:now()>job.deadline?'failed':await jobStore.get(key+'/run.json')?'running':'queued',...(now()>job.deadline?{error:'CODEX_OPERATION_EXPIRED'}:{})};
 }
 async function queueAccount(id,type,input={},requestId){
  checkEnabled();if(!plain(input))throw failure('CODEX_INPUT_INVALID');await entry(id);if(type==='quota'){if(Object.keys(input).length)throw failure('CODEX_INPUT_INVALID');}
  else if(type!=='wake'||Object.keys(input).some(k=>!['model','effort'].includes(k))||!/^[a-zA-Z0-9._-]{1,100}$/.test(input.model||'')||!/^[a-zA-Z0-9_-]{1,30}$/.test(input.effort||''))throw failure('CODEX_INPUT_INVALID');
  return enqueue('codex-'+type,{accountId:id,...input},requestId);
 }
 async function commitAccount(account,auth,request,epoch,at){
  const info=identity(account,auth);if(request.accountId&&request.accountId!==info.id)throw failure('CODEX_ACCOUNT_IDENTITY_MISMATCH');
  if(!uuid.test(epoch||''))throw failure('CODEX_AUTH_CANDIDATE_INVALID');
  const base='auth/'+info.id+'/'+epoch,key=numbered(base,1),digest=hash(JSON.stringify(auth));
  if(!await vault().create(key,{auth,digest,at})&&(await vault().get(key))?.value.digest!==digest)throw failure('CODEX_AUTH_CANDIDATE_INVALID');
  await edit(old=>{
   const existing=old.accounts.find(a=>a.id===info.id);
   if(existing?.epoch===epoch||existing?.authorizedAt>at)return null;
   return {...old,activeId:!old.activeId||old.activeId===request.baseActiveId?info.id:old.activeId,accounts:[{...info,epoch,status:'ready',authorizedAt:at},...old.accounts.filter(a=>a.id!==info.id)]};
  });
  return info;
 }
 async function recoverLogin(id,request){
  if(request.owner!==owner)throw failure('CODEX_OPERATION_NOT_FOUND',404);
  const base=prefix+'attempts/'+id+'/',key='jobs/'+owner+'/'+id;
  const done=(await vault().get(base+'result.json'))?.value;if(done)return done;
  let terminal=(await vault().get(base+'terminal.json'))?.value;
  if(terminal?.status==='cancelled'){const value={status:'cancelled',finishedAt:now()};await vault().create(base+'result.json',value);await jobStore.create(key+'/result.json',{status:'failed',error:'JOB_CANCELLED',finishedAt:now()});return value;}
  const candidate=(await vault().get(base+'candidate.json'))?.value;if(!candidate)return null;
  if(candidate.at>request.deadline||candidate.digest!==hash(JSON.stringify(candidate.auth))||identity(candidate.account,candidate.auth).id!==candidate.accountId)throw failure('CODEX_AUTH_CANDIDATE_INVALID');
  if(!terminal){await vault().create(base+'terminal.json',{status:'committing',epoch:candidate.epoch,digest:candidate.digest,at:now()});terminal=(await vault().get(base+'terminal.json'))?.value;}
  if(terminal?.status==='cancelled')return recoverLogin(id,request);
  if(terminal?.status!=='committing'||terminal.epoch!==candidate.epoch||terminal.digest!==candidate.digest)throw failure('CODEX_AUTH_CANDIDATE_INVALID');
  const a=await commitAccount(candidate.account,candidate.auth,request,candidate.epoch,candidate.at),value={status:'complete',accountId:a.id,finishedAt:now()};
  await vault().create(base+'result.json',value);await jobStore.create(key+'/result.json',{status:'ready',finishedAt:now()});return value;
 }
 async function run(key,job){
  if(!await jobStore.create(key+'/run.json',{startedAt:now(),deadlineAt:job.deadline})){
   if(job.type==='codex-login'&&!await vault().get(prefix+'attempts/'+job.id+'/result.json')){const request=(await vault().get(prefix+'attempts/'+job.id+'/request.json'))?.value;if(request?.owner===owner&&await recoverLogin(job.id,request))return {recovered:true};}
   return {skipped:true};
  }
  if(job.type==='codex-login'){
   const base=prefix+'attempts/'+job.id+'/',request=(await vault().get(base+'request.json'))?.value;
   if(!request||request.owner!==owner)return {skipped:true};
   try{
    if(await vault().get(base+'terminal.json')){await recoverLogin(job.id,request);return {cancelled:true};}
    if(now()>request.deadline)throw failure('CODEX_OPERATION_EXPIRED');
    let cancelled=false,nextCancelRead=0,nextCallbackRead=0;
    const result=await runtime({timeoutMs:Math.max(1000,Math.min(840000,job.deadline-now()-15000)),onAuth:async auth=>{if(validAuth(auth))await vault().create(base+'candidate-'+hash(JSON.stringify(auth))+'.json',{auth,at:now()});}},rt=>methods().login(rt,{
     flow:request.flow||'device',deadlineMs:Math.max(1000,Math.min(840000,job.deadline-now()-15000)),
     onStage:async stage=>{if(['exchanging','confirming','saving'].includes(stage))await vault().create(base+'stage-'+stage+'.json',{at:now()}).catch(()=>{});},
     isCancelled:async()=>{if(now()>=nextCancelRead){cancelled=!!await vault().get(base+'terminal.json');nextCancelRead=now()+1200;}return cancelled;},
     readCallback:async()=>{if(now()<nextCallbackRead)return null;nextCallbackRead=now()+1200;return (await vault().get(base+'callback.json'))?.value.callbackUrl||null;},
     onReady:async ready=>{
      if(ready.flow==='browser'){
       const checked=require('./browser-oauth.cjs').authorization(ready.authorizationUrl);
       await vault().create(base+'browser.json',{authorizationUrl:checked.authorizationUrl,at:now()});
      }else await vault().create(base+'device.json',{verificationUrl:ready.verificationUrl,userCode:ready.userCode,at:now()});
     }
    }));
    if(now()>request.deadline)throw failure('CODEX_OPERATION_EXPIRED');
    const info=identity(result.account,result.auth);if(request.accountId&&request.accountId!==info.id)throw failure('CODEX_ACCOUNT_IDENTITY_MISMATCH');
    const candidate={account:result.account,accountId:info.id,auth:result.auth,digest:hash(JSON.stringify(result.auth)),epoch:crypto.randomUUID(),at:now()};
    if(!await vault().create(base+'candidate.json',candidate)){const saved=(await vault().get(base+'candidate.json'))?.value;if(saved?.digest!==candidate.digest)throw failure('CODEX_AUTH_CANDIDATE_INVALID');}
    const saved=await recoverLogin(job.id,request);return {ok:saved?.status==='complete'};
   }catch(e){
    await vault().create(base+'diagnostic.json',{at:now(),errors:diagnostics(e)}).catch(()=>{});
    if(storageFailure(e)&&await vault().get(base+'candidate.json'))throw failure('CODEX_AUTH_COMMIT_PENDING',503);
    const terminal=(await vault().get(base+'terminal.json'))?.value,code=terminal?.status==='cancelled'?'JOB_CANCELLED':safeError(e),status=code==='JOB_CANCELLED'?'cancelled':code==='CODEX_OPERATION_EXPIRED'?'expired':'failed';
    const value={status,error:code,finishedAt:now()};await vault().create(base+'result.json',value);await jobStore.create(key+'/result.json',{status:'failed',error:code,finishedAt:now()});return {ok:false};
   }
  }
  try{
   const result=await withAccount(job.input.accountId,async(rt,a)=>{
    if(job.type==='codex-quota'){
     const raw=await methods().readQuota(rt),quota={epoch:a.epoch,fetchedAt:now(),...(raw.rateLimits?{rateLimits:raw.rateLimits}:{}),...(raw.rateLimitsByLimitId?{rateLimitsByLimitId:raw.rateLimitsByLimitId}:{})};
     for(let retry=0;retry<4;retry++){const old=await latest(vault(),'quota/'+job.input.accountId);if(old.value?.epoch===a.epoch&&old.value.fetchedAt>quota.fetchedAt)return {quota:publicQuota(old.value)};if(await vault().create(numbered('quota/'+job.input.accountId,old.revision+1),quota))return {quota:publicQuota(quota)};}
     throw failure('CODEX_QUOTA_SAVE_PENDING',503);
    }
    const started=now(),generation={provider:'openai-codex',protocol:'codex',model:job.input.model,effort:job.input.effort,reasoningEffort:job.input.effort==='deep'?'high':job.input.effort};
    const result=await methods().complete(rt,{system:'只回复一个JSON对象，不调用工具。计算37乘19，字段value为结果。',input:{task:'37×19'}},generation,{probe:true});
    let parsed;try{parsed=JSON.parse(result.output);}catch{throw failure('MODEL_INCOMPLETE');}if(parsed.value!==703)throw failure('MODEL_INCOMPLETE');
    return {probe:{passed:true,latencyMs:now()-started},model:result.model,reasoningEffort:result.reasoningEffort,...(result.usage?{usage:result.usage}:{})};
   },{timeoutMs:Math.max(1000,Math.min(150000,job.deadline-now()-15000))});
   await jobStore.create(key+'/result.json',{status:'ready',...result,finishedAt:now()});return {ok:true};
  }catch(e){await jobStore.create(key+'/result.json',{status:'failed',error:safeError(e),finishedAt:now()});return {ok:false};}
 }
 async function bind(generation){
  if(generation?.provider!=='openai-codex')return generation;
  checkEnabled();
  const current=await registry(),id=generation.codexAccountId||current.activeId,a=id?await entry(id):null;
  if(!a||a.status!=='ready')throw failure('CODEX_ACCOUNT_REAUTH_REQUIRED',409);
  return {...generation,codexAccountId:id};
 }
 async function bindAll(generations){
  const result={...generations},keys=['generation','figureGeneration','repairGeneration'].filter(key=>result[key]?.provider==='openai-codex');
  if(!keys.length)return result;
  checkEnabled();const current=await registry();
  for(const key of keys){const id=result[key].codexAccountId||current.activeId,a=current.accounts.find(a=>a.id===id);if(!a||a.status!=='ready')throw failure('CODEX_ACCOUNT_REAUTH_REQUIRED',409);result[key]={...result[key],codexAccountId:id};}
  return result;
 }
 return {accounts,activate,begin,status,submitCallback,cancel,operation,queueAccount,run,withAccount,bind,bindAll,registry};
}
module.exports={createControl,secureStore,validAuth,identity,latest,prefix,numbered,safeError};
