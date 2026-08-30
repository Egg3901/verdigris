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
  { name: 'season-spring', seed: 'verdigris', tick: 641, zoom: 3, ward: 'garden', forceWeather: 'fair', weatherWarp: 9 },
  { name: 'season-summer', seed: 'verdigris', tick: 12 * 1440 + 641, zoom: 3, ward: 'garden', forceWeather: 'fair', weatherWarp: 9 },
  { name: 'season-autumn', seed: 'verdigris', tick: 24 * 1440 + 641, zoom: 3, ward: 'garden', forceWeather: 'fair', weatherWarp: 9 },
  { name: 'season-winter', seed: 'verdigris', tick: 36 * 1440 + 641, zoom: 3, ward: 'garden', forceWeather: 'fair', weatherWarp: 9 },
  { name: 'merchant-ward', seed: 'verdigris', tick: 641, zoom: 2, ward: 'merchant' },
  { name: 'merchant-closed', seed: 'verdigris', tick: 1320, zoom: 3, ward: 'merchant' },
  { name: 'works-ward', seed: 'verdigris', tick: 641, zoom: 2, ward: 'works' },
  { name: 'courts-ward', seed: 'verdigris', tick: 641, zoom: 2, ward: 'courts' },
  { name: 'quayside-ward', seed: 'verdigris', tick: 641, zoom: 2, ward: 'quayside' },
  { name: 'works-scaffold', seed: 'verdigris', tick: 641, zoom: 3, works: true },
  { name: 'civic-deputation', seed: 'verdigris', tick: 641, zoom: 2, deputation: true },
  { name: 'fire-day', seed: 'verdigris', tick: 641, zoom: 3, disaster: 'fire' },
  { name: 'fire-night', seed: 'verdigris', tick: 1320, zoom: 3, disaster: 'fire' },
  { name: 'flood-street', seed: 'verdigris', tick: 641, zoom: 3, disaster: 'flood' },
  { name: 'collapse-ruin', seed: 'verdigris', tick: 641, zoom: 3, disaster: 'collapse' },
  { name: 'river-fog', seed: 'verdigris', tick: 641, zoom: 2, ward: 'quayside' },
  { name: 'river-outfall-rain', seed: 'verdigris', tick: 641, zoom: 3, forceWeather: 'rain', weatherWarp: 1440, outfall: true },
  { name: 'river-outfall-drought', seed: 'verdigris', tick: 641, zoom: 3, forceWeather: 'drought', weatherWarp: 1440, outfall: true },
  { name: 'rain-street', seed: 'weather-0', tick: 641, zoom: 2, ward: 'merchant' },
  { name: 'storm-quay', seed: 'weather-3', tick: 641, zoom: 2, ward: 'quayside' },
  { name: 'rain-night', seed: 'night-rain-5', tick: 1320, zoom: 2, ward: 'civic' },
  { name: 'storm-refuge', seed: 'weather-3', tick: 641, zoom: 3, shelter: true },
  { name: 'civic-market', seed: 'coppergate', tick: 480, zoom: 3, market: true },
  { name: 'merchant-frontage', seed: 'verdigris', tick: 641, zoom: 3, ward: 'merchant' },
  { name: 'works-yard', seed: 'verdigris', tick: 641, zoom: 3, ward: 'works' },
  { name: 'courts-patina', seed: 'verdigris', tick: 641, zoom: 3, ward: 'courts' },
  { name: 'mill-machinery', seed: 'verdigris', tick: 641, zoom: 3, buildingKind: 'mill' },
  { name: 'gas-holder', seed: 'verdigris', tick: 641, zoom: 3, buildingKind: 'gasworks' },
  { name: 'pump-beam', seed: 'verdigris', tick: 641, zoom: 3, buildingKind: 'pumphouse' },
  { name: 'tram-contact', seed: 'verdigris', tick: 641, zoom: 3, buildingKind: 'tramdepot' },
  { name: 'civic-clock', seed: 'verdigris', tick: 641, zoom: 3, buildingKind: 'townhall' },
  { name: 'washing-wind', seed: 'verdigris', tick: 641, zoom: 3, washing: true },
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
for (const scene of SCENES) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await page.goto(`${BASE}?seed=${scene.seed}&t=${scene.tick}&freeze=1`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__verdigris));
  await page.evaluate((s) => {
    window.__verdigris.freeze();
    if (s.forceWeather) {
      window.__verdigris.forceWeather(s.forceWeather);
      window.__verdigris.warp(s.weatherWarp ?? 0);
    }
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
    if (s.deputation) {
      const city = window.__verdigris.city;
      const target = city.buildings
        .filter((b) => b.streetId >= 0 && b.fabric < 760)
        .map((b) => ({
          b,
          neighbours: city.souls.filter((soul) => city.buildings[soul.homeId]?.streetId === b.streetId).length,
        }))
        .filter((item) => item.neighbours >= 8)
        .sort((a, b) => b.neighbours - a.neighbours || a.b.id - b.b.id)[0]?.b;
      if (target
        && window.__verdigris.nudge('fileWorks', { kind: 'building', id: target.id })
        && window.__verdigris.nudge('callDeputation', { kind: 'building', id: target.id })) {
        window.__verdigris.warp(60);
        const hall = city.buildings.find((b) => b.kind === 'townhall');
        if (hall) window.__verdigris.lookAt(hall.ox, hall.oy);
      }
    }
    if (s.disaster) {
      const city = window.__verdigris.city;
      const ordinaryFirm = (b) => b.firmId >= 0 && b.householdIds.length === 0;
      let candidates = city.buildings.filter(ordinaryFirm);
      if (s.disaster === 'fire') {
        candidates = candidates.filter((b) => b.kind === 'workshop' && b.gasSeg >= 0);
      } else if (s.disaster === 'flood') {
        candidates = candidates.filter((b) => {
          const riverY = city.river.centre[b.doorX];
          return b.drainSeg >= 0 && riverY >= 0
            && Math.abs(b.doorY - riverY) <= city.river.halfWidth[b.doorX] + 4;
        });
      } else {
        candidates = candidates.filter((b) => b.kind === 'wharfshed' || b.kind === 'warehouse' || b.kind === 'workshop');
      }
      candidates.sort((a, b) => {
        if (s.disaster === 'collapse') {
          return Number(b.kind === 'wharfshed') - Number(a.kind === 'wharfshed')
            || (b.w * b.d) - (a.w * a.d) || a.id - b.id;
        }
        if (s.disaster === 'flood') {
          const ar = city.river.centre[a.doorX];
          const br = city.river.centre[b.doorX];
          return Math.abs(a.doorY - ar) - Math.abs(b.doorY - br)
            || (b.w * b.d) - (a.w * a.d) || a.id - b.id;
        }
        return a.id - b.id;
      });
      for (const target of candidates) {
        if (!window.__verdigris.disaster(s.disaster, target.id)) continue;
        window.__verdigris.select('building', target.id);
        window.__verdigris.lookAt(target.ox, target.oy);
        break;
      }
    }
    if (s.shelter) {
      const city = window.__verdigris.city;
      const provider = city.buildings
        .filter((b) => b.kind === 'chapel' || b.kind === 'bathhouse' || b.kind === 'dispensary' || b.kind === 'townhall')
        .sort((a, b) => Number(b.kind === 'dispensary') - Number(a.kind === 'dispensary') || a.id - b.id)[0];
      const exposed = city.souls.find((soul) => soul.inId < 0 && soul.activity !== 'held' && soul.activity !== 'dead');
      if (provider && exposed) {
        exposed.age = 6;
        exposed.health = 200;
        exposed.warmth = 180;
        if (window.__verdigris.nudge('openShelter', { kind: 'building', id: provider.id })) {
          window.__verdigris.select('building', provider.id);
          window.__verdigris.lookAt(provider.ox, provider.oy);
        }
      }
    }
    if (s.market) {
      const city = window.__verdigris.city;
      if (!window.__verdigris.market()) throw new Error('market fixture refused');
      const hall = city.buildings.find((b) => b.kind === 'townhall');
      if (hall) {
        window.__verdigris.warp(60);
        window.__verdigris.select('building', hall.id);
        window.__verdigris.lookAt(hall.ox, hall.oy);
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
    if (s.buildingKind) {
      const city = window.__verdigris.city;
      const target = city.buildings
        .filter((building) => building.kind === s.buildingKind)
        .sort((a, b) => (b.w * b.d) - (a.w * a.d) || a.id - b.id)[0];
      if (target) window.__verdigris.lookAt(target.ox, target.oy);
    }
    if (s.washing) {
      const city = window.__verdigris.city;
      const target = city.buildings.find((building) => window.__verdigris.debugSkin(building.id).washing);
      if (target) window.__verdigris.lookAt(target.ox, target.oy);
    }
    if (s.outfall) {
      const city = window.__verdigris.city;
      const d = city.district;
      let found = null;
      for (let ty = 0; ty < d.height && !found; ty++) {
        for (let tx = 0; tx < d.width; tx++) {
          const k = ty * d.width + tx;
          if (d.tile[k] !== 1) continue;
          const east = tx + 1 >= d.width || d.tile[k + 1] === 0;
          const south = ty + 1 >= d.height || d.tile[k + d.width] === 0;
          if (east || south) { found = [tx, ty]; break; }
        }
      }
      if (found) window.__verdigris.lookAt(found[0], found[1]);
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
