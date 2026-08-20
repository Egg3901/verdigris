// The compositor: ground bitmap, flattened building sprites, and the ID buffer.
//
// Each building is flattened ONCE into its own sprite. The alternative, which
// looks like the obvious optimisation, is to composite the whole world into one
// bitmap and blit it in horizontal strips with agents interleaved. That breaks:
// a tall building's upper facade occupies screen rows ABOVE an agent standing
// behind it, so the agent, drawn later, paints over the facade. Flatten per
// building and sort per object instead.
//
// The ID buffer is stamped in the same painter's order as the main pass, so a
// single getImageData at the cursor is a pixel-exact pick through chimneys,
// overhangs and archways. Analytic inverse-iso cannot do that: it returns the
// ground cell, which is the wrong building the moment the cursor is over a roof.
import type { City } from '../sim/city';
import type { Building } from '../sim/buildings';
import { DEFS } from '../sim/buildings';
import { cellKey, insideIsland } from '../sim/district';
import { Tile } from '../sim/types';
import type { TileCode } from '../sim/types';
import { PAL, shadeHex } from './palette';
import { TILE_W, TILE_H, HEAD_ROOM, isoX, isoY, worldBounds, depthKey, LAYER_STRUCT } from './iso';
import { boxBounds, drawIsoBox, drawIsoDiamond } from './fallback';

export interface StaticSprite {
  buildingId: number;
  sprite: HTMLCanvasElement;
  /** Offset from the sprite's top-left to the diamond centre of its origin tile. */
  ax: number;
  ay: number;
  /** World-pixel position of the origin tile's diamond centre. */
  wx: number;
  wy: number;
  depth: number;
}

export interface Scene {
  ground: HTMLCanvasElement;
  idBuffer: HTMLCanvasElement;
  idCtx: CanvasRenderingContext2D;
  statics: StaticSprite[];
  originX: number;
  originY: number;
}

const GROUND_COLOUR: Partial<Record<TileCode, string>> = {
  [Tile.Water]: PAL.riv1,
  [Tile.Wharf]: PAL.soot2,
  [Tile.Embankment]: PAL.stone2,
  [Tile.Street]: PAL.stone1,
  [Tile.Alley]: PAL.soot2,
  [Tile.Rail]: PAL.stone1,
  [Tile.Yard]: PAL.leaf1,
  [Tile.Court]: PAL.soot1,
  [Tile.Plot]: PAL.wood1,
  [Tile.Square]: PAL.stone3,
  [Tile.Park]: PAL.leaf1,
  [Tile.Bridge]: PAL.stone2,
};

interface Skin { top: string; left: string; right: string }

function skinFor(b: Building, grime: number): Skin {
  const soot = Math.min(0.42, grime / 620);
  const wall = (base: string) => shadeHex(base, -soot);
  switch (b.kind) {
    case 'townhall':
    case 'exchange':
    case 'bank':
    case 'postexchange':
      return { top: PAL.verd2, left: wall(PAL.stone4), right: wall(PAL.stone2) };
    case 'glasshouse':
      return { top: PAL.verd3, left: wall(PAL.stone3), right: wall(PAL.stone1) };
    case 'chapel':
    case 'school':
    case 'bathhouse':
    case 'dispensary':
      return { top: PAL.lead1, left: wall(PAL.stone3), right: wall(PAL.stone1) };
    case 'newspaper':
    case 'constabulary':
      return { top: PAL.slate1, left: wall(PAL.stone2), right: wall(PAL.stone1) };
    case 'mill':
    case 'foundry':
    case 'gasworks':
      return { top: PAL.soot1, left: wall(PAL.brick1), right: wall(PAL.brick0) };
    case 'workshop':
    case 'warehouse':
    case 'tramdepot':
    case 'pumphouse':
      return { top: PAL.lead0, left: wall(PAL.brick1), right: wall(PAL.brick0) };
    case 'wharfshed':
      return { top: PAL.wood0, left: wall(PAL.wood2), right: wall(PAL.wood1) };
    case 'mast':
      return { top: PAL.gold, left: PAL.verd2, right: PAL.verd1 };
    case 'villa':
      return { top: PAL.slate1, left: wall(PAL.stone4), right: wall(PAL.stone2) };
    case 'pub':
      return { top: PAL.slate2, left: wall(PAL.buntRed), right: wall(PAL.brick0) };
    case 'shop':
      return { top: PAL.slate1, left: wall(PAL.stone3), right: wall(PAL.stone1) };
    case 'tenement':
    case 'lodging':
      return { top: PAL.slate0, left: wall(PAL.brick1), right: wall(PAL.brick0) };
    case 'courtdwelling':
      return { top: PAL.soot0, left: wall(PAL.brick0), right: shadeHex(PAL.brick0, -0.25) };
    default:
      return { top: PAL.slate1, left: wall(PAL.stone2), right: wall(PAL.stone0) };
  }
}

function heightOf(b: Building): number {
  return Math.round(DEFS[b.kind].storeys * 9 + 3);
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

function ctxOf(c: HTMLCanvasElement, readFrequently = false): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', readFrequently ? { willReadFrequently: true } : undefined);
  if (!ctx) throw new Error('2d context unavailable');
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/** Build everything static. Called at startup and whenever a building's look
 *  changes (peek, fire, boarded windows), never per frame. */
export function buildScene(city: City): Scene {
  const b = worldBounds();
  const originX = -b.minX;
  const originY = -b.minY;

  const ground = makeCanvas(b.w, b.h);
  const gctx = ctxOf(ground);
  const d = city.district;

  // Ground diamonds, painter's order by tx + ty so overlapping half-tiles stack
  // the way the eye expects.
  for (let ty = 0; ty < d.height; ty++) {
    for (let tx = 0; tx < d.width; tx++) {
      if (!insideIsland(d, tx, ty)) continue;
      const k = cellKey(d, tx, ty);
      const tile = d.tile[k] as TileCode;
      if (tile === Tile.Void) continue;
      let colour = GROUND_COLOUR[tile] ?? PAL.soot2;
      if (tile !== Tile.Water) {
        // Soot rises toward the factory quarter. A district that visibly gets
        // dirtier as you walk east IS the theme, rendered.
        colour = shadeHex(colour, -Math.min(0.4, d.grime[k] / 700));
      }
      drawIsoDiamond(gctx, originX + isoX(tx, ty), originY + isoY(tx, ty), colour);
    }
  }

  const statics: StaticSprite[] = [];
  const idBuffer = makeCanvas(b.w, b.h);
  const idCtx = ctxOf(idBuffer, true);
  const scratch = makeCanvas(256, 256);
  const sctx = ctxOf(scratch);

  const ordered = city.buildings.slice().sort((p, q) => depthOf(p) - depthOf(q));
  for (const bld of ordered) {
    const s = flattenBuilding(city, bld);
    statics.push(s);
    stampId(idCtx, sctx, scratch, s, bld.id, originX, originY);
  }
  statics.sort((p, q) => p.depth - q.depth);

  return { ground, idBuffer, idCtx, statics, originX, originY };
}

function depthOf(b: Building): number {
  return depthKey(b.ox + b.w - 1, b.oy + b.d - 1, LAYER_STRUCT);
}

export function flattenBuilding(city: City, b: Building): StaticSprite {
  const h = heightOf(b);
  const bounds = boxBounds(b.w, b.d, h);
  const pad = 2;
  const w = bounds.maxX - bounds.minX + pad * 2;
  const ht = bounds.maxY - bounds.minY + pad * 2;
  const sprite = makeCanvas(w, ht);
  const ctx = ctxOf(sprite);
  const ax = -bounds.minX + pad;
  const ay = -bounds.minY + pad;

  const grime = city.district.grime[cellKey(city.district, b.ox, b.oy)];
  const skin = skinFor(b, grime);
  drawIsoBox(ctx, ax, ay, b.w, b.d, h, { ...skin, outline: PAL.ink });

  // A gold cornice on anything that has kept its facade up. This is the papering
  // over, and it is deliberately drawn on the same buildings whose fabric is worst.
  if (b.facade > 820) {
    ctx.fillStyle = PAL.gold;
    ctx.fillRect(Math.round(ax - (TILE_W * b.w) / 4), Math.round(ay - h + TILE_H / 2), Math.round((TILE_W * b.w) / 2), 1);
  }

  const sx = b.ox + b.w - 1;
  const sy = b.oy + b.d - 1;
  return {
    buildingId: b.id, sprite, ax, ay,
    wx: isoX(sx, sy), wy: isoY(sx, sy),
    depth: depthKey(sx, sy, LAYER_STRUCT),
  };
}

/**
 * Stamp a silhouette into the ID buffer, colour-encoding the building id.
 * source-in over the flattened sprite gives an exact silhouette, which is what
 * the binary-alpha palette contract exists to guarantee.
 */
function stampId(
  idCtx: CanvasRenderingContext2D, sctx: CanvasRenderingContext2D, scratch: HTMLCanvasElement,
  s: StaticSprite, id: number, originX: number, originY: number,
): void {
  const w = s.sprite.width;
  const h = s.sprite.height;
  if (scratch.width < w || scratch.height < h) {
    scratch.width = Math.max(scratch.width, w);
    scratch.height = Math.max(scratch.height, h);
    sctx.imageSmoothingEnabled = false;
  }
  sctx.clearRect(0, 0, scratch.width, scratch.height);
  sctx.globalCompositeOperation = 'source-over';
  sctx.drawImage(s.sprite, 0, 0);
  sctx.globalCompositeOperation = 'source-in';
  sctx.fillStyle = `rgb(${id & 255},${(id >> 8) & 255},1)`;
  sctx.fillRect(0, 0, w, h);
  sctx.globalCompositeOperation = 'source-over';
  idCtx.drawImage(
    scratch, 0, 0, w, h,
    Math.round(originX + s.wx - s.ax), Math.round(originY + s.wy - s.ay), w, h,
  );
}

/** Re-flatten one building after a state change. Cheap: a handful of blits. */
export function refreshBuilding(city: City, scene: Scene, id: number): void {
  const idx = scene.statics.findIndex((s) => s.buildingId === id);
  if (idx < 0) return;
  scene.statics[idx] = flattenBuilding(city, city.buildings[id]);
}

export { HEAD_ROOM, TILE_H };
