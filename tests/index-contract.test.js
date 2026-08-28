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
assert.match(index, /integrity="sha384-/);
assert.match(index, /function wipeLocalData\(btn\)/);
assert.match(index, /id="statRuns"/);

/* 模式随会话持久化 */
assert.match(index, /mode: MODE,/);
assert.match(index, /if\(s\.mode === 'open' \|\| s\.mode === 'guided'\)/);

/* 自适应星图：reportRequested 驱动、阈值入口、额度先告知、确认弹窗、再点亮 */
assert.match(index, /let reportRequested = false;/);
assert.match(index, /const OPEN_REPORT_MIN_TURNS = 5;/);
assert.match(index, /const expectingReport = reportRequested \|\| \(!reportDone && MODE === 'guided' && turnCount >= 10\);/);
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

console.log('index contract tests passed');
