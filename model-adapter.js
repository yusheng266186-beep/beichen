'use strict';
const profiles=require('./model-profiles.json');
const providers=require('./api-providers.json');
function modelProfile(config){
  const route=profiles.providers?.[config?.name];
  if(route&&Object.hasOwn(route,config?.model))return route[config.model];
  const p=profiles.models[config?.model];
  return p&&config?.name==='deepseek'&&p.family==='deepseek'?p:null;
}
function adaptModelBody(body,config,defaultEffort='standard',options={}){
  const p=modelProfile(config),route=providers[config?.name];
  if(!p||!route){const e=new Error('BEICHEN_MODEL_NOT_ADAPTED');e.code=e.message;e.status=503;throw e;}
  const tier=Object.hasOwn(p.efforts,body.effort)?body.effort:Object.hasOwn(p.efforts,defaultEffort)?defaultEffort:'standard';
  const budgets=Number(body.max_tokens)>=10000?p.reportBudgets:p.chatBudgets;
  const cap=Math.min(p.maxTokens??128000,options.probe?8192:128000);
  const tokens=Math.min(cap,Math.max(Number(body.max_tokens)||3000,budgets[tier]));
  const effort=p.efforts[tier];
  if(route.protocol==='gemini'){
    return {systemInstruction:{parts:[{text:body.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n\n')}]},contents:body.messages.filter(m=>m.role!=='system').map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]})),generationConfig:{maxOutputTokens:Math.min(tokens,65536),temperature:Number.isFinite(body.temperature)?body.temperature:1,thinkingConfig:{thinkingLevel:effort,includeThoughts:true}}};
  }
  if(route.protocol==='responses'){
    const output={model:config.model,stream:true,store:false,max_output_tokens:tokens,input:body.messages.map(m=>({role:m.role,content:[{type:m.role==='assistant'?'output_text':'input_text',text:m.content}]}))};
    if(effort!=='auto')output.reasoning={effort,summary:'auto'};
    return output;
  }
  if(route.protocol==='anthropic'){
    const output={model:config.model,stream:true,max_tokens:tokens,messages:body.messages.filter(m=>m.role!=='system').map(m=>({role:m.role,content:[{type:'text',text:m.content}]}))};
    const system=body.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n\n');
    if(system)output.system=system;
    if(p.adaptiveThinking){output.thinking={type:'adaptive'};if(effort!=='auto')output.output_config={effort};}
    else if(p.reasoning)output.thinking={type:'enabled',budget_tokens:Math.min(({eco:1024,standard:4096,deep:8192,low:1024,medium:4096,high:8192,xhigh:16384,max:32768,ultra:65536})[tier]||4096,tokens-1024)};
    return output;
  }
  const output={model:config.model,messages:body.messages,stream:true,[p.tokenField]:tokens};
  const format=p.thinkingFormat??(p.family==='gpt'?'openai':p.family==='glm'||p.family==='deepseek'?'deepseek':'none');
  if(format==='openrouter'){if(effort!=='auto')output.reasoning={effort};}
  else if(['deepseek','zai','qwen'].includes(format)){
    output.thinking={type:'enabled'};if(p.family==='glm')output.thinking.clear_thinking=true;if(effort!=='auto')output.reasoning_effort=effort;
  }else if(format==='together'){
    output.reasoning={enabled:!!p.reasoning};if(effort!=='auto')output.reasoning_effort=effort;
  }else if(format==='string-thinking'){if(effort!=='auto')output.thinking=effort;}
  else if(['chat-template','qwen-chat-template'].includes(format)){
    const variables={'thinking.enabled':!!p.reasoning,'thinking.effort':effort,'thinking.budget':tokens};
    for(const [field,name]of [['chatTemplateKwargs','chat_template_kwargs'],['chatTemplateArgs','chat_template_args']])if(p.compat?.[field])output[name]=Object.fromEntries(Object.entries(p.compat[field]).map(([k,v])=>[k,v&&typeof v==='object'&&v.$var?variables[v.$var]:v]));
    if(format==='qwen-chat-template')output.chat_template_kwargs={enable_thinking:!!p.reasoning,...output.chat_template_kwargs};
  }else if(format==='ant-ling'){if(effort!=='auto')output.reasoning={effort};}
  else if(format==='baseten'){output.enable_thinking=!!p.reasoning;if(effort!=='auto')output.reasoning_effort=effort;}
  else if(effort!=='auto')output.reasoning_effort=effort;
  if(p.family==='glm'&&Number.isFinite(body.temperature))output.temperature=Math.min(1,Math.max(0,body.temperature));
  return output;
}
module.exports={modelProfile,adaptModelBody,profileVersion:profiles.version};
if(require.main===module&&process.argv[2]==='--probe'){
  const [, , ,name,model,effort]=process.argv;
  const body={messages:[{role:'user',content:'计算37×19，只回复结果数字。'}],max_tokens:256,effort};
  process.stdout.write(JSON.stringify(adaptModelBody(body,{name,model},'standard',{probe:true})));
}
