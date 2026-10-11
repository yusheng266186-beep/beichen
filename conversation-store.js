/* One complete local conversation; IndexedDB backs up localStorage quota failures. */
(function(root, factory){
  if(typeof module === 'object' && module.exports) module.exports = factory();
  else root.BeichenConversationStore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';
  function create(options){
    const {localStorage, indexedDB, key, onFailure=()=>{}} = options;
    let queue = Promise.resolve(), opening;
    function open(){
      if(!indexedDB) return Promise.resolve(null);
      if(opening) return opening;
      opening = new Promise(resolve=>{
        let finished=false;
        const done=db=>{ if(finished){ if(db) db.close(); return; } finished=true; clearTimeout(timer); resolve(db); };
        const timer=setTimeout(()=>done(null),3000);
        try{
          const req=indexedDB.open('beichen_conversations_v1',1);
          req.onupgradeneeded=()=>req.result.createObjectStore('sessions');
          req.onsuccess=()=>{ req.result.onversionchange=()=>req.result.close(); done(req.result); };
          req.onerror=req.onblocked=()=>done(null);
        }catch(_){ done(null); }
      });
      return opening;
    }
    async function operate(kind, value){
      const db=await open();
      if(!db) throw new Error('local database unavailable');
      return new Promise((resolve,reject)=>{
        let timer;
        try{
          const tx=db.transaction('sessions',kind==='get'?'readonly':'readwrite');
          const store=tx.objectStore('sessions');
          const req=kind==='get'?store.get(key):kind==='delete'?store.delete(key):store.put(value,key);
          timer=setTimeout(()=>{ try{tx.abort()}catch(_){ } reject(new Error('local database transaction timed out')); },5000);
          tx.oncomplete=()=>{ clearTimeout(timer); resolve(req.result); };
          tx.onerror=tx.onabort=()=>{ clearTimeout(timer); reject(new Error('local database transaction failed')); };
        }catch(e){ clearTimeout(timer); reject(e); }
      });
    }
    function schedule(operation){
      const next=queue.then(operation,operation);
      queue=next.catch(()=>{});
      return next;
    }
    function save(snapshot){
      // Snapshot now; subsequent turns must not mutate an in-flight local write.
      const encoded=JSON.stringify(snapshot), frozen=JSON.parse(encoded);
      let localOk=false;
      try{ localStorage.setItem(key,encoded); localOk=true; }catch(_){ }
      return schedule(async()=>{
        try{ await operate('put',frozen); return true; }
        catch(_){ if(!localOk) onFailure(); return localOk; }
      });
    }
    function clear(){
      try{ localStorage.removeItem(key); }catch(_){ }
      return schedule(async()=>{ try{ await operate('delete'); }catch(_){ } });
    }
    async function load(){
      await queue;
      let local=null, stored=null;
      try{ local=JSON.parse(localStorage.getItem(key)||'null'); }catch(_){ }
      try{ stored=await operate('get'); }catch(_){ }
      return Number(stored?.savedAt||0) > Number(local?.savedAt||0) ? stored : local || stored || null;
    }
    return {save, clear, load};
  }
  return {create};
});
