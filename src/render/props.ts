// Trees, and the texture that stops the ground reading as flat colour.
//
// Both are cheap and both matter more than their cost suggests: a diamond of
// unbroken green looks like a placeholder, and a district with no trees on its
// fringe looks like it was stamped rather than grown.
import { TILE_W, TILE_H, isoX, isoY, depthKey, LAYER_STRUCT } from './iso';
import { PAL, shadeHex, gradeHex, isDarkVariant } from './palette';
import type { Variant } from './palette';
import { mix } from '../sim/rng';
import { fillEllipseHard, ditherPolyHard, hardenAlpha, fillPolyHard, lineHard, BAYER } from './raster';
import { Tile } from '../sim/types';
import type { District } from '../sim/district';
import type { Ward } from '../sim/gen/wards';
import { cellKey, insideIsland } from '../sim/district';
import type { City } from '../sim/city';
import { isOccasionActive } from '../sim/occasions';

export interface Prop {
  sprite: HTMLCanvasElement;
  ax: number;
  ay: number;
  wx: number;
  wy: number;
  depth: number;
}

const CANOPY = [PAL.leaf1, PAL.leaf2, PAL.leaf3, PAL.moss1, PAL.moss2];

/** A lime tree, eighteen pixels tall. Three overlapping canopy blobs so the
 *  silhouette is lumpy rather than a circle. */
type TreeShape = 'lime' | 'poplar' | 'scrub';

/**
 * Three silhouettes at three sizes.
 *
 * One four-blob shape at one size read as broccoli, and at zoom 1 a tree was the
 * same size as a small house. Silhouette is what distinguishes vegetation at this
 * scale, exactly as it is for roofs.
 */
function bakeTree(salt: number, shape: TreeShape, size: number, variant: Variant): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 20;
  c.height = 26;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;
  const lit = gradeHex(CANOPY[salt % CANOPY.length], variant);
  const shade = shadeHex(lit, -0.3);
  const dark = shadeHex(lit, -0.5);

  const trunkH = shape === 'poplar' ? 5 : shape === 'scrub' ? 3 : 8;
  ctx.fillStyle = gradeHex(PAL.wood0, variant);
  ctx.fillRect(9, 24 - trunkH, shape === 'scrub' ? 1 : 2, trunkH);

  const k = size;
  const blobs: [number, number, number][] = shape === 'poplar'
    // Tall and narrow: a Lombardy poplar, which is the shape that breaks a
    // skyline of round canopies.
    ? [[10, 16, 3.4 * k], [10, 12, 3.6 * k], [10, 8, 3.0 * k], [10, 5, 2.2 * k]]
    : shape === 'scrub'
      // Low and wide: hedge and bramble along a back yard.
      ? [[8, 19, 4.2 * k], [13, 19, 3.6 * k], [10, 16, 3.4 * k]]
      : [[10, 12, 7 * k], [7, 9, 5 * k], [13, 10, 5 * k], [10, 7, 5 * k]];
  // Scanline ellipses: ctx.ellipse + fill antialiases the rim, and a soft-edged
  // tree against a hard-edged town is the one thing that gives the trick away.
  for (const [bx, by, r] of blobs) fillEllipseHard(ctx, bx, by + 1, r, r * 0.8, dark);
  for (const [bx, by, r] of blobs) fillEllipseHard(ctx, bx, by, r - 0.5, r * 0.75, shade);
  // Light from the west, upper left, as everywhere else.
  for (const [bx, by, r] of blobs) fillEllipseHard(ctx, bx - 1, by - 1, r - 2, r * 0.55, lit);
  // Break the canopy edge so it reads as leaves rather than as a blob.
  ditherPolyHard(ctx, [{x:2,y:2},{x:18,y:2},{x:18,y:17},{x:2,y:17}], shade, 3);
  hardenAlpha(ctx, c.width, c.height, variant);
  return c;
}

/**
 * Scatter trees over grass and yards.
 *
 * Deterministic from (seed, cell), never Math.random, so a district looks the
 * same every time it is loaded and the screenshot goldens hold.
 */
/**
 * The civic square's furniture: a fountain, a bandstand, market stalls.
 *
 * Measured across seeds, the square is the single largest uninterrupted area of
 * flat colour in the frame. It is where the bunting goes, where the crowd
 * gathers, and where a riot happens, and it was 49 cells of nothing.
 */
function bakeFountain(variant: Variant): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 34; c.height = 30;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const g = (x: string) => gradeHex(x, variant);
  // Basin: an iso diamond with a rim.
  fillPolyHard(ctx, [{x:17,y:14},{x:33,y:22},{x:17,y:30},{x:1,y:22}], g(PAL.stone2));
  fillPolyHard(ctx, [{x:17,y:16},{x:30,y:22},{x:17,y:28},{x:4,y:22}], g(PAL.riv1));
  ditherPolyHard(ctx, [{x:17,y:16},{x:30,y:22},{x:17,y:28},{x:4,y:22}], g(PAL.rivGlint), 4);
  // Plinth and a figure on top: the reason anybody looks at a fountain.
  fillPolyHard(ctx, [{x:14,y:10},{x:20,y:10},{x:20,y:20},{x:14,y:20}], g(PAL.stone3));
  fillPolyHard(ctx, [{x:18,y:10},{x:20,y:10},{x:20,y:20},{x:18,y:20}], g(PAL.stone1));
  fillPolyHard(ctx, [{x:15,y:3},{x:19,y:3},{x:19,y:10},{x:15,y:10}], g(PAL.verd2));
  fillPolyHard(ctx, [{x:16,y:0},{x:18,y:0},{x:18,y:3},{x:16,y:3}], g(PAL.verd3));
  hardenAlpha(ctx, c.width, c.height, variant);
  return c;
}

function bakeStall(salt: number, variant: Variant): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 26;
  c.height = 26;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const g = (x: string) => gradeHex(x, variant);
  const cloth = [PAL.buntRed, PAL.buntBlue, PAL.verd1, PAL.ochre1][salt % 4];

  // 1. Back poles
  ctx.fillStyle = g(PAL.wood0);
  ctx.fillRect(2, 9, 1, 10);
  ctx.fillRect(24, 9, 1, 10);

  // 2. Table top iso diamond
  fillPolyHard(ctx, [{x:13,y:14},{x:22,y:18},{x:13,y:22},{x:4,y:18}], g(PAL.wood2));

  // 3. Table front-left face
  fillPolyHard(ctx, [{x:4,y:18},{x:13,y:22},{x:13,y:24},{x:4,y:20}], g(PAL.wood1));

  // 4. Table front-right face
  fillPolyHard(ctx, [{x:13,y:22},{x:22,y:18},{x:22,y:20},{x:13,y:24}], g(shadeHex(PAL.wood1, 0.2)));

  // 5. Table legs
  ctx.fillStyle = g(PAL.wood0);
  ctx.fillRect(4, 20, 1, 4);
  ctx.fillRect(21, 20, 1, 4);
  ctx.fillRect(12, 24, 1, 2);

  // 6. Goods on the table top diamond
  const goods = salt % 4;
  if (goods === 0) {
    fillPolyHard(ctx, [{x:8,y:17},{x:10,y:17},{x:9,y:19}], g(PAL.ochre2));
    fillPolyHard(ctx, [{x:12,y:16},{x:14,y:16},{x:13,y:18}], g(PAL.grass0));
    fillPolyHard(ctx, [{x:16,y:17},{x:18,y:17},{x:17,y:19}], g(PAL.buntRed));
    fillPolyHard(ctx, [{x:12,y:19},{x:14,y:19},{x:13,y:21}], g(PAL.ochre2));
  } else if (goods === 1) {
    ctx.fillStyle = g(PAL.buntBlue);
    ctx.fillRect(8, 17, 4, 2);
    ctx.fillStyle = g(PAL.buntRed);
    ctx.fillRect(12, 18, 4, 2);
    ctx.fillStyle = g(PAL.cream2);
    ctx.fillRect(16, 19, 4, 2);
  } else if (goods === 2) {
    ctx.fillStyle = g(PAL.cream1);
    ctx.fillRect(8, 17, 2, 1);
    ctx.fillRect(11, 16, 2, 1);
    ctx.fillRect(14, 17, 2, 1);
    ctx.fillRect(17, 18, 2, 1);
    ctx.fillRect(12, 19, 2, 1);
  } else {
    ctx.fillStyle = g(PAL.stone2);
    ctx.fillRect(7, 17, 4, 1);
    ctx.fillRect(11, 16, 4, 1);
    ctx.fillRect(15, 17, 4, 1);
    ctx.fillRect(18, 18, 4, 1);
  }

  // 7. Canopy shaded (right) slope, lower slope
  fillPolyHard(ctx, [{x:7,y:3},{x:18,y:8},{x:13,y:14},{x:2,y:9}], g(shadeHex(cloth, 0.25)));

  // 8. Canopy lit (upper) slope
  fillPolyHard(ctx, [{x:13,y:4},{x:24,y:9},{x:18,y:8},{x:7,y:3}], g(cloth));

  // 9. Stripes on the lower slope
  fillPolyHard(ctx, [{x:8,y:5},{x:19,y:10},{x:18,y:11},{x:7,y:6}], g(PAL.buntCream));
  fillPolyHard(ctx, [{x:5,y:7},{x:16,y:12},{x:15,y:13},{x:4,y:8}], g(PAL.buntCream));

  // 10. Valance hanging 2px from front eaves
  fillPolyHard(ctx, [{x:2,y:9},{x:13,y:14},{x:13,y:16},{x:2,y:11}], g(cloth));
  fillPolyHard(ctx, [{x:13,y:14},{x:24,y:9},{x:24,y:11},{x:13,y:16}], g(cloth));
  fillPolyHard(ctx, [{x:2,y:11},{x:13,y:16},{x:13,y:17},{x:2,y:12}], g(shadeHex(cloth, 0.35)));
  fillPolyHard(ctx, [{x:13,y:16},{x:24,y:11},{x:24,y:12},{x:13,y:17}], g(shadeHex(cloth, 0.35)));

  // 11. Front pole
  if (salt % 2 === 0) {
    ctx.fillStyle = g(PAL.wood1);
    ctx.fillRect(12, 16, 1, 8);
  }

  // 12. Crate beside the left legs
  if (salt % 3 === 0) {
    fillPolyHard(ctx, [{x:3,y:20},{x:6,y:21},{x:3,y:23},{x:0,y:21}], g(PAL.wood2));
    fillPolyHard(ctx, [{x:0,y:21},{x:3,y:23},{x:3,y:25},{x:0,y:23}], g(PAL.wood1));
    fillPolyHard(ctx, [{x:3,y:23},{x:6,y:21},{x:6,y:23},{x:3,y:25}], g(PAL.wood0));
  }

  hardenAlpha(ctx, c.width, c.height, variant);
  return c;
}

export function buildSquareProps(
  district: District, seed: number, variant: Variant,
  sqX: number, sqY: number, sqW: number,
): Prop[] {
  const out: Prop[] = [];
  const cx = sqX + (sqW >> 1);
  const cy = sqY + (sqW >> 1);
  if (!insideIsland(district, cx, cy)) return out;

  const fountain = bakeFountain(variant);
  out.push({
    sprite: fountain, ax: 17, ay: 28,
    wx: isoX(cx, cy), wy: isoY(cx, cy),
    depth: depthKey(cx, cy, LAYER_STRUCT),
  });

  // Stalls around the rim of the square, on the paving, never on the fountain.
  const stalls = new Map<number, HTMLCanvasElement>();
  for (let y = sqY; y < sqY + sqW; y++) {
    for (let x = sqX; x < sqX + sqW; x++) {
      if (Math.abs(x - cx) <= 1 && Math.abs(y - cy) <= 1) continue;
      if (district.tile[cellKey(district, x, y)] !== Tile.Square) continue;
      const roll = mix(seed, 71, x, y) % 100;
      if (roll >= 16) continue;
      const salt = mix(seed, 72, x, y);
      const variantIdx = salt % 4;
      let sprite = stalls.get(variantIdx);
      if (!sprite) { sprite = bakeStall(variantIdx, variant); stalls.set(variantIdx, sprite); }
      out.push({
        sprite, ax: 13, ay: 24,
        wx: isoX(x, y), wy: isoY(x, y),
        depth: depthKey(x, y, LAYER_STRUCT),
      });
    }
  }
  return out;
}

function bakeMarketGoods(salt: number, variant: Variant): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 20; c.height = 18;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const g = (x: string) => gradeHex(x, variant);
  const cloth = [PAL.buntRed, PAL.buntBlue, PAL.verd1][salt % 3];
  fillPolyHard(ctx, [{ x: 10, y: 2 }, { x: 19, y: 6 }, { x: 10, y: 10 }, { x: 1, y: 6 }], g(cloth));
  ctx.fillStyle = g(PAL.wood0);
  ctx.fillRect(2, 6, 1, 9);
  ctx.fillRect(17, 6, 1, 9);
  ctx.fillStyle = g(PAL.wood2);
  ctx.fillRect(5, 11, 10, 3);
  ctx.fillStyle = g(PAL.ochre1);
  ctx.fillRect(6, 10, 2, 1);
  ctx.fillStyle = g(PAL.verd2);
  ctx.fillRect(11, 10, 2, 1);
  hardenAlpha(ctx, c.width, c.height, variant);
  return c;
}

/** Extra awnings and goods appear only when the simulation has actual vendors in the square. */
export function buildMarketProps(city: City, variant: Variant): Prop[] {
  const occasion = city.occasions.current;
  if (!occasion || !isOccasionActive(city)) return [];
  const out: Prop[] = [];
  const sqX = city.streetPlan.squareX;
  const sqY = city.streetPlan.squareY;
  const sqW = city.streetPlan.squareW;
  const placements: readonly [number, number][] = [
    [sqX + 1, sqY + 1], [sqX + sqW - 2, sqY + 1], [sqX + 1, sqY + sqW - 2],
  ];
  for (let i = 0; i < occasion.vendorIds.length && i < placements.length; i++) {
    if (!occasion.arrivedIds.includes(occasion.vendorIds[i])) continue;
    const [x, y] = placements[i];
    const sprite = bakeMarketGoods(occasion.vendorIds[i], variant);
    out.push({ sprite, ax: 10, ay: 15, wx: isoX(x, y), wy: isoY(x, y), depth: depthKey(x, y, LAYER_STRUCT) });
  }
  return out;
}

export function buildProps(
  district: District, seed: number, variant: Variant, wards: readonly Ward[] = [],
): Prop[] {
  const cache = new Map<number, HTMLCanvasElement>();
  const out: Prop[] = [];
  for (let ty = 0; ty < district.height; ty++) {
    for (let tx = 0; tx < district.width; tx++) {
      if (!insideIsland(district, tx, ty)) continue;
      const k = cellKey(district, tx, ty);
      const t = district.tile[k];
      if (t !== Tile.Park && t !== Tile.Yard) continue;
      // Belt and braces: nothing is planted on a cell the water laps at from two
      // sides, whatever the generator left behind.
      let lapped = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = tx + dx;
        const ny = ty + dy;
        if (nx < 0 || ny < 0 || nx >= district.width || ny >= district.height) continue;
        if (district.tile[cellKey(district, nx, ny)] === Tile.Water) lapped++;
      }
      if (lapped >= 2) continue;
      const roll = mix(seed, 51, tx, ty) % 100;
      // Parks are wooded, back yards are mostly not: a yard with a tree in every
      // one of them reads as an orchard, not as a town.
      const ward = wards[district.wardId[k]]?.kind;
      const yardWant = ward === 'garden' ? 34 : ward === 'works' ? 8 : ward === 'courts' ? 10 : 16;
      const want = t === Tile.Park ? 46 : yardWant;
      if (roll >= want) continue;
      const salt = mix(seed, 52, tx, ty);
      const canopy = salt % CANOPY.length;
      const shapes: TreeShape[] = ['lime', 'lime', 'poplar', 'scrub'];
      const shape = shapes[(salt >>> 3) % shapes.length];
      // Three size classes. A stand of identical trees is a wallpaper.
      const sizeIdx = (salt >>> 6) % 3;
      const size = [0.72, 0.88, 1.0][sizeIdx];
      const key = canopy * 100 + shapes.indexOf(shape) * 10 + sizeIdx;
      let sprite = cache.get(key);
      if (!sprite) {
        sprite = bakeTree(canopy, shape, size, variant);
        cache.set(key, sprite);
      }
      // Jitter inside the cell, so trees do not sit on a lattice.
      // Unsigned shifts: mix() is unsigned 32-bit and `>>` would go negative.
      const jx = ((salt >>> 5) % 9) - 4;
      const jy = ((salt >>> 9) % 7) - 3;
      out.push({
        sprite, ax: 10, ay: 24,
        wx: isoX(tx, ty) + jx,
        wy: isoY(tx, ty) + jy,
        depth: depthKey(tx, ty, LAYER_STRUCT) + 1,
      });
    }
  }
  out.sort((a, b) => a.depth - b.depth);
  return out;
}

function bakeLamp(variant: Variant, arc: boolean): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 14; c.height = 26;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;
  const g = (x: string) => gradeHex(x, variant);
  const post = g(PAL.soot1);
  ctx.fillStyle = post;
  ctx.fillRect(6, 10, 2, 15);
  ctx.fillRect(4, 24, 6, 2);
  ctx.fillRect(2, 10, 6, 2);
  // A 7x9 brass-framed lantern is the loudest object in the frame at zoom 1:
  // across the district it reads as a scatter of gold rectangles floating over
  // the roofs, because the post is one dark pixel wide and vanishes while the
  // head does not. Five by six, and the frame is brass INK rather than brass, so
  // the lamp reads as a lamp close up and as a dot from above.
  const glass = !isDarkVariant(variant) ? g(PAL.darkWindow) : (arc ? PAL.arc1 : PAL.gas2);
  const frame = g(arc ? PAL.stone1 : PAL.brassInk);
  ctx.fillStyle = frame;
  ctx.fillRect(2, 4, 5, 6);
  ctx.fillStyle = glass;
  ctx.fillRect(3, 5, 3, 4);
  if (isDarkVariant(variant)) {
    ctx.fillStyle = arc ? PAL.arc0 : PAL.gas1;
    ctx.fillRect(3, 6, 2, 2);
  }
  hardenAlpha(ctx, c.width, c.height, variant);
  return c;
}

function bakeBollard(variant: Variant, stone: boolean): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 6; c.height = 8;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const g = (x: string) => gradeHex(x, variant);
  ctx.fillStyle = g(stone ? PAL.stone2 : PAL.soot2);
  ctx.fillRect(2, 2, 2, 6);
  ctx.fillStyle = g(stone ? PAL.stone3 : PAL.soot3);
  ctx.fillRect(2, 2, 1, 6);
  ctx.fillStyle = g(stone ? PAL.stone1 : PAL.soot1);
  ctx.fillRect(1, 1, 4, 2);
  hardenAlpha(ctx, c.width, c.height, variant);
  return c;
}

function bakeTrough(variant: Variant): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 10;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const g = (x: string) => gradeHex(x, variant);
  fillPolyHard(ctx, [{x:8,y:4},{x:15,y:7},{x:8,y:10},{x:1,y:7}], g(PAL.stone2));
  fillPolyHard(ctx, [{x:8,y:5},{x:13,y:7},{x:8,y:9},{x:3,y:7}], g(PAL.riv1));
  ditherPolyHard(ctx, [{x:8,y:5},{x:13,y:7},{x:8,y:9},{x:3,y:7}], g(PAL.rivGlint), 3);
  hardenAlpha(ctx, c.width, c.height, variant);
  return c;
}

function bakeColumn(salt: number, variant: Variant): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 10; c.height = 20;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const g = (x: string) => gradeHex(x, variant);
  const poster = [PAL.buntRed, PAL.buntBlue, PAL.ochre1, PAL.verd1][salt % 4];
  ctx.fillStyle = g(PAL.soot2);
  ctx.fillRect(2, 4, 6, 14);
  ctx.fillStyle = g(poster);
  ctx.fillRect(3, 6, 4, 6);
  ctx.fillStyle = g(PAL.buntCream);
  ctx.fillRect(3, 13, 4, 3);
  ctx.fillStyle = g(PAL.soot1);
  ctx.fillRect(1, 3, 8, 2);
  ctx.fillRect(3, 1, 4, 3);
  ctx.fillRect(2, 18, 6, 1);
  hardenAlpha(ctx, c.width, c.height, variant);
  return c;
}

function bakeCart(salt: number, variant: Variant): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 18; c.height = 14;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const g = (x: string) => gradeHex(x, variant);
  const bed = [PAL.wood2, PAL.wood1, PAL.ochre0][salt % 3];
  fillPolyHard(ctx, [{x:9,y:5},{x:17,y:8},{x:9,y:11},{x:1,y:8}], g(bed));
  fillPolyHard(ctx, [{x:9,y:3},{x:17,y:6},{x:17,y:8},{x:9,y:5}], g(shadeHex(bed, 0.1)));
  ctx.fillStyle = g(PAL.soot1);
  ctx.fillRect(3, 10, 3, 3);
  ctx.fillRect(12, 10, 3, 3);
  ctx.fillStyle = g(PAL.soot3);
  ctx.fillRect(4, 11, 1, 1);
  ctx.fillRect(13, 11, 1, 1);
  hardenAlpha(ctx, c.width, c.height, variant);
  return c;
}

function bakeCrane(variant: Variant): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 22; c.height = 28;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const g = (x: string) => gradeHex(x, variant);
  const iron = g(PAL.soot2);
  ctx.fillStyle = iron;
  ctx.fillRect(4, 10, 2, 16);
  ctx.fillRect(3, 25, 5, 2);
  lineHard(ctx, { x: 5, y: 10 }, { x: 18, y: 4 }, iron);
  lineHard(ctx, { x: 5, y: 12 }, { x: 18, y: 4 }, g(PAL.soot3));
  ctx.fillStyle = g(PAL.wood1);
  ctx.fillRect(16, 4, 3, 2);
  ctx.fillStyle = g(PAL.soot1);
  ctx.fillRect(17, 6, 1, 8);
  hardenAlpha(ctx, c.width, c.height, variant);
  return c;
}

function bakeBarrels(variant: Variant): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 14; c.height = 11;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const g = (x: string) => gradeHex(x, variant);
  ctx.fillStyle = g(PAL.wood1);
  ctx.fillRect(2, 4, 5, 7);
  ctx.fillRect(8, 2, 4, 9);
  ctx.fillStyle = g(PAL.wood2);
  ctx.fillRect(3, 4, 2, 7);
  ctx.fillRect(9, 2, 1, 9);
  ctx.fillStyle = g(PAL.soot2);
  ctx.fillRect(2, 5, 5, 1);
  ctx.fillRect(2, 9, 5, 1);
  ctx.fillRect(8, 4, 4, 1);
  ctx.fillRect(8, 9, 4, 1);
  hardenAlpha(ctx, c.width, c.height, variant);
  return c;
}

function bakeCoal(variant: Variant): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 9;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const g = (x: string) => gradeHex(x, variant);
  fillPolyHard(ctx, [{ x: 1, y: 8 }, { x: 5, y: 3 }, { x: 10, y: 2 }, { x: 15, y: 8 }], g(PAL.soot1));
  ctx.fillStyle = g(PAL.soot3);
  ctx.fillRect(5, 4, 2, 2);
  ctx.fillRect(10, 4, 2, 2);
  hardenAlpha(ctx, c.width, c.height, variant);
  return c;
}

function bakeUrn(variant: Variant): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 10; c.height = 13;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const g = (x: string) => gradeHex(x, variant);
  ctx.fillStyle = g(PAL.leaf2);
  ctx.fillRect(2, 1, 6, 4);
  ctx.fillStyle = g(PAL.leaf3);
  ctx.fillRect(4, 0, 3, 4);
  ctx.fillStyle = g(PAL.stone2);
  ctx.fillRect(3, 5, 4, 6);
  ctx.fillStyle = g(PAL.stone3);
  ctx.fillRect(4, 5, 2, 5);
  ctx.fillStyle = g(PAL.stone1);
  ctx.fillRect(2, 10, 6, 2);
  hardenAlpha(ctx, c.width, c.height, variant);
  return c;
}

function bakeDisplay(variant: Variant): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 12;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const g = (x: string) => gradeHex(x, variant);
  fillPolyHard(ctx, [{x:8,y:4},{x:15,y:7},{x:8,y:11},{x:1,y:7}], g(PAL.wood1));
  ctx.fillStyle = g(PAL.wood2);
  ctx.fillRect(3, 5, 10, 2);
  ctx.fillStyle = g(PAL.buntRedHi);
  ctx.fillRect(5, 2, 3, 3);
  ctx.fillStyle = g(PAL.leaf3);
  ctx.fillRect(10, 2, 3, 3);
  hardenAlpha(ctx, c.width, c.height, variant);
  return c;
}

function bakeToolBench(variant: Variant): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 17; c.height = 13;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const g = (x: string) => gradeHex(x, variant);
  ctx.fillStyle = g(PAL.wood1);
  ctx.fillRect(2, 5, 13, 3);
  ctx.fillRect(4, 8, 2, 5);
  ctx.fillRect(11, 8, 2, 5);
  ctx.fillStyle = g(PAL.soot2);
  lineHard(ctx, {x:4,y:4}, {x:8,y:1}, g(PAL.soot2));
  lineHard(ctx, {x:9,y:2}, {x:12,y:5}, g(PAL.soot3));
  hardenAlpha(ctx, c.width, c.height, variant);
  return c;
}

function bakeWashTub(variant: Variant): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 14; c.height = 11;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const g = (x: string) => gradeHex(x, variant);
  fillPolyHard(ctx, [{x:2,y:4},{x:12,y:4},{x:10,y:10},{x:4,y:10}], g(PAL.wood1));
  fillPolyHard(ctx, [{x:3,y:4},{x:11,y:4},{x:10,y:6},{x:4,y:6}], g(PAL.riv1));
  ctx.fillStyle = g(PAL.buntCream);
  ctx.fillRect(9, 1, 3, 4);
  hardenAlpha(ctx, c.width, c.height, variant);
  return c;
}

function bakeRopeCoil(variant: Variant): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 15; c.height = 10;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const g = (x: string) => gradeHex(x, variant);
  fillEllipseHard(ctx, 7, 6, 6, 3, g(PAL.thatch1));
  fillEllipseHard(ctx, 7, 6, 3, 1.5, g(PAL.dirt0));
  ctx.fillStyle = g(PAL.wood2);
  ctx.fillRect(11, 2, 1, 4);
  hardenAlpha(ctx, c.width, c.height, variant);
  return c;
}

/**
 * A pneumatic post pillar: the one piece of the buried post network that stands
 * on the street. A verdigris shaft with a brass collar and a dark send slot,
 * on the polite and mercantile streets where the service actually runs. The
 * network existed only as prose and a map overlay before this.
 */
function bakePostPillar(variant: Variant): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 16;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const g = (x: string) => gradeHex(x, variant);
  ctx.fillStyle = g(PAL.soot1);
  ctx.fillRect(1, 13, 6, 2);
  ctx.fillStyle = g(PAL.verd1);
  ctx.fillRect(2, 4, 4, 9);
  ctx.fillStyle = g(PAL.verd2);
  ctx.fillRect(2, 4, 1, 9);
  ctx.fillStyle = g(PAL.brass2);
  ctx.fillRect(2, 3, 4, 1);
  ctx.fillStyle = g(PAL.verd1);
  ctx.fillRect(3, 1, 2, 2);
  ctx.fillStyle = g(PAL.soot0);
  ctx.fillRect(3, 6, 2, 1);
  hardenAlpha(ctx, c.width, c.height, variant);
  return c;
}

/** A stack of shipping crates, stencilled, for the wharves and yards. */
function bakeCrates(salt: number, variant: Variant): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 15; c.height = 13;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const g = (x: string) => gradeHex(x, variant);
  const wood = [PAL.wood2, PAL.thatch1][salt % 2];
  ctx.fillStyle = g(wood);
  ctx.fillRect(1, 6, 7, 7);
  ctx.fillRect(8, 8, 6, 5);
  ctx.fillRect(3, 1, 6, 5);
  ctx.fillStyle = g(shadeHex(wood, -0.2));
  ctx.fillRect(1, 6, 7, 1);
  ctx.fillRect(8, 8, 6, 1);
  ctx.fillRect(3, 1, 6, 1);
  ctx.fillRect(4, 6, 1, 7);
  ctx.fillRect(11, 9, 1, 4);
  // The stencil mark: one dark glyph, which is all a shipping mark is at 3px.
  ctx.fillStyle = g(PAL.soot1);
  ctx.fillRect(5, 3, 2, 2);
  hardenAlpha(ctx, c.width, c.height, variant);
  return c;
}

function bakeBench(variant: Variant): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 13;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const g = (x: string) => gradeHex(x, variant);
  ctx.fillStyle = g(PAL.wood2);
  ctx.fillRect(2, 4, 12, 2);
  ctx.fillRect(3, 7, 10, 2);
  ctx.fillStyle = g(PAL.wood0);
  ctx.fillRect(4, 9, 2, 4);
  ctx.fillRect(10, 9, 2, 4);
  hardenAlpha(ctx, c.width, c.height, variant);
  return c;
}

/**
 * Street furniture: lamps, bollards, troughs, advertising columns, carts, and
 * a few wharf cranes. Sparse, hashed from the cell, never on a building.
 */
export function buildStreetProps(
  district: District, seed: number, variant: Variant, wards: readonly Ward[] = [],
): Prop[] {
  const out: Prop[] = [];
  const lampGas = bakeLamp(variant, false);
  const lampArc = bakeLamp(variant, true);
  const bollardStone = bakeBollard(variant, true);
  const bollardIron = bakeBollard(variant, false);
  const trough = bakeTrough(variant);
  const columns = [0, 1, 2, 3].map((s) => bakeColumn(s, variant));
  const carts = [0, 1, 2].map((s) => bakeCart(s, variant));
  const crane = bakeCrane(variant);
  const barrels = bakeBarrels(variant);
  const coal = bakeCoal(variant);
  const urn = bakeUrn(variant);
  const display = bakeDisplay(variant);
  const toolBench = bakeToolBench(variant);
  const washTub = bakeWashTub(variant);
  const ropeCoil = bakeRopeCoil(variant);
  const bench = bakeBench(variant);
  const postPillar = bakePostPillar(variant);
  const crates = [0, 1].map((s) => bakeCrates(s, variant));

  for (let ty = 0; ty < district.height; ty++) {
    for (let tx = 0; tx < district.width; tx++) {
      if (!insideIsland(district, tx, ty)) continue;
      const k = cellKey(district, tx, ty);
      if (district.buildingId[k] >= 0) continue;
      const t = district.tile[k];
      const polite = district.polite[k] === 1;
      const ward = wards[district.wardId[k]]?.kind;
      const roll = mix(seed, 81, tx, ty) % 100;
      const jx = ((mix(seed, 82, tx, ty) >>> 5) % 7) - 3;
      const jy = ((mix(seed, 82, tx, ty) >>> 9) % 5) - 2;
      const push = (sprite: HTMLCanvasElement, ax: number, ay: number) => {
        out.push({
          sprite, ax, ay,
          wx: isoX(tx, ty) + jx,
          wy: isoY(tx, ty) + jy,
          depth: depthKey(tx, ty, LAYER_STRUCT),
        });
      };

      if (t === Tile.Street || t === Tile.Embankment || t === Tile.Bridge) {
        const lampChance = t === Tile.Embankment ? 24
          : ward === 'civic' || ward === 'merchant' ? 19
            : ward === 'garden' ? 17 : ward === 'courts' ? 10 : 14;
        if (roll < lampChance) {
          push(polite && t === Tile.Embankment ? lampArc : lampGas, 7, 25);
          continue;
        }
      }
      if (ward === 'merchant' && (t === Tile.Street || t === Tile.Square) && roll >= 20 && roll < 24) {
        push(display, 8, 11);
        continue;
      }
      if (ward === 'works' && (t === Tile.Street || t === Tile.Yard) && roll >= 20 && roll < 24) {
        push(toolBench, 8, 12);
        continue;
      }
      if (ward === 'courts' && (t === Tile.Street || t === Tile.Alley) && roll >= 20 && roll < 24) {
        push(washTub, 7, 10);
        continue;
      }
      if (ward === 'quayside' && (t === Tile.Wharf || t === Tile.Street) && roll >= 20 && roll < 24) {
        push(ropeCoil, 7, 9);
        continue;
      }
      if (ward === 'garden' && (t === Tile.Street || t === Tile.Embankment) && roll >= 20 && roll < 24) {
        push(bench, 8, 12);
        continue;
      }
      if (t === Tile.Street && roll >= 10 && roll < 13) {
        push(trough, 8, 9);
        continue;
      }
      if ((t === Tile.Street || t === Tile.Square) && roll >= 13
        && roll < (ward === 'civic' || ward === 'merchant' ? 19 : 16)) {
        push(columns[mix(seed, 83, tx, ty) % 4], 5, 19);
        continue;
      }
      if (t === Tile.Street && !polite && roll >= 16 && roll < 19) {
        push(carts[mix(seed, 84, tx, ty) % 3], 9, 13);
        continue;
      }
      if ((t === Tile.Embankment || t === Tile.Wharf) && roll >= 22 && roll < 32) {
        push(t === Tile.Embankment ? bollardStone : bollardIron, 3, 8);
        continue;
      }
      if (t === Tile.Wharf && roll < 6) {
        push(carts[mix(seed, 84, tx, ty) % 3], 9, 13);
        continue;
      }
      if (t === Tile.Wharf && roll >= 6 && roll < 9) {
        push(crane, 5, 27);
        continue;
      }
      if ((t === Tile.Street || t === Tile.Alley || t === Tile.Wharf)
        && (ward === 'quayside' || ward === 'courts') && roll >= 32 && roll < 38) {
        push(barrels, 7, 11);
        continue;
      }
      if ((t === Tile.Street || t === Tile.Yard) && ward === 'works' && roll >= 34 && roll < 40) {
        push(coal, 8, 9);
        continue;
      }
      if ((t === Tile.Street || t === Tile.Embankment) && ward === 'garden' && roll >= 36 && roll < 40) {
        push(urn, 5, 13);
        continue;
      }
      // The pneumatic post, above ground: a pillar every few polite streets.
      if (t === Tile.Street && (ward === 'civic' || ward === 'merchant' || ward === 'garden')
        && roll >= 40 && roll < 42) {
        push(postPillar, 4, 15);
        continue;
      }
      // Crate stacks where goods actually move: wharves, works yards, and the
      // streets outside the warehouses.
      if ((t === Tile.Wharf || t === Tile.Yard || t === Tile.Street)
        && (ward === 'quayside' || ward === 'works') && roll >= 42 && roll < 47) {
        push(crates[mix(seed, 85, tx, ty) % 2], 7, 12);
      }
    }
  }
  return out;
}

/**
 * Ground texture, drawn into the ground bitmap after the flat diamonds.
 *
 * Cobble gets speckle, grass gets tufts, water gets a ripple. All from an integer
 * hash of the cell, so it is stable and free.
 */
const GROUND: Record<number, string> = {
  [Tile.Street]: PAL.cobble1,
  [Tile.Square]: PAL.cobble2,
  [Tile.Embankment]: PAL.cobble2,
};

export function textureCell(
  ctx: CanvasRenderingContext2D, seed: number,
  tx: number, ty: number, tile: number, ox: number, oy: number, variant: Variant,
  polite = true,
): void {
  const cx = ox + isoX(tx, ty);
  const cy = oy + isoY(tx, ty);
  const h = mix(seed, 53, tx, ty);
  // Grade the texture colours to the same lighting variant as the diamond
  // underneath. Without this the ground is night-blue and the texture on top of
  // it is daylight tan, which at magnification reads as a halftone screen laid
  // over the city rather than as cobbles.
  const g = (c: string) => gradeHex(c, variant);

  // Solid pixels, never globalAlpha. A translucent speckle blends with whatever
  // is under it and produces a colour that is in no palette, which is precisely
  // the thing this pass exists to avoid.
  const speck = (n: number, colour: string) => {
    ctx.fillStyle = colour;
    for (let i = 0; i < n; i++) {
      const s = mix(h, 54, i);
      // Uniform inside the diamond: pick along the two diagonals rather than in
      // a box, or the corners of the cell get speckle that belongs to a neighbour.
      const a = ((s % 1000) / 1000) * 2 - 1;
      const b = (((s >>> 10) % 1000) / 1000) * 2 - 1;
      if (Math.abs(a) + Math.abs(b) > 1) continue;
      ctx.fillRect(Math.round(cx + a * (TILE_W / 2)), Math.round(cy + b * (TILE_H / 2)), 1, 1);
    }
  };

  /** Ordered-dither a colour across the cell diamond: courses for cobble, tufts
   *  for grass. This is the texture the reference has and we did not. */
  const course = (colour: string, amount: number) => {
    ctx.fillStyle = colour;
    for (let dy = -TILE_H / 2; dy < TILE_H / 2; dy++) {
      const half = (TILE_W / 2) * (1 - Math.abs(dy) / (TILE_H / 2));
      const y = Math.round(cy + dy);
      const row = BAYER[((y % 4) + 4) % 4];
      for (let dx = -Math.floor(half); dx < half; dx++) {
        const x = Math.round(cx + dx);
        if (row[((x % 4) + 4) % 4] < amount) ctx.fillRect(x, y, 1, 1);
      }
    }
  };

  switch (tile) {
    case Tile.Street:
    case Tile.Square:
    case Tile.Embankment:
      course(g(shadeHex(GROUND[tile] ?? PAL.cobble1, polite ? -0.09 : -0.16)), polite ? 4 : 6);
      speck(5, g(shadeHex(PAL.cobble2, 0.04)));
      speck(4, g(shadeHex(PAL.cobble0, -0.04)));
      if (!polite) speck(4, g(PAL.soot1));
      break;
    case Tile.Alley:
    case Tile.Court:
      course(g(shadeHex(PAL.soot1, 0.06)), 4);
      speck(5, g(PAL.cobble0));
      break;
    case Tile.Park:
    case Tile.Yard:
      course(g(PAL.grass0), 5);
      speck(6, g(PAL.grass3));
      speck(4, g(PAL.leaf2));
      break;
    case Tile.Wharf:
    case Tile.Plot:
      course(g(PAL.dirt0), 4);
      speck(4, g(PAL.dirt2));
      break;
    case Tile.Water:
      // Ripple bands across the channel rather than random speckle. Low contrast:
      // riv2 against riv1 is a 30-luma jump and read as polka dots.
      course(g(shadeHex(PAL.riv1, 0.07)), 3);
      speck(2, g(PAL.rivGlint));
      break;
    default:
      break;
  }
}
