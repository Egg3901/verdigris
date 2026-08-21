// The tile grid. Flat typed arrays, row-major. No objects per cell: 4096 cells
// times a handful of arrays stays compact, and it keeps iteration order fixed.
import { GRID_W, GRID_H, Tile, WALKABLE } from './types';
import type { TileCode, BuildingId, PlotId, NodeId } from './types';
import { fbm2, Stream } from './rng';

export interface District {
  width: number;
  height: number;
  tile: Uint8Array;
  plotId: Int16Array;
  buildingId: Int16Array;
  nodeId: Int16Array;
  streetId: Int16Array;
  blockId: Int16Array;
  /** 1 on the polite bank (embankment, balustrade, arc lamps), 0 on the working bank.
   *  One flag, and it does most of the class geography for free. */
  polite: Uint8Array;
  /** 0..255 soot, rising toward the factory quarter. The theme, rendered. */
  grime: Uint8Array;
  /** Seeded coastline mask. The grid is storage; this is the actual island. */
  land: Uint8Array;
}

export function newDistrict(seed = 0): District {
  const n = GRID_W * GRID_H;
  const d: District = {
    width: GRID_W,
    height: GRID_H,
    tile: new Uint8Array(n),
    plotId: new Int16Array(n),
    buildingId: new Int16Array(n),
    nodeId: new Int16Array(n),
    streetId: new Int16Array(n),
    blockId: new Int16Array(n),
    polite: new Uint8Array(n),
    grime: new Uint8Array(n),
    land: new Uint8Array(n),
  };
  d.plotId.fill(-1);
  d.buildingId.fill(-1);
  d.nodeId.fill(-1);
  d.streetId.fill(-1);
  d.blockId.fill(-1);
  const cx = (GRID_W - 1) / 2;
  const cy = (GRID_H - 1) / 2;
  const r = ((GRID_W - 1) / 2) * ISLAND_R;
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const dx = Math.abs(x - cx);
      const dy = Math.abs(y - cy);
      // Broad seeded noise cuts coves and pushes out headlands by up to two
      // cells. Low frequency keeps the silhouette surveyed rather than ragged.
      const coast = (fbm2(seed, Stream.Gen, x * 0.075, y * 0.075, 3) - 0.5) * 4.5;
      if (Math.max(dx, dy) + 0.14 * Math.min(dx, dy) <= r + 1.2 + coast) {
        d.land[y * GRID_W + x] = 1;
      }
    }
  }
  return d;
}

export function cellKey(d: District, x: number, y: number): number {
  return y * d.width + x;
}

export function inBounds(d: District, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < d.width && y < d.height;
}

export function tileAt(d: District, x: number, y: number): TileCode {
  if (!inBounds(d, x, y)) return Tile.Void;
  return d.tile[cellKey(d, x, y)] as TileCode;
}

export function setTile(d: District, x: number, y: number, t: TileCode): void {
  if (inBounds(d, x, y)) d.tile[cellKey(d, x, y)] = t;
}

export function buildingAtCell(d: District, x: number, y: number): BuildingId {
  if (!inBounds(d, x, y)) return -1;
  return d.buildingId[cellKey(d, x, y)];
}

export function plotAtCell(d: District, x: number, y: number): PlotId {
  if (!inBounds(d, x, y)) return -1;
  return d.plotId[cellKey(d, x, y)];
}

export function nodeAtCell(d: District, x: number, y: number): NodeId {
  if (!inBounds(d, x, y)) return -1;
  return d.nodeId[cellKey(d, x, y)];
}

const WALK_SET = new Uint8Array(16);
for (const t of WALKABLE) WALK_SET[t] = 1;

export function isWalkable(d: District, x: number, y: number): boolean {
  if (!inBounds(d, x, y)) return false;
  return WALK_SET[d.tile[cellKey(d, x, y)]] === 1;
}

/**
 * The district as a diamond on screen.
 *
 * THE METRIC IS COUNTERINTUITIVE AND I HAD IT BACKWARDS. This used to test
 * `dx + dy <= r`, an L1 ball, on the reasoning that L1 draws a diamond. It does,
 * in TILE space, and the isometric projection then turns that diamond into an
 * axis-aligned RECTANGLE. Proof: with u = x-cx and v = y-cy, screen X is
 * proportional to (u-v) and screen Y to (u+v); setting a = u-v and b = u+v gives
 * |u|+|v| = max(|a|,|b|), so `|u|+|v| <= r` is exactly `|a| <= r AND |b| <= r`,
 * which is a box. Measured: the old island filled 100% of its bounding box.
 *
 * The projection swaps the two metrics, so an L-infinity square in tile space is
 * what lands as a diamond on screen. Measured: 56% bounding-box fill, and the
 * silhouette the reference actually has.
 *
 * The 0.707 keeps the projected silhouette diamond-like while leaving room for
 * seeded coves and headlands at the edge of the storage grid.
 */
const ISLAND_R = 0.707;

export function insideIsland(d: District, x: number, y: number): boolean {
  return inBounds(d, x, y) && d.land[cellKey(d, x, y)] === 1;
}

/** Tile-space extent of the island. The renderer frames on this, not on the grid,
 *  so coastline variation does not leave the district floating in a frame of void. */
export function islandTileBounds(): { min: number; max: number } {
  const c = (GRID_W - 1) / 2;
  const r = ((GRID_W - 1) / 2) * ISLAND_R + 3.5;
  return { min: Math.floor(c - r), max: Math.ceil(c + r) };
}

export function forEachIslandCell(d: District, fn: (x: number, y: number, k: number) => void): void {
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      if (insideIsland(d, x, y)) fn(x, y, y * d.width + x);
    }
  }
}

const N4X = [1, -1, 0, 0];
const N4Y = [0, 0, 1, -1];

/** Fixed iteration order (E, W, S, N). Never change it: the worldgen depends on it. */
export function neighbours4(x: number, y: number, i: number): { x: number; y: number } {
  return { x: x + N4X[i], y: y + N4Y[i] };
}

export function countIslandCells(d: District): number {
  let n = 0;
  forEachIslandCell(d, () => { n++; });
  return n;
}

/** Debug dump. Used by the worldgen tests so the district is eyeballable in a terminal
 *  long before there is a renderer. */
const GLYPH: Record<number, string> = {
  [Tile.Void]: ' ',
  [Tile.Water]: '~',
  [Tile.Wharf]: '=',
  [Tile.Embankment]: '"',
  [Tile.Street]: '.',
  [Tile.Alley]: ',',
  [Tile.Rail]: '+',
  [Tile.Yard]: 'o',
  [Tile.Court]: 'c',
  [Tile.Plot]: '#',
  [Tile.Square]: 'S',
  [Tile.Park]: 'p',
  [Tile.Bridge]: 'B',
};

export function dumpDistrict(d: District): string {
  const rows: string[] = [];
  for (let y = 0; y < d.height; y++) {
    let row = '';
    for (let x = 0; x < d.width; x++) row += GLYPH[d.tile[cellKey(d, x, y)]] ?? '?';
    rows.push(row);
  }
  return rows.join('\n');
}
