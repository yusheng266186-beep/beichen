'use strict';
/* 页面契约:双模式、两段式、宽容星图解析、设置面板、安全接线 */
const assert = require('assert');
const fs = require('fs');
const index = fs.readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');

/* 双模式 */
assert.match(index, /id="modeModal"/);
assert.match(index, /function chooseMode\(/);
assert.match(index, /let MODE = 'guided'/);
assert.match(index, /const OPEN_GUIDANCE = \{/);
assert.match(index, /openGuidance\(n\)/);
assert.match(index, /OPENINGS2\.askOpen/);
assert.match(index, /addSubjectPicker\(\);/);
assert.doesNotMatch(index, /MODE === 'open'[\s\S]{0,120}addSubjectPicker/);
assert.doesNotMatch(index, /OPEN_GUIDANCE\[1\][\s\S]{0,400}【选项】/);
assert.match(index, /else if\(MODE === 'open'\)\{\s*choicesWrap\.classList\.add\('hide'\)/);

/* 两段式:格式契约标准,正文自由;提问以普通段落呈现(无框无符号) */
assert.match(index, /「想问你：」/);
assert.match(index, /function renderTurnHTML\(/);
assert.match(index, /mdLite\(parts\.answer\) \+ '<br><br>' \+ mdLite\(q\)/);
assert.doesNotMatch(index, /next-q/);
assert.match(index, /【选项】/);

/* 星图:宽容解析 + 组合缩写,绝不死循环 */
assert.match(index, /map\._complete = Boolean\(complete\)/);
assert.match(index, /物:'物理',化:'化学',生:'生物'/);
assert.doesNotMatch(index, /comboParts\.length < 4/);

/* 接线与安全 */
assert.match(index, /^const RELAY = 'https:\/\/[a-z0-9-]+\.ap-chengdu\.tencentscf\.com';$/m);
assert.match(index, /connect-src 'self' https:\/\/[a-z0-9-]+\.ap-chengdu\.tencentscf\.com/);
/* 截图组件自托管：零第三方脚本依赖,CSP 不再放行 jsdelivr */
assert.match(index, /<script src="vendor\/html2canvas\.min\.js" defer><\/script>/);
assert.match(index, /script-src 'self' 'unsafe-inline'/);
assert.doesNotMatch(index, /cdn\.jsdelivr/);
{
  const vendorPath = require('path').join(__dirname, '..', 'vendor', 'html2canvas.min.js');
  assert.ok(fs.existsSync(vendorPath), 'vendor/html2canvas.min.js missing');
  assert.ok(fs.readFileSync(vendorPath, 'utf8').startsWith('/*!'), 'vendor bundle lost its license banner');
}
assert.match(index, /function wipeLocalData\(btn\)/);
assert.match(index, /id="statRuns"/);

/* 模式随会话持久化 */
assert.match(index, /mode: MODE,/);
assert.match(index, /if\(s\.mode === 'open' \|\| s\.mode === 'guided'\)/);

/* 自适应星图：reportRequested 驱动、阈值入口、额度先告知、确认弹窗、再点亮 */
assert.match(index, /let reportRequested = false;/);
assert.match(index, /const OPEN_REPORT_MIN_TURNS = 5;/);
assert.match(index, /function guidedAutoReportDue\(\)\{/);
assert.match(index, /return !reportDone && !reportRequested && MODE === 'guided' && turnCount >= 10 && !guidedAutoTried;/);
assert.match(index, /if\(guidedAutoReportDue\(\)\) return buildReportInstructions\(\);/);
assert.match(index, /const expectingReport = reportRequested \|\| autoGuidedReport;/);
assert.match(index, /function openReportAsk\(\)/);
assert.match(index, /async function requestReport\(\)/);
assert.match(index, /id="reportAskModal"/);
assert.match(index, /点亮会消耗 <b>1 次谈心额度<\/b>（剩 ' \+ \(GATE_MAX_RUNS - runs\) \+ '\/' \+ GATE_MAX_RUNS/);
assert.match(index, /if\(reportOffered \|\| turnCount >= OPEN_REPORT_FORCE_TURNS\) renderChips\(\['点亮星图'\]\);/);
assert.match(index, /星图 · 可点亮/);
assert.match(index, /const readyToLight = MODE === 'open' && !reportDone && \(reportOffered \|\| turnCount >= OPEN_REPORT_FORCE_TURNS\);/);

/* 夜航由辰实时评估点亮时机:第 5 轮起随轮下发评估指令,标记【可点亮】驱动入口,满 15 轮固定给出 */
assert.match(index, /const OPEN_REPORT_FORCE_TURNS = 15;/);
assert.match(index, /const OPEN_EVALUATION = /);
assert.match(index, /【可点亮/);
assert.match(index, /replace\(\/【可点亮\[\^】\]\*】\/g, ''\)/);
assert.match(index, /reportOffered = !reportDone && !!s\.reportOffered;/);
assert.match(index, /reportOffered: !reportDone && !!reportOffered,/);

/* 星图后转解答者:回答为主,不再主动提问 */
assert.match(index, /绝不再主动向 TA 提问/);
assert.match(index, /你的角色转为解答者/);

/* 开始任何新谈心前必须自选聊法：重新测试与无会话刷新都进模式选择
   (免验证回访延迟 480ms 弹出,让星门先淡出,模式弹窗进场动画不被遮住) */
assert.match(index, /if\(!restoreSession\(\)\)\{ setTimeout\(showModeSelect, 480\); \} return; \}/);
assert.match(index, /showModeSelect\(\);\s*\n\s*toast\('我们重新开始'\);/);

/* ─── v2.6 正确性与体验修复 ─── */
/* 输入法组词中的回车是确认候选,不得误发送 */
assert.match(index, /if\(e\.isComposing \|\| e\.keyCode === 229\) return;/);
/* 刘海屏:顶栏与遮罩都要避让状态栏 */
assert.match(index, /\.top\{[^}]*padding-top:env\(safe-area-inset-top,0px\)/);
assert.match(index, /padding:18px;padding-top:calc\(18px \+ env\(safe-area-inset-top,0px\)\)/);
/* 重测代际:旧一轮的错误/星图渲染不得写进重开后的新对话 */
assert.match(index, /let talkEpoch = 0;/);
assert.match(index, /talkEpoch\+\+;/);
assert.match(index, /const epoch = talkEpoch;/);
assert.match(index, /await processResponse\(raw, expectingReport, bubble, epoch\);/);
assert.match(index, /if\(epoch !== undefined && epoch !== talkEpoch\) return;/);
assert.doesNotMatch(index, /querySelector\('\.row:last-child \.bub'\)/);   /* 兜底只写流式气泡,不再按"最后一行"猜 */
assert.match(index, /restart\(\)\{\s*\/\* 先校验后中止/);   /* 校验不过不打断正在进行的生成 */
assert.match(index, /restartAfterVerify = true;/);
assert.match(index, /if\(restartAfterVerify\)\{ restartAfterVerify = false; restart\(\); return; \}/);
assert.match(index, /if\(restoreSession\(\)\) return;/);   /* 重验成功先接回本机未完的会话 */
/* 对话中途验证失效:把星门拉起来,用户有地方重新输入 */
assert.match(index, /验证在对话中途失效：除了提示，还要把星门拉起来让用户有地方重新输入/);
/* 星门验证 12s 超时,按钮不得永久卡住 */
assert.match(index, /const verifyTm = setTimeout\(\(\)=>ac\.abort\(\), 12000\);/);
assert.match(index, /signal: ac\.signal/);
/* 弹窗语义与键盘/返回键交互 */
assert.match(index, /id="modeModal" role="dialog" aria-modal="true" aria-label="选择聊法"/);
assert.match(index, /id="settingsModal" role="dialog" aria-modal="true" aria-label="设置"/);
assert.match(index, /const DISMISSIBLE = \[/);
assert.match(index, /e\.key === 'Escape' && top/);
assert.match(index, /window\.addEventListener\('popstate'/);
assert.match(index, /history\.pushState\(\{bcOv:1\},''\)/);
assert.match(index, /id="toast" role="status" aria-live="polite"/);
/* 瞬时动作按钮不回存;刷新后「点亮星图」入口仍恢复为按钮 */
assert.match(index, /filter\(c => c !== '重新点亮星图' && c !== '再试一次'\)/);
assert.match(index, /savedChoices\.length === 0 \|\| \(savedChoices\.length === 1 && savedChoices\[0\] === '点亮星图'\)/);
/* 对比度与文案体系 */
assert.match(index, /--mut:#5f615c;/);
assert.doesNotMatch(index, /#737570/);
assert.doesNotMatch(index, /NORTHSTAR/);
assert.doesNotMatch(index, /思考的扶手/);
assert.match(index, /聊到够了辰会主动告诉你/);
assert.match(index, /rel="icon"/);
assert.match(index, /name="theme-color"/);

/* ─── v2.6.1 全站动效丰富 + v2.6.2 滚动显现 ─── */
/* 动效 tokens 就位 */
assert.match(index, /--ease-spring:cubic-bezier\(\.22,1\.1,\.36,1\)/);
assert.match(index, /--ease-glide:cubic-bezier\(\.22,\.9,\.3,1\.05\)/);
/* 覆盖率条:transform 弹簧生长(合成器动画),构建时写内联最终宽度 */
assert.match(index, /transform:scaleX\(0\);transform-origin:0 50%;transition:transform 1\.1s var\(--ease-spring\)/);
assert.match(index, /class="cov-fill" style="width:'\+cov\+'%"/);
assert.match(index, /style="width:'\+c\.cov\+'%"/);
assert.doesNotMatch(index, /transition:width 1\.2s/);   /* 旧 width 过渡必须彻底移除 */
/* 轴星滑动统一走滑行 token */
assert.match(index, /transition:left 1\.4s var\(--ease-glide\)/);

/* ── 滚动显现:进入视口才进场,不滑动就不播 ── */
assert.match(index, /document\.documentElement\.classList\.add\('js'\)/);   /* 隐藏规则只在 JS 可用时生效 */
assert.match(index, /html\.js \[data-reveal\]:not\(\.revealed\)\{opacity:0\}/);
assert.match(index, /\[data-reveal\]\.revealed\{animation:msg-in \.55s var\(--ease-stagger\) both\}/);
assert.match(index, /\.report-card\.capture-clone \[data-reveal\]\{opacity:1!important;animation:none!important\}/);   /* 截图克隆强制最终态 */
assert.match(index, /function growFills/);
assert.match(index, /function revealWithin/);
assert.match(index, /new IntersectionObserver/);
assert.match(index, /revealWithin\(card \|\| el\)/);   /* 打开弹窗即开始观察 */
assert.match(index, /sort\(\(a,b\)=>a\.boundingClientRect\.top - b\.boundingClientRect\.top\)/);   /* 同批自上而下错拍 */
/* 每次打开都重新武装显现状态:第二次打开动画从头可播,不再"只演一次" */
assert.match(index, /function rearmReveal/);
assert.match(index, /rearmReveal\(card \|\| el\);/);
assert.match(index, /t\.classList\.remove\('revealed'\);/);
assert.doesNotMatch(index, /#reportModal\.show \.rc-body > \*/);   /* 打开即播的正文 stagger 必须移除 */
assert.doesNotMatch(index, /#modeModal\.show \.mode-card\{/);
/* data-reveal 布点:报告卡分区/收尾区/按钮,设置与数据与选聊法正文,JS 构建项 */
assert.match(index, /class="rc-sec-lb" data-reveal/);
assert.match(index, /class="bless" data-reveal/);
assert.match(index, /data-reveal id="rp-time"/);
assert.match(index, /data-reveal id="rp-quota"/);
assert.match(index, /id="saveReportBtn" data-reveal/);
assert.match(index, /class="stat-card" data-reveal/);
assert.match(index, /class="dev-note" data-reveal/);
assert.match(index, /class="modal-acts" data-reveal/);
assert.match(index, /class="dsec" data-reveal/);
assert.match(index, /class="mode-card" data-reveal/);
assert.match(index, /class="settings-note" data-reveal/);
assert.match(index, /div\.className = 'starcard'; div\.setAttribute\('data-reveal',''\);/);
assert.match(index, /b\.className = 'mj' \+ \(\(m\.reason \|\| m\.career\) \? ' link' : ''\);/);
assert.match(index, /div\.className = 'combo' \+ \(isPrimary\?'':' alt'\); div\.setAttribute\('data-reveal',''\);/);
assert.match(index, /row\.className = 'crow'; row\.setAttribute\('data-reveal',''\);/);
assert.doesNotMatch(index, /animationDelay = \(i\*90\)/);   /* 旧的内联延迟已被 IO 批次错拍取代 */

/* ── v2.6.9 星图轮等待:思考低语(真实 reasoning 增量上屏)+叙述轮播兜底 ── */
assert.match(index, /onReasoning, onReasoningDelta \} = opt/);   /* askStream 暴露思考增量回调 */
assert.match(index, /if\(onReasoningDelta\) onReasoningDelta\(reasoning\)/);
assert.match(index, /onReasoningDelta: onThink/);   /* respond 接线 */
assert.match(index, /function showThink/);
assert.match(index, /function clearThink/);
assert.match(index, /const REPORT_WAIT_LINES = \[/);
assert.match(index, /function startReportWait/);
assert.match(index, /function stopReportWait/);
assert.match(index, /stopReportWait\(\); setTypingLabel\('辰在安静思考'\)/);   /* 真思考上线,轮播让位 */
assert.match(index, /if\(expectingReport\) startReportWait\(\)/);   /* 星图轮启动轮播兜底 */
assert.match(index, /\.typing-think\{/);   /* 低语样式:第二行,淡入 */
assert.match(index, /if\(now - lastThinkSwap < 600\) return;/);   /* 600ms 节流 */
assert.match(index, /item\.content\.indexOf\('开场：'\) === 0\) return/);   /* 刷新恢复:占位符不上屏 */
assert.match(index, /【思考语言】你的全部内部思考一律用中文进行/);   /* 低语观感:中文思考 */

/* ── v2.6.7/8 专业解析悬浮卡(分析+就业方向,无角标,全站动效) + FAQ 赋分/改科 + 回程淡入可感知 ── */
assert.match(index, /【专业】5-8个专业方向，每个依次输出三段：专业名\|\|推荐分析\|\|就业方向/);   /* 报告契约:名||分析||就业 三段成组,5-8个 */
assert.match(index, /function openMajorPop/);
assert.match(index, /function mjPopClose\(immediate\)/);
assert.match(index, /mjPopClose\(true\)/);   /* 重开报告/重新渲染时直接收起悬浮卡 */
assert.match(index, /if\(mjPopState\)\{ mjPopClose\(\); return; \}/);   /* Esc 先收悬浮卡,不关报告 */
assert.match(index, /\.mj-pop\{[\s\S]*?position:absolute;/);
assert.match(index, /animation:msg-in \.34s var\(--ease-spring\) both/);   /* 悬浮卡入场复用全站 msg-in */
assert.doesNotMatch(index, /@keyframes popIn/);   /* 不再私有 keyframes,与全站动效一致 */
assert.doesNotMatch(index, /\.mj\.link::after/);   /* 专业 pill 不带角标符号 */
assert.match(index, /\.report-card\.capture-clone \.mj-pop,/);   /* 截图不含悬浮卡 */
assert.match(index, /mp-career/);   /* 就业方向段 */
assert.match(index, /b\.title = '点开看专业解析'/);
assert.match(index, /再选科目要赋分，赋分是怎么算的？/);
assert.match(index, /选科定了以后还能改吗？/);
assert.match(index, /3\+1\+2 等级赋分通行规则/);   /* FAQ 事实来源注记 */

/* ── v2.6.4 数据参考全量显现 + 霍兰德条形 + 数字计数 ── */
assert.match(index, /function countUp/);
assert.match(index, /t\.querySelectorAll\('\.stat b'\)\.forEach\(\(b,i\)=>countUp\(b, 120 \+ i\*80\)\)/);   /* 核心数据逐格计数 */
assert.match(index, /countUp\(leanEm, 200, 1400\)/);   /* 星值与轴星滑动同步计数 */
assert.match(index, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/) ;
assert.match(index, /querySelectorAll\('\.cov-fill, \.hl-f'\)/);   /* 霍兰德六条与覆盖率条同款弹簧 */
assert.match(index, /#dataModal \.cov-fill, #dataModal \.hl-f/);   /* 重置覆盖霍兰德条 */
assert.match(index, /\.hl-f\{height:100%;border-radius:99px;transform:scaleX\(0\);transform-origin:0 50%;transition:transform 1\.1s var\(--ease-spring\)\}/);
assert.match(index, /details\.faq\[open\] \.faq-a\{animation:msg-in/);   /* FAQ 展开轻浮现 */
assert.match(index, /class="model-card" data-reveal/);
assert.match(index, /class="faq" data-reveal/);
assert.match(index, /class="book" data-reveal/);
assert.match(index, /class="dsec-t" data-reveal/);
assert.equal((index.match(/class="dsec" data-reveal/g)||[]).length, 2);   /* 仅核心数据/十二组合保留容器级显现 */

/* ── v2.6.5 细节打磨;v2.6.13 回程动画整套移除(用户定案:回程即时呈现) ── */
assert.doesNotMatch(index, /watchReturn/);   /* 上滑回程动画系统已删 */
assert.doesNotMatch(index, /returnIO/);
assert.doesNotMatch(index, /msg-in-back/);
assert.doesNotMatch(index, /_exitTop/);
assert.doesNotMatch(index, /t\.animate\(\{opacity:\[0,1\]\}/);   /* 纯透明度淡入同样不存在 */
assert.match(index, /function rearmReveal/);
assert.match(index, /rearmReveal\(el\);/);   /* 选聊法再次弹出也重播双卡进场 */
assert.match(index, /\.gate-in\.enter\{animation:land-up/);   /* 星门入场可重播 */
assert.match(index, /class="gate-in enter"/);
assert.match(index, /gi\.classList\.remove\('enter'\); void gi\.offsetWidth; gi\.classList\.add\('enter'\);/);   /* 重新上锁重演 */
assert.match(index, /#reportBtn\{animation:msg-in \.45s var\(--ease-stagger\) both\}/);   /* 星图按钮就绪弹出 */
assert.match(index, /details\.faq summary:active\{opacity:\.7\}/);   /* FAQ 按压反馈 */
assert.doesNotMatch(index, /[^.]\.gate-in > \*:nth-child/);   /* 星门子动画必须收编到 .enter 作用域 */

/* 确认小卡整卡在首屏,保留打开即微递进 */
assert.match(index, /\.overlay\.show \.restart-card > \*\{animation:msg-in/);
assert.match(index, /\.gate-in\.enter > \*:nth-child\(2\)\{animation:msg-in/);
assert.match(index, /\.gate-in\.enter > \*:nth-child\(10\)\{animation:msg-in/);

/* ── 星图前置回应:引导词强制先写临别回应再输出星图(否则等待期无文字可流式) ── */
assert.match(index, /第一段（先输出）：给 TA 的临别回应，60~100 字/);
assert.match(index, /从【北辰星图】这一行起不要输出标签格式之外的任何内容/);

/* 全站主题化命名：开发代号"自由聊/有扶手"不得再出现在页面任何位置 */
assert.doesNotMatch(index, /自由聊|有扶手/);

/* 提示词拆分：SYSTEM 基座模式中性，选项格式指令随有扶手引导词下发 */
const systemBlock = /const SYSTEM = `[\s\S]*?`;/.exec(index)[0];
assert.match(systemBlock, /绝不输出【选项】/);
assert.doesNotMatch(systemBlock, /每轮末尾附【选项】/);
assert.match(index, /GUIDED_OPTION_FORMAT/);

/* 去十轮化：自由聊轮数可变后，历史压缩与星图指令不再绑定"十问" */
assert.doesNotMatch(index, /完成了十问谈心/);
assert.doesNotMatch(index, /十问已毕——你的星图画好了/);
assert.match(index, /与一位高一学生的谈心记录，学生说过的话（按时间顺序）/);

/* 超长对话裁剪：中转上限 24 条消息，上下文最多 22 条 */
assert.match(index, /const MAX_CONTEXT_MESSAGES = 22;/);
assert.match(index, /history\.slice\(-\(MAX_CONTEXT_MESSAGES - 1\)\)/);

/* 引导词扩池行为级验证：从页面源码提取 openGuidance，1-30 轮永不空串且不泄漏【选项】 */
const poolBlock = /const OPEN_GUIDANCE = \{[\s\S]*?\n\};/.exec(index)[0];
function grabFn(startMarker){
  const i = index.indexOf(startMarker);
  assert.ok(i >= 0, 'missing ' + startMarker);
  const j = index.indexOf('\n}', i);
  return index.slice(i, j + 2);
}
const openLib = [poolBlock, grabFn('function openDeepening'), grabFn('function openGuidance')].join('\n\n');
const guidanceAt = new Function('n', openLib + '\nreturn openGuidance(n);');
for(let n = 1; n <= 30; n++){
  const g = guidanceAt(n);
  assert.ok(typeof g === 'string' && g.length > 20, 'openGuidance(' + n + ') 非空串');
  /* 允许出现"绝不输出【选项】标签"的禁令文字，但绝不携带选项格式模板 */
  assert.ok(!g.includes('选项A||') && !g.includes('||'), 'openGuidance(' + n + ') 不得携带【选项】格式模板');
}

/* 不引用已删除的备用中转 */
assert.doesNotMatch(index, /relay-worker/);

/* 请求契约:页面不携带 model 字段,模型名由服务端固定 */
assert.doesNotMatch(index, /model: MODEL/);
assert.doesNotMatch(index, /const MODEL =/);

/* ─── v2.6.14 超长输入防线 + 设置面板版本标记 ─── */
/* 发送前本地拦截超长输入:误粘长文被云端 400 拒收后会永久留在 history 里锁死整段会话 */
assert.match(index, /const MAX_INPUT_CHARS = 6000;/);
assert.match(index, /if\(text\.length > MAX_INPUT_CHARS\)\{/);
/* 400/413 不再误报为"网络连接失败" */
assert.match(index, /if\(status === 400 \|\| status === 413\) return \/TOO_LARGE\/\.test\(msg\)/);
/* 页面版本标记:设置面板可见,随改动递增(CDN 缓存排障用) */
assert.match(index, /const APP_VERSION = 'v2\.\d+\.\d+';/);
assert.match(index, /id="statVer"/);

/* ─── v2.6.15 领航自动星图只试一次 + 验证票据改存 localStorage ─── */
assert.match(index, /let guidedAutoTried = false;/);
assert.match(index, /if\(autoGuidedReport\) guidedAutoTried = true;/);
assert.match(index, /reportAttempted: !reportDone && MODE === 'guided' && guidedAutoTried,/);
assert.match(index, /guidedAutoTried = !reportDone && MODE === 'guided' && !!s\.reportAttempted;/);
assert.match(index, /reportRequested = true; respond\(buildGuidance\(99\)\)/);   /* 解析失败按钮=显式点亮,按星图档重发 */
assert.match(index, /if\(expectingReport\) reportRequested = true; respond\(guidance\)/);   /* 网络失败重试接回点亮意图 */
assert.match(index, /领航自动星图已尝试过仍未成功/);   /* 刷新后恢复「点亮星图」入口而非自动重试 */
assert.match(index, /try\{ return window\.localStorage; \}catch\(_\)\{ return window\.sessionStorage; \}/);   /* 票据主存 localStorage(用户拍板) */
assert.match(index, /if\(!gateToken\(\) && window\.sessionStorage\.getItem\(GATE_TOKEN_KEY\)\)/);   /* 旧票迁移:在聊学生免重验 */
assert.doesNotMatch(index, /Older builds kept the token in localStorage/);   /* 迁移注释必须同步更新 */

/* ─── v2.6.16 字体主源切 Google Fonts(大陆边缘实测快一个量级) + load 后注入不拖进度条 + 本地兜底 ─── */
assert.match(index, /fonts\.googleapis\.com\/css2\?family=Cormorant\+Garamond:ital,wght@0,400;0,600;1,400&family=Noto\+Serif\+SC:wght@400;500;700&display=swap/);
assert.match(index, /loadFonts\(GOOGLE_FONTS, 'fonts\/fonts\.css'\)/);   /* Google 失败自动回退自托管,最坏情况字形照旧 */
assert.match(index, /window\.addEventListener\('load', start\)/);   /* 页面 load 后才注入:字体不参与"加载完成"信号 */
assert.match(index, /style-src 'self' 'unsafe-inline' https:\/\/fonts\.googleapis\.com/);
assert.match(index, /font-src 'self' https:\/\/fonts\.gstatic\.com/);
assert.match(index, /rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin/);
assert.match(index, /<noscript><link rel="stylesheet" href="fonts\/fonts\.css"><\/noscript>/);
assert.doesNotMatch(index, /media="print" onload="this\.media='all'"/);   /* 旧 print-trick 必须移除(它会拖住进度条) */

console.log('index contract tests passed');
