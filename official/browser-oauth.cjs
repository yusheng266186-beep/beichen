'use strict';
// Cockpit-style browser login: keep the runtime's PKCE request unchanged and
// accept its exact loopback return URL when a remote browser cannot reach it.
const http=require('node:http'),crypto=require('node:crypto');
const failure=code=>Object.assign(Error(code),{status:400});
const equal=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y);};
function loopback(value){
 const u=new URL(value);
 if(u.protocol!=='http:'||!['localhost','127.0.0.1'].includes(u.hostname)||!u.port||u.username||u.password||u.pathname!=='/auth/callback'||u.search||u.hash)throw failure('CODEX_CALLBACK_INVALID');
 return u;
}
function authorization(value){
 try{
  if(typeof value!=='string'||value.length>16384||/[\r\n]/.test(value))throw Error();
  const u=new URL(value);
  if(u.origin!=='https://auth.openai.com'||u.pathname!=='/oauth/authorize'||u.username||u.password||u.hash||u.searchParams.get('response_type')!=='code'||u.searchParams.get('code_challenge_method')!=='S256')throw Error();
  for(const k of ['redirect_uri','state','code_challenge','client_id'])if(u.searchParams.getAll(k).length!==1||!u.searchParams.get(k))throw Error();
  const redirect=loopback(u.searchParams.get('redirect_uri'));
  return {authorizationUrl:u.href,redirectUri:redirect.href,state:u.searchParams.get('state')};
 }catch{throw failure('CODEX_AUTHORIZATION_URL_INVALID');}
}
function callback(value,authorizationUrl){
 const expected=authorization(authorizationUrl);
 try{
  if(typeof value!=='string'||value.length>16384||/[\r\n]/.test(value))throw Error();
  const u=new URL(value.trim()),redirect=new URL(expected.redirectUri);
  if(u.protocol!==redirect.protocol||!['localhost','127.0.0.1'].includes(u.hostname)||u.port!==redirect.port||u.pathname!==redirect.pathname||u.username||u.password||u.hash)throw Error();
  if(u.searchParams.getAll('state').length!==1||!equal(u.searchParams.get('state'),expected.state))throw failure('CODEX_CALLBACK_STATE_MISMATCH');
  for(const k of ['code','error'])if(u.searchParams.getAll(k).length>1)throw Error();
  const code=u.searchParams.get('code'),error=u.searchParams.get('error');
  if(!!code===!!error||!code&&!/^[a-zA-Z0-9_ .-]{1,120}$/.test(error))throw Error();
  // Never use a user-supplied network target or carry unrelated query values.
  const q=new URLSearchParams({state:expected.state});
  if(code)q.set('code',code);else q.set('error',error);
  redirect.search=q.toString();return redirect.href;
 }catch(e){if(e.message==='CODEX_CALLBACK_STATE_MISMATCH')throw e;throw failure('CODEX_CALLBACK_INVALID');}
}
function deliver(value,authorizationUrl,{signal,timeoutMs=60000,onStage}={}){
 const checked=new URL(callback(value,authorizationUrl));
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
 const get=url=>new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:checked.port,path:url.pathname+url.search,method:'GET',headers:{Host:checked.host},signal:combined},res=>{
   res.resume();res.on('end',()=>resolve({status:res.statusCode,location:res.headers.location}));
   res.on('error',()=>reject(failure('CODEX_CALLBACK_DELIVERY_FAILED')));
   res.on('aborted',()=>reject(failure('CODEX_CALLBACK_DELIVERY_FAILED')));
  });
  req.on('error',()=>reject(failure('CODEX_CALLBACK_DELIVERY_FAILED')));req.end();
 });
 return (async()=>{
  try{
   const response=await get(checked);
   if(response.status>=300&&response.status<400){
    // The official runtime persists the token at /auth/callback, but emits
    // account/login/completed only after /success is visited. Reproduce the
    // browser's final hop; never follow arbitrary hosts, ports or paths.
    let next;try{next=new URL(response.location,checked);}catch{throw failure('CODEX_CALLBACK_REDIRECT_INVALID');}
    if(next.protocol!=='http:'||!['127.0.0.1','localhost'].includes(next.hostname)||next.port!==checked.port||next.username||next.password||next.pathname!=='/success'||next.hash)throw failure('CODEX_CALLBACK_REDIRECT_INVALID');
    await onStage?.('confirming');
    const success=await get(next);
    if(success.status<200||success.status>=300)throw failure('CODEX_CALLBACK_CONFIRMATION_FAILED');
   }else if(response.status<200||response.status>=300)throw failure('CODEX_CALLBACK_REJECTED');
  }finally{clearTimeout(timer);}
 })();
}
module.exports={authorization,callback,deliver};
