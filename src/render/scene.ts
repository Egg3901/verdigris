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
import { PAL, shadeHex, hexToRgb, rgbToHex } from './palette';
import { TILE_H, HEAD_ROOM, isoX, isoY, worldBounds, depthKey, LAYER_STRUCT } from './iso';
import { drawIsoDiamond } from './fallback';
import { drawHouse, houseBounds } from './house';
import type { HouseSpec, HouseSkin, RoofShape } from './house';
import { mix } from '../sim/rng';
import { buildProps, textureCell } from './props';
import type { Prop } from './props';

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
  props: Prop[];
  idBuffer: HTMLCanvasElement;
  idCtx: CanvasRenderingContext2D;
  statics: StaticSprite[];
  originX: number;
  originY: number;
}

const GROUND_COLOUR: Partial<Record<TileCode, string>> = {
  [Tile.Water]: PAL.riv1,
  [Tile.Wharf]: PAL.dirt1,
  [Tile.Embankment]: PAL.cobble2,
  [Tile.Street]: PAL.cobble1,
  [Tile.Alley]: PAL.cobble0,
  [Tile.Rail]: PAL.cobble1,
  [Tile.Yard]: PAL.grass1,
  [Tile.Court]: PAL.dirt0,
  [Tile.Plot]: PAL.dirt1,
  [Tile.Square]: PAL.cobble2,
  [Tile.Park]: PAL.grass2,
  [Tile.Bridge]: PAL.wood2,
};

// Roof and wall families. The district's social geography is a colour scheme:
// terracotta and timber on the working bank, slate and cream on the polite one,
// verdigris copper on anything civic. You should be able to tell which side of
// the river you are looking at with the sound off.
interface Family {
  roof: [string, string, string];
  wall: [string, string];
  shape: RoofShape;
  trim?: string;
}

const FAMILY: Partial<Record<string, Family>> = {
  townhall: { roof: [PAL.verd2, PAL.verd1, PAL.verd3], wall: [PAL.stone4, PAL.stone2], shape: 'hip', trim: PAL.gold },
  exchange: { roof: [PAL.verd2, PAL.verd1, PAL.verd3], wall: [PAL.stone4, PAL.stone2], shape: 'hip', trim: PAL.gold },
  bank: { roof: [PAL.verd1, PAL.verd0, PAL.verd2], wall: [PAL.stone4, PAL.stone2], shape: 'hip', trim: PAL.gold },
  postexchange: { roof: [PAL.verd2, PAL.verd1, PAL.verd3], wall: [PAL.stone3, PAL.stone1], shape: 'hip', trim: PAL.brass2 },
  glasshouse: { roof: [PAL.verd3, PAL.verd2, PAL.rivGlint], wall: [PAL.stone3, PAL.stone1], shape: 'gable', trim: PAL.verd3 },
  chapel: { roof: [PAL.slate2, PAL.slate1, PAL.arc0], wall: [PAL.stone3, PAL.stone1], shape: 'gable' },
  school: { roof: [PAL.slate2, PAL.slate1, PAL.arc0], wall: [PAL.stone2, PAL.stone1], shape: 'hip' },
  bathhouse: { roof: [PAL.verd1, PAL.verd0, PAL.verd2], wall: [PAL.stone3, PAL.stone1], shape: 'hip' },
  dispensary: { roof: [PAL.slate2, PAL.slate1, PAL.arc0], wall: [PAL.cream2, PAL.cream1], shape: 'gable' },
  newspaper: { roof: [PAL.slate2, PAL.slate1, PAL.slate2], wall: [PAL.cream1, PAL.cream0], shape: 'gable' },
  constabulary: { roof: [PAL.slate2, PAL.slate1, PAL.arc0], wall: [PAL.stone2, PAL.stone1], shape: 'gable' },
  mast: { roof: [PAL.gold, PAL.brass2, PAL.gold], wall: [PAL.verd2, PAL.verd1], shape: 'pyramid', trim: PAL.gold },

  mill: { roof: [PAL.soot3, PAL.soot2, PAL.slate2], wall: [PAL.brick1, PAL.brick0], shape: 'gable' },
  foundry: { roof: [PAL.soot3, PAL.soot2, PAL.slate2], wall: [PAL.brick2, PAL.brick1], shape: 'gable' },
  gasworks: { roof: [PAL.soot2, PAL.soot1, PAL.soot3], wall: [PAL.brick1, PAL.brick0], shape: 'flat' },
  tramdepot: { roof: [PAL.slate2, PAL.slate1, PAL.slate2], wall: [PAL.brick1, PAL.brick0], shape: 'gable' },
  pumphouse: { roof: [PAL.tileRed2, PAL.tileRed1, PAL.tileRed3], wall: [PAL.brick1, PAL.brick0], shape: 'hip' },
  workshop: { roof: [PAL.slate2, PAL.slate1, PAL.slate2], wall: [PAL.brick2, PAL.brick1], shape: 'gable' },
  warehouse: { roof: [PAL.thatch1, PAL.thatch0, PAL.thatch2], wall: [PAL.wood2, PAL.wood1], shape: 'gable' },
  wharfshed: { roof: [PAL.thatch2, PAL.thatch1, PAL.thatch2], wall: [PAL.wood2, PAL.wood1], shape: 'gable' },

  pub: { roof: [PAL.tileRed2, PAL.tileRed1, PAL.tileRed3], wall: [PAL.buntRed, PAL.brick1], shape: 'gable', trim: PAL.brass2 },
  shop: { roof: [PAL.tileRed2, PAL.tileRed1, PAL.tileRed3], wall: [PAL.cream2, PAL.cream1], shape: 'gable', trim: PAL.brass1 },
  villa: { roof: [PAL.slate2, PAL.slate1, PAL.arc0], wall: [PAL.cream3, PAL.cream1], shape: 'hip', trim: PAL.brass2 },
  terrace: { roof: [PAL.tileRed2, PAL.tileRed1, PAL.tileRed3], wall: [PAL.cream2, PAL.cream1], shape: 'gable' },
  tenement: { roof: [PAL.slate1, PAL.slate0, PAL.slate2], wall: [PAL.brick2, PAL.brick1], shape: 'gable' },
  lodging: { roof: [PAL.thatch1, PAL.thatch0, PAL.thatch2], wall: [PAL.ochre1, PAL.ochre0], shape: 'gable' },
  courtdwelling: { roof: [PAL.soot3, PAL.soot2, PAL.soot3], wall: [PAL.brick1, PAL.brick0], shape: 'gable' },
};

const DEFAULT_FAMILY: Family = {
  roof: [PAL.tileRed2, PAL.tileRed1, PAL.tileRed3],
  wall: [PAL.cream2, PAL.cream1],
  shape: 'gable',
};

/** Raise a colour until its luminance clears a floor, keeping its hue. */
function liftToFloor(hex: string, floor: number): string {
  const [r, g, b] = hexToRgb(hex);
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  if (lum >= floor) return hex;
  const k = floor / Math.max(1, lum);
  return rgbToHex(r * k, g * k, b * k);
}

// Five wall washes and four roof washes, picked per building. This is where the
// variety comes from: without it two hundred buildings read as twelve buildings
// repeated, however good the geometry is.
const WALL_WASH = [0, -0.1, 0.1, -0.05, 0.06];
const ROOF_WASH = [0, -0.09, 0.08, -0.04];

/**
 * Pick from a table using a 32-bit hash.
 *
 * mix() returns an UNSIGNED 32-bit value, but `>>` is a SIGNED shift: for any
 * hash at or above 2^31, `salt >> 3` is negative, `% n` stays negative, and the
 * lookup returns undefined. Downstream that became NaN colour channels and then
 * black buildings. Always shift these with `>>>`, and take the index through
 * here so the mistake cannot be made twice.
 */
function pickFrom<T>(table: readonly T[], salt: number, shift = 0): T {
  const i = (salt >>> shift) % table.length;
  return table[i];
}

function specFor(city: City, b: Building, grime: number): HouseSpec {
  const fam = FAMILY[b.kind] ?? DEFAULT_FAMILY;
  const def = DEFS[b.kind];
  const salt = mix(city.seed, 41, b.id);
  const soot = Math.min(0.34, grime / 760);

  const wallWash = pickFrom(WALL_WASH, salt);
  const roofWash = pickFrom(ROOF_WASH, salt, 3);
  // Soot lands on WALLS. Shading roofs by grime as well drove a third of the
  // district to near-black, and a town seen from above is mostly roof: lose the
  // roof colour and you lose the town.
  const wash = (c: string, k: number) => shadeHex(shadeHex(c, k), -soot);
  // Plus a hard luminance floor on every roof. Family colours, washes, soot and
  // neglect all stack, and any two of them together can push a roof to black. A
  // black roof is a hole in the town, and enough of them and the district reads
  // as a burnt-out lot rather than a working city.
  const roofWashOf = (c: string, k: number) => liftToFloor(shadeHex(c, k - soot * 0.25), 62);

  // A neglected building loses its highlights; a kept-up one keeps its trim.
  const tired = b.fabric < 420 ? -0.08 : 0;

  const skin: HouseSkin = {
    wallLit: wash(fam.wall[0], wallWash + tired),
    wallShade: wash(fam.wall[1], wallWash + tired - 0.06),
    // Gable ends carry the same floor as the roof, for the same reason: they are
    // large and they face the camera.
    gableLit: liftToFloor(wash(fam.wall[0], wallWash + tired - 0.04), 58),
    gableShade: liftToFloor(wash(fam.wall[1], wallWash + tired - 0.1), 48),
    roofLit: roofWashOf(fam.roof[0], roofWash),
    roofShade: roofWashOf(fam.roof[1], roofWash),
    roofRidge: roofWashOf(fam.roof[2], roofWash + 0.1),
    trim: b.facade > 780 ? fam.trim : undefined,
    window: PAL.darkWindow,
    outline: PAL.soot0,
  };

  const storeys = def.storeys;
  const wallH = Math.max(7, Math.round(storeys * 8 + 2));
  const roofH = fam.shape === 'flat' ? 3
    : fam.shape === 'pyramid' ? Math.round(14 + storeys * 3)
      : Math.round(5 + Math.min(b.w, b.d) * 2 + (salt % 3));

  return {
    w: b.w, d: b.d, wallH, roofH,
    shape: fam.shape,
    chimneys: fam.shape === 'flat' || fam.shape === 'pyramid' ? 0
      : b.kind === 'mill' || b.kind === 'foundry' ? 2
        : 1 + ((salt >>> 6) % 2),
    windowRows: Math.max(1, Math.min(3, storeys - 1)),
    skin,
    ridgeAlongX: b.w === b.d ? (salt & 1) === 1 : b.w > b.d,
  };
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
      textureCell(gctx, city.seed, tx, ty, tile, originX, originY);
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

  return { ground, props: buildProps(d, city.seed), idBuffer, idCtx, statics, originX, originY };
}

function depthOf(b: Building): number {
  return depthKey(b.ox + b.w - 1, b.oy + b.d - 1, LAYER_STRUCT);
}

export function debugSkin(city: City, b: Building) {
  return specFor(city, b, city.district.grime[cellKey(city.district, b.ox, b.oy)]);
}

export function flattenBuilding(city: City, b: Building): StaticSprite {
  const grime = city.district.grime[cellKey(city.district, b.ox, b.oy)];
  const spec = specFor(city, b, grime);
  const bounds = houseBounds(spec);
  const pad = 2;
  const w = bounds.maxX - bounds.minX + pad * 2;
  const ht = bounds.maxY - bounds.minY + pad * 2;
  const sprite = makeCanvas(w, ht);
  const ctx = ctxOf(sprite);
  const ax = -bounds.minX + pad;
  const ay = -bounds.minY + pad;

  drawHouse(ctx, ax, ay, spec);

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
