(()=>{'use strict';
 const root=document.documentElement,media=matchMedia('(prefers-color-scheme: dark)');
 const valid=value=>['auto','light','dark'].includes(value)?value:'auto';
 let theme='auto';try{theme=valid(localStorage.getItem('bc_theme'));}catch{}
 const apply=()=>{root.dataset.theme=theme==='auto'?(media.matches?'dark':'light'):theme;root.dataset.themePreference=theme;document.querySelector('meta[name="theme-color"]')?.setAttribute('content',root.dataset.theme==='dark'?'#14171d':'#f7f6f2');window.dispatchEvent(new Event('beichen-theme'));};
 window.beichenTheme={get:()=>theme,next(){theme=['auto','light','dark'][(['auto','light','dark'].indexOf(theme)+1)%3];try{localStorage.setItem('bc_theme',theme);}catch{}apply();return theme;}};
 media.addEventListener('change',apply);window.addEventListener('storage',e=>{if(e.key==='bc_theme'||e.key===null){theme=valid(e.newValue);apply();}});apply();
 function fonts(href,fallback){const link=document.createElement('link');link.rel='stylesheet';link.href=href;if(fallback)link.onerror=()=>fonts(fallback);document.head.append(link);}
 window.addEventListener('load',()=>fonts('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Noto+Serif+SC:wght@400;500;700&display=swap','../fonts/fonts.css'),{once:true});
})();
