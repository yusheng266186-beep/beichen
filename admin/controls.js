(()=>{
 'use strict';
 const reduced=matchMedia('(prefers-reduced-motion: reduce)'),narrow=matchMedia('(max-width: 600px)'),instances=new Map();
 let active=null,frame=0;
 const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
 function icon(name){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),use=document.createElementNS(svg.namespaceURI,'use');svg.setAttribute('aria-hidden','true');use.setAttribute('href','#icon-'+name);svg.append(use);return svg;}
 class Picker{
  constructor(select){
   this.select=select;this.rows=[];this.signature='';this.opened=false;this.revision=0;this.typeBuffer='';this.typeTime=0;
   this.button=node('button','picker-trigger');this.button.type='button';this.button.id=select.id+'Button';this.button.setAttribute('role','combobox');this.button.setAttribute('aria-haspopup','listbox');this.button.setAttribute('aria-expanded','false');
   this.value=node('span','picker-value');this.valueName=node('span','picker-value-name');this.valueDetail=node('span','picker-value-detail');this.value.append(this.valueName,this.valueDetail);this.button.append(this.value,icon('chevron'));
   const label=document.querySelector('label[for="'+select.id+'"]');if(label){label.id||=select.id+'Label';label.htmlFor=this.button.id;this.button.setAttribute('aria-labelledby',label.id);this.label=label.childNodes[0].textContent.trim();}else this.label='选择';
   if(select.id==='account')this.button.setAttribute('aria-describedby','accountHelp');
   select.hidden=true;select.tabIndex=-1;select.after(this.button);
   this.button.addEventListener('click',()=>this.opened?this.close({restore:true}):this.open());
   this.button.addEventListener('keydown',e=>this.key(e));
   select.addEventListener('change',()=>this.sync());
   new MutationObserver(()=>this.sync()).observe(select,{childList:true,subtree:true,attributes:true,characterData:true});
   this.sync();
  }
  sync(){
   const select=this.select,rows=[...select.options].map(o=>({value:o.value,label:o.dataset.label||o.textContent,detail:o.dataset.detail||'',disabled:o.disabled}));
   const signature=JSON.stringify(rows),changed=this.signature!==signature;this.rows=rows;this.signature=signature;
   const selected=rows.find(r=>r.value===select.value),available=rows.some(r=>r.value&&!r.disabled);
   this.button.disabled=select.disabled||!available;
   this.valueName.textContent=selected?.label||'暂无可选项';this.valueDetail.textContent=selected?.detail||'';this.valueDetail.hidden=!selected?.detail;
   if(this.opened){if(this.button.disabled||select.closest('[hidden]:not(select)'))return this.close({immediate:true});if(changed)this.render();else for(const option of this.list.children)option.setAttribute('aria-selected',String(this.rows[Number(option.dataset.index)].value===select.value));this.position();}
  }
  render(){
   this.list.replaceChildren();this.rows.forEach((row,index)=>{
    const option=node('li','picker-option');option.id=this.select.id+'Option'+index;option.dataset.index=index;option.setAttribute('role','option');option.setAttribute('aria-selected',String(row.value===this.select.value));option.setAttribute('aria-disabled',String(row.disabled||!row.value));
    const copy=node('span','picker-option-copy');copy.append(node('span','picker-option-name',row.label));if(row.detail)copy.append(node('span','picker-option-detail',row.detail));option.append(copy,icon('check'));this.list.append(option);
   });
   this.count.textContent=this.rows.filter(r=>r.value&&!r.disabled).length+' 项可选';
   this.setActive(Math.max(0,this.rows.findIndex(r=>r.value===this.select.value&&!r.disabled)),false);
  }
  open(){
   if(this.button.disabled)return;if(active)active.close({immediate:true});active=this;this.opened=true;this.revision++;this.typeBuffer='';this.typeTime=0;
   this.mobile=narrow.matches;this.popup=node('section','picker-popover');this.popup.dataset.mobile=String(this.mobile);this.popup.setAttribute('aria-label',this.label+'选择');
   const heading=node('div','picker-heading'),copy=node('div');copy.append(node('span','picker-caption',this.label));this.count=node('span','picker-count');copy.append(this.count);
   const close=node('button','icon-btn picker-close');close.type='button';close.setAttribute('aria-label','关闭'+this.label+'选择');close.append(icon('close'));close.onclick=()=>this.close({restore:true});heading.append(copy,close);
   this.list=node('ul','picker-list');this.list.id=this.select.id+'List';this.list.setAttribute('role','listbox');this.list.setAttribute('aria-label',this.label);
   this.popup.append(heading,this.list);if(this.mobile){this.veil=node('div','picker-veil');this.veil.setAttribute('aria-hidden','true');document.body.append(this.veil);this.oldOverflow=document.body.style.overflow;document.body.style.overflow='hidden';}
   document.body.append(this.popup);this.button.setAttribute('aria-expanded','true');this.button.setAttribute('aria-controls',this.list.id);this.render();this.position();this.setActive(this.index,true);this.button.focus({preventScroll:true});
   this.list.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse')e.preventDefault();});
   this.list.addEventListener('pointermove',e=>{const option=e.target.closest('[data-index]');if(e.pointerType==='mouse'&&option&&!this.rows[Number(option.dataset.index)].disabled)this.setActive(Number(option.dataset.index),false);});
   this.list.addEventListener('click',e=>{const option=e.target.closest('[data-index]');if(option){this.choose(Number(option.dataset.index));if(this.opened)this.button.focus({preventScroll:true});}});
   if(!reduced.matches){this.animation=this.popup.animate([{opacity:0,transform:this.mobile?'translateY(32px)':'translateY('+(this.above?'-':'')+'7px) scale(.985)'},{opacity:1,transform:'none'}],{duration:this.mobile?340:240,easing:'cubic-bezier(.23,1,.32,1)'});this.veil?.animate([{opacity:0},{opacity:1}],{duration:220,easing:'ease-out'});}
  }
  position(){
   if(!this.opened)return;if(this.mobile!==narrow.matches)return this.close({immediate:true});
   const viewport=window.visualViewport,x=viewport?.offsetLeft||0,y=viewport?.offsetTop||0,w=viewport?.width||innerWidth,h=viewport?.height||innerHeight;
   if(this.mobile){this.popup.style.left=x+12+'px';this.popup.style.width=w-24+'px';this.popup.style.top='auto';this.popup.style.bottom=Math.max(12,innerHeight-y-h+12)+'px';this.popup.style.maxHeight=Math.min(h-24,560)+'px';return;}
   const r=this.button.getBoundingClientRect();if(r.bottom<y||r.top>y+h)return this.close({immediate:true});
   const width=Math.min(Math.max(r.width,310),w-24),below=y+h-r.bottom-12,above=r.top-y-12;this.above=below<260&&above>below;
   this.popup.style.width=width+'px';this.popup.style.left=Math.min(Math.max(x+12,r.left),x+w-width-12)+'px';this.popup.style.maxHeight=Math.max(96,Math.min(430,(this.above?above:below)-8))+'px';
   const height=this.popup.getBoundingClientRect().height;this.popup.style.top=(this.above?r.top-height-8:r.bottom+8)+'px';this.popup.style.transformOrigin=this.above?'bottom left':'top left';
  }
  setActive(index,scroll){
   if(!this.list)return;this.index=index;
   for(const option of this.list.children)option.classList.toggle('is-active',Number(option.dataset.index)===index);
   const option=this.list.children[index];if(option){this.button.setAttribute('aria-activedescendant',option.id);if(scroll){const top=option.offsetTop,bottom=top+option.offsetHeight;if(top<this.list.scrollTop)this.list.scrollTop=top;else if(bottom>this.list.scrollTop+this.list.clientHeight)this.list.scrollTop=bottom-this.list.clientHeight;}}
  }
  choose(index){
   const row=this.rows[index];if(!row||row.disabled||!row.value)return;const changed=this.select.value!==row.value;this.select.value=row.value;this.close({restore:true});this.sync();if(changed){this.select.dispatchEvent(new Event('input',{bubbles:true}));this.select.dispatchEvent(new Event('change',{bubbles:true}));}
  }
  key(e){
   if(e.altKey||e.ctrlKey||e.metaKey)return;
   if(e.key==='Escape'&&this.opened){e.preventDefault();e.stopPropagation();this.close({restore:true});return;}
   if(e.key==='Tab'){this.close({immediate:true});return;}
   if(['Enter',' '].includes(e.key)){e.preventDefault();this.opened?this.choose(this.index):this.open();return;}
   const allowed=this.rows.map((r,i)=>!r.disabled&&r.value?i:-1).filter(i=>i>=0);if(!allowed.length)return;
   if(['ArrowDown','ArrowUp','Home','End','PageDown','PageUp'].includes(e.key)){
    e.preventDefault();if(!this.opened){this.open();if(['ArrowDown','ArrowUp'].includes(e.key))return;}
    const current=Math.max(0,allowed.indexOf(this.index)),step=e.key==='ArrowUp'?-1:e.key==='PageDown'?6:e.key==='PageUp'?-6:1;
    this.setActive(allowed[e.key==='Home'?0:e.key==='End'?allowed.length-1:Math.min(allowed.length-1,Math.max(0,current+step))],true);return;
   }
   if(e.key.length===1){e.preventDefault();if(!this.opened)this.open();const now=Date.now();this.typeBuffer=now-this.typeTime<650?this.typeBuffer+e.key:e.key;this.typeTime=now;const q=this.typeBuffer.toLocaleLowerCase(),start=allowed.indexOf(this.index),ordered=allowed.slice(start+1).concat(allowed.slice(0,start+1)),index=ordered.find(i=>(this.rows[i].label+' '+this.rows[i].detail).toLocaleLowerCase().startsWith(q));if(index!==undefined)this.setActive(index,true);}
  }
  close({restore=false,immediate=false}={}){
   if(!this.popup)return;const revision=++this.revision,from={opacity:getComputedStyle(this.popup).opacity,transform:getComputedStyle(this.popup).transform};this.opened=false;this.button.setAttribute('aria-expanded','false');this.button.removeAttribute('aria-activedescendant');this.button.removeAttribute('aria-controls');this.animation?.cancel();
   const popup=this.popup,veil=this.veil;popup.inert=true;popup.style.pointerEvents='none';if(restore&&!this.button.disabled)this.button.focus({preventScroll:true});
   const finish=()=>{if(revision!==this.revision)return;popup.remove();veil?.remove();this.popup=null;this.veil=null;if(this.mobile)document.body.style.overflow=this.oldOverflow;if(active===this)active=null;};
   if(immediate||reduced.matches){finish();return;}
   this.animation=popup.animate([from,{opacity:0,transform:this.mobile?'translateY(18px)':'translateY(3px) scale(.99)'}],{duration:150,easing:'cubic-bezier(.4,0,1,1)',fill:'forwards'});veil?.animate([{opacity:1},{opacity:0}],{duration:150,fill:'forwards'});this.animation.finished.then(finish,()=>{});
  }
 }
 for(const select of document.querySelectorAll('select[data-picker]'))instances.set(select,new Picker(select));
 document.addEventListener('pointerdown',e=>{if(active?.opened&&!active.popup.contains(e.target)&&!active.button.contains(e.target))active.close({restore:!!e.target.closest('.picker-veil')});});
 document.addEventListener('focusin',e=>{if(active?.opened&&!active.popup.contains(e.target)&&e.target!==active.button)active.close({immediate:true});});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&active?.opened){e.preventDefault();active.close({restore:true});}});
 const reposition=()=>{if(!frame)frame=requestAnimationFrame(()=>{frame=0;active?.position();});};
 window.addEventListener('resize',reposition,{passive:true});window.addEventListener('scroll',reposition,{passive:true});window.visualViewport?.addEventListener('resize',reposition,{passive:true});window.visualViewport?.addEventListener('scroll',reposition,{passive:true});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)active?.close({immediate:true});});
 window.beichenControls={sync(select){if(select)instances.get(select)?.sync();else for(const instance of instances.values())instance.sync();},close(){active?.close({immediate:true});}};
})();
