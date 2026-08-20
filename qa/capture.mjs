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
  { name: 'lamps', seed: 'verdigris', tick: 1140, zoom: 1 },
  { name: 'dead-hour', seed: 'verdigris', tick: 180, zoom: 1 },
  { name: 'coppergate', seed: 'coppergate', tick: 641, zoom: 1 },
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
for (const scene of SCENES) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await page.goto(`${BASE}?seed=${scene.seed}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__verdigris));
  await page.evaluate((s) => {
    window.__verdigris.freeze();
    window.__verdigris.warp(s.tick);
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
