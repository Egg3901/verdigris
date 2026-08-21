// Browser-level proof of the renderer's three non-negotiable contracts:
// exact target time, binary alpha, and a finite art-directed colour bank.
import { chromium } from 'playwright';

const BASE = process.env.VERDIGRIS_URL ?? 'http://127.0.0.1:4173/';
const CASES = [
  { name: 'day', tick: 641 },
  { name: 'dusk', tick: 1200 },
  { name: 'night', tick: 1320 },
];

const browser = await chromium.launch();
try {
  for (const test of CASES) {
    const page = await browser.newPage({ viewport: { width: 960, height: 640 }, deviceScaleFactor: 1 });
    await page.goto(`${BASE}?seed=verdigris&t=${test.tick}&freeze=1`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.__verdigris));
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
        colours: colours.size,
        allowed: allowed.size,
        partialAlpha,
        illegal: [...illegal].slice(0, 12),
      };
    });
    if (result.tick !== test.tick) throw new Error(`${test.name}: expected tick ${test.tick}, got ${result.tick}`);
    if (result.partialAlpha) throw new Error(`${test.name}: ${result.partialAlpha} partial-alpha pixels`);
    if (result.illegal.length) throw new Error(`${test.name}: colours outside bank: ${result.illegal.join(', ')}`);
    console.log(`${test.name}: tick ${result.tick}, ${result.colours}/${result.allowed} palette colours, binary alpha`);
    await page.close();
  }
} finally {
  await browser.close();
}
