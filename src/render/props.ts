// Trees, and the texture that stops the ground reading as flat colour.
//
// Both are cheap and both matter more than their cost suggests: a diamond of
// unbroken green looks like a placeholder, and a district with no trees on its
// fringe looks like it was stamped rather than grown.
import { TILE_W, TILE_H, isoX, isoY, depthKey, LAYER_STRUCT } from './iso';
import { PAL, shadeHex, gradeHex } from './palette';
import type { Variant } from './palette';
import { mix } from '../sim/rng';
import { fillEllipseHard, ditherPolyHard, hardenAlpha, BAYER } from './raster';
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
function bakeTree(salt: number, variant: Variant): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 20;
  c.height = 26;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;
  const lit = gradeHex(CANOPY[salt % CANOPY.length], variant);
  const shade = shadeHex(lit, -0.3);
  const dark = shadeHex(lit, -0.5);

  ctx.fillStyle = gradeHex(PAL.wood0, variant);
  ctx.fillRect(9, 16, 2, 8);

  const blobs: [number, number, number][] = [
    [10, 12, 7], [7, 9, 5], [13, 10, 5], [10, 7, 5],
  ];
  // Scanline ellipses: ctx.ellipse + fill antialiases the rim, and a soft-edged
  // tree against a hard-edged town is the one thing that gives the trick away.
  for (const [bx, by, r] of blobs) fillEllipseHard(ctx, bx, by + 1, r, r * 0.8, dark);
  for (const [bx, by, r] of blobs) fillEllipseHard(ctx, bx, by, r - 0.5, r * 0.75, shade);
  // Light from the west, upper left, as everywhere else.
  for (const [bx, by, r] of blobs) fillEllipseHard(ctx, bx - 1, by - 1, r - 2, r * 0.55, lit);
  // Break the canopy edge so it reads as leaves rather than as a blob.
  ditherPolyHard(ctx, [{x:2,y:2},{x:18,y:2},{x:18,y:17},{x:2,y:17}], shade, 3);
  hardenAlpha(ctx, c.width, c.height);
  return c;
}

/**
 * Scatter trees over grass and yards.
 *
 * Deterministic from (seed, cell), never Math.random, so a district looks the
 * same every time it is loaded and the screenshot goldens hold.
 */
export function buildProps(district: District, seed: number, variant: Variant): Prop[] {
  const cache = new Map<number, HTMLCanvasElement>();
  const out: Prop[] = [];
  for (let ty = 0; ty < district.height; ty++) {
    for (let tx = 0; tx < district.width; tx++) {
      if (!insideIsland(district, tx, ty)) continue;
      const k = cellKey(district, tx, ty);
      const t = district.tile[k];
      if (t !== Tile.Park && t !== Tile.Yard) continue;
      const roll = mix(seed, 51, tx, ty) % 100;
      // Parks are wooded, back yards are mostly not: a yard with a tree in every
      // one of them reads as an orchard, not as a town.
      const want = t === Tile.Park ? 46 : 16;
      if (roll >= want) continue;
      const salt = mix(seed, 52, tx, ty);
      const canopy = salt % CANOPY.length;
      let sprite = cache.get(canopy);
      if (!sprite) {
        sprite = bakeTree(canopy, variant);
        cache.set(canopy, sprite);
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
      course(g(shadeHex(GROUND[tile] ?? PAL.cobble1, -0.09)), 4);
      speck(5, g(shadeHex(PAL.cobble2, 0.04)));
      speck(4, g(shadeHex(PAL.cobble0, -0.04)));
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
