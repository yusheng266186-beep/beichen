'use strict';
const {StringDecoder}=require('node:string_decoder');
const frame=delta=>'data: '+JSON.stringify({choices:[{delta,finish_reason:null}]})+'\n\n';
const terminal=reason=>'data: '+JSON.stringify({choices:[{delta:{},finish_reason:reason}]})+'\n\ndata: [DONE]\n\n';
function createStreamNormalizer(protocol){
  if(!['anthropic','responses'].includes(protocol))return {push:chunk=>chunk,end:()=>''};
  const decoder=new StringDecoder('utf8');let buffer='',data=[],completed=false,text='',stop=null;
  const content=value=>{if(!value)return '';text+=value;return frame({content:value});};
  const finish=reason=>{completed=true;return terminal(reason);};
  function event(payload){
    if(completed||!payload||payload==='[DONE]')return '';
    const e=JSON.parse(payload),type=e.type;
    if(type==='error'||e.error||type==='response.failed')throw Error('BEICHEN_UPSTREAM_ERROR');
    if(protocol==='anthropic'){
      if(type==='content_block_start'&&e.content_block?.type==='text')return content(e.content_block.text);
      if(type==='content_block_delta'){
        if(e.delta?.type==='text_delta')return content(e.delta.text);
        if(e.delta?.type==='thinking_delta'&&e.delta.thinking)return frame({reasoning_content:e.delta.thinking});
      }
      if(type==='message_delta'&&e.delta?.stop_reason){stop={end_turn:'stop',stop_sequence:'stop',max_tokens:'length'}[e.delta.stop_reason];if(!stop)throw Error('BEICHEN_UPSTREAM_INCOMPLETE');}
      if(type==='message_stop'){if(!stop)throw Error('BEICHEN_UPSTREAM_INCOMPLETE');return finish(stop);}
    }else{
      if(type==='response.output_text.delta')return content(e.delta);
      if(['response.reasoning_summary_text.delta','response.reasoning_text.delta'].includes(type)&&e.delta)return frame({reasoning_content:e.delta});
      if(type==='response.completed'||type==='response.incomplete'){
        const r=e.response??{},full=(r.output??[]).filter(x=>x.type==='message').flatMap(x=>x.content??[]).filter(x=>x.type==='output_text').map(x=>x.text??'').join('');
        let remainder='';if(full){if(!full.startsWith(text))throw Error('BEICHEN_UPSTREAM_INCOMPLETE');remainder=content(full.slice(text.length));}
        if(type==='response.incomplete'){if(r.incomplete_details?.reason!=='max_output_tokens')throw Error('BEICHEN_UPSTREAM_INCOMPLETE');return remainder+finish('length');}
        if(r.status&&r.status!=='completed')throw Error('BEICHEN_UPSTREAM_INCOMPLETE');return remainder+finish('stop');
      }
    }
    return '';
  }
  function lines(final=false){
    let output='',at;
    while((at=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,at).replace(/\r$/,'');buffer=buffer.slice(at+1);
      if(line===''){if(data.length){output+=event(data.join('\n'));data=[];}}
      else if(line.startsWith('data:'))data.push(line.slice(5).replace(/^ /,''));
      if(data.reduce((n,x)=>n+x.length,0)>4*1024*1024)throw Error('BEICHEN_UPSTREAM_ERROR');
    }
    if(buffer.length>4*1024*1024)throw Error('BEICHEN_UPSTREAM_ERROR');
    if(final){if(buffer.startsWith('data:'))data.push(buffer.slice(5).trimStart());if(data.length)output+=event(data.join('\n'));buffer='';data=[];}
    return output;
  }
  return {push(chunk){buffer+=decoder.write(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));return lines();},end(){buffer+=decoder.end();return lines(true);}};
}
module.exports={createStreamNormalizer};
if(require.main===module&&process.argv[2]==='--normalize'){
  const parser=createStreamNormalizer(process.argv[3]);
  process.stdin.on('data',chunk=>{try{process.stdout.write(parser.push(chunk));}catch(_){process.exitCode=1;process.stdin.destroy();}});
  process.stdin.on('end',()=>{try{process.stdout.write(parser.end());}catch(_){process.exitCode=1;}});
}
