// Minimal browser regression for back-facing gables bleeding through roof slopes.
import { chromium } from 'playwright';

const BASE = process.env.VERDIGRIS_URL ?? 'http://127.0.0.1:5173/';
const browser = await chromium.launch();

try {
  const page = await browser.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const result = await page.evaluate(async () => {
    const { drawHouse, houseCorners } = await import('/src/render/house.ts');
    const ox = 96;
    const oy = 116;
    const wallH = 24;
    const roofH = 16;
    const gable = '#ff00ff';

    const inside = (px, py, [a, b, c]) => {
      const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
      const d1 = cross(a, b, { x: px, y: py });
      const d2 = cross(b, c, { x: px, y: py });
      const d3 = cross(c, a, { x: px, y: py });
      return (d1 > 1 && d2 > 1 && d3 > 1) || (d1 < -1 && d2 < -1 && d3 < -1);
    };

    const check = (shape, ridgeAlongX) => {
      const canvas = document.createElement('canvas');
      canvas.width = 192;
      canvas.height = 160;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      drawHouse(ctx, ox, oy, {
        w: 2, d: 2, wallH, roofH, shape, chimneys: 0, windowRows: 0,
        ridgeAlongX, material: 'glazed', polite: false, finial: 'none', finialH: 0,
        skin: {
          wallLit: '#705030', wallShade: '#503020', gableLit: gable, gableShade: gable,
          roofLit: '#507090', roofShade: '#304050', roofRidge: '#d0e0f0', outline: '#101018',
        },
      });

      const eave = houseCorners(ox, oy, 2, 2, wallH);
      const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - roofH });
      const r0 = ridgeAlongX ? mid(eave.W, eave.N) : mid(eave.N, eave.E);
      const far = ridgeAlongX ? [eave.W, eave.N, r0] : [eave.N, eave.E, r0];
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let farGablePixels = 0;
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          if (!inside(x + 0.5, y + 0.5, far)) continue;
          const i = (y * canvas.width + x) * 4;
          if (data[i] === 255 && data[i + 1] === 0 && data[i + 2] === 255 && data[i + 3] === 255) {
            farGablePixels++;
          }
        }
      }
      return farGablePixels;
    };

    return {
      gableX: check('gable', true), gableY: check('gable', false),
      gambrelX: check('gambrel', true), gambrelY: check('gambrel', false),
    };
  });

  const failures = Object.entries(result).filter(([, pixels]) => pixels > 0);
  if (failures.length) {
    throw new Error(`back-facing gable visible: ${failures.map(([name, pixels]) => `${name}=${pixels}`).join(', ')}`);
  }
  console.log('roof occlusion: gable and gambrel roofs hide both back-facing ends');
} finally {
  await browser.close();
}
