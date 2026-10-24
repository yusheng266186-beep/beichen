'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),source=path.resolve(process.argv[2]||'');
if(!fs.existsSync(path.join(source,'backend/model-control.cjs')))throw Error('Pass the local jianwei-observatory checkout path.');
const control=require(path.join(source,'backend/model-control.cjs'));
const read=name=>JSON.parse(fs.readFileSync(path.join(source,'backend',name),'utf8')),write=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value,null,2)+'\n');
const providers=Object.fromEntries(Object.entries(control.routes).filter(([id])=>id!=='openai-chatgpt').map(([id,p])=>[id,{...p,prefix:p.prefix||(id==='kimi-code'?'KIMI_CODE':'GEMINI')}]));
const profiles=read('model-profiles.json'),sourceVersion=profiles.version;profiles.sourceVersion=sourceVersion;profiles.version='v2.11.0';
for(const [id,p] of Object.entries(providers)){
 profiles.providers[id]||={};
 for(const model of p.catalog){
  let item=control.modelProfile(id,model);
  item=structuredClone(item||{family:'gemini',name:'Gemini 3.8 Flash',efforts:{eco:'low',standard:'high',deep:'high'},tokenField:'max_tokens',note:'Gemini 原生流式协议，按模型支持的思考强度执行。'});
  item.chatBudgets||={eco:8192,standard:16384,deep:32768};item.reportBudgets||={eco:32768,standard:49152,deep:65536};
  for(const effort of new Set(Object.values(item.efforts)))item.efforts[effort]??=effort;
  for(const effort of Object.keys(item.efforts)){item.chatBudgets[effort]??=16384;item.reportBudgets[effort]??=49152;}
  item.nativeEfforts=Object.keys(item.efforts).filter(k=>!['eco','standard','deep'].includes(k));profiles.providers[id][model]=item;
 }
}
write('api-providers.json',providers);write('model-profiles.json',profiles);write('model-performance.json',read('model-performance.json'));
const files=['codex-runtime.cjs','codex-accounts.cjs','openai-proxy.cjs','tencent.cjs','store.cjs','browser-oauth.cjs'],hashes={};
for(const file of files){const bytes=fs.readFileSync(path.join(source,'backend',file));fs.writeFileSync(path.join(root,'official',file),bytes);hashes[file]=crypto.createHash('sha256').update(bytes).digest('hex');}
write('official/SOURCE.json',{repository:'https://github.com/yusheng266186-beep/jianwei-observatory',commit:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim(),sourceDirectory:'backend',files:hashes});
write('model-sync.json',{sourceRepository:'yusheng266186-beep/jianwei-observatory',sourceCommit:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim(),profileVersion:sourceVersion,providers:Object.keys(providers).length,models:Object.values(providers).reduce((n,p)=>n+p.catalog.length,0)});
console.log(JSON.stringify(JSON.parse(fs.readFileSync(path.join(root,'model-sync.json')))));
