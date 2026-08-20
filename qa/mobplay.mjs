// Can a phone player actually play? Reproduces the exact measurements the
// critique used: intervention reachability, pinch zoom, soul tapping.
import { chromium } from 'playwright';
const B = await chromium.launch();
const ctx = await B.newContext({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true});
const p = await ctx.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto('http://127.0.0.1:4185/?seed=verdigris',{waitUntil:'networkidle'});
await p.waitForFunction(()=>window.__verdigris);
await p.evaluate(()=>{window.__verdigris.freeze();window.__verdigris.warp(1080);});
await p.waitForTimeout(250);

// 1. Interventions reachable by touch?
await p.tap('#sheetbar button:nth-child(2)');   // ACT
await p.waitForTimeout(200);
const nudgeVisible = await p.evaluate(()=>{const e=document.getElementById('nudges');
  return e && getComputedStyle(e).display!=='none' && e.getBoundingClientRect().height>10;});
console.log('interventions reachable by touch:', nudgeVisible);
await p.screenshot({path:'/tmp/vqa/m-act-sheet.png'});

// 2. Can we actually spend one?
const before = await p.evaluate(()=>window.__verdigris.city.budgetLeft);
const btns = await p.$$('#nudges button');
let spent=false;
for (const b of btns) {
  if (await b.getAttribute('aria-disabled')==='true') continue;
  await b.tap(); spent=true; break;
}
await p.waitForTimeout(250);
const after = await p.evaluate(()=>window.__verdigris.city.budgetLeft);
const toast = await p.evaluate(()=>{const t=document.getElementById('toast');
  return t && t.hasAttribute('data-show') ? t.textContent : null;});
console.log(`spent an intervention by touch: ${spent}, budget ${before} -> ${after}`);
console.log('on-screen toast:', toast ? JSON.stringify(toast.slice(0,70)) : 'NONE');

// 3. Refused action gives visible feedback?
await p.evaluate(()=>document.documentElement.removeAttribute('data-sheet'));
await p.evaluate(()=>{const t=document.getElementById('toast'); t.removeAttribute('data-show');});
await p.tap('#sheetbar button:nth-child(2)');
await p.waitForTimeout(150);
// Playwright refuses to tap an aria-disabled element, which is itself the right
// answer, so dispatch directly to prove the handler also refuses.
await p.evaluate(()=>{
  const b=[...document.querySelectorAll('#nudges button')].find(x=>x.getAttribute('aria-disabled')==='true');
  if(b) b.click();
});
await p.waitForTimeout(200);
console.log('disabled row is inert (correct):', await p.evaluate(()=>{
  const t=document.getElementById('toast'); return !t.hasAttribute('data-show');}));

// 4. Pinch to zoom in.
await p.evaluate(()=>document.documentElement.removeAttribute('data-sheet'));
const z0 = await p.evaluate(()=>window.__verdigris.city && document.querySelectorAll('#zoomstepper .pip:not(.off)').length);
await p.evaluate(()=>{
  const c=document.getElementById('world');
  const mk=(t,id,x,y)=>c.dispatchEvent(new PointerEvent(t,{pointerId:id,clientX:x,clientY:y,bubbles:true,pointerType:'touch',isPrimary:id===1}));
  mk('pointerdown',1,150,400); mk('pointerdown',2,240,400);
  for(let i=1;i<=8;i++){ mk('pointermove',1,150-i*8,400); mk('pointermove',2,240+i*8,400); }
  mk('pointerup',1,70,400); mk('pointerup',2,320,400);
});
await p.waitForTimeout(250);
const z1 = await p.evaluate(()=>document.querySelectorAll('#zoomstepper .pip:not(.off)').length);
console.log(`pinch zoom: ${z0} -> ${z1} pips  ${z1>z0?'WORKS':'FAILED'}`);

// 5. Tapping souls, same grid the critique used.
for (const zoom of [1,2,3]) {
  await p.evaluate((z)=>{window.__verdigris.zoom(z);window.__verdigris.select('building',-1);}, zoom);
  await p.waitForTimeout(120);
  let hits=0, tries=0;
  for(let gx=0; gx<14; gx++) for(let gy=0; gy<14; gy++){
    const x=40+gx*24, y=150+gy*38; if(y>640) continue; tries++;
    await p.evaluate(([x,y])=>{
      const c=document.getElementById('world');
      const mk=(t)=>c.dispatchEvent(new PointerEvent(t,{pointerId:9,clientX:x,clientY:y,bubbles:true,pointerType:'touch',isPrimary:true}));
      mk('pointerdown'); mk('pointerup');
    },[x,y]);
    if (await p.evaluate(()=>window.__verdigris.city && document.getElementById('inspector').querySelector('.heading')?.textContent==='CARRYING:')) hits++;
  }
  console.log(`soul taps at zoom ${zoom}: ${hits}/${tries}`);
}
console.log('errors:', errs.length? errs.join('|'):'none');
await B.close();
