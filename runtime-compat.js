'use strict';
// Historical SCF Web functions cannot change their configured Node 16 image.
// These two APIs are needed by the shared OAuth vault. Keep its code unchanged.
// Local development and CI continue to use Node 20 or newer.
if(typeof globalThis.structuredClone!=='function'){
 const v8=require('node:v8');
 globalThis.structuredClone=value=>v8.deserialize(v8.serialize(value));
}
if(typeof AbortSignal.any!=='function'){
 AbortSignal.any=function(signals){
  const rows=Array.from(signals);if(rows.some(s=>!s||typeof s.addEventListener!=='function'||typeof s.aborted!=='boolean'))throw new TypeError('Expected AbortSignal values');
  const controller=new AbortController(),listeners=[];
  const abort=signal=>{for(const [s,listener] of listeners)s.removeEventListener('abort',listener);listeners.length=0;controller.abort(signal.reason);};
  for(const signal of rows){if(signal.aborted){abort(signal);break;}const listener=()=>abort(signal);listeners.push([signal,listener]);signal.addEventListener('abort',listener,{once:true});}
  return controller.signal;
 };
}
