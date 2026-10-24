'use strict';
const http=require('node:http'),https=require('node:https'),tls=require('node:tls');
const {request:direct}=require('./official/tencent.cjs'),{withProxy}=require('./official/openai-proxy.cjs');
function checkedTarget(value,method='GET'){
 const u=new URL(value),prefix='/repos/yusheng266186-beep/beichen-handover';
 const read=(u.pathname===prefix+'/contents/.workbench/state.json'&&u.search==='?ref=main')||(u.pathname===prefix+'/actions/workflows/beichen-workbench.yml/runs'&&u.search==='?per_page=20')||(new RegExp('^'+prefix+'/actions/runs/\\d{1,20}/jobs$').test(u.pathname)&&u.search==='?per_page=10');
 const write=u.pathname===prefix+'/actions/workflows/beichen-workbench.yml/dispatches'&&!u.search;
 if(u.protocol!=='https:'||u.hostname!=='api.github.com'||u.port||u.username||u.password||u.hash||!(method==='GET'&&read||method==='POST'&&write))throw Error('CONSOLE_DESTINATION_REJECTED');return u;
}
function tunnelRequest(url,{method='GET',headers={},body='',timeout=12000,deadlineMs=timeout,maxBytes=2*1024*1024}={}){
 const target=checkedTarget(url,method);
 return new Promise((resolve,reject)=>{
  let done=false,connect,socket,secure,timer;const agent=new https.Agent({keepAlive:false});
  const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);agent.destroy();connect?.destroy();secure?.destroy();socket?.destroy();error?reject(error):resolve(result);};
  agent.createConnection=(_,callback)=>{let called=false;const cb=(e,s)=>{if(!called){called=true;callback(e,s);}};connect=http.request({host:'127.0.0.1',port:18080,method:'CONNECT',path:'api.github.com:443',headers:{Host:'api.github.com:443'}});connect.once('error',cb);connect.once('connect',(r,s,head)=>{socket=s;if(done){s.destroy();return;}if(r.statusCode!==200){s.destroy();return cb(Error('CONSOLE_PROXY_CONNECT_FAILED'));}if(head.length)s.unshift(head);secure=tls.connect({socket:s,servername:'api.github.com',rejectUnauthorized:true,ALPNProtocols:['http/1.1']});secure.once('secureConnect',()=>cb(null,secure));secure.once('error',cb);});connect.end();};
  const req=https.request(target,{method,headers:{...headers,...(body?{'Content-Length':Buffer.byteLength(body)}:{})},agent},res=>{let size=0;const chunks=[];res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes)return req.destroy(Error('RESPONSE_LIMIT'));chunks.push(chunk);});res.once('end',()=>finish(null,{status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));res.once('error',e=>finish(e));res.once('aborted',()=>finish(Error('NETWORK_INTERRUPTED')));});
  req.once('error',e=>finish(e));timer=setTimeout(()=>{const error=Error('NETWORK_TIMEOUT');finish(error);req.destroy(error);},deadlineMs);req.setTimeout(timeout,()=>req.destroy(Error('NETWORK_TIMEOUT')));req.end(body);
 });
}
function request(url,options={}){checkedTarget(url,options.method||'GET');return process.env.OPENAI_PROXY_CONFIG?withProxy(()=>tunnelRequest(url,options)):direct(url,options);}
module.exports={request,checkedTarget};
