'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function fn(marker){const start=html.indexOf(marker);assert.ok(start>=0,marker);return html.slice(start,html.indexOf('\n}',start)+2)}
const archiveSource=html.slice(html.indexOf("const REPORT_DB = "),html.indexOf('\n/* ── 专业解析悬浮卡'));
const report=()=>({'称号':'机巧寻星者','方位':'理科','星值':'72','一句话':'你喜欢机器人',cards:[{title:'学科底色',body:'完整原话\n第二段'}],_dir:'li',_lean:72,_complete:true});
function database(options={}){
  const entries=[],stats={closed:0,reads:0,writes:0},control={};
  const indexedDB={open(){
    const db={close(){stats.closed++},objectStoreNames:{contains:()=>true},transaction(name,mode){
      assert.equal(name,'charts');const tx={};
      function request(value){
        const rq={result:mode==='readwrite'?entries.length+1:JSON.parse(JSON.stringify(entries))};
        if(mode==='readonly')stats.reads++;else stats.writes++;
        setImmediate(()=>{
          rq.onsuccess?.();
          const finish=()=>{
            if(options.abort || options.readError && mode==='readonly')return tx.onabort?.();
            if(mode==='readwrite')entries.push({...JSON.parse(JSON.stringify(value)),id:rq.result});
            tx.oncomplete?.();
          };
          if(options.manual)control.finish=finish;else setImmediate(finish);
        });
        return rq;
      }
      tx.objectStore=()=>({add:request,getAll:()=>request()});tx.abort=()=>tx.onabort?.();return tx;
    }};
    const rq={result:db};setImmediate(()=>options.blocked?rq.onblocked?.():rq.onsuccess?.());control.openRequest=rq;return rq;
  }};
  return {indexedDB,entries,stats,control};
}
function archiveContext(db){
  const warnings=[],rep=report(),ctx={window:{indexedDB:db.indexedDB},indexedDB:db.indexedDB,setTimeout,clearTimeout,talkEpoch:0,lastReport:rep,toast:s=>warnings.push(s),saveSession(){ctx.saved=(ctx.saved||0)+1}};
  vm.createContext(ctx);vm.runInContext(archiveSource,ctx);return{ctx,rep,warnings};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('从报告底部切换历史：已打开的报告也回顶并重新显现，保留原焦点及返回记录',()=>{
  const originalFocus={},card={scrollTop:1800},star={style:{},classList:{remove(){}}},close={hasAttribute:()=>true,focus(){}};
  const el={dataset:{},_prevFocus:originalFocus,classList:{contains:()=>true,remove(){},add(){}},querySelector:selector=>selector==='.rc-close'?close:card};
  let pushed=0,rearmed=0,revealed=0;
  const ctx={document:{activeElement:{},getElementById:id=>id==='axis-star'?star:el,querySelectorAll:()=>[]},HTMLElement:class{},clearTimeout(){},setTimeout(){},mjPopClose(){},shownReport:report(),DISMISSIBLE:['reportModal'],overlayNavigation:{open(){pushed++}},rearmReveal:s=>{assert.equal(s,card);rearmed++},revealWithin:s=>{assert.equal(s,card);revealed++}};
  vm.createContext(ctx);vm.runInContext(fn('function openOverlay'),ctx);ctx.openOverlay('reportModal');
  assert.equal(card.scrollTop,0);assert.equal(rearmed,1);assert.equal(revealed,1);assert.equal(pushed,0);assert.equal(el._prevFocus,originalFocus);
  ctx.openOverlay('settingsModal');assert.equal(rearmed,1,'其他已打开的弹窗不重新初始化');
});

test('保存必须等事务提交；请求成功后回滚不能标为已存档',async()=>{
  const db=database({manual:true}),{ctx,rep,warnings}=archiveContext(db);
  let finished=false;const saving=ctx.saveReportHistory(rep).then(id=>{finished=true;return id});
  while(!db.control.finish)await tick();
  assert.equal(finished,false);assert.equal(vm.runInContext('currentReportKey',ctx),null);
  db.control.finish();assert.equal(await saving,1);assert.equal(ctx.saved,1);assert.equal(warnings.length,0);assert.equal(db.stats.closed,1);
  const failed=archiveContext(database({abort:true}));assert.equal(await failed.ctx.saveReportHistory(failed.rep),null);
  assert.equal(vm.runInContext('currentReportKey',failed.ctx),null);assert.match(failed.warnings[0],/暂未保存/);
});

test('存档保存原文快照，立即打开列表会等待提交，刷新后旧档可读取',async()=>{
  const db=database(),{ctx,rep}=archiveContext(db);const original=JSON.stringify(rep);
  ctx.saveReportHistory(rep);rep.cards[0].body='后续修改';
  const items=await ctx.listReportHistory();assert.equal(items.length,1);assert.equal(JSON.stringify(items[0].report),original);
  const refreshed=archiveContext(db);assert.equal((await refreshed.ctx.listReportHistory()).length,1);assert.equal(db.stats.closed,3);
});

test('数据库读取失败明确拒绝，不能伪装成没有存档；阻塞后迟到的连接关闭',async()=>{
  const failed=archiveContext(database({readError:true}));await assert.rejects(failed.ctx.listReportHistory(),/读取失败/);
  const db=database({blocked:true}),{ctx}=archiveContext(db);await assert.rejects(ctx.idbOpen(),/关闭其他北辰页面/);
  db.control.openRequest.onsuccess();assert.equal(db.stats.closed,1);
});

test('回看保持历史日期，回到当前与顶部入口都渲染当前星图后刷新显示',()=>{
  const elements={'rp-history-tip':{hidden:true,querySelector:()=>({hidden:false})},'rp-time':{textContent:''}};
  const live=report(),entry={id:1,savedAt:1700000000000,report:{...report(),'称号':'旧星图'}};let rendered,opened=0;
  const ctx={document:{getElementById:id=>elements[id]},lastReport:live,currentReportKey:2,currentReportSavedAt:1800000000000,renderReport:r=>rendered=r,openOverlay:id=>{assert.equal(id,'reportModal');opened++},toast(){}};
  vm.createContext(ctx);vm.runInContext(fn('function reportSignature')+'\n'+fn('function viewHistoryReport')+'\n'+fn('function openLiveReport')+'\n'+fn('function backToLiveReport'),ctx);
  ctx.viewHistoryReport(entry);assert.equal(rendered,entry.report);assert.equal(elements['rp-history-tip'].hidden,false);
  assert.equal(elements['rp-time'].textContent,'POLARIS · '+new Date(entry.savedAt).toLocaleString('zh-CN',{hour12:false}));
  ctx.backToLiveReport();assert.equal(rendered,live);assert.equal(opened,2);
});

test('旧谈话中的漏存星图只补存一次，历史读取错误显示重试入口',async()=>{
  const db=database(),a=archiveContext(db),children=[];
  const list={innerHTML:'',appendChild:b=>children.push(b)};
  a.ctx.document={getElementById:()=>list,createElement:()=>({})};a.ctx.openOverlay=()=>{};a.ctx.esc=String;
  await a.ctx.openReportHistory();assert.equal(db.entries.length,1);assert.equal(children.length,1);
  await a.ctx.openReportHistory();assert.equal(db.entries.length,1,'重复打开不复制当前星图');
  const failed=archiveContext(database({readError:true})),buttons=[];
  failed.ctx.document={getElementById:()=>list,createElement:()=>({})};list.appendChild=b=>buttons.push(b);failed.ctx.openOverlay=()=>{};
  await failed.ctx.openReportHistory();assert.match(list.innerHTML,/读取失败/);assert.doesNotMatch(list.innerHTML,/还没有存档/);assert.equal(buttons[0].textContent,'重新读取');
});
