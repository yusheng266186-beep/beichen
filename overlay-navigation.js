/* Browser Back closes only the layer being left; Forward never resurrects a dialog. */
(function(root, factory){
  if(typeof module === 'object' && module.exports) module.exports = factory();
  else root.BeichenOverlayNavigation = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';
  function create(nav, onClose){
    const page=String(Date.now())+'-'+Math.random().toString(36).slice(2);
    let stack=[], pending=false, queued=[];
    const marker=()=>({...(nav.state || {}), bcOv:{page, stack:[...stack]}});
    const replace=()=>{ try{ nav.replaceState(marker(),''); }catch(_){ } };
    replace(); // A reload starts without any open dialogs, even on a former overlay entry.
    function open(id){
      if(stack.includes(id) || queued.includes(id)) return;
      if(pending){ queued.push(id); return; }
      stack.push(id);
      try{ nav.pushState(marker(),''); }catch(_){ }
    }
    function close(id){
      if(queued.includes(id)){ queued=queued.filter(x=>x!==id); return; }
      const i=stack.indexOf(id);
      if(i<0) return;
      const top=i===stack.length-1;
      stack.splice(i,1);
      if(pending) return;
      const entry=nav.state?.bcOv;
      if(top && entry?.page===page && entry.stack.includes(id)){
        pending=true;
        try{ nav.back(); }catch(_){ pending=false; replace(); }
      }else replace();
    }
    function pop(){
      const entry=nav.state?.bcOv;
      const incoming=entry?.page===page && Array.isArray(entry.stack) ? entry.stack : [];
      if(pending){
        // Several quick X/Escape clicks may close several layers before the first pop.
        if(incoming.length>stack.length){ try{ nav.back(); return; }catch(_){ } }
        pending=false;
        replace();
        const next=queued; queued=[];
        next.forEach(open);
        return;
      }
      let shared=0;
      while(shared<stack.length && shared<incoming.length && stack[shared]===incoming[shared]) shared++;
      const closing=stack.slice(shared).reverse();
      stack=stack.slice(0,shared);
      closing.forEach(onClose);
      replace();
    }
    return {open,close,pop,top:()=>queued[queued.length-1] || stack[stack.length-1] || null};
  }
  return {create};
});
