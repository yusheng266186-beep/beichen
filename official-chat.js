'use strict';
require('./runtime-compat');
const accounts=require('./official/codex-accounts.cjs'),runtime=require('./official/codex-runtime.cjs'),{modelProfile}=require('./model-adapter');
const pause=(ms,signal)=>new Promise((yes,no)=>{const timer=setTimeout(done,ms);function done(){signal?.removeEventListener('abort',abort);yes();}function abort(){clearTimeout(timer);signal?.removeEventListener('abort',abort);no(Error('BEICHEN_CLIENT_ABORTED'));}if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});});
function profile(config,body){const p=modelProfile(config);if(!p)throw Error('BEICHEN_MODEL_NOT_ADAPTED');const tier=Object.hasOwn(p.efforts,body.effort)?body.effort:Object.hasOwn(p.efforts,process.env.AI_DEFAULT_EFFORT)?process.env.AI_DEFAULT_EFFORT:'standard';return {model:config.model,reasoningEffort:p.efforts[tier]};}
async function complete(body,config,{onProgress,signal,timeoutMs=540000,control,methods=runtime,probe=false}={}){
 const vault=control||accounts.createControl(),bound=await vault.bind({provider:'openai-codex',codexAccountId:config.accountId||undefined}),end=Date.now()+timeoutMs,generation=profile(config,body);
 const prompt={system:body.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n\n'),input:{messages:body.messages.filter(m=>m.role!=='system')}};
 while(true){if(signal?.aborted)throw Error('BEICHEN_CLIENT_ABORTED');const remaining=end-Date.now();if(remaining<1)throw Error('BEICHEN_UPSTREAM_TIMEOUT');
  try{return await vault.withAccount(bound.codexAccountId,rt=>methods.complete(rt,prompt,generation,{onProgress,signal,probe}),{signal,timeoutMs:remaining});}
  catch(e){if(e.message!=='CODEX_ACCOUNT_BUSY'||end-Date.now()<2000)throw e;await pause(1500,signal);}
 }
}
async function proxy(req,res,body,config,{headers,timeoutMs=540000,completion=complete}={}){
 const controller=new AbortController();let finished=false,written='',summary='',bytes=0;
 const abort=()=>{if(!finished)controller.abort();};req.once('aborted',abort);res.once('close',abort);
 const timer=setTimeout(()=>controller.abort(),timeoutMs),heartbeat=setInterval(()=>{if(!res.writableEnded&&!res.destroyed)res.write(': ping\n\n');},15000);heartbeat.unref?.();
 res.writeHead(200,headers);const send=event=>{if(controller.signal.aborted||res.destroyed)throw Error('BEICHEN_CLIENT_ABORTED');const frame='data: '+JSON.stringify(event)+'\n\n';bytes+=Buffer.byteLength(frame);if(bytes>8*1024*1024){controller.abort();throw Error('BEICHEN_UPSTREAM_ERROR');}res.write(frame);};
 const delta=value=>send({choices:[{delta:value,finish_reason:null}]});
 try{
  const result=await completion(body,config,{signal:controller.signal,timeoutMs,onProgress:value=>{
   if(typeof value.summary==='string'&&value.summary.startsWith(summary)){const text=value.summary.slice(summary.length);summary=value.summary;if(text)delta({reasoning_content:text});}
   if(typeof value.draftSource==='string'&&value.draftSource.startsWith(written)){const text=value.draftSource.slice(written.length);written=value.draftSource;if(text)delta({content:text});}
  }});
  if(!result.output||!result.output.startsWith(written))throw Error('BEICHEN_UPSTREAM_INCOMPLETE');
  if(result.output.length>written.length)delta({content:result.output.slice(written.length)});
  send({choices:[{delta:{},finish_reason:'stop'}],...(result.usage?{usage:{prompt_tokens:result.usage.input,completion_tokens:result.usage.output}}:{})});
  finished=true;res.end('data: [DONE]\n\n');return bytes;
 }catch(e){if(!res.destroyed&&!res.writableEnded)res.end('data: '+JSON.stringify({error:{message:e.message==='BEICHEN_CLIENT_ABORTED'?'BEICHEN_CLIENT_ABORTED':e.message==='CODEX_ACCOUNT_REAUTH_REQUIRED'||e.message==='MODEL_AUTH_FAILED'?'BEICHEN_OFFICIAL_REAUTHORIZE':'BEICHEN_UPSTREAM_ERROR'}})+'\n\n');throw Object.assign(Error(e.message),{code:e.message,status:502});}
 finally{clearTimeout(timer);clearInterval(heartbeat);req.removeListener('aborted',abort);res.removeListener('close',abort);}
}
module.exports={complete,proxy,profile};
