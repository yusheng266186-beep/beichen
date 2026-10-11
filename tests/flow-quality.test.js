'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm');
const context=require('../conversation-context'), storeLib=require('../conversation-store'), navigation=require('../overlay-navigation');
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
process.env.BEICHEN_NO_LISTEN='1'; process.env.STATE_STORE='memory';
const relay=require('../scf-relay');
function fn(marker){ const i=html.indexOf(marker); assert.ok(i>=0,marker); return html.slice(i,html.indexOf('\n}',i)+2); }
function accepted(messages, opt){ const out=context.pack(messages,opt); relay.validateChatBody({messages:out,max_tokens:16384,stream:true}); return out; }
const base={role:'system',content:'test personality and knowledge'};
test('长谈话保留最早的否定、家长期待、修改意见和原始提问，续写仍合法',()=>{
  const history=[{role:'assistant',content:'家人和你的想法一致吗？'}, {role:'user',content:'我不喜欢生物，也不想做医生。爸爸希望我学医。'},
    ...Array.from({length:70},(_,i)=>({role:i%2?'user':'assistant',content:'普通谈话片段 '+i})),
    {role:'user',content:'我后来开始喜欢化学，但仍然不想学医，机器人是我的热爱。'}];
  const messages=[base,...history,{role:'system',content:'回应并进一步了解学生'}];
  const out=accepted(messages), all=out.map(m=>m.content).join('');
  for(const m of history) assert.ok(all.includes(m.content),m.content);
  assert.ok(all.includes('学生原话') && all.includes('辰的历史回复'));
  assert.ok(out.length<=22);
  const continuation=accepted([...messages,{role:'assistant',content:'半份报告'.repeat(4500)}, {role:'user',content:'继续'}],{reserveMessages:0,reserveChars:0});
  assert.equal(continuation.at(-1).content,'继续');
  assert.ok(continuation.length<=24 && continuation.every(m=>m.content.length<=16000));
  assert.equal(JSON.stringify(messages),JSON.stringify([base,...history,{role:'system',content:'回应并进一步了解学生'}]),'packing does not mutate original history');
});
test('十份各 6000 字回答与真实问题原文均参与星图；短对话保持原角色',()=>{
  const short=[base,{role:'assistant',content:'最喜欢什么？'},{role:'user',content:'搭机器人'}];
  assert.deepEqual(context.pack(short),short);
  const history=Array.from({length:10},(_,i)=>[{role:'assistant',content:'原始问题 '+i},{role:'user',content:('回答'+i+'：')+'中'.repeat(5996)}]).flat();
  const evidence=context.transcript(history);
  const packed=accepted([base,{role:'system',content:'星图格式'}, {role:'user',content:evidence}]);
  const restored=packed.filter(m=>m.role==='user').map(m=>m.content).join('');
  assert.equal(restored,evidence);
  assert.ok(packed.length>3);
});
test('emoji、换行及长报告中间内容分段后逐字相等；超限明确失败且不裁剪',()=>{
  const source='前'.repeat(15999)+'😀\n中部重要证据\n'+'后'.repeat(20000);
  const out=context.pack([{role:'user',content:source}]);
  assert.equal(out.map(m=>m.content).join(''),source);
  assert.ok(out.every(m=>!/[\uD800-\uDBFF]$/.test(m.content)));
  assert.throws(()=>context.pack([{role:'user',content:'中'.repeat(100001)}],{reserveChars:0}),e=>e.code==='CONTEXT_CAPACITY');
  assert.throws(()=>context.pack([{role:'user',content:'\u0000'.repeat(90000)}],{reserveChars:0}),e=>e.code==='CONTEXT_CAPACITY','JSON escaping also respects byte cap');
});
test('格式修复携带完整长原文和学生证据，不省略报告中部',async()=>{
  const source='前'.repeat(16000)+'不可遗漏的中部'+'后'.repeat(9000);
  let sent;
  const ctx={SYSTEM:'knowledge',buildReportEvidence:()=> '学生原话：我排斥医生',setTypingLabel(){},ask:async m=>{sent=accepted(m);return{content:'repaired'}}};
  vm.createContext(ctx); vm.runInContext(fn('async function repairReportText'),ctx);
  assert.equal(await ctx.repairReportText(source),'repaired');
  const all=sent.map(m=>m.content).join('');
  assert.ok(all.includes(source) && all.includes('学生原话：我排斥医生'));
});
test('有效会话回访后失效，点击、回车与自动输入重新验证；重复初始化只绑定一次',async()=>{
  let valid=true, submissions=0;
  const elements={}, listeners={};
  const ctx={talkEpoch:0,location:{search:''},window:{sessionStorage:{getItem:()=>null,removeItem(){}},matchMedia:()=>({matches:false})},
    document:{getElementById:id=>elements[id] ||= {dataset:{},value:'',disabled:false,classList:{add(){}},addEventListener(type,cb){(listeners[id+':'+type] ||= []).push(cb)}}},
    gateOk:()=>valid,gateToken:()=> 'test-ticket',restoreSession:async()=>true,setBusy(){},gateGet:()=>1,gateRemove(){},gateSet(){},gateTry(){submissions++;},lockGate(){},showModeSelect(){},setTimeout(){},
    GATE_TOKEN_KEY:'token',GATE_AT_KEY:'at',GATE_EXP_KEY:'exp',GATE_RUNS_KEY:'runs',GATE_COMPLETION_KEY:'completion'};
  vm.createContext(ctx); vm.runInContext(fn('function bindGateControls')+'\n'+fn('function setupGate')+'\nsetupGate(); setupGate();',ctx);
  await Promise.resolve(); valid=false;
  for(const key of ['gateBtn:click','gateInput:keydown','gateInput:input']) assert.equal(listeners[key].length,1,key);
  listeners['gateBtn:click'][0](); listeners['gateInput:keydown'][0]({key:'Enter'});
  elements.gateInput.value='12a3456'; listeners['gateInput:input'][0]();
  assert.equal(elements.gateInput.value,'123456'); assert.equal(submissions,3);
  elements.gateBtn.disabled=true; listeners['gateInput:input'][0](); assert.equal(submissions,3);
});
function localStorageFixture(fail=false){ const map=new Map(); return {getItem:k=>map.get(k)||null,setItem(k,v){if(fail)throw Error('quota');map.set(k,v)},removeItem:k=>map.delete(k)}; }
function indexedDBFixture(){
  const data=new Map();
  const db={close(){},transaction(){
    const tx={objectStore:()=>({
      put(value,key){return request(()=>data.set(key,value))},get(key){return request(()=>data.get(key))},delete(key){return request(()=>data.delete(key))}
    })};
    function request(action){const req={};setTimeout(()=>{req.result=action();tx.oncomplete?.()},1);return req}
    return tx;
  }};
  return {open(){const req={result:db};setTimeout(()=>req.onsuccess?.(),1);return req}};
}
test('完整 80 条记录、长星图在刷新后恢复；本机 quota 满时从 IndexedDB 接回',async()=>{
  const local=localStorageFixture(true), db=indexedDBFixture();
  let warnings=0;
  const history=Array.from({length:80},(_,i)=>({role:i%2?'user':'assistant',content:'原话 '+i}));
  history.push({role:'assistant',kind:'report',content:'【北辰星图】'+'完整报告'.repeat(6000)});
  const snapshot={history,turnCount:40,savedAt:123};
  const a=storeLib.create({localStorage:local,indexedDB:db,key:'session',onFailure:()=>warnings++});
  assert.equal(await a.save(snapshot),true); snapshot.history[0].content='later mutation';
  const b=storeLib.create({localStorage:local,indexedDB:db,key:'session'});
  const restored=await b.load();
  assert.equal(restored.history.length,81); assert.equal(restored.history[0].content,'原话 0');
  assert.equal(restored.history.at(-1).content.length,24006); assert.equal(warnings,0);
});
test('新存档优先、清除排在旧保存之后，不会复活旧谈话；两种存储失败给提示',async()=>{
  const local=localStorageFixture(),db=indexedDBFixture();
  const a=storeLib.create({localStorage:local,indexedDB:db,key:'session'});
  a.save({history:['older'],savedAt:1}); const clear=a.clear(); await clear; assert.equal(await a.load(),null);
  await a.save({history:['newer'],savedAt:3}); local.setItem('session',JSON.stringify({history:['stale'],savedAt:2}));
  assert.deepEqual((await a.load()).history,['newer']);
  const partialLocal=localStorageFixture();let writes=0;
  const rapid=storeLib.create({localStorage:{...partialLocal,setItem(k,v){if(++writes>1)throw Error('quota');partialLocal.setItem(k,v)}},indexedDB:indexedDBFixture(),key:'session'});
  await rapid.save({history:['first'],savedAt:10});await rapid.save({history:['same millisecond, newer'],savedAt:10});
  assert.deepEqual((await rapid.load()).history,['same millisecond, newer'],'a quota failure during two saves in one millisecond must not resurrect the older copy');
  let warnings=0;
  const b=storeLib.create({localStorage:localStorageFixture(true),key:'session',onFailure:()=>warnings++});
  assert.equal(await b.save({savedAt:4}),false); assert.equal(warnings,1);
});
function navFixture(){
  const entries=[{}];let cursor=0, pops=[];
  const nav={get state(){return entries[cursor]},replaceState:s=>entries[cursor]=s,pushState(s){entries.splice(cursor+1);entries.push(s);cursor++},back(){if(cursor>0){cursor--;pops.push(true)}},forward(){if(cursor<entries.length-1){cursor++;pops.push(true)}}};
  let closed=[];const ctl=navigation.create(nav,id=>closed.push(id));
  function flush(){while(pops.length){pops.shift();ctl.pop()}}
  return {ctl,nav,closed,flush,get cursor(){return cursor}};
}
test('浏览器返回逐层关闭，X/Escape 消费对应记录，前进和刷新不重开弹窗',()=>{
  const a=navFixture();a.ctl.open('history');a.ctl.open('report');
  a.nav.back();a.flush();assert.deepEqual(a.closed,['report']);assert.equal(a.ctl.top(),'history');
  a.ctl.close('history');a.flush();assert.equal(a.cursor,0);assert.equal(a.ctl.top(),null);
  a.nav.forward();a.flush();assert.equal(a.ctl.top(),null);assert.deepEqual(a.closed,['report']);
  a.ctl.open('settings');const reloaded=navigation.create(a.nav,()=>assert.fail('reload reopened a modal'));assert.equal(reloaded.top(),null);
});
test('快速关闭多层、关闭后立即打开新弹窗、关闭底层都不会关闭错误弹窗',()=>{
  const a=navFixture();a.ctl.open('history');a.ctl.open('report');a.ctl.close('report');a.ctl.close('history');a.ctl.open('settings');a.flush();
  assert.equal(a.ctl.top(),'settings');assert.deepEqual(a.closed,[]);assert.equal(a.cursor,1);
  a.ctl.open('report');a.ctl.close('settings');a.nav.back();a.flush();assert.deepEqual(a.closed,['report']);assert.equal(a.ctl.top(),null);
});
test('从旧弹窗切换至新弹窗后，关闭动画结束不会把键盘焦点拉到背景',()=>{
  let finish, focused;
  const oldButton={isConnected:true,offsetParent:{},focus(){focused='background'}};
  const topButton={focus(){focused='current-dialog'}};
  const old={dataset:{},_prevFocus:oldButton,classList:{contains:()=>true,add(){},remove(){}}};
  const top={contains:()=>false,querySelector:()=>topButton};
  const ctx={document:{getElementById:id=>id==='history'?old:top},topDismissible:()=> 'report',overlayNavigation:{close(){}},setTimeout:cb=>{finish=cb}};
  vm.createContext(ctx);vm.runInContext(fn('function closeOverlay'),ctx);
  ctx.closeOverlay('history'); finish(); assert.equal(focused,'current-dialog');assert.equal(old._prevFocus,null);
});
test('页面保存和成功星图处理不再删除历史；异步恢复不会覆盖重新开始的会话',async()=>{
  const original=Array.from({length:81},(_,i)=>({role:i%2?'user':'assistant',content:'history '+i}));
  let saved;
  const ctx={history:original,turnCount:40,reportDone:false,MAX_SESSION_MESSAGES:20000,MAX_SESSION_TEXT:200000,MODE:'open',lastReport:null,reportOffered:false,guidedAutoTried:false,quotaSyncPending:false,currentReportKey:null,currentReportSavedAt:null,
    choicesEl:{querySelectorAll:()=>[]},conversationStore:{save:s=>saved=s,load:()=>new Promise(r=>ctx.finish=r)},sanitizeReport:()=>null,toast(){},talkEpoch:1,gateOk:()=>true};
  vm.createContext(ctx);vm.runInContext(fn('function normalizeHistory')+'\n'+fn('function saveSession')+'\n'+fn('async function restoreSession'),ctx);
  ctx.saveSession();assert.equal(saved.history.length,81);assert.equal(saved.history[0].content,'history 0');
  const loading=ctx.restoreSession();ctx.talkEpoch++;ctx.finish(saved);assert.equal(await loading,false);assert.equal(ctx.history,original);
  assert.doesNotMatch(fn('async function processResponse'),/history\s*=\s*\[/,'report completion cannot replace conversation with a memo');
});
