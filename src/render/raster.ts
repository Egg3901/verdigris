// Hard-edged rasterisation.
//
// THE PROBLEM THIS SOLVES. Canvas2D antialiases every path fill and every stroke,
// and there is no flag to turn that off: imageSmoothingEnabled only governs image
// scaling. So a roof slope drawn with ctx.fill() gets a soft gradient border one
// to two pixels wide along every diagonal, in colours that are blends of the two
// sides and therefore members of no palette. Measured on the shipped build:
// 13,588 unique colours in a single frame, and only 14.7% of non-void pixels were
// exactly a palette entry. That soft diagonal is THE tell. It is the difference
// between "isometric pixel art" and "flat-shaded vector that wishes it were".
//
// THE FIX. Rasterise polygons ourselves, one integer scanline at a time, and emit
// each span as a fillRect with integer arguments. fillRect on integer bounds is
// not antialiased, so every edge lands hard on a pixel boundary and every pixel
// is exactly the colour we asked for.
//
// This is the same job a sprite atlas would do, done at bake time instead of in
// Pillow, and it applies to the vector primitives we already have rather than
// requiring 470 hand-drawn frames first.
export interface Pt {
  x: number;
  y: number;
}

/**
 * Scanline fill. Handles convex and concave simple polygons, which is everything
 * a house is made of.
 *
 * Sampling is at the pixel CENTRE (y + 0.5), the same convention a GPU uses, so
 * two polygons sharing an edge tile against each other without a seam and without
 * double-drawing the shared row.
 */
export function fillPolyHard(
  ctx: CanvasRenderingContext2D, pts: readonly Pt[], colour: string,
): void {
  if (pts.length < 3) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const y0 = Math.floor(minY);
  const y1 = Math.ceil(maxY);
  ctx.fillStyle = colour;
  const xs: number[] = [];
  for (let y = y0; y < y1; y++) {
    const sy = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      // Half-open rule on the y span: an edge counts if it crosses this scanline
      // going down but not going up through the same vertex, which is what stops
      // shared vertices producing a doubled or missing crossing.
      if ((a.y <= sy && b.y > sy) || (b.y <= sy && a.y > sy)) {
        xs.push(a.x + ((sy - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = Math.round(xs[i]);
      const xb = Math.round(xs[i + 1]);
      if (xb > xa) ctx.fillRect(xa, y, xb - xa, 1);
    }
  }
}

/** A one-pixel line, plotted rather than stroked. ctx.stroke() antialiases and,
 *  at a half-pixel offset, smears a 1px line across two rows at half alpha. */
export function lineHard(
  ctx: CanvasRenderingContext2D, a: Pt, b: Pt, colour: string,
): void {
  ctx.fillStyle = colour;
  let x0 = Math.round(a.x);
  let y0 = Math.round(a.y);
  const x1 = Math.round(b.x);
  const y1 = Math.round(b.y);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let guard = 0;
  for (;;) {
    ctx.fillRect(x0, y0, 1, 1);
    if ((x0 === x1 && y0 === y1) || guard++ > 4096) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

/** An axis-aligned ellipse, scanline filled. Used for tree canopies, which were
 *  the last soft-edged thing in the frame. */
export function fillEllipseHard(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, colour: string,
): void {
  ctx.fillStyle = colour;
  const y0 = Math.floor(cy - ry);
  const y1 = Math.ceil(cy + ry);
  for (let y = y0; y < y1; y++) {
    const t = (y + 0.5 - cy) / ry;
    if (t < -1 || t > 1) continue;
    const half = rx * Math.sqrt(1 - t * t);
    const xa = Math.round(cx - half);
    const xb = Math.round(cx + half);
    if (xb > xa) ctx.fillRect(xa, y, xb - xa, 1);
  }
}

/** The 4x4 ordered dither matrix, thresholds 0..15. */
export const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/**
 * Ordered-dither a second colour into a polygon.
 *
 * This is what gives a flat face texture without adding a third colour, and it is
 * the single most characteristic mark of the medium: pixel art shades by
 * scattering pixels of an existing colour, not by blending toward a new one.
 * `amount` is 0..16, how many of the sixteen cells in each 4x4 block take the
 * second colour.
 */
export function ditherPolyHard(
  ctx: CanvasRenderingContext2D, pts: readonly Pt[], colour: string, amount: number,
): void {
  if (amount <= 0 || pts.length < 3) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  ctx.fillStyle = colour;
  const xs: number[] = [];
  for (let y = Math.floor(minY); y < Math.ceil(maxY); y++) {
    const sy = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if ((a.y <= sy && b.y > sy) || (b.y <= sy && a.y > sy)) {
        xs.push(a.x + ((sy - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    const row = BAYER[((y % 4) + 4) % 4];
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = Math.round(xs[i]);
      const xb = Math.round(xs[i + 1]);
      for (let x = xa; x < xb; x++) {
        if (row[((x % 4) + 4) % 4] < amount) ctx.fillRect(x, y, 1, 1);
      }
    }
  }
}

/**
 * Force every pixel to fully opaque or fully transparent.
 *
 * The palette contract claims alpha is exactly 0 or 255. It was not: text
 * rendering, ellipse edges and any residual antialiasing left partial alpha behind, and
 * partial alpha breaks the source-in silhouette stamp that the ID picking buffer
 * depends on, as well as producing soft halos when a sprite is drawn over the
 * ground.
 */
export function hardenAlpha(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  if (w <= 0 || h <= 0) return;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] >= 128) {
      d[i] = 255;
    } else {
      d[i] = 0;
      d[i - 3] = 0;
      d[i - 2] = 0;
      d[i - 1] = 0;
    }
  }
  ctx.putImageData(img, 0, 0);
}
