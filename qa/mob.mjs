import { chromium, devices } from 'playwright';
const B = await chromium.launch();
const CASES = [
  ['iPhone 12 portrait', {viewport:{width:390,height:844}, deviceScaleFactor:3, isMobile:true, hasTouch:true}],
  ['iPhone 12 landscape',{viewport:{width:844,height:390}, deviceScaleFactor:3, isMobile:true, hasTouch:true}],
  ['iPad portrait',      {viewport:{width:768,height:1024},deviceScaleFactor:2, isMobile:true, hasTouch:true}],
  ['small 320x568',      {viewport:{width:320,height:568}, deviceScaleFactor:2, isMobile:true, hasTouch:true}],
  ['desktop 1280x600',   {viewport:{width:1280,height:600}}],
  ['desktop 1440x900',   {viewport:{width:1440,height:900}}],
];
for (const [name, opts] of CASES) {
  const ctx = await B.newContext(opts);
  const p = await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto('http://127.0.0.1:4185/?seed=verdigris',{waitUntil:'networkidle'});
  await p.waitForFunction(()=>window.__verdigris);
  await p.evaluate(()=>{window.__verdigris.freeze();window.__verdigris.warp(641);});
  await p.waitForTimeout(250);
  const r = await p.evaluate(()=>{
    const box = id => { const e=document.getElementById(id);
      if(!e|| e.hidden || getComputedStyle(e).display==='none') return null;
      const b=e.getBoundingClientRect(); return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)};};
    const ids=['titleplate','inspector','zoomstepper','scrubber','verbs','nudges','ticker','sheetbar'];
    const boxes={}; ids.forEach(i=>boxes[i]=box(i));
    const overlaps=[];
    const ks=Object.keys(boxes).filter(k=>boxes[k]);
    for(let i=0;i<ks.length;i++)for(let j=i+1;j<ks.length;j++){
      const a=boxes[ks[i]],b=boxes[ks[j]];
      if(ks[i]==='sheetbar'||ks[j]==='sheetbar')continue;
      const ox=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x);
      const oy=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);
      if(ox>2&&oy>2) overlaps.push(ks[i]+'/'+ks[j]+' '+ox+'x'+oy);
    }
    const off=ks.filter(k=>{const b=boxes[k];
      return b.x<-2||b.y<-2||b.x+b.w>innerWidth+2||b.y+b.h>innerHeight+2;});
    // Is the zoom + button actually the topmost element at its own centre?
    const plus=[...document.querySelectorAll('#zoomstepper button')].pop();
    let plusOk=null;
    if(plus){const b=plus.getBoundingClientRect();
      plusOk = document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)===plus;}
    return {px:getComputedStyle(document.documentElement).getPropertyValue('--px').trim(),
      boxes, overlaps, off, plusOk,
      nudgesReachable: !!document.getElementById('sheetbar') || !!boxes.nudges};
  });
  console.log(`\n${name}  --px=${r.px}`);
  console.log('  overlaps: ' + (r.overlaps.length? r.overlaps.join(', ') : 'none'));
  console.log('  offscreen: ' + (r.off.length? r.off.join(', ') : 'none'));
  console.log('  zoom + clickable: ' + r.plusOk);
  console.log('  errors: ' + (errs.length? errs.join('|'):'none'));
  await p.screenshot({path:`/tmp/vqa/m-${name.replace(/[^a-z0-9]/gi,'-')}.png`});
  await ctx.close();
}
await B.close();
