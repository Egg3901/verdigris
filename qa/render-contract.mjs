// Browser-level proof of the renderer's three non-negotiable contracts:
// exact target time, binary alpha, and a finite art-directed colour bank.
import { chromium } from 'playwright';

const BASE = process.env.VERDIGRIS_URL ?? 'http://127.0.0.1:4173/';
const CASES = [
  { name: 'day', tick: 641 },
  { name: 'dusk', tick: 1200 },
  { name: 'night', tick: 1320 },
  { name: 'fire-night', tick: 1320, disaster: 'fire' },
  { name: 'flood-day', tick: 641, disaster: 'flood' },
  { name: 'collapse-day', tick: 641, disaster: 'collapse' },
  { name: 'fog-day', seed: 'verdigris', tick: 641, weather: 'fog' },
  { name: 'rain-day', seed: 'weather-0', tick: 641, weather: 'rain' },
  { name: 'storm-day', seed: 'weather-3', tick: 641, weather: 'storm' },
  { name: 'rain-night', seed: 'night-rain-5', tick: 1320, weather: 'rain' },
  { name: 'storm-refuge', seed: 'weather-3', tick: 641, weather: 'storm', shelter: true },
  { name: 'civic-market', seed: 'coppergate', tick: 480, expectedTick: 540, market: true },
  { name: 'merchant-authorship', seed: 'verdigris', tick: 641, ward: 'merchant' },
  { name: 'works-authorship', seed: 'verdigris', tick: 641, ward: 'works' },
  { name: 'courts-authorship', seed: 'verdigris', tick: 641, ward: 'courts' },
];

const browser = await chromium.launch();
try {
  for (const test of CASES) {
    const page = await browser.newPage({ viewport: { width: 960, height: 640 }, deviceScaleFactor: 1 });
    await page.goto(`${BASE}?seed=${test.seed ?? 'verdigris'}&t=${test.tick}&freeze=1`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.__verdigris));
    if (test.ward) {
      await page.evaluate((kind) => {
        const ward = window.__verdigris.city.wards.find((item) => item.kind === kind);
        if (!ward) throw new Error(`missing ${kind} ward`);
        window.__verdigris.lookAt(ward.anchorX, ward.anchorY);
        window.__verdigris.zoom(3);
      }, test.ward);
      await page.waitForTimeout(120);
    }
    if (test.shelter) {
      await page.evaluate(() => {
        const hook = window.__verdigris;
        const provider = hook.city.buildings
          .filter((b) => b.kind === 'chapel' || b.kind === 'bathhouse' || b.kind === 'dispensary' || b.kind === 'townhall')
          .sort((a, b) => Number(b.kind === 'dispensary') - Number(a.kind === 'dispensary') || a.id - b.id)[0];
        const exposed = hook.city.souls.find((s) => s.inId < 0 && s.activity !== 'held' && s.activity !== 'dead');
        if (!provider || !exposed) throw new Error('storm refuge fixture missing');
        exposed.age = 6;
        exposed.health = 200;
        exposed.warmth = 180;
        if (!hook.nudge('openShelter', { kind: 'building', id: provider.id })) throw new Error('storm refuge refused');
        hook.lookAt(provider.ox, provider.oy);
        hook.zoom(3);
      });
      await page.waitForTimeout(120);
    }
    if (test.market) {
      await page.evaluate(() => {
        const hook = window.__verdigris;
        if (!hook.market()) throw new Error('market fixture refused');
        hook.warp(60);
        const hall = hook.city.buildings.find((b) => b.kind === 'townhall');
        if (hall) { hook.lookAt(hall.ox, hall.oy); hook.zoom(3); }
      });
      await page.waitForTimeout(120);
    }
    if (test.disaster) {
      await page.evaluate((kind) => {
        const hook = window.__verdigris;
        const city = hook.city;
        let candidates = city.buildings.filter((b) => b.firmId >= 0 && b.householdIds.length === 0);
        if (kind === 'fire') candidates = candidates.filter((b) => b.kind === 'workshop' && b.gasSeg >= 0);
        if (kind === 'flood') candidates = candidates.filter((b) => {
          const riverY = city.river.centre[b.doorX];
          return b.drainSeg >= 0 && riverY >= 0
            && Math.abs(b.doorY - riverY) <= city.river.halfWidth[b.doorX] + 4;
        });
        if (kind === 'collapse') {
          candidates = candidates.filter((b) => b.kind === 'wharfshed' || b.kind === 'warehouse' || b.kind === 'workshop');
        }
        candidates.sort((a, b) => {
          if (kind === 'collapse') {
            return Number(b.kind === 'wharfshed') - Number(a.kind === 'wharfshed')
              || (b.w * b.d) - (a.w * a.d) || a.id - b.id;
          }
          if (kind === 'flood') {
            const ar = city.river.centre[a.doorX];
            const br = city.river.centre[b.doorX];
            return Math.abs(a.doorY - ar) - Math.abs(b.doorY - br)
              || (b.w * b.d) - (a.w * a.d) || a.id - b.id;
          }
          return a.id - b.id;
        });
        const target = candidates.find((b) => hook.disaster(kind, b.id));
        if (!target) throw new Error(`no ${kind} target`);
        hook.lookAt(target.ox, target.oy);
        hook.zoom(3);
      }, test.disaster);
      await page.waitForTimeout(120);
    }
    const result = await page.evaluate(() => {
      window.__verdigris.freeze();
      const canvas = document.querySelector('#world');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const allowed = new Set(window.__verdigris.palette().map((x) => x.toLowerCase()));
      const colours = new Set();
      const illegal = new Set();
      let partialAlpha = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] !== 0 && data[i + 3] !== 255) partialAlpha++;
        if (data[i + 3] === 0) continue;
        const hex = `#${data[i].toString(16).padStart(2, '0')}${data[i + 1].toString(16).padStart(2, '0')}${data[i + 2].toString(16).padStart(2, '0')}`;
        colours.add(hex);
        if (!allowed.has(hex)) illegal.add(hex);
      }
      return {
        tick: window.__verdigris.state().tick,
        weather: window.__verdigris.weather(),
        colours: colours.size,
        allowed: allowed.size,
        partialAlpha,
        illegal: [...illegal].slice(0, 12),
      };
    });
    const expectedTick = test.expectedTick ?? test.tick;
    if (result.tick !== expectedTick) throw new Error(`${test.name}: expected tick ${expectedTick}, got ${result.tick}`);
    if (test.weather && result.weather !== test.weather) {
      throw new Error(`${test.name}: expected ${test.weather}, got ${result.weather}`);
    }
    if (result.partialAlpha) throw new Error(`${test.name}: ${result.partialAlpha} partial-alpha pixels`);
    if (result.illegal.length) throw new Error(`${test.name}: colours outside bank: ${result.illegal.join(', ')}`);
    console.log(`${test.name}: tick ${result.tick}, ${result.colours}/${result.allowed} palette colours, binary alpha`);
    await page.close();
  }
} finally {
  await browser.close();
}
