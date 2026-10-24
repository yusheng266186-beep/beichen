(()=>{'use strict';
 const root=document.documentElement,media=matchMedia('(prefers-color-scheme: dark)');
 let theme='auto';try{theme=localStorage.getItem('bc_theme')||'auto';}catch{}
 const apply=()=>{root.dataset.theme=theme==='auto'?(media.matches?'dark':'light'):theme;root.dataset.themePreference=theme;document.querySelector('meta[name="theme-color"]')?.setAttribute('content',root.dataset.theme==='dark'?'#14171d':'#f7f6f2');};
 window.beichenTheme={get:()=>theme,next(){theme=['auto','light','dark'][(['auto','light','dark'].indexOf(theme)+1)%3];try{localStorage.setItem('bc_theme',theme);}catch{}apply();return theme;}};
 media.addEventListener('change',apply);window.addEventListener('storage',e=>{if(e.key==='bc_theme'){theme=e.newValue||'auto';apply();}});apply();
 function fonts(href,fallback){const link=document.createElement('link');link.rel='stylesheet';link.href=href;if(fallback)link.onerror=()=>fonts(fallback);document.head.append(link);}
 window.addEventListener('load',()=>fonts('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Noto+Serif+SC:wght@400;500;700&display=swap','../fonts/fonts.css'),{once:true});
})();
