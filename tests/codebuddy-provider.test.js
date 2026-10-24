'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const providers=require('../api-providers.json'),profiles=require('../model-profiles.json'),adapter=require('../model-adapter');
test('CodeBuddy has an independent credential and preserves full conversation with the declared native effort',()=>{
 const route=providers.codebuddy;assert.equal(route.key,'CODEBUDDY_API_KEY');assert.equal(route.url,'https://www.codebuddy.cn/v2');assert.equal(route.catalog.length,14);
 const messages=[{role:'system',content:'北辰原有规则'},{role:'user',content:'完整早期经历'},{role:'assistant',content:'追问'},{role:'user',content:'最新回答'}];
 for(const model of route.catalog){
  const profile=profiles.providers.codebuddy[model];assert(profile.nativeEfforts.length);
  for(const effort of Object.keys(profile.efforts)){
   const body=adapter.adaptModelBody({messages,max_tokens:64000,effort,temperature:.2,thinking:{type:'disabled'}},{name:'codebuddy',model});
   assert.deepEqual(body.messages,messages);assert.equal(body.model,model);assert.equal(body.stream,true);
   assert.equal(body.reasoning_effort,profile.efforts[effort]);assert(profile.nativeEfforts.includes(body.reasoning_effort));
   assert(body.max_tokens<=profile.maxTokens);assert.equal(body.temperature,undefined);assert.equal(body.thinking,undefined);
  }
 }
 assert.equal(adapter.adaptModelBody({messages,effort:'deep'},{name:'codebuddy',model:'hy4-preview'}).reasoning_effort,'high');
});
