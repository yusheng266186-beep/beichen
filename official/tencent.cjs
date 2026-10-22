'use strict';
const https=require('node:https'),crypto=require('node:crypto');
const hash=(value,algorithm='sha256')=>crypto.createHash(algorithm).update(value).digest('hex');
const hmac=(key,value,algorithm='sha256',encoding)=>crypto.createHmac(algorithm,key).update(value).digest(encoding);
function requestOnce(url,{method='GET',headers={},body='',timeout=30000,deadlineMs=0,maxBytes=1024*1024,onChunk,signal,collectBody=true}={}){
 return new Promise((resolve,reject)=>{
  const target=new URL(url);if(target.protocol!=='https:')return reject(new Error('HTTPS_REQUIRED'));
  let deadline,abort,tlsEstablished=false,requestFinished=false,responseHeadersReceived=false,responseBytes=0,responseStatus,responseType;const finish=(error,result)=>{clearTimeout(deadline);if(abort)signal?.removeEventListener('abort',abort);if(error){if(!error.message&&/^[A-Z0-9_]+$/.test(error.code||''))error.message=error.code;if(!error.diagnostic&&['ETIMEDOUT','ECONNRESET','EHOSTUNREACH','ENETUNREACH','EAI_AGAIN','NETWORK_TIMEOUT','NETWORK_INTERRUPTED'].includes(error.code||error.message))error.diagnostic={kind:'network',tlsEstablished,requestFinished,responseHeadersReceived,responseBytes,...(Number.isInteger(responseStatus)?{responseStatus}:{}),...(responseType?{responseType}:{}),...(error.timeoutKind?{timeoutKind:error.timeoutKind,timeoutMs:error.timeoutMs}:{})};reject(error);}else resolve(result);};
  const req=https.request(target,{method,headers:{...headers,...(body?{'Content-Length':Buffer.byteLength(body)}:{})}},res=>{
   responseHeadersReceived=true;responseStatus=res.statusCode;const type=String(res.headers?.['content-type']||'').split(';')[0].trim().toLowerCase();responseType=/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type)?type:undefined;let bytes=0,chunks=[];res.on('data',chunk=>{bytes+=chunk.length;responseBytes=bytes;if(bytes>maxBytes){res.destroy(new Error('RESPONSE_LIMIT'));return;}if(collectBody||res.statusCode!==200)chunks.push(chunk);if(res.statusCode===200&&onChunk){try{onChunk(chunk);}catch(error){req.destroy(error);}}});
   res.on('end',()=>finish(null,{status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString('utf8')}));
   res.on('error',error=>finish(error));res.on('aborted',()=>finish(new Error('NETWORK_INTERRUPTED')));
  });
  req.on('socket',socket=>{if(socket.encrypted&&!socket.connecting&&socket.authorized)tlsEstablished=true;else socket.once('secureConnect',()=>{tlsEstablished=true;});});req.once('finish',()=>{requestFinished=true;});
  req.setTimeout(timeout,()=>req.destroy(Object.assign(new Error('NETWORK_TIMEOUT'),{timeoutKind:'idle',timeoutMs:timeout})));req.on('error',error=>finish(error));
  if(signal){abort=()=>req.destroy(new Error('JOB_CANCELLED'));if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});}
  if(deadlineMs>0)deadline=setTimeout(()=>req.destroy(Object.assign(new Error('NETWORK_TIMEOUT'),{timeoutKind:'deadline',timeoutMs:deadlineMs})),deadlineMs);
  req.end(body);
 });
}
async function request(url,options={}){
 // Retry only when TLS was never established and HTTP was never written.
 // No model request can have reached the upstream in this state. A lost
 // response after sending, a 524, or a partial stream must never be resent.
 if(!options.deadlineMs)return requestOnce(url,options);
 const end=Date.now()+options.deadlineMs;
 try{return await requestOnce(url,options);}catch(error){
  const d=error.diagnostic,remaining=end-Date.now();
  if(!['ETIMEDOUT','ECONNRESET','EHOSTUNREACH','ENETUNREACH','EAI_AGAIN'].includes(error.code)||d?.kind!=='network'||d.tlsEstablished||d.requestFinished||d.responseHeadersReceived||d.responseBytes||remaining<=500||options.signal?.aborted)throw error;
  await new Promise(resolve=>setTimeout(resolve,150));
  const deadlineMs=end-Date.now();if(deadlineMs<=0)throw error;
  return requestOnce(url,{...options,deadlineMs,timeout:Math.min(options.timeout||30000,deadlineMs)});
 }
}
function credentials(env=process.env){return {SecretId:env.TENCENTCLOUD_SECRETID||env.TENCENTCLOUD_SECRET_ID,SecretKey:env.TENCENTCLOUD_SECRETKEY||env.TENCENTCLOUD_SECRET_KEY,Token:env.TENCENTCLOUD_SESSIONTOKEN||env.TENCENTCLOUD_TOKEN};}
async function cloud(service,action,version,params,{region='ap-chengdu',auth=credentials(),timeout=45000}={}){
 if(!auth.SecretId||!auth.SecretKey)throw new Error('CLOUD_AUTH_REQUIRED');
 const host=service+'.tencentcloudapi.com',body=JSON.stringify(params),timestamp=Math.floor(Date.now()/1000),date=new Date(timestamp*1000).toISOString().slice(0,10),scope=date+'/'+service+'/tc3_request';
 const canonical='POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:'+host+'\n\ncontent-type;host\n'+hash(body);
 const signing=hmac(hmac(hmac('TC3'+auth.SecretKey,date),service),'tc3_request');
 const signature=hmac(signing,'TC3-HMAC-SHA256\n'+timestamp+'\n'+scope+'\n'+hash(canonical),'sha256','hex');
 const result=await request('https://'+host,{method:'POST',body,timeout,maxBytes:6*1024*1024,headers:{'Content-Type':'application/json; charset=utf-8','X-TC-Action':action,'X-TC-Version':version,'X-TC-Region':region,'X-TC-Timestamp':String(timestamp),...(auth.Token?{'X-TC-Token':auth.Token}:{}),Authorization:'TC3-HMAC-SHA256 Credential='+auth.SecretId+'/'+scope+', SignedHeaders=content-type;host, Signature='+signature}});
 const data=JSON.parse(result.body).Response;if(data?.Error){const error=new Error(data.Error.Code);error.code=data.Error.Code;error.detail=data.Error.Message;throw error;}if(!data)throw new Error('CLOUD_BAD_RESPONSE');return data;
}
const encode=value=>encodeURIComponent(value).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
async function cos(host,path,{method='GET',body='',headers={},auth=credentials(),maxBytes=6*1024*1024}={}){
 if(!auth.SecretId||!auth.SecretKey)throw new Error('CLOUD_AUTH_REQUIRED');
 const time=Math.floor(Date.now()/1000)-60,keyTime=time+';'+(time+960),all={host,...headers,...(auth.Token?{'x-cos-security-token':auth.Token}:{})};
 const names=Object.keys(all).map(k=>k.toLowerCase()).sort(),normalized=Object.fromEntries(Object.entries(all).map(([k,v])=>[k.toLowerCase(),String(v)]));
 const headerString=names.map(k=>encode(k)+'='+encode(normalized[k])).join('&');
 const [pathname,query='']=path.split('?'),params=new URLSearchParams(query),queryNames=[...params.keys()].sort(),queryString=queryNames.map(k=>encode(k.toLowerCase())+'='+encode(params.get(k))).join('&');
 const httpString=method.toLowerCase()+'\n'+pathname+'\n'+queryString+'\n'+headerString+'\n',signKey=hmac(auth.SecretKey,keyTime,'sha1','hex');
 const signature=hmac(signKey,'sha1\n'+keyTime+'\n'+hash(httpString,'sha1')+'\n','sha1','hex');
 const authorization='q-sign-algorithm=sha1&q-ak='+auth.SecretId+'&q-sign-time='+keyTime+'&q-key-time='+keyTime+'&q-header-list='+names.join(';')+'&q-url-param-list='+queryNames.join(';')+'&q-signature='+signature;
 return request('https://'+host+path,{method,body,headers:{...all,Authorization:authorization},maxBytes});
}
module.exports={request,cloud,cos,credentials,hash};
