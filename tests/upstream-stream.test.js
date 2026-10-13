'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createStreamNormalizer}=require('../upstream-stream');
const event=value=>'data: '+JSON.stringify(value)+'\n\n';
function decode(raw){return raw.split('\n').filter(x=>x.startsWith('data: ')&&x!=='data: [DONE]').map(x=>JSON.parse(x.slice(6)));}
function collect(protocol,events,width=1){const normalizer=createStreamNormalizer(protocol),bytes=Buffer.from(events.join(''));let output='';for(let i=0;i<bytes.length;i+=width)output+=normalizer.push(bytes.subarray(i,i+width));return output+normalizer.end();}
test('Claude 中文与思考流在任意字节边界还原，结束信号只出现一次',()=>{
 const raw=collect('anthropic',[event({type:'content_block_delta',delta:{type:'thinking_delta',thinking:'先核对证据'}}),event({type:'content_block_delta',delta:{type:'text_delta',text:'你可以保留两个方向🌟'}}),event({type:'message_delta',delta:{stop_reason:'end_turn'}}),event({type:'message_stop'})]);
 assert.equal(decode(raw).map(e=>e.choices[0].delta.content||'').join(''),'你可以保留两个方向🌟');assert.match(raw,/先核对证据/);assert.equal(raw.match(/\[DONE\]/g).length,1);
});
test('Responses 终态重复正文不重复输出，只有终态正文时也不丢失',()=>{
 for(const deltas of [[],[event({type:'response.output_text.delta',delta:'完整星图'})]]){
  const raw=collect('responses',[...deltas,event({type:'response.completed',response:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'完整星图：准确、详细。'}]}]}})]);
  assert.equal(decode(raw).map(e=>e.choices[0].delta.content||'').join(''),'完整星图：准确、详细。');assert.match(raw,/\[DONE\]/);
 }
});
test('输出达到上限保留 length，供星图接续生成',()=>{
 const raw=collect('responses',[event({type:'response.output_text.delta',delta:'未完的星图'}),event({type:'response.incomplete',response:{status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}})]);
 assert.equal(decode(raw).at(-1).choices[0].finish_reason,'length');assert.match(raw,/\[DONE\]/);
});
test('流中错误和拒绝状态不能变成成功；缺终态不伪造完成',()=>{
 assert.throws(()=>collect('responses',[event({type:'response.failed'})]));
 assert.throws(()=>collect('responses',[event({type:'response.incomplete',response:{incomplete_details:{reason:'content_filter'}}})]));
 assert.throws(()=>collect('anthropic',[event({type:'message_stop'})]));
 assert.doesNotMatch(collect('responses',[event({type:'response.output_text.delta',delta:'半张星图'})]),/\[DONE\]/);
});
test('较大的星图终态完整解析，尾部不被旧 256KB 阈值截断',()=>{
 const text='完整学生原话与解释。'.repeat(12000)+'结束';
 const raw=collect('responses',[event({type:'response.completed',response:{status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}]}})],16384);
 assert.equal(decode(raw).map(e=>e.choices[0].delta.content||'').join(''),text);
});
