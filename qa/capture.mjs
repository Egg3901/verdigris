// Deterministic screenshot goldens.
//
// Fixed seed, speed 0, and time moved ONLY through warp, so a golden is a pure
// function of (seed, tick) rather than of how fast the machine happened to be.
// Text chrome is hidden during capture: DOM text rasterization is not
// deterministic run to run, and this is a prose game, so prose is asserted in
// vitest by hashing describeBuilding output instead.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = process.env.VERDIGRIS_QA_DIR ?? resolve(process.cwd(), '../verdigris-qa');
const BASE = process.env.VERDIGRIS_URL ?? 'http://127.0.0.1:4173/';

const SCENES = [
  { name: 'morning', seed: 'verdigris', tick: 641, zoom: 1 },
  { name: 'morning-street', seed: 'verdigris', tick: 641, zoom: 2 },
  { name: 'night-street', seed: 'verdigris', tick: 1320, zoom: 2 },
  // 1260 is inside lamp hour and exercises both grading and window glow.
  { name: 'lamps', seed: 'verdigris', tick: 1260, zoom: 1 },
  { name: 'dead-hour', seed: 'verdigris', tick: 180, zoom: 1 },
  { name: 'coppergate', seed: 'coppergate', tick: 641, zoom: 1 },
  { name: 'civic-ward', seed: 'verdigris', tick: 641, zoom: 2, ward: 'civic' },
  { name: 'garden-ward', seed: 'verdigris', tick: 641, zoom: 2, ward: 'garden' },
  { name: 'merchant-ward', seed: 'verdigris', tick: 641, zoom: 2, ward: 'merchant' },
  { name: 'works-ward', seed: 'verdigris', tick: 641, zoom: 2, ward: 'works' },
  { name: 'courts-ward', seed: 'verdigris', tick: 641, zoom: 2, ward: 'courts' },
  { name: 'quayside-ward', seed: 'verdigris', tick: 641, zoom: 2, ward: 'quayside' },
  { name: 'works-scaffold', seed: 'verdigris', tick: 641, zoom: 3, works: true },
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
for (const scene of SCENES) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await page.goto(`${BASE}?seed=${scene.seed}&t=${scene.tick}&freeze=1`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__verdigris));
  await page.evaluate((s) => {
    window.__verdigris.freeze();
    if (s.works) {
      const city = window.__verdigris.city;
      const target = city.buildings.filter((b) =>
        b.kind === 'tenement' && b.fabric < 760 && b.drainSeg >= 0)
        .sort((a, b) => ((a.ox - 32) ** 2 + (a.oy - 50) ** 2)
          - ((b.ox - 32) ** 2 + (b.oy - 50) ** 2))[0];
      if (target && window.__verdigris.nudge('fileWorks', { kind: 'building', id: target.id })) {
        const order = city.works.orders[city.works.orders.length - 1];
        const toStart = Math.max(0, order.startsAt - city.tick);
        const nextHour = (60 - ((city.tick + toStart) % 60)) % 60;
        window.__verdigris.warp(toStart + nextHour);
        window.__verdigris.select('building', target.id);
        window.__verdigris.lookAt(target.ox, target.oy);
      }
    }
    if (s.ward) {
      const city = window.__verdigris.city;
      const ward = city.wards.find((item) => item.kind === s.ward);
      const target = ward ? city.buildings
        .filter((building) => city.plots[building.plotId].wardId === ward.id)
        .sort((a, b) => ((a.ox - ward.anchorX) ** 2 + (a.oy - ward.anchorY) ** 2)
          - ((b.ox - ward.anchorX) ** 2 + (b.oy - ward.anchorY) ** 2))[0] : null;
      if (target) window.__verdigris.lookAt(target.ox, target.oy);
    }
    if (s.lookAt) window.__verdigris.lookAt(s.lookAt[0], s.lookAt[1]);
    window.__verdigris.zoom(s.zoom);
  }, scene);
  await page.addStyleTag({ content: '#shell { visibility: hidden !important; }' });
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${OUT}/${scene.name}.png` });
  const state = await page.evaluate(() => window.__verdigris.state());
  console.log(`${scene.name}: tick ${state.tick}, ${state.outdoors} outdoors, ${state.buildings} roofs`);
  await page.close();
}
await browser.close();
