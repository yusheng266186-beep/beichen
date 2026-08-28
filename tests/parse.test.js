/* 星图解析行为级测试:从 index.html 提取页面真实函数,跑关键场景。
   这些场景覆盖了历史上导致"星图永远显示不出来"的死循环案例。 */
const assert = require('assert');
const fs = require('fs');
const index = fs.readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');

function grab(startMarker) {
  const i = index.indexOf(startMarker);
  assert.ok(i >= 0, 'missing ' + startMarker);
  const j = index.indexOf('\n}', i);
  return index.slice(i, j + 2);
}
const lib = [
  /const COMBOS = \[[\s\S]*?\];/.exec(index)[0],
  /const REPORT_LABELS = \[[\s\S]*?\];/.exec(index)[0],
  grab('function cleanText'),
  grab('function cleanTitle'),
  grab('function normCombo'),
  grab('function parseReport')
].join('\n\n');
(0, eval)(lib);

function cardLine(t, b) { return '\n【星卡】' + t + '||' + b; }
function buildReport(opts) {
  const o = Object.assign({abbr: false, newlineCombo: false, noMajor: false, noBless: false, fourCards: false, noStarValue: false}, opts || {});
  let out = '\n【北辰星图】\n【称号】拆齿轮的观星人';
  if (!o.noStarValue) out += '\n【星值】62';
  out += '\n【方位】理科';
  out += '\n【一句话】动手的直觉是你的底色，把粗心驯服，理科的路会越走越亮。';
  const cards = [
    ['学科底色', '你提到物理课总提前做完，这种手感是真实的礼物。'],
    ['思维与学习', '推导让你投入，材料的慢读则需要一点耐心。'],
    ['热爱与方向', '拆装机械的夜晚，说明你适合动手创造的世界。'],
    ['决策透视', '黄金三角里，前景一角还需补齐。'],
    ['盲区叮嘱', '别让一次考试的粗心，盖住你真正的天赋。']
  ];
  (o.fourCards ? cards.slice(0, 4) : cards).forEach(c => { out += cardLine(c[0], c[1]); });
  const combo = o.abbr ? '物化生' : '物理+化学+生物';
  const alt = o.abbr ? '物化地' : '物理+化学+地理';
  out += o.newlineCombo
    ? '\n【组合】' + combo + '\n首选理由：动手与原理兼顾\n' + alt + '\n备选理由：保留地理的赋分空间'
    : '\n【组合】' + combo + '||理由：动手与原理兼顾||' + alt + '||理由：保留地理的赋分空间';
  if (!o.noMajor) out += '\n【专业】机械工程、车辆工程、自动化';
  if (!o.noBless) out += '\n【寄语】愿你带着拆齿轮的好奇心，把每一道难题都拆成自己能懂的样子。';
  return out;
}
function check(tag, text, expect) {
  const r = parseReport(text);
  let pass;
  if (expect === null) pass = r === null;
  else if (expect === 'loose') pass = r !== null && r._complete === false;
  else pass = r !== null && r._complete === true;
  assert.ok(pass, tag + ' → ' + (r ? '_complete=' + r._complete : 'null'));
  console.log('  ok', tag);
}
check('标准全字段 → 严格档渲染', buildReport(), true);
check('组合口语缩写 物化生/物化地(历史死因) → 严格档渲染', buildReport({abbr: true}), true);
check('组合换行分隔 → 渲染', buildReport({newlineCombo: true}), true);
check('缺专业/寄语且仅4卡 → 宽容档渲染不卡死', buildReport({noMajor: true, noBless: true, fourCards: true}), 'loose');
check('缺星值 → 宽容档渲染(方位回退)', buildReport({noStarValue: true}), 'loose');
check('无关文本 → null(走一次修复)', '完全无关的闲聊内容。', null);
console.log('parse tests passed');
