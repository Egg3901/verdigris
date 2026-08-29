import { chromium } from 'playwright';
const tag = process.argv[2] || 'before';
const scenes = [
  { name: 'milltown-verdigris', seed: 'verdigris' },
  { name: 'port-coppergate', seed: 'coppergate' },
  { name: 'garden-district-01', seed: 'district-01' },
  { name: 'crossing-district-00', seed: 'district-00' },
];
const browser = await chromium.launch();
for (const s of scenes) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:4187/?seed=${s.seed}&t=641&freeze=1`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__verdigris));
  await page.evaluate(() => {
    window.__verdigris.freeze();
    window.__verdigris.zoom(1);
    const sh = document.querySelector('#shell'); if (sh) sh.style.display = 'none';
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `/tmp/shots/${tag}-${s.name}.png` });
  await page.close();
}
await browser.close();
