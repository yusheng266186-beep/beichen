(()=>{'use strict';
 const $=id=>document.getElementById(id),base=document.querySelector('meta[name="beichen-api"]').content;
 const titles={status:'核验云端状态',on:'开启 Redis',off:'关闭 Redis',switch:'切换模型配置'};
 const labels={queued:'等待执行',waiting:'等待执行',pending:'等待执行',in_progress:'执行中',completed:'已结束',success:'已完成',failure:'未完成',cancelled:'已取消',timed_out:'执行超时',skipped:'已跳过'};
 const efforts={eco:'省时',standard:'标准',deep:'深思',minimal:'最简',low:'轻快',medium:'均衡',high:'深入',xhigh:'更深入',max:'极致',ultra:'超强',auto:'自动',none:'关闭思考'};
 const errors={PROBE_AUTH:'所选模型或账号暂无调用权限，请核对授权与套餐。',PROBE_QUOTA:'上游额度不足或请求受限，请稍后再试。',PROBE_TIMEOUT:'所选模型响应超时，可降低思考强度后重试。',PROBE_FAILED:'模型未完成连通测试，请核对服务或稍后重试。',PROBE_RATE_LIMIT:'本分钟测试次数较多，请稍候再试。',INVALID_CODE:'验证码不正确或已过期，请检查后重试。',CODE_USED:'这组验证码已用于进入后台，请等待下一组验证码。',RATE_LIMIT:'验证过于频繁，请稍后再试。',NOT_CONFIGURED:'后台连接暂未配置完成，请稍后进入。',CONNECTION_EXPIRED:'云端维护连接已失效，请由维护者续期。',GITHUB_UNAVAILABLE:'暂时无法连接任务服务，请稍后重新读取。',STATE_UNAVAILABLE:'暂时无法读取核验结果，请稍后重试。',TASK_ACTIVE:'已有云端任务正在执行，请等待完成。',REQUEST_CONFLICT:'任务号对应的操作不同，请重新进入后台核对。',SUBMISSION_UNCERTAIN:'尚未确认任务是否接收，请保留这次任务号并核对。',UNAVAILABLE:'云端维护服务暂时不可用，请稍后重试。',BAD_REQUEST:'所选配置已变化，请核对服务、型号和档位。'};
 const storage={get(key){try{return JSON.parse(sessionStorage.getItem(key)||'null');}catch{return null;}},set(key,value){try{value===null?sessionStorage.removeItem(key):sessionStorage.setItem(key,JSON.stringify(value));}catch{}}};
 let session=storage.get('bc_console_session'),pending=storage.get('bc_console_pending'),latest=null,loading=false,submitting=false,loginBusy=false,dirty=false,epoch=0,timer=null,desiredModel='',selectedEffort='',confirmation=null,progressId=null,testing=false,probeController=null;
 const controllers=new Set(),reduce=matchMedia('(prefers-reduced-motion: reduce)'),dialogAnimations=new WeakMap();
 const date=t=>t?new Date(t).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'尚未核验';
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 const message=e=>e.name==='AbortError'?'连接超时，请重新读取。':errors[String(e.code||'').replace('BEICHEN_CONSOLE_','')]||e.message||'连接暂时中断，请稍后重试。';
 function animate(node,frames,options){if(reduce.matches)return Promise.resolve();const a=node.animate(frames,options);return a.finished.catch(()=>{});}
 function notice(text){$('notice').textContent=text;$('notice').hidden=!text;if(text)animate($('notice'),[{opacity:0,transform:'translateY(-5px)'},{opacity:1,transform:'translateY(0)'}],{duration:220,easing:'cubic-bezier(.23,1,.32,1)'});}
 function error(text){$('errorText').textContent=text;$('error').hidden=!text;$('retry').textContent=pending?.uncertain?'核对这次提交':'重新读取';}
 function rememberPending(){storage.set('bc_console_pending',pending);}
 function lock(text){epoch++;for(const c of controllers)c.abort();controllers.clear();clearTimeout(timer);session=null;storage.set('bc_console_session',null);latest=null;loading=false;submitting=false;testing=false;probeController=null;dirty=false;for(const d of [$('confirm'),$('progress')])if(d.open)d.close();$('workspace').hidden=true;$('workspace').inert=false;$('gate').hidden=false;$('gate').style.opacity='';$('gate').getAnimations().forEach(a=>a.cancel());$('logout').hidden=true;$('code').value='';$('gateError').textContent=text||'';buttons();}
 async function api(path,{method='GET',body,id,anonymous=false,signal,timeoutMs=30000}={}){
  const generation=epoch,controller=new AbortController();controllers.add(controller);const timeout=setTimeout(()=>controller.abort(),timeoutMs),abort=()=>controller.abort();if(signal){if(signal.aborted)controller.abort();else signal.addEventListener('abort',abort,{once:true});}
  try{const r=await fetch(base+'/console'+path,{method,credentials:'omit',cache:'no-store',headers:{...(body?{'Content-Type':'application/json'}:{}),...(!anonymous&&session?{Authorization:'Bearer '+session.token}:{}),...(id?{'X-Request-ID':id}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal});let data;try{data=await r.json();}catch{throw Error('服务返回暂时不可读，请稍后重试。');}if(generation!==epoch)throw new DOMException('旧请求已结束','AbortError');if(!r.ok){const e=Object.assign(Error('云端请求失败'),{code:data.error?.message,status:r.status,safeToRetry:data.error?.safeToRetry});if(r.status===401&&!anonymous)lock('登录已过期，请重新输入动态验证码。');throw e;}return data;}
  finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort);controllers.delete(controller);}
 }
 async function enter(){
  const generation=epoch;$('logout').hidden=false;$('workspace').hidden=false;$('workspace').inert=true;
  const start=refresh();await animate($('gate'),[{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(-10px)'}],{duration:300,easing:'cubic-bezier(.23,1,.32,1)'});if(generation!==epoch)return;$('gate').hidden=true;$('workspace').inert=false;
  for(const [i,n]of [...$('workspace').children].slice(0,5).entries())if(!n.hidden)animate(n,[{opacity:0,transform:'translateY(11px)'},{opacity:1,transform:'translateY(0)'}],{duration:420,delay:i*35,easing:'cubic-bezier(.22,.9,.36,1)'});
  await start;
 }
 async function login(event){event?.preventDefault();if(loginBusy)return;const code=$('code').value.replace(/\D/g,'');if(code.length!==6){$('gateError').textContent='请输入六位动态验证码。';$('code').focus();return;}loginBusy=true;$('loginButton').disabled=true;$('loginButton').querySelector('span').textContent='正在验证';$('gateError').textContent='';
  try{session=await api('/session',{method:'POST',body:{code},anonymous:true});storage.set('bc_console_session',session);$('code').value='';await enter();}
  catch(e){if(!$('gate').hidden){$('gateError').textContent=message(e);$('code').focus();$('code').select();animate($('code'),[{transform:'translateX(0)'},{transform:'translateX(-5px)'},{transform:'translateX(4px)'},{transform:'translateX(0)'}],{duration:280,easing:'ease-out'});}}
  finally{loginBusy=false;$('loginButton').disabled=false;$('loginButton').querySelector('span').textContent='进入工作台';}
 }
 function provider(){return latest?.api.providers.find(p=>p.id===$('provider').value);}
 function model(){return provider()?.models.find(m=>m.id===$('model').value);}
 function selectOptions(select,rows,wanted){const fragment=document.createDocumentFragment();for(const row of rows){const option=el('option',row.label||row.name||row.id);option.value=row.id;option.disabled=row.disabled||false;fragment.append(option);}select.replaceChildren(fragment);select.value=rows.some(r=>r.id===wanted&&!r.disabled)?wanted:rows.find(r=>!r.disabled)?.id||'';}
 function modelOptions(wanted=desiredModel){
  const p=provider(),q=$('search').value.trim().toLowerCase(),all=p?.models||[],matches=all.filter(m=>!q||(m.id+' '+m.name).toLowerCase().includes(q));
  selectOptions($('model'),matches.map(m=>({id:m.id,label:m.name+' · '+m.id})),wanted);if(!matches.length){const option=el('option','没有匹配的型号');option.value='';$('model').append(option);}
  $('modelCount').textContent=matches.length+' / '+all.length;modelHelp();
 }
 function modelHelp(){
  const m=model(),previous=selectedEffort||latest?.api.defaultEffort||'standard',tiers=m?.nativeEfforts?.length?m.nativeEfforts:Object.keys(m?.efforts||{});
  selectedEffort=tiers.includes(previous)?previous:tiers.find(t=>m?.efforts[t]===m?.efforts[previous])||tiers.find(t=>m?.efforts[t]==='high')||tiers[0]||'';
  $('efforts').replaceChildren();for(const tier of tiers){const b=el('button',efforts[tier]||tier);b.type='button';b.dataset.effort=tier;b.setAttribute('role','radio');b.setAttribute('aria-checked',String(tier===selectedEffort));b.tabIndex=tier===selectedEffort?0:-1;b.title=m.efforts[tier];$('efforts').append(b);}
  $('modelHelp').textContent=m?(m.note+(m.performance?' 参考输出 '+m.performance.tps+' tokens/s（'+m.performance.observedAt+'），非实时速度。':'')):'没有匹配的型号，请调整搜索内容。';
  $('accountField').hidden=provider()?.id!=='openai-codex';buttons();
 }
 function chosenEffort(tier){$('probeResult').hidden=true;selectedEffort=tier;dirty=true;for(const b of $('efforts').children){b.setAttribute('aria-checked',String(b.dataset.effort===tier));b.tabIndex=b.dataset.effort===tier?0:-1;}buttons();}
 function buttons(){
  const busy=submitting||!!pending||!!latest?.active,noData=!latest,locked=busy||noData||testing;
  for(const id of ['provider','model','search','account'])$(id).disabled=locked;for(const b of $('efforts').children)b.disabled=locked;
  $('start').disabled=locked||!['off','on'].includes(latest?.redis.status)||latest?.redis.status==='on';$('stop').disabled=locked||!['on','off'].includes(latest?.redis.status)||latest?.redis.status==='off';
  $('refresh').disabled=busy||loading||testing;$('refresh').setAttribute('aria-busy',String(loading||pending?.action==='status'||latest?.active?.action==='status'));
  const m=model(),p=provider(),same=latest?.api.provider===p?.id&&latest?.api.model===m?.id&&(latest?.api.defaultEffort===selectedEffort||m?.efforts[latest?.api.defaultEffort]===m?.efforts[selectedEffort])&&(p?.id!=='openai-codex'||latest?.api.accountId===$('account').value);
  $('probeModel').disabled=!testing&&(busy||noData||!p?.configured||!m||!selectedEffort||(p.id==='openai-codex'&&!$('account').value));$('probeModel').textContent=testing?'取消测试':'测试连通';$('probeModel').setAttribute('aria-busy',String(testing));
  $('applyModel').disabled=locked||!p?.configured||!m||!selectedEffort||same||(p.id==='openai-codex'&&!$('account').value);$('draftHint').textContent=dirty&&!same?'有尚未应用的调整':'已提交的对话保留原配置';
 }
 function render(data){
  latest=data;const p=data.api.providers.find(p=>p.id===data.api.provider),m=p?.models.find(m=>m.id===data.api.model);
  $('currentModel').textContent=(p?.label||data.api.provider||'尚未配置')+' · '+(m?.name||data.api.model||'—');$('currentEffort').textContent='默认 '+(efforts[data.api.defaultEffort]||data.api.defaultEffort)+(m?.efforts[data.api.defaultEffort]?' · '+m.efforts[data.api.defaultEffort]:'');
  if(!dirty){selectOptions($('provider'),data.api.providers.map(p=>({id:p.id,label:p.label+(p.configured?'':' · 未配置'),disabled:!p.configured})),data.api.provider);desiredModel=data.api.model;selectedEffort=data.api.defaultEffort;$('search').value='';}
  selectOptions($('account'),data.api.accounts.map(a=>({id:a.id,label:a.label+(a.status==='ready'?' · 可用':' · 待授权'),disabled:a.status!=='ready'})),dirty?$('account').value:data.api.accountId);
  modelOptions();
  const status=data.redis.status;$('statusPanel').dataset.state=status;$('stateText').textContent={on:'已开启',off:'已关闭',pending:'处理中',isolated:'已隔离',unknown:'尚未确认'}[status];
  $('stateDescription').textContent={on:'Redis 已运行。使用期间按量计费，闲时可关闭。',off:'Redis 当前关闭。需要使用北辰时，可在这里开启。',pending:'云端正在调整服务，请等待任务完成。',isolated:'实例已隔离，请先核验实际云端状态。',unknown:'暂未确认 Redis 状态，请核验后再操作。'}[status];
  $('readyText').textContent=data.ready===true?'已就绪':data.ready===false?'未就绪':'尚未确认';$('monitorText').textContent={on:'监测中',off:'已暂停',unknown:'尚未确认'}[data.monitor];
  $('updated').textContent='上次核验 '+date(data.checkedAt)+(data.stale?' · 状态可能已变化':'');
  $('history').replaceChildren();for(const run of data.runs){const li=el('li'),copy=el('div',undefined,'record-copy');copy.append(el('strong',titles[run.action]||'服务操作'),el('time',date(run.createdAt)));const details=el('button','进度 ↗','text-btn');details.type='button';details.dataset.task=run.id;details.setAttribute('aria-label','查看'+(titles[run.action]||'任务')+'，'+date(run.createdAt)+'的进度');li.append(el('span',run.action==='off'?'↓':run.action==='on'?'↑':'↻','record-mark'),copy,el('span',labels[run.conclusion||run.status]||'执行中','result '+(run.conclusion||'')),details);$('history').append(li);}
  $('historyEmpty').hidden=!!data.runs.length;$('historyEmpty').textContent='暂无服务操作记录';$('historyCount').textContent='最近 '+data.runs.length+' 次';
  const task=data.active||pending;$('taskPanel').hidden=!task;if(task){$('taskTitle').textContent=titles[task.action]||'云端任务';$('taskStep').textContent=data.active?(labels[task.status]||'执行中'):(pending?.uncertain?'接收结果尚未确认，请核对本次提交。':'已发送，等待云端任务出现。');$('taskLabel').textContent=data.active?'云端正在处理':'任务提交中';}
  buttons();if(data.warnings.length)error(data.warnings.join('；'));
 }
 function schedule(){clearTimeout(timer);if(!document.hidden&&session&&(pending||latest?.active))timer=setTimeout(()=>refresh(),4500);}
 async function refresh(){
  if(!session||loading||document.hidden)return;loading=true;const generation=epoch;buttons();
  try{const data=await api('/state');if(generation!==epoch)return;let completed=latest?.active?data.runs.find(r=>r.id===latest.active.id&&r.status==='completed'):null;
   if(pending){const run=data.runs.find(r=>r.requestId===pending.id);if(run){if(run.status==='completed'){completed=run;pending=null;rememberPending();if(run.conclusion==='success')dirty=false;}else{pending=null;rememberPending();}}}
   if(completed?.conclusion==='success')dirty=false;error('');render(data);if(pending?.uncertain)error('尚未确认云端接收。可用原任务号继续核对，请勿另建重复任务。');
   if(completed)notice(completed.conclusion==='success'?(titles[completed.action]+'已完成，核验结果已更新。'):(titles[completed.action]+'未完成，请查看任务进度。'));
   if($('progress').open&&progressId)await loadProgress(progressId);
  }catch(e){if(generation===epoch&&session)error(message(e));}
  finally{if(generation===epoch){loading=false;buttons();schedule();}}
 }
 async function submit(action,target={},id){
  if(submitting||latest?.active)return;submitting=true;const generation=epoch;pending={id:id||crypto.randomUUID(),action,target,at:Date.now(),uncertain:false};rememberPending();buttons();error('');renderTask();
  try{const result=await api('/actions',{method:'POST',body:{action,...target},id:pending.id});if(generation!==epoch)return;if(result.status==='uncertain'){pending.uncertain=true;rememberPending();throw Object.assign(Error('尚未确认云端接收。'),{code:'BEICHEN_CONSOLE_SUBMISSION_UNCERTAIN'});}if(result.status==='rejected'){pending=null;rememberPending();throw Error('这次提交已被拒绝，未执行变更，请核对连接后重新操作。');}notice('任务已交给云端。关闭页面后也会继续，重新进入可查看结果。');}
  catch(e){if(generation!==epoch)return;if(e.safeToRetry||e.code==='BEICHEN_CONSOLE_TASK_ACTIVE'){pending=null;rememberPending();}else if(pending){pending.uncertain=true;rememberPending();}error(message(e));}
  finally{if(generation===epoch){submitting=false;renderTask();buttons();await refresh();}}
 }
 function renderTask(){const task=latest?.active||pending;$('taskPanel').hidden=!task;if(task){$('taskTitle').textContent=titles[task.action]||'云端任务';$('taskLabel').textContent='云端执行';$('taskStep').textContent=pending?.uncertain?'提交结果尚未确认，可使用原任务号继续核对。':labels[task.status]||'正在提交，请稍候。';}}
 function openDialog(dialog){
  dialogAnimations.get(dialog)?.cancel();dialog.inert=false;if(!dialog.open)dialog.showModal();if(!reduce.matches){const a=dialog.animate([{opacity:0,transform:'translateY(14px) scale(.97)'},{opacity:1,transform:'translateY(0) scale(1)'}],{duration:340,easing:'cubic-bezier(.22,1.1,.36,1)'});dialogAnimations.set(dialog,a);}
 }
 async function closeDialog(dialog){if(!dialog.open)return;const old=dialogAnimations.get(dialog),computed=getComputedStyle(dialog),from={opacity:computed.opacity,transform:computed.transform};old?.cancel();dialog.inert=true;
  if(!reduce.matches){const a=dialog.animate([from,{opacity:0,transform:'translateY(8px) scale(.985)'}],{duration:180,easing:'cubic-bezier(.4,0,1,1)'});dialogAnimations.set(dialog,a);await a.finished.catch(()=>{});if(dialogAnimations.get(dialog)!==a)return;}
  dialog.close();dialog.inert=false;
 }
 function confirm(action,target={}){
  confirmation={action,target};$('confirmAction').classList.toggle('danger',action==='off');$('confirmAction').classList.toggle('primary',action!=='off');$('confirmTitle').textContent={on:'让北辰重新就绪？',off:'暂时关闭 Redis？',switch:'为新对话更换模型？'}[action]||'确认操作';
  $('confirmBody').textContent={on:'将创建或复用 Redis 并连接北辰，核验通过后恢复监测。Redis 开启期间按量计费。',off:'将销毁按量 Redis。云端学生会话与额度状态会清空，保留重建配置；服务工作台仍可登录。',switch:'先检查所选模型与档位，检查通过后再更新配置。切换会重载服务实例，建议在没有进行中的学生请求时操作。'}[action];
  $('confirmAction').textContent=action==='off'?'确认关闭':action==='on'?'确认开启':action==='switch'?'检查并应用':'确认保存';const m=model();$('confirmDetail').hidden=action!=='switch';$('confirmDetail').textContent=action==='switch'?[provider().label,m.name+' · '+m.id,'思考强度：'+(efforts[target.effort]||target.effort)+' / '+m.efforts[target.effort]].join('\n'):'';openDialog($('confirm'));
 }
 async function loadProgress(id){
  try{const data=await api('/tasks/'+id);if(!session||progressId!==id)return;$('progressTitle').textContent=titles[data.action]||'任务进度';$('progressSteps').replaceChildren();const steps=data.jobs.flatMap(j=>j.steps).filter(s=>!['Set up job','Complete job'].includes(s.name));
   for(const step of steps){const li=el('li'),mark=step.conclusion==='success'?'✓':step.conclusion==='failure'?'!':step.status==='in_progress'?'◌':'·';li.append(el('span',mark,'step-mark '+(step.conclusion||'')),el('span',step.name));$('progressSteps').append(li);}
   if(!steps.length)$('progressSteps').append(el('li','任务正在等待执行。'));$('progressHint').textContent=data.status==='completed'?(data.conclusion==='success'?'任务已完成，最终状态已回读。':'任务未完成，原有配置以最新核验结果为准。'):'任务在云端执行，关闭页面不会中断。';
  }catch(e){$('progressHint').textContent=message(e);}
 }
 function showProgress(id){progressId=String(id);$('progressSteps').replaceChildren(el('li','正在读取进度…'));$('progressHint').textContent='';openDialog($('progress'));loadProgress(progressId);}
 $('loginForm').addEventListener('submit',login);$('code').addEventListener('input',()=>{const clean=$('code').value.replace(/\D/g,'').slice(0,6);$('code').value=clean;if(clean.length===6)login();});
 $('logout').onclick=async()=>{if(submitting)return;$('logout').disabled=true;try{await api('/session',{method:'DELETE'});lock('你已退出工作台。');}catch(e){if(session)error('退出暂未确认，请重试。');}finally{$('logout').disabled=false;}};
 $('themeButton').onclick=()=>{const value=window.beichenTheme.next();$('themeButton').setAttribute('aria-label','界面主题：'+({auto:'跟随系统',light:'日光',dark:'夜航'}[value])+'，点击切换');};
 $('refresh').onclick=()=>submit('status');$('retry').onclick=()=>pending?.uncertain?submit(pending.action,pending.target,pending.id):refresh();
 $('start').onclick=()=>confirm('on');$('stop').onclick=()=>confirm('off');$('cancel').onclick=()=>closeDialog($('confirm'));$('confirmAction').onclick=async()=>{const c=confirmation;if(!c||submitting)return;confirmation=null;await closeDialog($('confirm'));submit(c.action,c.target);};
 async function testConnection(){
  if(testing){probeController?.abort();return;}if($('probeModel').disabled)return;
  const generation=epoch,target={provider:$('provider').value,model:$('model').value,effort:selectedEffort,...($('provider').value==='openai-codex'?{accountId:$('account').value}:{})},name=model().name,started=Date.now();
  testing=true;probeController=new AbortController();const controller=probeController;$('probeResult').hidden=false;$('probeResult').className='probe-result';$('probeResult').textContent='正在连接 '+name+' · '+target.effort+'…';buttons();
  const elapsed=setInterval(()=>{if(generation===epoch&&testing)$('probeResult').textContent='正在连接 '+name+' · '+target.effort+'，已等待 '+Math.floor((Date.now()-started)/1000)+' 秒…';},1000);
  try{const result=await api('/probe',{method:'POST',body:target,signal:controller.signal,timeoutMs:175000});if(generation!==epoch)return;$('probeResult').className='probe-result success';$('probeResult').textContent='连接成功 · '+(result.latencyMs/1000).toFixed(1)+' 秒 · '+name+' / '+target.effort;}
  catch(e){if(generation===epoch&&session){$('probeResult').className='probe-result '+(controller.signal.aborted?'':'failure');$('probeResult').textContent=controller.signal.aborted?'本次测试已取消。':message(e);}}
  finally{clearInterval(elapsed);if(generation===epoch){testing=false;probeController=null;buttons();}}
 }
 $('probeModel').onclick=testConnection;
 $('modelForm').onsubmit=e=>{e.preventDefault();if($('applyModel').disabled)return;confirm('switch',{provider:$('provider').value,model:$('model').value,effort:selectedEffort,...($('provider').value==='openai-codex'?{accountId:$('account').value}:{})});};
 $('provider').onchange=()=>{$('probeResult').hidden=true;dirty=true;desiredModel='';selectedEffort='';$('search').value='';modelOptions();};$('model').onchange=()=>{$('probeResult').hidden=true;dirty=true;desiredModel=$('model').value;modelHelp();};$('search').oninput=()=>{$('probeResult').hidden=true;dirty=true;modelOptions();};$('account').onchange=()=>{$('probeResult').hidden=true;dirty=true;buttons();};
 $('efforts').onclick=e=>{const b=e.target.closest('[data-effort]');if(b&&!b.disabled)chosenEffort(b.dataset.effort);};$('efforts').onkeydown=e=>{const nodes=[...$('efforts').children].filter(b=>!b.disabled),index=nodes.indexOf(e.target);if(index<0||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?nodes.length-1:(index+(e.key==='ArrowLeft'?-1:1)+nodes.length)%nodes.length;chosenEffort(nodes[next].dataset.effort);nodes[next].focus();};
 $('history').onclick=e=>{const b=e.target.closest('[data-task]');if(b)showProgress(b.dataset.task);};$('taskDetails').onclick=()=>latest?.active?showProgress(latest.active.id):refresh();$('closeProgress').onclick=()=>closeDialog($('progress'));
 for(const dialog of [$('confirm'),$('progress')]){dialog.addEventListener('cancel',e=>{e.preventDefault();closeDialog(dialog);});dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeDialog(dialog);}});}
 document.addEventListener('visibilitychange',()=>{clearTimeout(timer);if(!document.hidden&&session)refresh();});window.addEventListener('pageshow',e=>{if(e.persisted&&session)refresh();});
 if(session?.token&&session.expiresAt>Date.now())enter();else{session=null;storage.set('bc_console_session',null);}
})();
