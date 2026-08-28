import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = process.env.VERDIGRIS_QA_DIR ?? '/tmp/vqa-sweep';
const BASE = process.env.VERDIGRIS_URL ?? 'http://127.0.0.1:4173/';

const SWEEP = [
  { name: "small-hours", seed: "verdigris", tick: 180, zoom: 2, ward: "merchant" },
  { name: "dawn", seed: "verdigris", tick: 330, zoom: 2, ward: "merchant" },
  { name: "morning", seed: "verdigris", tick: 480, zoom: 2, ward: "merchant" },
  { name: "noon", seed: "verdigris", tick: 720, zoom: 2, ward: "merchant" },
  { name: "golden-hour", seed: "verdigris", tick: 1020, zoom: 2, ward: "merchant" },
  { name: "dusk", seed: "verdigris", tick: 1140, zoom: 2, ward: "merchant" },
  { name: "lamps", seed: "verdigris", tick: 1260, zoom: 2, ward: "merchant" },
  { name: "night", seed: "verdigris", tick: 1380, zoom: 2, ward: "merchant" },
  { name: "quayside-fair", seed: "verdigris", tick: 720, zoom: 2, ward: "quayside", weather: "fair" },
  { name: "quayside-overcast", seed: "verdigris", tick: 720, zoom: 2, ward: "quayside", weather: "overcast" },
  { name: "quayside-rain", seed: "verdigris", tick: 720, zoom: 2, ward: "quayside", weather: "rain" },
  { name: "quayside-storm", seed: "verdigris", tick: 720, zoom: 2, ward: "quayside", weather: "storm" },
  { name: "quayside-fog", seed: "verdigris", tick: 720, zoom: 2, ward: "quayside", weather: "fog" },
  { name: "wide-morning", seed: "verdigris", tick: 480, zoom: 1 },
  { name: "wide-golden", seed: "verdigris", tick: 1020, zoom: 1 },
  { name: "wide-dusk", seed: "verdigris", tick: 1140, zoom: 1 },
  { name: "wide-night", seed: "verdigris", tick: 1320, zoom: 1 }
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
for (const scene of SWEEP) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await page.goto(`${BASE}?seed=${scene.seed}&t=${scene.tick}&freeze=1`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__verdigris));
  await page.evaluate((s) => {
    window.__verdigris.freeze();
    if (s.weather) {
      window.__verdigris.forceWeather(s.weather);
      window.__verdigris.warp(1);
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
