// Trees, and the texture that stops the ground reading as flat colour.
//
// Both are cheap and both matter more than their cost suggests: a diamond of
// unbroken green looks like a placeholder, and a district with no trees on its
// fringe looks like it was stamped rather than grown.
import { TILE_W, TILE_H, isoX, isoY, depthKey, LAYER_STRUCT } from './iso';
import { PAL, shadeHex, gradeHex } from './palette';
import type { Variant } from './palette';
import { mix } from '../sim/rng';
import { fillEllipseHard, ditherPolyHard, hardenAlpha, fillPolyHard, lineHard, BAYER } from './raster';
import { Tile } from '../sim/types';
import type { District } from '../sim/district';
import { cellKey, insideIsland } from '../sim/district';

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
  c.width = 26; c.height = 24;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const g = (x: string) => gradeHex(x, variant);
  const cloth = [PAL.buntRed, PAL.buntBlue, PAL.verd1, PAL.ochre1][salt % 4];
  // Trestle, then a canopy over it, then the poles.
  fillPolyHard(ctx, [{x:13,y:12},{x:24,y:17},{x:13,y:22},{x:2,y:17}], g(PAL.wood1));
  fillPolyHard(ctx, [{x:13,y:2},{x:25,y:8},{x:13,y:14},{x:1,y:8}], g(cloth));
  ditherPolyHard(ctx, [{x:13,y:2},{x:25,y:8},{x:13,y:14},{x:1,y:8}], g(shadeHex(cloth, 0.25)), 7);
  ctx.fillStyle = g(PAL.wood0);
  ctx.fillRect(2, 8, 1, 9);
  ctx.fillRect(24, 8, 1, 9);
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
        sprite, ax: 13, ay: 22,
        wx: isoX(x, y), wy: isoY(x, y),
        depth: depthKey(x, y, LAYER_STRUCT),
      });
    }
  }
  return out;
}

export function buildProps(district: District, seed: number, variant: Variant): Prop[] {
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
      const want = t === Tile.Park ? 46 : 16;
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
  const glass = variant === 'day' ? g(PAL.darkWindow) : (arc ? PAL.arc1 : PAL.gas2);
  const frame = g(arc ? PAL.stone1 : PAL.brassInk);
  ctx.fillStyle = frame;
  ctx.fillRect(2, 4, 5, 6);
  ctx.fillStyle = glass;
  ctx.fillRect(3, 5, 3, 4);
  if (variant !== 'day') {
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

/**
 * Street furniture: lamps, bollards, troughs, advertising columns, carts, and
 * a few wharf cranes. Sparse, hashed from the cell, never on a building.
 */
export function buildStreetProps(
  district: District, seed: number, variant: Variant,
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

  for (let ty = 0; ty < district.height; ty++) {
    for (let tx = 0; tx < district.width; tx++) {
      if (!insideIsland(district, tx, ty)) continue;
      const k = cellKey(district, tx, ty);
      if (district.buildingId[k] >= 0) continue;
      const t = district.tile[k];
      const polite = district.polite[k] === 1;
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
        if (roll < (t === Tile.Embankment ? 24 : 14)) {
          push(polite && t === Tile.Embankment ? lampArc : lampGas, 7, 25);
          continue;
        }
      }
      if (t === Tile.Street && roll >= 10 && roll < 13) {
        push(trough, 8, 9);
        continue;
      }
      if ((t === Tile.Street || t === Tile.Square) && roll >= 13 && roll < 16) {
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
