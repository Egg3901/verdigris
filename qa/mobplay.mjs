// Can a phone player actually play? Exercises the real touch routes and enforces
// one working surface at a time, usable targets, pinch zoom and soul tapping.
import { chromium } from 'playwright';
const BASE = process.env.VERDIGRIS_URL ?? 'http://127.0.0.1:4185/';
const B = await chromium.launch();
const ctx = await B.newContext({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true});
const p = await ctx.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
await p.goto(`${BASE}?seed=verdigris`,{waitUntil:'networkidle'});
await p.waitForFunction(()=>window.__verdigris);
const welcome = p.getByRole('button', { name: 'TAKE OFFICE' });
if (await welcome.count()) await welcome.tap();
await p.evaluate(()=>{
  const hook=window.__verdigris;
  hook.freeze();
  const toSixPm=(1080-(hook.city.tick%1440)+1440)%1440;
  hook.warp(toSixPm);
});
await p.waitForTimeout(250);

// 1. Interventions reachable by touch?
await p.tap('#sheetbar button:nth-child(2)');   // ACT
await p.waitForTimeout(200);
const nudgeVisible = await p.evaluate(()=>{const e=document.getElementById('nudges');
  return e && getComputedStyle(e).display!=='none' && e.getBoundingClientRect().height>10;});
console.log('interventions reachable by touch:', nudgeVisible);
assert(nudgeVisible, 'ACT sheet was not visible');
const deskClosedForAct = await p.evaluate(()=>document.getElementById('desk').hidden);
assert(deskClosedForAct, 'ACT opened behind the alderman desk');
await p.screenshot({path:'/tmp/vqa/m-act-sheet.png'});

// 2. Can we actually use one and see its result? Powers no longer consume a
// daily allowance, so the observable contract is the effect plus its toast.
const btns = await p.$$('#nudges button');
let used=false;
for (const b of btns) {
  if (await b.getAttribute('aria-disabled')==='true') continue;
  await b.tap(); used=true; break;
}
await p.waitForTimeout(250);
const toast = await p.evaluate(()=>{const t=document.getElementById('toast');
  return t && t.hasAttribute('data-show') ? t.textContent : null;});
console.log(`used an intervention by touch: ${used}`);
console.log('on-screen toast:', toast ? JSON.stringify(toast.slice(0,70)) : 'NONE');
assert(used&&toast, 'touch intervention did not apply and report its result');

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
const disabledInert=await p.evaluate(()=>{
  const t=document.getElementById('toast'); return !t.hasAttribute('data-show');});
console.log('disabled row is inert (correct):', disabledInert);
assert(disabledInert, 'disabled intervention produced an effect');

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
assert(z1 > z0, 'pinch did not change zoom');

// 5. Centre a real outdoor soul and tap the rendered body.
const soul = await p.evaluate(()=>{
  const hook=window.__verdigris;
  const s=hook.city.souls.find(x=>x.inId<0&&x.atNode>=0);
  if(!s) throw new Error('fixture has no outdoor soul at 6PM');
  hook.zoom(3);
  hook.lookAt(hook.city.graph.cx[s.atNode],hook.city.graph.cy[s.atNode]);
  return `${s.given} ${s.family}`;
});
await p.waitForTimeout(150);
await p.evaluate(()=>{
  const c=document.getElementById('world'),x=innerWidth/2,y=innerHeight/2;
  const mk=t=>c.dispatchEvent(new PointerEvent(t,{pointerId:9,clientX:x,clientY:y,bubbles:true,pointerType:'touch',isPrimary:true}));
  mk('pointerdown'); mk('pointerup');
});
await p.waitForTimeout(250);
const pickedSoul = await p.evaluate(()=>document.querySelector('#inspector .heading')?.textContent==='CARRYING:');
console.log(`direct soul tap: ${soul} ${pickedSoul?'WORKS':'FAILED'}`);
assert(pickedSoul, 'a centred outdoor soul could not be tapped');

// 6. Switching working surfaces must close the previous one instead of opening
// the new panel underneath it.
await p.tap('#sheetbar button:nth-child(1)'); // LOOK
assert(await p.evaluate(()=>getComputedStyle(document.getElementById('verbs')).display!=='none'), 'LOOK sheet did not open');
await p.getByRole('button',{name:'The vestry: pass and rescind ordinances'}).tap();
assert(await p.evaluate(()=>!document.getElementById('vestry').hidden&&!document.documentElement.hasAttribute('data-sheet')), 'VESTRY did not replace LOOK');
await p.getByRole('button',{name:'Keys and what this is'}).tap();
assert(await p.evaluate(()=>!document.getElementById('help').hidden&&document.getElementById('vestry').hidden), 'HELP did not replace VESTRY');
await p.locator('#desk-sheet').tap();
assert(await p.evaluate(()=>!document.getElementById('desk').hidden&&document.getElementById('help').hidden), 'DESK did not replace HELP');

// 7. Desk people and close controls need a real fingertip target.
const person=p.locator('#desk .dperson').first();
await person.scrollIntoViewIfNeeded();
const personBox=await person.boundingBox();
const closeBox=await p.locator('#desk .close').boundingBox();
assert(personBox&&personBox.height>=44, `desk person target is ${personBox?.height??0}px high`);
assert(closeBox&&closeBox.width>=44&&closeBox.height>=44, `desk close target is ${closeBox?.width??0}x${closeBox?.height??0}px`);
await person.tap();
await p.waitForTimeout(150);
assert(await p.evaluate(()=>document.getElementById('desk').hasAttribute('data-peek')&&!document.getElementById('inspector').hidden), 'desk person did not open the phone inspector');
await p.locator('#desk .dpeek').tap();
await p.locator('#desk .close').tap();
assert(await p.evaluate(()=>document.getElementById('desk').hidden), 'desk close did not work');

console.log('errors:', errs.length? errs.join('|'):'none');
assert(!errs.length, `page errors: ${errs.join('|')}`);
await ctx.close();

// 8. The dynamically wrapping bottom bar is a different shape at the smallest
// portrait and phone landscape sizes. Every surface must stop above its actual
// measured top edge, not an assumed height.
for(const viewport of [
  {name:'small portrait',width:320,height:568,query:''},
  {name:'large type portrait',width:360,height:640,query:'&ui=3'},
  {name:'phone landscape',width:844,height:390,query:''},
]){
  const mobile=await B.newContext({viewport,deviceScaleFactor:2,isMobile:true,hasTouch:true});
  const page=await mobile.newPage();
  await page.goto(`${BASE}?seed=verdigris&t=641&freeze=1${viewport.query}`,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.__verdigris);
  await page.getByRole('button',{name:'TAKE OFFICE'}).tap();
  const controls=await page.evaluate(()=>[...document.querySelectorAll('#sheetbar button')].map(node=>{
    const box=node.getBoundingClientRect();
    return {label:node.textContent,left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height};
  }));
  assert(controls.every(control=>control.left>=0&&control.right<=viewport.width&&control.top>=0
    &&control.bottom<=viewport.height&&control.width>=44&&control.height>=44),
  `${viewport.name} has an unreachable bottom control: ${JSON.stringify(controls)}`);
  const check=async(label,selector)=>{
    const result=await page.evaluate(({selector,width,height})=>{
      const node=document.querySelector(selector),box=node.getBoundingClientRect();
      const bar=document.getElementById('scrubber').getBoundingClientRect();
      return {visible:!node.hidden&&getComputedStyle(node).display!=='none',left:box.left,
        right:box.right,top:box.top,bottom:box.bottom,barTop:bar.top,
        overflow:document.documentElement.scrollWidth>width||document.documentElement.scrollHeight>height};
    },{selector,width:viewport.width,height:viewport.height});
    assert(result.visible&&result.left>=0&&result.right<=viewport.width+1&&result.top>=0
      &&result.bottom<=result.barTop+1&&!result.overflow,`${viewport.name} ${label} escaped its usable area: ${JSON.stringify(result)}`);
  };
  await check('desk','#desk');
  await page.evaluate(()=>{
    [...document.querySelectorAll('#sheetbar button')].find(node=>node.textContent==='ACT')?.click();
    document.getElementById('desk-sheet').click();
  });
  assert(await page.evaluate(()=>!document.getElementById('desk').hidden&&!document.documentElement.hasAttribute('data-sheet')),
    `${viewport.name} rapid surface switch left two panels open`);
  await page.locator('#sheetbar button').filter({hasText:'ACT'}).tap(); await check('act','#nudges');
  await page.getByRole('button',{name:'The vestry: pass and rescind ordinances'}).tap(); await check('vestry','#vestry');
  await page.getByRole('button',{name:'Keys and what this is'}).tap(); await check('help','#help');
  await page.locator('#desk-sheet').tap(); await check('desk again','#desk');
  console.log(`${viewport.name}: all working surfaces clear of the bottom bar`);
  await mobile.close();
}
await B.close();
