// 30-day headless measurement of ordinance behaviour.
//
// Loads the built game, freezes it, and moves time only through warp, so the
// numbers are a function of (seed, acts, ticks) and not of wall-clock timing.
import { chromium } from 'playwright';

const BASE = process.env.VERDIGRIS_URL ?? 'http://127.0.0.1:4198/';
const DAYS = 30;
const EVENING = 1260;
const EARLY_CLOSE = 1140;
const CHILD_HOUR = 840;
const SEED = 'verdigris';

function sample(page, extra) {
  return page.evaluate((extra) => {
    const c = window.__verdigris.city;
    let pubs = 0;
    let chapel = 0;
    let courts = 0;
    let courtsPiped = 0;
    let shebeen = 0;
    for (const b of c.buildings) {
      if (b.kind === 'pub') pubs += b.occupants.length;
      if (b.kind === 'chapel') chapel += b.occupants.length;
      if (b.kind === 'courtdwelling') {
        courts++;
        if (c.networks.drain.buildingSeg[b.id] >= 0) courtsPiped++;
      }
    }
    if (c.laws.shebeenId >= 0) shebeen = c.buildings[c.laws.shebeenId].occupants.length;
    let millYoung = 0;
    let millYoungHome = 0;
    let millYoungExist = 0;
    let millYoungWorking = 0;
    let publicanGrievance = 0;
    let publicans = 0;
    let bylawCarriers = 0;
    let outdoorDrinkers = 0;
    let drinking = 0;
    for (const s of c.souls) {
      if (s.age >= 14 && s.age < 16 && s.trade !== 'child' && s.trade !== 'none' && s.workId >= 0) {
        millYoungExist++;
        if (s.inId === s.workId) millYoung++;
        if (s.inId === s.homeId) millYoungHome++;
        if (s.activity === 'working') millYoungWorking++;
      }
      if (s.trade === 'publican') { publicanGrievance += s.grievance; publicans++; }
      if (s.beliefs.some((b) => c.claims.claims[b.claimId] && c.claims.claims[b.claimId].kind === 'bylaw')) {
        bylawCarriers++;
      }
      if (s.inId < 0 && s.scheduleId === 0) outdoorDrinkers++;
      if (s.activity === 'drinking') drinking++;
    }
    const state = window.__verdigris.state();
    return {
      tick: state.tick,
      outdoors: state.outdoors,
      pubs,
      chapel,
      courts,
      courtsPiped,
      shebeen,
      millYoung,
      millYoungHome,
      millYoungExist,
      millYoungWorking,
      publicanGrievance: publicans ? Math.round(publicanGrievance / publicans) : 0,
      bylawCarriers,
      outdoorDrinkers,
      drinking,
      enforcement: c.laws.enforcement,
      active: c.laws.active,
      petitions: c.laws.petitions.reduce((n, p) => n + p.supporters, 0),
      extra,
    };
  }, extra);
}

async function run(page, law, param) {
  await page.goto(`${BASE}?seed=${SEED}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__verdigris));
  await page.evaluate(() => window.__verdigris.freeze());
  await page.evaluate(() => window.__verdigris.warp(60));
  if (law) {
    const ok = await page.evaluate(([kind, p]) => window.__verdigris.enact(kind, p), [law, param]);
    if (!ok) throw new Error(`enact ${law} failed`);
  }
  const evenings = [];
  let at = 60;
  for (let d = 5; d <= DAYS; d += 5) {
    const target = d * 1440 + EVENING;
    await page.evaluate((n) => window.__verdigris.warp(n), target - at);
    at = target;
    evenings.push(await sample(page, { day: d, hour: 'evening' }));
  }
  const childTarget = DAYS * 1440 + CHILD_HOUR;
  if (childTarget > at) {
    await page.evaluate((n) => window.__verdigris.warp(n), childTarget - at);
    at = childTarget;
  }
  const afternoon = await sample(page, { day: DAYS, hour: 'afternoon' });
  return { evenings, afternoon, law: law ?? 'control' };
}

function mean(rows, key) {
  if (!rows.length) return 0;
  return Math.round(rows.reduce((n, r) => n + r[key], 0) / rows.length);
}

const browser = await chromium.launch();
const page = await browser.newPage();
page.setDefaultTimeout(180000);

const control = await run(page, null);
const curfew = await run(page, 'curfew', 1200);
const licensing = await run(page, 'licensingHours', 1260);
const licensingEarly = await run(page, 'licensingHours', EARLY_CLOSE);
const drainage = await run(page, 'drainageAct', 1);
const child = await run(page, 'childLabour', 780);
await browser.close();

const report = {
  control: {
    eveningPubs: mean(control.evenings, 'pubs'),
    eveningOutdoors: mean(control.evenings, 'outdoors'),
    eveningDrinking: mean(control.evenings, 'drinking'),
    courtsPiped: control.evenings[control.evenings.length - 1].courtsPiped,
    millYoungAfternoon: control.afternoon.millYoung,
    publicanGrievance: mean(control.evenings, 'publicanGrievance'),
    bylawCarriers: mean(control.evenings, 'bylawCarriers'),
  },
  curfew: {
    eveningPubs: mean(curfew.evenings, 'pubs'),
    eveningOutdoors: mean(curfew.evenings, 'outdoors'),
    publicanGrievance: mean(curfew.evenings, 'publicanGrievance'),
    bylawCarriers: mean(curfew.evenings, 'bylawCarriers'),
    petitions: curfew.evenings[curfew.evenings.length - 1].petitions,
  },
  licensing: {
    eveningPubs: mean(licensing.evenings, 'pubs'),
    eveningDrinking: mean(licensing.evenings, 'drinking'),
    shebeen: mean(licensing.evenings, 'shebeen'),
    publicanGrievance: mean(licensing.evenings, 'publicanGrievance'),
    bylawCarriers: mean(licensing.evenings, 'bylawCarriers'),
  },
  licensingEarly: {
    eveningPubs: mean(licensingEarly.evenings, 'pubs'),
    eveningDrinking: mean(licensingEarly.evenings, 'drinking'),
    shebeen: mean(licensingEarly.evenings, 'shebeen'),
    bylawCarriers: mean(licensingEarly.evenings, 'bylawCarriers'),
  },
  drainage: {
    courtsPiped: drainage.evenings[drainage.evenings.length - 1].courtsPiped,
    courts: drainage.evenings[drainage.evenings.length - 1].courts,
  },
  childLabour: {
    millYoungAfternoon: child.afternoon.millYoung,
    millYoungHomeAfternoon: child.afternoon.millYoungHome,
    millYoungExist: child.afternoon.millYoungExist,
    millYoungWorking: child.afternoon.millYoungWorking,
  },
  controlChild: {
    millYoungAfternoon: control.afternoon.millYoung,
    millYoungHomeAfternoon: control.afternoon.millYoungHome,
    millYoungExist: control.afternoon.millYoungExist,
    millYoungWorking: control.afternoon.millYoungWorking,
  },
};

console.log(JSON.stringify(report, null, 2));
console.log('---');
console.log(`curfew pubs ${report.curfew.eveningPubs} vs control ${report.control.eveningPubs}`);
console.log(`licensing 9pm pubs ${report.licensing.eveningPubs} drinking ${report.licensing.eveningDrinking} vs control ${report.control.eveningPubs}, shebeen ${report.licensing.shebeen}`);
console.log(`licensing 7pm pubs ${report.licensingEarly.eveningPubs} drinking ${report.licensingEarly.eveningDrinking} vs control ${report.control.eveningPubs}, shebeen ${report.licensingEarly.shebeen}`);
console.log(`drainage courts piped ${report.drainage.courtsPiped} / ${report.drainage.courts} vs control ${report.control.courtsPiped}`);
console.log(`child labour at mill ${report.childLabour.millYoungAfternoon} working ${report.childLabour.millYoungWorking} home ${report.childLabour.millYoungHomeAfternoon} exist ${report.childLabour.millYoungExist}`);
console.log(`control young at mill ${report.controlChild.millYoungAfternoon} working ${report.controlChild.millYoungWorking} home ${report.controlChild.millYoungHomeAfternoon} exist ${report.controlChild.millYoungExist}`);
console.log(`curfew bylaw carriers ${report.curfew.bylawCarriers} vs control ${report.control.bylawCarriers}`);
