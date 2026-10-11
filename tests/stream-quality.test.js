"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const html=fs.readFileSync(require('path').join(__dirname,'../index.html'),'utf8');
const BeichenContext=require('../conversation-context');
function functionText(marker){const start=html.indexOf(marker);return html.slice(start,html.indexOf('\n}',start)+2)}
function client(payload){let updates=[],requests=[];const ctx={BeichenContext,requestLimits:BeichenContext.LIMITS,AbortController,TextDecoder,setTimeout,clearTimeout,effortPref:()=> 'deep',apiEndpoint:()=> '/chat',apiHeaders:()=>({}),sleep:async()=>{},RETRYABLE:new Set([502]),fetch:async(url,options)=>{requests.push(JSON.parse(options.body));return{ok:true,body:{getReader:()=>{let emitted=false;return{read:async()=>emitted?{done:true}:(emitted=true,{done:false,value:Buffer.from(payload)})}}}}}};vm.createContext(ctx);vm.runInContext(functionText('async function askStream')+'\n'+functionText('async function ask(messages')+'\nglobalThis.askTest=ask;',ctx);return{ctx,requests,updates}}
const fixture=[{role:'user',content:'test question'}];
test('前端拒绝 EOF 截断而接受 OpenRouter reasoning 字段',async()=>{
 const a=client('data: {"choices":[{"delta":{"content":"半段"}}]}\n\n');await assert.rejects(a.ctx.askTest(fixture,{maxTokens:16384}),e=>e.code==='INCOMPLETE');
 const b=client('data: {"choices":[{"delta":{"reasoning":"reason","content":"完整"},"finish_reason":"stop"}]}\n\ndata: [DONE]');
 const result=await b.ctx.askTest(fixture,{maxTokens:16384});assert.equal(result.content,'完整');assert.equal(result.reasoning,'reason');assert.equal(b.requests[0].effort,'deep');
});
test('两次续写后仍 length 时禁止半份报告进入成功流程',async()=>{
 const a=client('data: {"choices":[{"delta":{"content":"半段"},"finish_reason":"length"}]}\n\ndata: [DONE]\n');
 await assert.rejects(a.ctx.askTest(fixture,{maxTokens:16384}),e=>e.code==='INCOMPLETE');assert.equal(a.requests.length,3);
});
test('24 条原始消息在 length 续写时仍通过消息校验，流式展示拼接前文',async()=>{
 const a=client('data: {"choices":[{"delta":{"content":"片段"},"finish_reason":"length"}]}\n\ndata: [DONE]\n');
 const original=Array.from({length:24},(_,i)=>({role:i%2?'user':'assistant',content:'原文 '+i}));
 const updates=[];
 await assert.rejects(a.ctx.askTest(original,{maxTokens:16384,onDelta:(chunk,all)=>updates.push(all)}),e=>e.code==='INCOMPLETE');
 assert.ok(a.requests.every(r=>r.messages.length<=24 && r.effort==='deep'));
 assert.equal(updates.at(-1),'片段\n片段\n片段');
});
test('专业只有名字或缺就业方向时不会通过质量门',()=>{
 const ctx={};vm.createContext(ctx);vm.runInContext(functionText('function reportQualityComplete')+'\nglobalThis.quality=reportQualityComplete;',ctx);
 const r={_complete:true,cards:Array(5).fill({}),_majors:Array(5).fill({name:'自动化',reason:'与机器人兴趣吻合',career:'工业控制'})};assert.equal(ctx.quality(r),true);
 assert.equal(ctx.quality({...r,_majors:Array(5).fill({name:'自动化'})}),false);assert.equal(ctx.quality({...r,cards:Array(4).fill({})}),false);
});
