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
import { PAL, shadeHex, hexToRgb, rgbToHex, gradeHex, variantFor } from './palette';
import type { Variant } from './palette';
import { minuteOfDay } from '../sim/clock';
import { TILE_W, TILE_H, HEAD_ROOM, isoX, isoY, worldBounds, depthKey, LAYER_STRUCT } from './iso';
import { serviceAt } from '../sim/networks';
import { drawIsoDiamond } from './fallback';
import { drawHouse, houseBounds } from './house';
import { hardenAlpha, ditherPolyHard, lineHard } from './raster';
import type { HouseSpec, HouseSkin, RoofShape } from './house';
import { mix } from '../sim/rng';
import { buildProps, buildSquareProps, textureCell } from './props';
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
  /** Which lighting variant this scene was baked at. The compositor rebakes when
   *  it changes, which is a handful of times a day, never per frame. */
  variant: Variant;
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
  /** A glazed ground floor and an awning. */
  shop?: boolean;
  /** Dormers on the near slope, for the deeper roofs. */
  dormers?: number;
}

const FAMILY: Partial<Record<string, Family>> = {
  townhall: { roof: [PAL.verd2, PAL.verd1, PAL.verd3], wall: [PAL.stone4, PAL.stone2], shape: 'hip', trim: PAL.gold, dormers: 2 },
  exchange: { roof: [PAL.verd2, PAL.verd1, PAL.verd3], wall: [PAL.stone4, PAL.stone2], shape: 'hip', trim: PAL.gold, shop: true },
  bank: { roof: [PAL.verd1, PAL.verd0, PAL.verd2], wall: [PAL.stone4, PAL.stone2], shape: 'hip', trim: PAL.gold, shop: true },
  postexchange: { roof: [PAL.verd2, PAL.verd1, PAL.verd3], wall: [PAL.stone3, PAL.stone1], shape: 'hip', trim: PAL.brass2, shop: true },
  glasshouse: { roof: [PAL.verd3, PAL.verd2, PAL.rivGlint], wall: [PAL.stone3, PAL.stone1], shape: 'gable', trim: PAL.verd3 },
  chapel: { roof: [PAL.slate2, PAL.slate1, PAL.arc0], wall: [PAL.stone3, PAL.stone1], shape: 'gable' },
  school: { roof: [PAL.slate2, PAL.slate1, PAL.arc0], wall: [PAL.stone2, PAL.stone1], shape: 'hip', dormers: 2 },
  bathhouse: { roof: [PAL.verd1, PAL.verd0, PAL.verd2], wall: [PAL.stone3, PAL.stone1], shape: 'hip' },
  dispensary: { roof: [PAL.slate2, PAL.slate1, PAL.arc0], wall: [PAL.cream2, PAL.cream1], shape: 'gable', shop: true },
  newspaper: { roof: [PAL.slate2, PAL.slate1, PAL.slate2], wall: [PAL.cream1, PAL.cream0], shape: 'gable', shop: true },
  constabulary: { roof: [PAL.slate2, PAL.slate1, PAL.arc0], wall: [PAL.stone2, PAL.stone1], shape: 'gable' },
  // Was a solid gold pyramid, which at zoom 1 was by far the loudest thing on the
  // map and read as a circus tent. Gold is under half a percent of pixels by
  // design; spending the entire budget on one roof wastes it.
  mast: { roof: [PAL.verd2, PAL.verd1, PAL.gold], wall: [PAL.verd2, PAL.verd1], shape: 'pyramid', trim: PAL.gold },

  mill: { roof: [PAL.soot3, PAL.soot2, PAL.slate2], wall: [PAL.brick1, PAL.brick0], shape: 'gable' },
  foundry: { roof: [PAL.soot3, PAL.soot2, PAL.slate2], wall: [PAL.brick2, PAL.brick1], shape: 'gable' },
  gasworks: { roof: [PAL.soot2, PAL.soot1, PAL.soot3], wall: [PAL.brick1, PAL.brick0], shape: 'flat' },
  tramdepot: { roof: [PAL.slate2, PAL.slate1, PAL.slate2], wall: [PAL.brick1, PAL.brick0], shape: 'gable' },
  pumphouse: { roof: [PAL.tileRed2, PAL.tileRed1, PAL.tileRed3], wall: [PAL.brick1, PAL.brick0], shape: 'hip' },
  workshop: { roof: [PAL.slate2, PAL.slate1, PAL.slate2], wall: [PAL.brick2, PAL.brick1], shape: 'gable' },
  // Same defect: thatch on timber was 14 luma apart.
  warehouse: { roof: [PAL.soot3, PAL.soot2, PAL.slate2], wall: [PAL.wood2, PAL.wood1], shape: 'gable' },
  wharfshed: { roof: [PAL.thatch2, PAL.thatch1, PAL.thatch2], wall: [PAL.wood2, PAL.wood1], shape: 'gable' },

  pub: { roof: [PAL.tileRed2, PAL.tileRed1, PAL.tileRed3], wall: [PAL.buntRed, PAL.brick1], shape: 'gable', trim: PAL.brass2, shop: true, dormers: 1 },
  shop: { roof: [PAL.tileRed2, PAL.tileRed1, PAL.tileRed3], wall: [PAL.cream2, PAL.cream1], shape: 'gable', trim: PAL.brass1, shop: true },
  villa: { roof: [PAL.slate2, PAL.slate1, PAL.arc0], wall: [PAL.cream3, PAL.cream1], shape: 'hip', trim: PAL.brass2, dormers: 2 },
  terrace: { roof: [PAL.tileRed2, PAL.tileRed1, PAL.tileRed3], wall: [PAL.cream2, PAL.cream1], shape: 'gable' },
  tenement: { roof: [PAL.slate1, PAL.slate0, PAL.slate2], wall: [PAL.brick2, PAL.brick1], shape: 'gable', dormers: 2 },
  // Was thatch1 on ochre1: 16 luma apart, so roof and wall were the same colour
  // across 62 buildings. Lead slate against ochre is 60 apart and the row reads.
  lodging: { roof: [PAL.slate2, PAL.slate1, PAL.arc0], wall: [PAL.ochre1, PAL.ochre0], shape: 'gable', dormers: 1 },
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
  // Snap the lift to the same ladder: an arbitrary rescale factor would put the
  // result back off-palette, which is the thing this whole pass is about.
  const k = Math.round((floor / Math.max(1, lum)) / 0.1) * 0.1;
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

/** Buildings fronting the civic square. Bunting hangs here and nowhere else,
 *  because the point of the flags is that they are where they will be seen. */
function nearSquare(city: City, b: Building): boolean {
  const d = city.district;
  for (const k of b.cells) {
    const x = k % d.width;
    const y = (k - x) / d.width;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (x + dx < 0 || y + dy < 0 || x + dx >= d.width || y + dy >= d.height) continue;
      if (d.tile[cellKey(d, x + dx, y + dy)] === Tile.Square) return true;
    }
  }
  return false;
}

function specFor(city: City, b: Building, grime: number, variant: Variant): HouseSpec {
  const fam = FAMILY[b.kind] ?? DEFAULT_FAMILY;
  const def = DEFS[b.kind];
  const salt = mix(city.seed, 41, b.id);
  // Soot on the same ladder as everything else, in five steps rather than 255.
  const soot = Math.round(Math.min(0.34, grime / 760) / 0.06) * 0.06;

  const wallWash = pickFrom(WALL_WASH, salt);
  const roofWash = pickFrom(ROOF_WASH, salt, 3);
  // Soot lands on WALLS. Shading roofs by grime as well drove a third of the
  // district to near-black, and a town seen from above is mostly roof: lose the
  // roof colour and you lose the town.
  const wash = (c: string, k: number) => gradeHex(shadeHex(shadeHex(c, k), -soot), variant);
  // Plus a hard luminance floor on every roof. Family colours, washes, soot and
  // neglect all stack, and any two of them together can push a roof to black. A
  // black roof is a hole in the town, and enough of them and the district reads
  // as a burnt-out lot rather than a working city.
  const roofWashOf = (c: string, k: number) => gradeHex(liftToFloor(shadeHex(c, k - soot * 0.25), 62), variant);

  // A neglected building loses its highlights; a kept-up one keeps its trim.
  const tired = b.fabric < 420 ? -0.08 : 0;

  const skin: HouseSkin = {
    wallLit: wash(fam.wall[0], wallWash + tired),
    wallShade: wash(fam.wall[1], wallWash + tired - 0.06),
    // Gable ends carry the same floor as the roof, for the same reason: they are
    // large and they face the camera.
    gableLit: gradeHex(liftToFloor(shadeHex(shadeHex(fam.wall[0], wallWash + tired - 0.04), -soot), 58), variant),
    gableShade: gradeHex(liftToFloor(shadeHex(shadeHex(fam.wall[1], wallWash + tired - 0.1), -soot), 48), variant),
    roofLit: roofWashOf(fam.roof[0], roofWash),
    roofShade: roofWashOf(fam.roof[1], roofWash),
    roofRidge: roofWashOf(fam.roof[2], roofWash + 0.1),
    trim: b.facade > 780 ? gradeHex(fam.trim ?? PAL.gold, variant, true) : undefined,
    // Chimneys are brick or soot, never the wall colour, and they carry the same
    // grime the walls do.
    chimney: gradeHex(shadeHex(soot > 0.18 ? PAL.soot2 : PAL.brick1, -soot * 0.5), variant),
    // Lit windows at dusk and after. A gaslight-era city with no lit window in it
    // was the single most conspicuous absence in the build: variantFor and the
    // palette entries both existed and neither had ever been called.
    window: variant === 'day' ? gradeHex(PAL.darkWindow, variant) : PAL.litWindow,
    windowLit: variant !== 'day',
    outline: gradeHex(PAL.soot0, variant),
  };

  const storeys = def.storeys;
  const wallH = Math.max(7, Math.round(storeys * 8 + 2));
  // A town seen from above is a field of ROOFS. At 0.3 of the wall height the
  // roofs were small hats on tall walls, and the tan wall hue dominated the
  // frame. Around 0.65 is where the silhouette starts carrying the image.
  const roofH = fam.shape === 'flat' ? 3
    : fam.shape === 'pyramid' ? Math.round(16 + storeys * 3)
      : Math.max(8, Math.round(wallH * 0.65 + (salt % 3)));

  const AWNINGS = [PAL.buntRed, PAL.buntBlue, PAL.verd1, PAL.brick1, PAL.ochre0];

  return {
    w: b.w, d: b.d, wallH, roofH,
    shape: fam.shape,
    salt: salt >>> 11,
    shopfront: fam.shop === true && b.w * b.d >= 1,
    sign: fam.shop === true,
    awning: gradeHex(pickFrom(AWNINGS, salt, 7), variant),
    // Dormers need a slope deep enough to sit one on.
    dormers: fam.dormers && roofH >= 12 ? fam.dormers : 0,
    // The rot, on the building rather than only in the prose. A building whose
    // fabric has genuinely failed gets its windows boarded.
    boarded: b.fabric < 260,
    // The flags the player paid for, on whatever fronts the square.
    bunting: city.buntingUntil > city.tick && nearSquare(city, b),
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
export function buildScene(city: City, variant: Variant = variantFor(minuteOfDay(city.tick))): Scene {
  const b = worldBounds();
  const originX = -b.minX;
  const originY = -b.minY;

  const ground = makeCanvas(b.w, b.h);
  const gctx = ctxOf(ground);
  const d = city.district;

  // Distance from each water cell to the nearest bank, so the channel can be
  // shaded across its width. A single flat value over 13% of the frame was the
  // least worked surface in the game and read as a swimming pool.
  const depth = new Int8Array(d.width * d.height);
  for (let ty = 0; ty < d.height; ty++) {
    for (let tx = 0; tx < d.width; tx++) {
      const k = cellKey(d, tx, ty);
      if (d.tile[k] !== Tile.Water) continue;
      let best = 4;
      for (let r = 1; r <= 3 && best === 4; r++) {
        for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
          const nx = tx + dx;
          const ny = ty + dy;
          if (nx < 0 || ny < 0 || nx >= d.width || ny >= d.height
            || d.tile[cellKey(d, nx, ny)] !== Tile.Water) { best = r; break; }
        }
      }
      depth[k] = best;
    }
  }

  // Ground diamonds, painter's order by tx + ty so overlapping half-tiles stack
  // the way the eye expects.
  for (let ty = 0; ty < d.height; ty++) {
    for (let tx = 0; tx < d.width; tx++) {
      if (!insideIsland(d, tx, ty)) continue;
      const k = cellKey(d, tx, ty);
      const tile = d.tile[k] as TileCode;
      if (tile === Tile.Void) continue;
      let colour = GROUND_COLOUR[tile] ?? PAL.soot2;
      if (tile === Tile.Water) {
        // Shallows at the bank, deep water in the channel.
        const dep = depth[k];
        colour = dep <= 1 ? PAL.riv2 : dep === 2 ? PAL.riv1 : shadeHex(PAL.riv1, -0.15);
      }
      if (tile !== Tile.Water) {
        // Soot rises toward the factory quarter. A district that visibly gets
        // dirtier as you walk east IS the theme, rendered.
        colour = shadeHex(colour, -Math.min(0.4, d.grime[k] / 700));
      }
      drawIsoDiamond(gctx, originX + isoX(tx, ty), originY + isoY(tx, ty), gradeHex(colour, variant));
      textureCell(gctx, city.seed, tx, ty, tile, originX, originY, variant);

      // Dither the step between depth bands. A hard step made the channel read as
      // a set of tiled patches rather than as water getting deeper.
      if (tile === Tile.Water && depth[k] === 2) {
        const bx = originX + isoX(tx, ty);
        const by = originY + isoY(tx, ty);
        ditherPolyHard(gctx, [
          { x: bx, y: by - TILE_H / 2 }, { x: bx + TILE_W / 2, y: by },
          { x: bx, y: by + TILE_H / 2 }, { x: bx - TILE_W / 2, y: by },
        ], gradeHex(PAL.riv2, variant), 6);
      }

      // A quay lip where land meets water: one bright pixel row on the land side
      // of the boundary. Without it the river is a hole cut in the map.
      if (tile !== Tile.Water) {
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          const nx = tx + dx;
          const ny = ty + dy;
          if (nx >= d.width || ny >= d.height) continue;
          if (d.tile[cellKey(d, nx, ny)] !== Tile.Water) continue;
          const ex = originX + isoX(tx, ty);
          const ey = originY + isoY(tx, ty);
          const lip = gradeHex(tile === Tile.Wharf ? PAL.wood2 : PAL.stone2, variant);
          if (dx === 1) lineHard(gctx, { x: ex, y: ey + TILE_H / 2 }, { x: ex + TILE_W / 2, y: ey }, lip);
          else lineHard(gctx, { x: ex, y: ey + TILE_H / 2 }, { x: ex - TILE_W / 2, y: ey }, lip);
        }
      }
    }
  }

  // Contact shadows, baked into the ground under every footprint.
  //
  // Without one, every building in the district hovers: there is no cue that a
  // wall meets the pavement, so the town reads as a set of objects arranged on a
  // surface rather than as a town standing on one. One dithered diamond per cell,
  // offset east and south away from the west light.
  for (const bld of city.buildings) {
    for (const k of bld.cells) {
      const x = k % d.width;
      const y = (k - x) / d.width;
      const sx2 = originX + isoX(x, y) + 2;
      const sy2 = originY + isoY(x, y) + 2;
      ditherPolyHard(gctx, [
        { x: sx2, y: sy2 - TILE_H / 2 },
        { x: sx2 + TILE_W / 2, y: sy2 },
        { x: sx2, y: sy2 + TILE_H / 2 },
        { x: sx2 - TILE_W / 2, y: sy2 },
      ], PAL.soot0, 7);
    }
  }
  for (const pr of buildProps(d, city.seed, variant)) {
    ditherPolyHard(gctx, [
      { x: pr.wx + 1, y: pr.wy - 3 }, { x: pr.wx + 8, y: pr.wy + 1 },
      { x: pr.wx + 1, y: pr.wy + 5 }, { x: pr.wx - 6, y: pr.wy + 1 },
    ], PAL.soot0, 6);
  }

  // Lamp pools are baked INTO THE GROUND, not drawn per frame over everything.
  //
  // The old pass ran after the whole merge walk with no depth participation and
  // no height term, so soft cream squares floated in the middle of roofs and up
  // walls. A street lamp lights the street: baking the pool under the buildings
  // is both correct occlusion and free, because lamps do not move and the ground
  // is already rebaked once per lighting variant.
  if (variant !== 'day') {
    for (const bld of city.buildings) {
      if (bld.gasSeg < 0 || !serviceAt(city.networks.gas, bld.id)) continue;
      const lx = originX + isoX(bld.doorX, bld.doorY);
      const ly = originY + isoY(bld.doorX, bld.doorY);
      // Concentric DITHERED diamonds, not alpha rings and certainly not a radial
      // gradient. Density falls off instead of opacity, so every pixel in the
      // pool is still a palette colour. A pool of blended half-alpha cream is the
      // classic modern-lighting-over-pixel-art tell.
      const rings: [number, number, string][] = [
        [3.0, 3, PAL.gas0], [2.2, 6, PAL.gas1], [1.4, 10, PAL.gas1], [0.8, 15, PAL.gas2],
      ];
      for (const [scale, density, colour] of rings) {
        ditherPolyHard(gctx, [
          { x: lx, y: ly - (TILE_H / 2) * scale },
          { x: lx + (TILE_W / 2) * scale, y: ly },
          { x: lx, y: ly + (TILE_H / 2) * scale },
          { x: lx - (TILE_W / 2) * scale, y: ly },
        ], colour, density);
      }
    }
  }

  const statics: StaticSprite[] = [];
  const idBuffer = makeCanvas(b.w, b.h);
  const idCtx = ctxOf(idBuffer, true);
  const scratch = makeCanvas(256, 256);
  const sctx = ctxOf(scratch);

  const ordered = city.buildings.slice().sort((p, q) => depthOf(p) - depthOf(q));
  for (const bld of ordered) {
    const s = flattenBuilding(city, bld, variant);
    statics.push(s);
    stampId(idCtx, sctx, scratch, s, bld.id, originX, originY);
  }
  statics.sort((p, q) => p.depth - q.depth);

  const props = buildProps(d, city.seed, variant).concat(
    buildSquareProps(d, city.seed, variant, city.streetPlan.squareX, city.streetPlan.squareY, city.streetPlan.squareW),
  );
  props.sort((a, b) => a.depth - b.depth);
  return { variant, ground, props, idBuffer, idCtx, statics, originX, originY };
}

function depthOf(b: Building): number {
  return depthKey(b.ox + b.w - 1, b.oy + b.d - 1, LAYER_STRUCT);
}

export function debugSkin(city: City, b: Building) {
  return specFor(city, b, city.district.grime[cellKey(city.district, b.ox, b.oy)], variantFor(minuteOfDay(city.tick)));
}

export function flattenBuilding(
  city: City, b: Building, variant: Variant = variantFor(minuteOfDay(city.tick)),
): StaticSprite {
  const grime = city.district.grime[cellKey(city.district, b.ox, b.oy)];
  const spec = specFor(city, b, grime, variant);
  const bounds = houseBounds(spec);
  const pad = 2;
  const w = bounds.maxX - bounds.minX + pad * 2;
  const ht = bounds.maxY - bounds.minY + pad * 2;
  const sprite = makeCanvas(w, ht);
  const ctx = ctxOf(sprite);
  const ax = -bounds.minX + pad;
  const ay = -bounds.minY + pad;

  drawHouse(ctx, ax, ay, spec);
  // Binary alpha, as the palette contract has always claimed. Partial alpha
  // breaks the source-in silhouette stamp the ID buffer depends on, and halos the
  // sprite against the ground.
  hardenAlpha(ctx, sprite.width, sprite.height);

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
