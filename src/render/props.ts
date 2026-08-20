// Trees, and the texture that stops the ground reading as flat colour.
//
// Both are cheap and both matter more than their cost suggests: a diamond of
// unbroken green looks like a placeholder, and a district with no trees on its
// fringe looks like it was stamped rather than grown.
import { TILE_W, TILE_H, isoX, isoY, depthKey, LAYER_STRUCT } from './iso';
import { PAL, shadeHex, gradeHex } from './palette';
import type { Variant } from './palette';
import { mix } from '../sim/rng';
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
  for (const [bx, by, r] of blobs) {
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.ellipse(bx, by + 1, r, r * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const [bx, by, r] of blobs) {
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.ellipse(bx, by, r - 0.5, r * 0.75, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Light from the west, upper left, as everywhere else.
  for (const [bx, by, r] of blobs) {
    ctx.fillStyle = lit;
    ctx.beginPath();
    ctx.ellipse(bx - 1, by - 1, r - 2, r * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
  }
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
export function textureCell(
  ctx: CanvasRenderingContext2D, seed: number,
  tx: number, ty: number, tile: number, ox: number, oy: number,
): void {
  const cx = ox + isoX(tx, ty);
  const cy = oy + isoY(tx, ty);
  const h = mix(seed, 53, tx, ty);

  const speck = (n: number, colour: string, alpha: number) => {
    ctx.fillStyle = colour;
    ctx.globalAlpha = alpha;
    for (let i = 0; i < n; i++) {
      const s = mix(h, 54, i);
      // Uniform inside the diamond: pick along the two diagonals rather than in
      // a box, or the corners of the cell get speckle that belongs to a neighbour.
      const a = ((s % 1000) / 1000) * 2 - 1;
      const b = (((s >>> 10) % 1000) / 1000) * 2 - 1;
      const t = Math.abs(a) + Math.abs(b);
      if (t > 1) continue;
      ctx.fillRect(Math.round(cx + a * (TILE_W / 2)), Math.round(cy + b * (TILE_H / 2)), 1, 1);
    }
    ctx.globalAlpha = 1;
  };

  switch (tile) {
    case Tile.Street:
    case Tile.Square:
    case Tile.Embankment:
      speck(9, PAL.cobble0, 0.35);
      speck(5, PAL.cobble2, 0.3);
      break;
    case Tile.Alley:
    case Tile.Court:
      speck(10, PAL.soot0, 0.4);
      break;
    case Tile.Park:
    case Tile.Yard:
      speck(8, PAL.grass3, 0.4);
      speck(5, PAL.grass0, 0.35);
      break;
    case Tile.Wharf:
    case Tile.Plot:
      speck(7, PAL.dirt0, 0.35);
      break;
    case Tile.Water:
      speck(4, PAL.riv2, 0.45);
      speck(2, PAL.rivGlint, 0.25);
      break;
    default:
      break;
  }
}
