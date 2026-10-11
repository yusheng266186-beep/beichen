"use strict";
const profiles = require('./model-profiles.json');
function modelProfile(config) {
  const p = profiles.models[config?.model];
  if (!p) return null;
  const family = config.name === 'deepseek' ? 'deepseek' : config.name === 'wefucke-gpt' ? 'gpt' : config.name === 'wefucke' ? 'glm' : '';
  return p.family === family ? p : null;
}
function adaptModelBody(body, config, defaultEffort = 'standard') {
  const p = modelProfile(config);
  if (!p) { const e = new Error('BEICHEN_MODEL_NOT_ADAPTED'); e.code = e.message; e.status = 503; throw e; }
  const tier = Object.hasOwn(p.efforts, body.effort) ? body.effort : Object.hasOwn(p.efforts, defaultEffort) ? defaultEffort : 'standard';
  const output = {model:config.model, messages:body.messages, stream:true};
  // Input max_tokens is the existing report/quota protocol. Increase only the upstream budget.
  const budgets = Number(body.max_tokens) >= 10000 ? p.reportBudgets : p.chatBudgets;
  output[p.tokenField] = Math.max(Number(body.max_tokens) || 3000, budgets[tier]);
  if (p.family !== 'gpt') output.thinking = {type:'enabled'};
  if (p.family === 'glm') output.thinking.clear_thinking = true;
  if (p.efforts[tier] !== 'auto') output.reasoning_effort = p.efforts[tier];
  if (p.family === 'glm' && Number.isFinite(body.temperature)) output.temperature = Math.min(1, Math.max(0, body.temperature));
  return output;
}
module.exports = {modelProfile, adaptModelBody, profileVersion:profiles.version};
