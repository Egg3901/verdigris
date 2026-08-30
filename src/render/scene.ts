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
import type { District } from '../sim/district';
import { Tile } from '../sim/types';
import type { TileCode } from '../sim/types';
import { PAL, shadeHex, hexToRgb, rgbToHex, gradeHex, variantFor, isDarkVariant } from './palette';
import type { Variant } from './palette';
import { minuteOfDay } from '../sim/clock';
import { TILE_W, TILE_H, HEAD_ROOM, isoX, isoY, worldBounds, depthKey, LAYER_STRUCT } from './iso';
import { serviceAt } from '../sim/networks';
import { drawIsoDiamond } from './fallback';
import { drawHouse, houseBounds } from './house';
import { hardenAlpha, ditherPolyHard, lineHard, fillPolyHard } from './raster';
import { buildCartRoutes } from './fx';
import type { CartRoute } from './fx';
import type { HouseSpec, HouseSkin, RoofShape, Finial, Frontage } from './house';
import type { RoofKind, SignGlyph, WallMaterial, WindowLight } from './detail';
import { mix, Stream } from '../sim/rng';
import { buildMarketProps, buildProps, buildSquareProps, buildStreetProps, textureCell } from './props';
import type { Prop } from './props';
import { worksStageFor, latestOrderFor } from '../sim/works';
import { isDeputationActive } from '../sim/deputations';
import { activePublicVisit } from '../sim/civic-visits';
import { disasterAt, isBuildingClosed, isDisasterActive } from '../sim/disasters';
import type { WardKind } from '../sim/gen/wards';
import { weatherAt, WEATHER_WATCH_MINUTES } from '../sim/weather';
import { riverLevelAt, riverDropAt } from '../sim/hydrology';
import { snowCoverAt } from '../sim/weather';
import { isShelterActive } from '../sim/shelters';

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
  /** Window panes in sprite coordinates, lit per frame on their own schedules. */
  windows: WindowLight[];
  /** Facade height and routine flags used by depth-correct per-frame details. */
  wallH: number;
  washing: boolean;
}

export interface Scene {
  /** Cart routes, precomputed once from the seed. */
  cartRoutes: CartRoute[];
  /** Which lighting variant this scene was baked at. The compositor rebakes when
   *  it changes, which is a handful of times a day, never per frame. */
  variant: Variant;
  worksRevision: number;
  deputationRevision: number;
  civicVisitRevision: number;
  disasterRevision: number;
  weatherRevision: number;
  /** Opening hours and outdoor domestic/work routines baked into the sprites. */
  dailyRevision: number;
  /** Thresholded fabric, facade and service state baked into building sprites. */
  buildingRevision: number;
  shelterRevision: number;
  occasionRevision: number;
  /** Combined river key this scene was baked at: surface drop in px and the
   *  coarse level, so a one-pixel move of the water plane rebakes the ground. */
  riverLevel: number;
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
  material: WallMaterial;
  finial?: Finial;
  finialH?: number;
  cresting?: boolean;
}

const FAMILY: Partial<Record<string, Family>> = {
  // Lead flats around a copper dome. The roof used to be copper too, so the
  // dome had nothing to stand against and the whole hall read as one green
  // shape with a gold ring on it.
  townhall: { roof: [PAL.slate2, PAL.slate1, PAL.arc0], wall: [PAL.stone4, PAL.stone2], shape: 'dome', trim: PAL.gold, dormers: 1, material: 'ashlar', finial: 'dome', finialH: 10, cresting: true },
  exchange: { roof: [PAL.verd2, PAL.verd1, PAL.verd3], wall: [PAL.stone4, PAL.stone2], shape: 'hip', trim: PAL.gold, shop: true, material: 'ashlar', finial: 'cupola', finialH: 14, cresting: true },
  bank: { roof: [PAL.verd1, PAL.verd0, PAL.verd2], wall: [PAL.stone4, PAL.stone2], shape: 'hip', trim: PAL.gold, shop: true, material: 'ashlar', cresting: true },
  postexchange: { roof: [PAL.verd2, PAL.verd1, PAL.verd3], wall: [PAL.stone3, PAL.stone1], shape: 'hip', trim: PAL.brass2, shop: true, material: 'ashlar', finial: 'cupola', finialH: 12 },
  glasshouse: { roof: [PAL.verd3, PAL.verd2, PAL.rivGlint], wall: [PAL.stone3, PAL.stone1], shape: 'gable', trim: PAL.verd3, material: 'glazed' },
  chapel: { roof: [PAL.slate2, PAL.slate1, PAL.arc0], wall: [PAL.stone3, PAL.stone1], shape: 'gable', material: 'ashlar', finial: 'spire', finialH: 36, cresting: true },
  school: { roof: [PAL.slate2, PAL.slate1, PAL.arc0], wall: [PAL.stone2, PAL.stone1], shape: 'mansard', dormers: 2, material: 'brick', finial: 'cupola', finialH: 12 },
  bathhouse: { roof: [PAL.verd1, PAL.verd0, PAL.verd2], wall: [PAL.stone3, PAL.stone1], shape: 'dome', material: 'ashlar', finial: 'dome', finialH: 8 },
  dispensary: { roof: [PAL.slate2, PAL.slate1, PAL.arc0], wall: [PAL.cream2, PAL.cream1], shape: 'gable', shop: true, material: 'stucco' },
  newspaper: { roof: [PAL.slate2, PAL.slate1, PAL.slate2], wall: [PAL.cream1, PAL.cream0], shape: 'gable', shop: true, material: 'brick' },
  constabulary: { roof: [PAL.slate2, PAL.slate1, PAL.arc0], wall: [PAL.stone2, PAL.stone1], shape: 'gable', material: 'ashlar' },
  // Lattice, not a box. Gold lives on the cap, not the whole shaft.
  mast: { roof: [PAL.verd2, PAL.verd1, PAL.gold], wall: [PAL.soot3, PAL.soot2], shape: 'flat', trim: PAL.gold, material: 'wood', finial: 'mast', finialH: 84 },

  mill: { roof: [PAL.soot3, PAL.soot2, PAL.slate2], wall: [PAL.brick1, PAL.brick0], shape: 'sawtooth', material: 'brick', finial: 'stack', finialH: 34 },
  foundry: { roof: [PAL.soot3, PAL.soot2, PAL.slate2], wall: [PAL.brick2, PAL.brick1], shape: 'sawtooth', material: 'brick', finial: 'stack', finialH: 26 },
  gasworks: { roof: [PAL.soot2, PAL.soot1, PAL.soot3], wall: [PAL.brick1, PAL.brick0], shape: 'flat', material: 'brick', finial: 'gasometer', finialH: 28 },
  tramdepot: { roof: [PAL.slate2, PAL.slate1, PAL.slate2], wall: [PAL.brick1, PAL.brick0], shape: 'sawtooth', material: 'brick' },
  pumphouse: { roof: [PAL.tileRed2, PAL.tileRed1, PAL.tileRed3], wall: [PAL.brick1, PAL.brick0], shape: 'hip', material: 'brick' },
  workshop: { roof: [PAL.slate2, PAL.slate1, PAL.slate2], wall: [PAL.brick2, PAL.brick1], shape: 'gambrel', material: 'brick' },
  warehouse: { roof: [PAL.soot3, PAL.soot2, PAL.slate2], wall: [PAL.wood2, PAL.wood1], shape: 'gambrel', material: 'wood' },
  wharfshed: { roof: [PAL.thatch2, PAL.thatch1, PAL.thatch2], wall: [PAL.wood2, PAL.wood1], shape: 'gambrel', material: 'wood' },

  pub: { roof: [PAL.tileRed2, PAL.tileRed1, PAL.tileRed3], wall: [PAL.buntRed, PAL.brick1], shape: 'gable', trim: PAL.brass2, shop: true, dormers: 1, material: 'brick' },
  shop: { roof: [PAL.tileRed2, PAL.tileRed1, PAL.tileRed3], wall: [PAL.cream2, PAL.cream1], shape: 'gable', trim: PAL.brass1, shop: true, material: 'stucco' },
  villa: { roof: [PAL.slate2, PAL.slate1, PAL.arc0], wall: [PAL.cream3, PAL.cream1], shape: 'mansard', trim: PAL.brass2, dormers: 2, material: 'stucco', cresting: true },
  terrace: { roof: [PAL.tileRed2, PAL.tileRed1, PAL.tileRed3], wall: [PAL.cream2, PAL.cream1], shape: 'gable', material: 'stucco' },
  tenement: { roof: [PAL.slate1, PAL.slate0, PAL.slate2], wall: [PAL.brick2, PAL.brick1], shape: 'gable', dormers: 2, material: 'brick' },
  lodging: { roof: [PAL.slate2, PAL.slate1, PAL.arc0], wall: [PAL.ochre1, PAL.ochre0], shape: 'gambrel', dormers: 1, material: 'timber' },
  courtdwelling: { roof: [PAL.soot3, PAL.soot2, PAL.soot3], wall: [PAL.brick1, PAL.brick0], shape: 'gable', material: 'brick' },
};

const DEFAULT_FAMILY: Family = {
  roof: [PAL.tileRed2, PAL.tileRed1, PAL.tileRed3],
  wall: [PAL.cream2, PAL.cream1],
  shape: 'gable',
  material: 'stucco',
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
// variety comes from: without it hundreds of buildings read as twelve buildings
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

interface DailyStreetState {
  shopsOpen: boolean;
  pubsOpen: boolean;
  washingOut: boolean;
  workSetOut: boolean;
}

/** Coarse routines that materially change the baked street and facades. */
function dailyStreetState(tick: number): DailyStreetState {
  const minute = minuteOfDay(tick);
  return {
    shopsOpen: minute >= 450 && minute < 1140,
    pubsOpen: minute >= 630 || minute < 90,
    washingOut: minute >= 480 && minute < 1020,
    workSetOut: minute >= 360 && minute < 1080,
  };
}

/** Small stable key used by the compositor to rebake at routine boundaries. */
export function dailyStreetRevisionAt(tick: number): number {
  const state = dailyStreetState(tick);
  return Number(state.shopsOpen)
    | (Number(state.pubsOpen) << 1)
    | (Number(state.washingOut) << 2)
    | (Number(state.workSetOut) << 3);
}

/**
 * Hash only the slow state that crosses a visible threshold.
 *
 * Fabric and facade move without their own revision counter. Folding their
 * rendered bands into one key means a repair can shed boards or grime on the
 * hour it happens, while changes within a band do not trigger needless bakes.
 */
export function buildingVisualRevision(city: City): number {
  let hash = 2166136261;
  for (const b of city.buildings) {
    const polite = city.district.polite[cellKey(city.district, b.ox, b.oy)] === 1;
    const def = DEFS[b.kind];
    let bands = Number(b.fabric < 220)
      | (Number(b.fabric < 250) << 1)
      | (Number(b.fabric < (polite ? 260 : 340)) << 2)
      | (Number(b.fabric < 500) << 3)
      | (Number(b.fabric < 540) << 4)
      | (Number(b.facade > (polite ? 720 : 880)) << 5)
      | (Number(b.burntAt >= 0) << 6);
    if (def.needsDrain && !serviceAt(city.networks.drain, b.id)) bands |= 1 << 7;
    hash = Math.imul(hash ^ b.id ^ (bands << 16), 16777619);
  }
  return hash >>> 0;
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

/** Which way the building's frontage runs, from the plot it was cut from. */
function plotOf(city: City, b: Building): 'x' | 'y' {
  const p = city.plots[b.plotId];
  if (!p) return b.w >= b.d ? 'x' : 'y';
  // dir 2 and 3 are south and north, so the street runs east to west and the
  // frontage with it.
  return p.dir === 2 || p.dir === 3 ? 'x' : 'y';
}

/**
 * What the hanging sign shows. Read off the building's NAME, so Mr Hobbs the
 * Bootmaker actually hangs a boot: the sign and the prose agree, which is the
 * whole point of a trade sign. Trades outside the four glyphs fall back to a
 * hashed pick, pubs always hang the tankard.
 */
function glyphFor(b: Building, salt: number): SignGlyph {
  if (b.kind === 'pub') return 'tankard';
  if (/Bootmaker|Cobbler/.test(b.name)) return 'boot';
  if (/Baker|Grocer|Confectioner/.test(b.name)) return 'loaf';
  if (/Draper|Milliner|Tailor/.test(b.name)) return 'scissors';
  return (['boot', 'loaf', 'scissors'] as const)[(salt >>> 17) % 3];
}

function specFor(city: City, b: Building, grime: number, variant: Variant): HouseSpec {
  const fam = FAMILY[b.kind] ?? DEFAULT_FAMILY;
  const def = DEFS[b.kind];
  const salt = mix(city.seed, 41, b.id);
  const polite = city.district.polite[cellKey(city.district, b.ox, b.oy)] === 1;
  const weather = weatherAt(city.seed, city.tick);
  const daily = dailyStreetState(city.tick);
  // Soot on the same ladder as everything else, in five steps rather than 255.
  // The working bank carries more of it: that is the class geography, rendered.
  const soot = Math.round(Math.min(polite ? 0.28 : 0.42, grime / 760 + (polite ? 0 : 0.08)) / 0.06) * 0.06;

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

  let roof = fam.roof;
  let wall = fam.wall;
  let material = fam.material;
  let shape = fam.shape;
  const wardKind = city.wards[city.plots[b.plotId]?.wardId]?.kind;
  // A one-tile-wide mill cannot carry sawteeth: they collapse into noise. Keep
  // the stack, give the roof a gable that will actually silhouette.
  if ((b.kind === 'mill' || b.kind === 'foundry' || b.kind === 'tramdepot') && Math.min(b.w, b.d) < 2) {
    shape = 'gable';
  }
  // The polite bank keeps stucco, slate and ashlar. The working bank is timber,
  // brick, terracotta, and patches. Same kinds, two cities.
  if (!polite) {
    if (b.kind === 'terrace') {
      wall = [PAL.cream1, PAL.cream0];
      roof = [PAL.tileRed2, PAL.tileRed1, PAL.tileRed3];
      material = 'timber';
    } else if (b.kind === 'shop') {
      wall = [PAL.ochre1, PAL.ochre0];
      roof = [PAL.tileRed1, PAL.tileRed0, PAL.tileRed2];
      material = 'timber';
    } else if (b.kind === 'villa') {
      material = 'stucco';
      shape = 'gable';
    } else if (b.kind === 'pub') {
      material = 'brick';
    }
  } else {
    if (b.kind === 'terrace') {
      wall = [PAL.cream3, PAL.cream1];
      roof = [PAL.slate2, PAL.slate1, PAL.arc0];
      material = 'stucco';
    } else if (b.kind === 'shop') {
      wall = [PAL.cream3, PAL.cream1];
      roof = [PAL.tileRed2, PAL.tileRed1, PAL.tileRed3];
      material = 'stucco';
    } else if (b.kind === 'villa') {
      material = 'ashlar';
    } else if (b.kind === 'lodging') {
      material = 'stucco';
      shape = 'mansard';
    }
  }

  // Ward identity is broad architectural rhythm, not a new building type. The
  // landmarks keep their authored silhouettes while ordinary addresses inherit
  // the materials of the quarter around them.
  if (!def.landmark) {
    switch (wardKind) {
      case 'civic':
        wall = b.kind === 'pub' ? [PAL.brick2, PAL.brick1] : [PAL.stone3, PAL.stone1];
        roof = [PAL.slate2, PAL.slate1, PAL.arc0];
        material = b.kind === 'shop' || b.kind === 'lodging' ? 'stucco' : 'ashlar';
        break;
      case 'garden':
        wall = [PAL.cream3, PAL.cream1];
        roof = [PAL.slate2, PAL.slate1, PAL.verd1];
        material = b.kind === 'terrace' || b.kind === 'villa' ? 'stucco' : material;
        break;
      case 'merchant':
        wall = b.kind === 'pub' ? [PAL.buntRed, PAL.brick1] : [PAL.cream2, PAL.ochre0];
        roof = [PAL.tileRed2, PAL.tileRed1, PAL.slate2];
        material = b.kind === 'shop' ? 'stucco' : material;
        break;
      case 'works':
        wall = [PAL.brick2, PAL.brick0];
        roof = [PAL.soot3, PAL.slate1, PAL.slate2];
        material = b.kind === 'terrace' ? 'timber' : 'brick';
        break;
      case 'courts':
        wall = [PAL.brick1, PAL.brick0];
        roof = [PAL.tileRed1, PAL.soot2, PAL.tileRed2];
        material = b.kind === 'tenement' || b.kind === 'courtdwelling' ? 'brick' : 'timber';
        if (b.kind === 'lodging' || b.kind === 'terrace') shape = 'gable';
        break;
      case 'quayside':
        wall = [PAL.wood2, PAL.wood1];
        roof = b.kind === 'warehouse' || b.kind === 'workshop'
          ? [PAL.slate2, PAL.slate1, PAL.soot2]
          : [PAL.thatch2, PAL.thatch1, PAL.tileRed1];
        material = 'wood';
        if (b.kind === 'lodging' || b.kind === 'terrace') shape = 'gambrel';
        break;
    }
  }

  // One family still needs several rooflines. These are restrained by building
  // kind and ward so the town keeps its grammar while adjacent addresses stop
  // reading as cloned stamps.
  if (!def.landmark) {
    const roofVariant = (salt >>> 18) % 6;
    if (b.kind === 'villa') {
      if (polite && roofVariant < 2) shape = 'mansard';
      else if (roofVariant === 2) shape = 'pyramid';
      else if (roofVariant === 3) shape = 'hip';
    } else if (b.kind === 'terrace') {
      if ((wardKind === 'civic' || wardKind === 'garden' || polite) && roofVariant === 0) shape = 'mansard';
      else if ((wardKind === 'courts' || wardKind === 'quayside') && roofVariant < 2) shape = 'gambrel';
    } else if (b.kind === 'tenement') {
      if ((wardKind === 'merchant' || polite) && roofVariant === 0) shape = 'mansard';
      else if ((wardKind === 'works' || wardKind === 'courts') && roofVariant === 1) shape = 'flat';
    } else if (b.kind === 'lodging') {
      shape = pickFrom(['gable', 'gambrel', 'mansard'] as const, salt, 19);
    } else if (b.kind === 'shop' || b.kind === 'pub') {
      if (roofVariant === 0 && polite) shape = 'mansard';
      else if (roofVariant === 1) shape = 'hip';
    } else if ((b.kind === 'workshop' || b.kind === 'warehouse') && Math.min(b.w, b.d) >= 2) {
      shape = pickFrom(['gable', 'gambrel', 'sawtooth'] as const, salt, 20);
    } else if (b.kind === 'courtdwelling' && roofVariant === 0) {
      shape = 'flat';
    }
  }

  // The covering family, read off the roof colours before they are washed. It
  // drives baked texture only, never geometry.
  // Works roofs are tarred boards and felt over iron, not hung slate: the
  // staggered slate joints on those huge sawtooth planes read as chain-link.
  const roofKind: RoofKind | undefined =
    roof[0] === PAL.soot2 || roof[0] === PAL.soot3 || shape === 'sawtooth' || shape === 'flat' ? undefined
      : roof[0] === PAL.verd0 || roof[0] === PAL.verd1 || roof[0] === PAL.verd2 || roof[0] === PAL.verd3 ? 'copper'
        : roof[0] === PAL.thatch1 || roof[0] === PAL.thatch2 ? 'thatch'
          : roof[0] === PAL.tileRed0 || roof[0] === PAL.tileRed1 || roof[0] === PAL.tileRed2 ? 'clay'
            : 'slate';

  const skin: HouseSkin = {
    wallLit: wash(wall[0], wallWash + tired),
    wallShade: wash(wall[1], wallWash + tired - 0.06),
    // Gable ends carry the same floor as the roof, for the same reason: they are
    // large and they face the camera.
    gableLit: gradeHex(liftToFloor(shadeHex(shadeHex(wall[0], wallWash + tired - 0.04), -soot), 58), variant),
    gableShade: gradeHex(liftToFloor(shadeHex(shadeHex(wall[1], wallWash + tired - 0.1), -soot), 48), variant),
    roofLit: roofWashOf(roof[0], roofWash),
    roofShade: roofWashOf(roof[1], roofWash),
    roofRidge: roofWashOf(roof[2], roofWash + 0.1),
    trim: (polite ? b.facade > 720 : b.facade > 880)
      ? gradeHex(fam.trim ?? PAL.gold, variant, true) : undefined,
    // Chimneys are brick or soot, never the wall colour, and they carry the same
    // grime the walls do.
    // A works shaft is black with firing regardless of what the street
    // sweeps: its colour comes from its own flue, not the local grime, or a
    // mill on a clean street grows pale grey pipes instead of chimneys.
    chimney: fam.finial === 'stack'
      ? gradeHex(shadeHex(PAL.brick1, -0.15), variant)
      : gradeHex(shadeHex(soot > 0.18 ? PAL.soot2 : PAL.brick1, -soot * 0.5), variant),
    // Lit windows at dusk and after. A gaslight-era city with no lit window in it
    // was the single most conspicuous absence in the build: variantFor and the
    // palette entries both existed and neither had ever been called.
    // Ordinary windows are baked dark and lit per frame (see drawWindowLights),
    // so a house lights and empties one room at a time. windowLit here only still
    // drives the landmark glazing (dome drums, cupolas, the winter garden).
    window: PAL.litWindow,
    windowLit: isDarkVariant(variant),
    outline: gradeHex(PAL.soot0, variant),
  };

  const storeys = def.storeys;
  const wallH = fam.finial === 'mast' ? 8
    : Math.max(7, Math.round(storeys * 8 + 2));
  // A town seen from above is a field of ROOFS. At 0.3 of the wall height the
  // roofs were small hats on tall walls, and the tan wall hue dominated the
  // frame. Around 0.65 is where the silhouette starts carrying the image.
  const roofH = fam.finial === 'mast' ? 0
    : shape === 'flat' ? 3
      : shape === 'pyramid' ? Math.round(16 + storeys * 3)
        : shape === 'dome' ? Math.max(12, Math.round(wallH * 0.55 + (salt % 3)))
          : Math.max(8, Math.round(wallH * 0.65 + (salt % 3)));
  const dormerBase = fam.dormers ?? 0;
  const dormers = roofH >= 12 && shape !== 'sawtooth' && shape !== 'flat'
    ? Math.min(3, dormerBase + (polite && ((salt >>> 15) % 4 === 0) ? 1 : 0))
    : 0;

  const AWNINGS = [PAL.buntRed, PAL.buntBlue, PAL.verd1, PAL.brick1, PAL.ochre0];
  const dwelling = b.kind === 'terrace' || b.kind === 'tenement'
    || b.kind === 'courtdwelling' || b.kind === 'lodging';
  const finial: Finial = fam.finial ?? 'none';
  const worksStage = worksStageFor(city, b.id);
  const drainState: 0 | 1 | 2 = !def.needsDrain ? 0 : serviceAt(city.networks.drain, b.id) ? 1 : 2;
  const wardWear = wardKind === 'works' || wardKind === 'courts' || wardKind === 'quayside' ? 1 : 0;
  const roofWear: 0 | 1 | 2 = worksStage >= 2 ? 0
    : b.fabric < 250 ? 2 : b.fabric < 540 || (wardWear > 0 && grime > 300) ? 1 : 0;
  const facadeWear: 0 | 1 | 2 = b.fabric < 220 ? 2
    : b.fabric < 500 || drainState === 2 || (wardWear > 0 && grime > 360) ? 1 : 0;
  const frontage: Frontage = b.kind === 'mill' || b.kind === 'foundry' || b.kind === 'gasworks'
    || b.kind === 'tramdepot' || b.kind === 'pumphouse' || b.kind === 'workshop' ? 'works'
    : b.kind === 'warehouse' ? 'warehouse'
      : b.kind === 'wharfshed' ? 'wharf'
        : b.kind === 'shop' || b.kind === 'pub' ? 'shop'
          : def.landmark ? 'civic' : 'house';
  const damageEvent = disasterAt(city, b.id);
  const damage: HouseSpec['damage'] = isBuildingClosed(city, b.id)
    && (damageEvent?.kind === 'collapse' || b.fabric === 0)
    ? 'collapsed'
    : damageEvent?.kind === 'fire' && isDisasterActive(city, damageEvent) ? 'burning'
      : damageEvent?.kind === 'flood' && isDisasterActive(city, damageEvent) ? 'flooded' : 'none';
  // The fire has moved on but the shell still stands: a charred husk until the
  // fabric is genuinely rebuilt. Live flame and total collapse both win over it.
  // A building on fire is lit from the inside: the windows glow hot whatever the
  // hour, so a daytime blaze still reads as a fire and not as a grey box with a
  // flame decal balanced on the ridge.
  if (damage === 'burning') {
    skin.window = gradeHex(PAL.litWindow, variant, true);
    skin.windowLit = true;
  }
  const scorched = b.burntAt >= 0 && damage !== 'collapsed' && damage !== 'burning';
  if (scorched) {
    // Char the whole skin toward soot: the paint is gone, the near tiles are gone,
    // the glass is knocked out. Chimney and outline are left, so the silhouette
    // still reads as a specific building rather than a black blob.
    skin.wallLit = gradeHex(PAL.soot2, variant);
    skin.wallShade = gradeHex(PAL.soot1, variant);
    skin.gableLit = gradeHex(PAL.soot2, variant);
    skin.gableShade = gradeHex(PAL.soot1, variant);
    skin.roofLit = gradeHex(PAL.soot2, variant);
    skin.roofShade = gradeHex(PAL.soot1, variant);
    skin.roofRidge = gradeHex(PAL.soot3, variant);
    skin.trim = undefined;
    skin.window = gradeHex(PAL.soot0, variant);
    skin.windowLit = false;
  }

  return {
    w: b.w, d: b.d, wallH, roofH,
    shape,
    salt: salt >>> 11,
    shopfront: fam.shop === true && b.w * b.d >= 1,
    shopOpen: b.kind === 'pub' ? daily.pubsOpen : daily.shopsOpen,
    sign: fam.shop === true,
    signGlyph: fam.shop === true && (b.kind === 'shop' || b.kind === 'pub') ? glyphFor(b, salt) : undefined,
    awning: gradeHex(pickFrom(AWNINGS, salt, 7), variant),
    // Dormers need a slope deep enough to sit one on.
    dormers,
    // The rot, on the building rather than only in the prose. A building whose
    // fabric has genuinely failed gets its windows boarded. The working bank
    // fails earlier.
    boarded: scorched || b.fabric < (polite ? 260 : 340),
    damage,
    scorched,
    // The flags the player paid for, on whatever fronts the square. Never over a
    // burnt-out shell: the district does not dress a ruin.
    bunting: !scorched && city.buntingUntil > city.tick && nearSquare(city, b),
    deputationBanner: b.kind === 'townhall' && (isDeputationActive(city) || Boolean(activePublicVisit(city))),
    shelterOpen: isShelterActive(city) && city.shelters.current?.providerId === b.id,
    chimneys: finial === 'mast' || shape === 'flat' || shape === 'pyramid' || shape === 'dome' ? 0
      : b.kind === 'mill' || b.kind === 'foundry' ? 1
        : 1 + ((salt >>> 6) % 2),
    windowRows: Math.max(1, Math.min(3, storeys - 1)),
    skin,
    // The ridge runs along the FRONTAGE, not along the longer footprint axis.
    //
    // A terrace house on a one-by-two plot is deeper than it is wide, so the old
    // rule ran its ridge back from the street, which points the gable END at the
    // camera. A gable end is wall, so the building presented a big pale triangle
    // where its roof should be and the roof itself was reduced to two thin strips
    // either side. Terraces are built in a row with the ridge along the row; you
    // see gable ends only where the row stops.
    ridgeAlongX: plotOf(city, b) === 'x',
    material,
    frontage,
    polite,
    patched: !polite && dwelling && ((salt >>> 9) % (wardKind === 'courts' ? 2 : 3) === 0),
    roofWear: scorched ? 2 : roofWear,
    facadeWear: scorched ? 2 : facadeWear,
    washing: daily.washingOut && weather.precipitation === 0
      && !polite && dwelling && ((salt >>> 11) % (wardKind === 'courts' ? 2 : 3) === 0),
    cresting: fam.cresting === true || ((wardKind === 'garden' || polite) && b.kind === 'villa'),
    railings: (polite || wardKind === 'garden' || wardKind === 'civic')
      && (b.kind === 'villa' || b.kind === 'bank' || b.kind === 'townhall' || b.kind === 'terrace'),
    // Iron balconies over the merchant-row shopfronts: living quarters above the
    // shop, dressed for the street below. About half the row, hashed per address.
    balcony: wardKind === 'merchant' && fam.shop === true && storeys >= 2
      && ((salt >>> 13) & 1) === 0,
    bayWindow: !fam.shop && (polite || wardKind === 'garden')
      && (b.kind === 'villa' || b.kind === 'terrace' || b.kind === 'lodging')
      && ((salt >>> 16) % 3 === 0),
    worksStage,
    drainState,
    // A mill or foundry has a fire in it around the clock; a scorched shell does
    // not, and neither does an idle collapsed one.
    furnace: (b.kind === 'mill' || b.kind === 'foundry') && !scorched && damage === 'none',
    // Snow is precipitation, but it does not run off a roof or pool in a
    // gutter, so a snow watch gets no drips and no puddles.
    rainStrength: weather.kind === 'snow' ? 0 : weather.precipitation,
    snowCover: snowCoverAt(city.seed, city.tick),
    finial,
    finialH: fam.finialH ?? 0,
    roofKind,
  };
}

/** An open street trench with spoil, a pipe, a barrier and a warning lamp: the
 *  mark a drain or gas repair leaves on the road while the crew is in. */
function drawRoadWorks(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, kind: 'gas' | 'drain', variant: Variant,
): void {
  const g = (c: string, e = false) => gradeHex(c, variant, e);
  const hw = Math.round(TILE_W * 0.32);
  const hh = Math.round(TILE_H * 0.32);
  const x = Math.round(cx);
  const y = Math.round(cy);
  // The trench, dug into the road.
  const trench = [
    { x, y: y - hh }, { x: x + hw, y }, { x, y: y + hh }, { x: x - hw, y },
  ];
  fillPolyHard(ctx, trench, g(PAL.soot1));
  ditherPolyHard(ctx, trench, g(PAL.dirt0), 6);
  // The main at the bottom of it: brass for gas, dark iron for drain.
  lineHard(ctx, { x: x - hw + 2, y: y + 1 }, { x: x + hw - 2, y: y - 1 },
    g(kind === 'gas' ? PAL.brass1 : PAL.soot3));
  lineHard(ctx, { x: x - hw + 2, y: y + 2 }, { x: x + hw - 2, y }, g(PAL.soot0));
  // A spoil heap on the near lip.
  ctx.fillStyle = g(PAL.dirt2);
  ctx.fillRect(x - hw, y + 1, 3, 2);
  ctx.fillRect(x - hw + 2, y + 2, 2, 1);
  // A duckboard laid across so people can still pass.
  lineHard(ctx, { x: x - hw + 1, y: y - 1 }, { x: x + hw - 1, y: y - 2 }, g(PAL.wood1));
  // A trestle barrier along the near edge, striped, with a lamp on the corner.
  const by = y + hh + 1;
  ctx.fillStyle = g(PAL.wood1);
  ctx.fillRect(x - 8, by - 4, 1, 4);
  ctx.fillRect(x + 7, by - 4, 1, 4);
  for (let i = -8; i < 8; i += 2) {
    ctx.fillStyle = ((i >> 1) & 1) ? g(PAL.buntRed) : g(PAL.buntCream);
    ctx.fillRect(x + i, by - 4, 2, 2);
  }
  ctx.fillStyle = g(PAL.soot2);
  ctx.fillRect(x + 8, by - 7, 1, 7);
  ctx.fillStyle = !isDarkVariant(variant) ? g(PAL.buntRed) : g(PAL.gas2, true);
  ctx.fillRect(x + 7, by - 8, 2, 2);
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
export function buildScene(city: City, variant: Variant = variantFor(minuteOfDay(city.tick), weatherAt(city.seed, city.tick).kind)): Scene {
  const b = worldBounds();
  const weather = weatherAt(city.seed, city.tick);
  // The water plane sits below the bank lip and moves with the trailing rain.
  // Everything below the lip, wall, bed, waterline, keys off these two numbers.
  let riverLevel = riverLevelAt(city.seed, city.tick);
  let drop = riverDropAt(city.seed, city.tick);
  // A flood is the river coming up over its walls: the surface surges to the
  // lip while the disaster runs, on top of the flooded-ground sheet below.
  for (const event of city.disasters.events) {
    if (event.kind === 'flood' && isDisasterActive(city, event)) {
      riverLevel = 4;
      drop = 0;
      break;
    }
  }
  const originX = -b.minX;
  const originY = -b.minY;
  const floodedBuildings = new Set<number>();
  for (const event of city.disasters.events) {
    if (event.kind !== 'flood' || !isDisasterActive(city, event)) continue;
    if (event.buildingId >= 0) floodedBuildings.add(event.buildingId);
    for (const id of event.affectedBuildingIds) floodedBuildings.add(id);
  }

  const ground = makeCanvas(b.w, b.h);
  const gctx = ctxOf(ground);
  const d = city.district;
  // Whether the PREVIOUS watch rained, for the drying puddles below. Derived,
  // like the weather itself, from (seed, tick) alone.
  const lastWatchRain = city.tick >= WEATHER_WATCH_MINUTES
    ? weatherAt(city.seed, city.tick - WEATHER_WATCH_MINUTES).precipitation
    : 0;
  const floodedCells = new Set<number>();
  for (const id of floodedBuildings) {
    const building = city.buildings[id];
    if (!building) continue;
    for (const k of building.cells) {
      const x = k % d.width;
      const y = (k - x) / d.width;
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= d.width || ny >= d.height) continue;
        const nk = cellKey(d, nx, ny);
        if (d.tile[nk] !== Tile.Void && d.tile[nk] !== Tile.Water) floodedCells.add(nk);
      }
    }
  }
  const naturalProps = buildProps(d, city.seed, variant, city.wards);
  const daily = dailyStreetState(city.tick);
  const streetProps = buildStreetProps(d, city.seed, variant, city.wards, {
    displaysOut: daily.shopsOpen && weather.precipitation === 0,
    workSetOut: daily.workSetOut && weather.precipitation === 0,
    washingOut: daily.washingOut && weather.precipitation === 0,
  });
  const squareProps = buildSquareProps(
    d, city.seed, variant, city.streetPlan.squareX, city.streetPlan.squareY, city.streetPlan.squareW,
  );
  const marketProps = buildMarketProps(city, variant);

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
        const dep = depth[k];
        // The bed is not a flat floor: it terraces down toward the channel,
        // two pixels per depth band, which is what the falling water exposes.
        const bedAt = (dd: number) => drop + Math.min(3, Math.max(0, dd - 1)) * 2;
        // The channel keeps its water longest: shallows dry out first as the
        // level falls, and in a drought only a mid-channel trickle is left.
        const dryBed = riverLevel === 0 ? dep <= 2 : riverLevel === 1 ? dep <= 1 : false;
        // What water remains at low levels sits down in the terraces it still fills.
        const wetY = riverLevel === 0 ? drop + 4 : riverLevel === 1 ? drop + 2 : drop;
        const cx0 = originX + isoX(tx, ty);
        const cy0 = originY + isoY(tx, ty);
        drawBankWalls(gctx, d, tx, ty, cx0, cy0, dryBed ? bedAt(dep) : wetY, riverLevel, variant);
        if (dryBed) {
          const bd = bedAt(dep);
          // Terrace faces where this bed steps down from a shallower dry neighbour.
          for (const [nx, ny] of [[tx - 1, ty], [tx, ty - 1]]) {
            if (nx < 0 || ny < 0) continue;
            const nk = cellKey(d, nx, ny);
            if (d.tile[nk] !== Tile.Water) continue;
            const nbd = bedAt(depth[nk]);
            if (nbd >= bd) continue;
            const a = nx < tx ? { x: cx0 - TILE_W / 2, y: cy0 } : { x: cx0, y: cy0 - TILE_H / 2 };
            const b = nx < tx ? { x: cx0, y: cy0 - TILE_H / 2 } : { x: cx0 + TILE_W / 2, y: cy0 };
            fillPolyHard(gctx, [
              { x: a.x, y: a.y + nbd }, { x: b.x, y: b.y + nbd },
              { x: b.x, y: b.y + bd }, { x: a.x, y: a.y + bd },
            ], gradeHex(shadeHex(PAL.dirt0, -0.42), variant));
          }
          drawDryBed(gctx, cx0, cy0 + bd, mix(city.seed, 57, tx, ty), variant);
        } else {
          // Shallows at the bank, deep water in the channel.
          const wet = dep <= 1 ? PAL.riv2 : dep === 2 ? PAL.riv1 : shadeHex(PAL.riv1, -0.15);
          drawIsoDiamond(gctx, cx0, cy0 + wetY, gradeHex(wet, variant));
          textureCell(gctx, city.seed, tx, ty, tile, originX, originY + wetY, variant, d.polite[k] === 1);
        }
      }
      if (tile !== Tile.Water) {
        // Soot rises toward the factory quarter. A district that visibly gets
        // dirtier as you walk east IS the theme, rendered.
        let dirt = Math.min(0.4, d.grime[k] / 700);
        if (d.polite[k] === 0) dirt = Math.min(0.5, dirt + 0.08);
        colour = shadeHex(colour, -dirt);
        const wardKind = city.wards[d.wardId[k]]?.kind as WardKind | undefined;
        if (tile === Tile.Street || tile === Tile.Alley || tile === Tile.Square || tile === Tile.Embankment || tile === Tile.Wharf) {
          if (wardKind === 'civic' || wardKind === 'garden') colour = shadeHex(colour, 0.08);
          if (wardKind === 'works' || wardKind === 'courts') colour = shadeHex(colour, -0.08);
          if (wardKind === 'quayside' && tile !== Tile.Embankment) colour = shadeHex(PAL.dirt1, -dirt * 0.7);
        }
      }
      if (tile !== Tile.Water) {
        drawIsoDiamond(gctx, originX + isoX(tx, ty), originY + isoY(tx, ty), gradeHex(colour, variant));
        textureCell(gctx, city.seed, tx, ty, tile, originX, originY, variant, d.polite[k] === 1);
      }

      // Standing rain gathers in selected joints and wheel ruts. Patches are
      // sparse and hashed per watch, so wet streets glint without becoming a
      // second river or crawling while the clock is held.
      const wettable = tile === Tile.Street || tile === Tile.Alley || tile === Tile.Square
        || tile === Tile.Embankment || tile === Tile.Wharf || tile === Tile.Rail;
      const wetRoll = mix(city.seed, Stream.Weather, weather.watch, k) % 100;
      if (weather.precipitation > 0 && wettable && d.buildingId[k] < 0
        && wetRoll < (weather.precipitation === 2 ? 32 : 19)) {
        const cx = originX + isoX(tx, ty);
        const cy = originY + isoY(tx, ty) + 2;
        const puddle = [
          { x: cx, y: cy - 3 }, { x: cx + 8, y: cy },
          { x: cx, y: cy + 3 }, { x: cx - 8, y: cy },
        ];
        ditherPolyHard(gctx, puddle, gradeHex(PAL.riv1, variant), weather.precipitation === 2 ? 6 : 4);
        const lean = weather.windX * 2;
        lineHard(gctx, { x: cx - 4 + lean, y: cy }, { x: cx + 3 + lean, y: cy }, gradeHex(PAL.riv2, variant));
        if ((wetRoll & 3) === 0) {
          lineHard(gctx, { x: cx - 1, y: cy - 1 }, { x: cx + 2, y: cy - 1 }, gradeHex(PAL.rivGlint, variant));
        }
      } else if (weather.precipitation === 0 && lastWatchRain > 0 && wettable
        && d.buildingId[k] < 0
        && (mix(city.seed, Stream.Weather, weather.watch - 1, k) % 100)
          < (lastWatchRain === 2 ? 11 : 6)) {
        // Drying out. For one watch after the rain stops, the deepest ruts still
        // hold water: the same cells that puddled last watch (same hash), only
        // the ones that pooled deepest, smaller and without the wind streak. The
        // streets dry the way streets dry, instead of snapping to bone dry the
        // minute the weather turns.
        const cx = originX + isoX(tx, ty);
        const cy = originY + isoY(tx, ty) + 2;
        ditherPolyHard(gctx, [
          { x: cx, y: cy - 2 }, { x: cx + 5, y: cy },
          { x: cx, y: cy + 2 }, { x: cx - 5, y: cy },
        ], gradeHex(PAL.riv1, variant), 4);
      }

      // Dither the step between depth bands. A hard step made the channel read as
      // a set of tiled patches rather than as water getting deeper.
      if (tile === Tile.Water && depth[k] === 2 && riverLevel >= 2) {
        const bx = originX + isoX(tx, ty);
        const by = originY + isoY(tx, ty) + drop;
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
          const a = dx === 1
            ? { x: ex, y: ey + TILE_H / 2 }
            : { x: ex, y: ey + TILE_H / 2 };
          const b = dx === 1
            ? { x: ex + TILE_W / 2, y: ey }
            : { x: ex - TILE_W / 2, y: ey };
          if (dx === 1) lineHard(gctx, a, b, lip);
          else lineHard(gctx, a, b, lip);
          // Balustrade on the polite bank, timber posts on the working one.
          const rail = gradeHex(tile === Tile.Embankment ? PAL.stone1 : PAL.wood0, variant);
          const n = Math.max(3, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 3));
          for (let i = 0; i <= n; i++) {
            const t = i / n;
            const x = Math.round(a.x + (b.x - a.x) * t);
            const y = Math.round(a.y + (b.y - a.y) * t);
            gctx.fillStyle = rail;
            gctx.fillRect(x, y - (tile === Tile.Embankment ? 4 : 3), 1, tile === Tile.Embankment ? 4 : 3);
          }
          if (tile === Tile.Embankment) {
            lineHard(gctx, { x: a.x, y: a.y - 4 }, { x: b.x, y: b.y - 4 }, rail);
          }
        }
      }
    }
  }

  drawKerbs(gctx, city, d, originX, originY, variant, weather.precipitation);
  drawBridgeDecks(gctx, city, d, originX, originY, drop, variant);
  drawIslandUnderside(gctx, d, city.seed, originX, originY, drop, variant);
  // The falls go in front of the rock they pour down.
  drawOutfalls(gctx, city, d, originX, originY, drop, variant);

  // River fog lies on the water plane, so roofs, bridges, people and cranes are
  // still painted in front of it by the normal compositor. Opaque ordered
  // dither gives it ragged holes without introducing alpha or a postprocess.
  if (weather.kind === 'fog') {
    for (let tx = 2; tx < d.width - 2; tx += 5) {
      const riverY = city.river.centre[tx];
      if (riverY < 0) continue;
      const salt = mix(city.seed, Stream.Weather, weather.watch, tx);
      const cx = originX + isoX(tx, riverY) + ((salt >>> 5) % 13) - 6;
      const cy = originY + isoY(tx, riverY) - 8 - ((salt >>> 10) % 5);
      for (let lobe = 0; lobe < 2; lobe++) {
        const lx = cx + (lobe === 0 ? -10 : 12);
        const ly = cy + (lobe === 0 ? 1 : -2);
        const bank = [
          { x: lx - 22, y: ly + 1 }, { x: lx - 11, y: ly - 6 },
          { x: lx + 8, y: ly - 7 }, { x: lx + 24, y: ly - 1 },
          { x: lx + 15, y: ly + 6 }, { x: lx - 13, y: ly + 7 },
        ];
        ditherPolyHard(gctx, bank, gradeHex(PAL.smoke2, variant), 7);
        ditherPolyHard(gctx, bank, gradeHex(PAL.smoke1, variant), 3);
      }
    }
  }

  // Floods stain the ground beneath structures. This is deliberately before
  // shadows and objects, so foundations, rubble and people all keep their depth.
  for (const k of floodedCells) {
    const tx = k % d.width;
    const ty = (k - tx) / d.width;
    const cx = originX + isoX(tx, ty);
    const cy = originY + isoY(tx, ty);
    const diamond = [
      { x: cx, y: cy - TILE_H / 2 }, { x: cx + TILE_W / 2, y: cy },
      { x: cx, y: cy + TILE_H / 2 }, { x: cx - TILE_W / 2, y: cy },
    ];
    // Standing flood water, read as water: a solid river-blue fill, a heavier
    // wash of the brighter shade, and a scatter of glints. Deeper and more
    // obvious than a faint stain, because a flood the player called for should
    // plainly be there.
    drawIsoDiamond(gctx, cx, cy, gradeHex(PAL.riv2, variant));
    ditherPolyHard(gctx, diamond, gradeHex(PAL.riv1, variant), 8);
    ditherPolyHard(gctx, diamond, gradeHex(PAL.rivGlint, variant), 3);
  }

  // The rails. Drawn as a polyline along the route rather than as tiles: the
  // corridors between graph nodes bend, so a per-cell rail tile would miss them.
  {
    const route = city.tram.route;
    const rail = gradeHex(PAL.soot3, variant);
    const sleeper = gradeHex(shadeHex(PAL.wood1, -0.1), variant);
    for (let i = 0; i + 1 < route.length; i++) {
      const a = route[i];
      const b = route[i + 1];
      const ax = originX + isoX(city.graph.cx[a], city.graph.cy[a]);
      const ay = originY + isoY(city.graph.cx[a], city.graph.cy[a]);
      const bx = originX + isoX(city.graph.cx[b], city.graph.cy[b]);
      const by = originY + isoY(city.graph.cx[b], city.graph.cy[b]);
      // The polyline is a straight line between two graph nodes, but the CORRIDOR
      // between them bends, so a naive line lays sleepers across open water where
      // it cuts a corner. Step along in tile space and lay track only where the
      // ground can actually carry it.
      const acx = city.graph.cx[a];
      const acy = city.graph.cy[a];
      const bcx = city.graph.cx[b];
      const bcy = city.graph.cy[b];
      const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 5));
      let runStart: { x: number; y: number } | null = null;
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const tx2 = Math.round(acx + (bcx - acx) * t);
        const ty2 = Math.round(acy + (bcy - acy) * t);
        const solid = tx2 >= 0 && ty2 >= 0 && tx2 < d.width && ty2 < d.height
          && d.tile[cellKey(d, tx2, ty2)] !== Tile.Water
          && d.tile[cellKey(d, tx2, ty2)] !== Tile.Void;
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        if (!solid) {
          if (runStart) {
            lineHard(gctx, { x: runStart.x, y: runStart.y - 1 }, { x, y: y - 1 }, rail);
            lineHard(gctx, { x: runStart.x, y: runStart.y + 2 }, { x, y: y + 2 }, rail);
            runStart = null;
          }
          continue;
        }
        if (!runStart) runStart = { x, y };
        gctx.fillStyle = sleeper;
        gctx.fillRect(Math.round(x) - 3, Math.round(y), 7, 1);
      }
      if (runStart) {
        lineHard(gctx, { x: runStart.x, y: runStart.y - 1 }, { x: bx, y: by - 1 }, rail);
        lineHard(gctx, { x: runStart.x, y: runStart.y + 2 }, { x: bx, y: by + 2 }, rail);
      }
    }
  }

  drawCastShadows(gctx, city, d, originX, originY, variant);

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
      // Never bake a shadow onto open water.
      if (d.tile[cellKey(d, x, y)] === Tile.Water) continue;
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
  for (const pr of naturalProps) {
    ditherPolyHard(gctx, [
      { x: pr.wx + 1, y: pr.wy - 3 }, { x: pr.wx + 8, y: pr.wy + 1 },
      { x: pr.wx + 1, y: pr.wy + 5 }, { x: pr.wx - 6, y: pr.wy + 1 },
    ], PAL.soot0, 6);
  }
  for (const pr of streetProps) {
    ditherPolyHard(gctx, [
      { x: pr.wx - 2, y: pr.wy }, { x: pr.wx + 4, y: pr.wy + 2 },
      { x: pr.wx - 2, y: pr.wy + 3 }, { x: pr.wx - 6, y: pr.wy + 2 },
    ], PAL.soot0, 5);
  }

  // Road works. A drain or gas repair means a crew has the street open: to reach
  // a buried main you dig up the road above it, not the house. So a building with
  // an active pipe works order gets a trench, spoil, a barrier and a lamp on the
  // street tile in front of its door. This is the physical form of "the works are
  // in", and the reason a cut main and its repair both leave a mark on the ward.
  for (const bld of city.buildings) {
    const order = latestOrderFor(city, bld.id);
    if (!order || order.status !== 'working' || order.kind === 'fabric') continue;
    // The street cell the door opens onto, so the trench sits on the road.
    let wx = -1;
    let wy = -1;
    // Prefer the cells toward the camera first, so the trench lands where it can
    // be seen rather than tucked behind the building.
    for (const [dx, dy] of [[0, 1], [1, 0], [1, 1], [-1, 0], [0, -1], [-1, 1], [1, -1], [-1, -1]]) {
      const nx = bld.doorX + dx;
      const ny = bld.doorY + dy;
      if (nx < 0 || ny < 0 || nx >= d.width || ny >= d.height) continue;
      const nk = cellKey(d, nx, ny);
      const t = d.tile[nk];
      if ((t === Tile.Street || t === Tile.Alley || t === Tile.Square || t === Tile.Embankment)
        && d.buildingId[nk] < 0) {
        wx = originX + isoX(nx, ny);
        wy = originY + isoY(nx, ny);
        break;
      }
    }
    if (wx < 0) continue;
    drawRoadWorks(gctx, wx, wy, order.kind, variant);
  }

  // Lamp pools are NO LONGER baked here. They are drawn per frame, right after
  // the ground blit and before the buildings, so they still occlude correctly
  // under walls but can now light one at a time as evening falls and flicker as
  // gaslight does. See drawLamps in render/fx.ts.

  // Collapse all generated washes into the finite lighting palette once, at
  // bake time. The frame now has art-directed colour ramps rather than hundreds
  // of accidental near-duplicates.
  hardenAlpha(gctx, ground.width, ground.height, variant);

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

  const props = naturalProps.concat(squareProps, streetProps, marketProps);
  props.sort((a, b) => a.depth - b.depth);
  return {
    cartRoutes: buildCartRoutes(city), variant,
    worksRevision: city.works.revision, deputationRevision: city.deputations.revision,
    civicVisitRevision: city.civicVisits.revision,
    disasterRevision: city.disasters.revision,
    weatherRevision: weather.revision,
    dailyRevision: dailyStreetRevisionAt(city.tick),
    buildingRevision: buildingVisualRevision(city),
    shelterRevision: city.shelters.revision,
    occasionRevision: city.occasions.revision,
    riverLevel: drop * 8 + riverLevel,
    ground, props, idBuffer, idCtx, statics, originX, originY,
  };
}

function depthOf(b: Building): number {
  return depthKey(b.ox + b.w - 1, b.oy + b.d - 1, LAYER_STRUCT);
}

export function debugSkin(city: City, b: Building) {
  return specFor(city, b, city.district.grime[cellKey(city.district, b.ox, b.oy)], variantFor(minuteOfDay(city.tick), weatherAt(city.seed, city.tick).kind));
}

export function flattenBuilding(
  city: City, b: Building, variant: Variant = variantFor(minuteOfDay(city.tick), weatherAt(city.seed, city.tick).kind),
): StaticSprite {
  const grime = city.district.grime[cellKey(city.district, b.ox, b.oy)];
  const spec = specFor(city, b, grime, variant);
  const bounds = houseBounds(spec);
  const pad = 4;
  const w = bounds.maxX - bounds.minX + pad * 2;
  const ht = bounds.maxY - bounds.minY + pad * 2;
  const sprite = makeCanvas(w, ht);
  const ctx = ctxOf(sprite);
  const ax = -bounds.minX + pad;
  const ay = -bounds.minY + pad;

  const windows: WindowLight[] = [];
  drawHouse(ctx, ax, ay, spec, windows);
  // Binary alpha, as the palette contract has always claimed. Partial alpha
  // breaks the source-in silhouette stamp the ID buffer depends on, and halos the
  // sprite against the ground.
  hardenAlpha(ctx, sprite.width, sprite.height, variant);

  const sx = b.ox + b.w - 1;
  const sy = b.oy + b.d - 1;
  return {
    buildingId: b.id, sprite, ax, ay,
    wx: isoX(sx, sy), wy: isoY(sx, sy),
    depth: depthKey(sx, sy, LAYER_STRUCT),
    windows,
    wallH: spec.wallH,
    washing: spec.washing === true && ((spec.salt ?? 0) % 6) === 0,
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

/**
 * The visible walls of the river channel: the two camera-facing faces under the
 * bank lip of each water cell. The south seams need nothing drawn, because the
 * later-painted land diamond occludes the sunken surface behind it, which is
 * exactly what a raised near bank does to water.
 */
function drawBankWalls(
  ctx: CanvasRenderingContext2D, d: District,
  tx: number, ty: number, cx: number, cy: number, drop: number, level: number, variant: Variant,
): void {
  const HW = TILE_W / 2;
  const HH = TILE_H / 2;
  for (const side of [0, 1]) {
    const nx = side === 0 ? tx - 1 : tx;
    const ny = side === 0 ? ty : ty - 1;
    if (nx < 0 || ny < 0) continue;
    const nTile = d.tile[cellKey(d, nx, ny)];
    if (nTile === Tile.Water || nTile === Tile.Void) continue;
    // Face material follows what stands on the lip above it.
    const ashlar = nTile === Tile.Embankment || nTile === Tile.Bridge || nTile === Tile.Square;
    const timber = nTile === Tile.Wharf;
    const face = ashlar ? shadeHex(PAL.stone1, -0.22) : timber ? shadeHex(PAL.wood1, -0.12) : shadeHex(PAL.dirt0, -0.1);
    const dark = ashlar ? PAL.stone0 : timber ? PAL.wood0 : shadeHex(PAL.dirt0, -0.3);
    const a = side === 0 ? { x: cx - HW, y: cy } : { x: cx, y: cy - HH };
    const b = side === 0 ? { x: cx, y: cy - HH } : { x: cx + HW, y: cy };
    fillPolyHard(ctx, [
      a, b, { x: b.x, y: b.y + drop }, { x: a.x, y: a.y + drop },
    ], gradeHex(side === 0 ? face : shadeHex(face, -0.14), variant));
    // Coursing on masonry, piles on timber, nothing on bare earth.
    if (ashlar) {
      for (let row = 3; row < drop - 1; row += 3) {
        lineHard(ctx, { x: a.x, y: a.y + row }, { x: b.x, y: b.y + row }, gradeHex(dark, variant));
      }
    } else if (timber) {
      const n = 4;
      for (let i = 1; i < n; i++) {
        const t = i / n;
        const px = Math.round(a.x + (b.x - a.x) * t);
        const py = Math.round(a.y + (b.y - a.y) * t);
        ctx.fillStyle = gradeHex(dark, variant);
        ctx.fillRect(px, py + 1, 1, drop - 1);
      }
    }
    // A bridge face is a pier wall with an arch through it, so the crossing
    // reads as a structure standing IN the river, not paint on top of it.
    if (nTile === Tile.Bridge && drop >= 4) {
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const half = Math.abs(b.x - a.x) * 0.3;
      const top = 2;
      const arch = [
        { x: mx - half, y: my + drop }, { x: mx - half, y: my + top + 2 },
        { x: mx, y: my + top }, { x: mx + half, y: my + top + 2 },
        { x: mx + half, y: my + drop },
      ];
      fillPolyHard(ctx, arch, gradeHex(shadeHex(PAL.riv1, -0.5), variant));
      lineHard(ctx, { x: mx - half, y: my + top + 2 }, { x: mx, y: my + top }, gradeHex(PAL.stone2, variant));
      lineHard(ctx, { x: mx, y: my + top }, { x: mx + half, y: my + top + 2 }, gradeHex(PAL.stone2, variant));
    }
    // The waterline stains the foot of the wall, and a falling river leaves
    // pale tide marks above it.
    lineHard(ctx, { x: a.x, y: a.y + drop - 1 }, { x: b.x, y: b.y + drop - 1 }, gradeHex(dark, variant));
    if (level <= 1) {
      const mark = gradeHex(shadeHex(face, 0.25), variant);
      lineHard(ctx, { x: a.x, y: a.y + drop - 3 }, { x: b.x, y: b.y + drop - 3 }, mark);
      if (drop > 6) lineHard(ctx, { x: a.x, y: a.y + drop - 5 }, { x: b.x, y: b.y + drop - 5 }, mark);
    }
  }
}
function drawDryBed(ctx: CanvasRenderingContext2D, cx: number, cy: number, salt: number, variant: Variant): void {
  // Fill base diamond with graded dirt.
  fillPolyHard(ctx, [
    { x: cx, y: cy - 8 },
    { x: cx + 16, y: cy },
    { x: cx, y: cy + 8 },
    { x: cx - 16, y: cy }
  ], gradeHex(shadeHex(PAL.dirt0, -0.12), variant));
  // Add damp patches with dither.
  ditherPolyHard(ctx, [
    { x: cx, y: cy - 8 },
    { x: cx + 16, y: cy },
    { x: cx, y: cy + 8 },
    { x: cx - 16, y: cy }
  ], gradeHex(shadeHex(PAL.dirt0, -0.35), variant), 4);
  // Draw crack lines.
  const crackCount = 3 + (mix(salt, 1, 0, 0) % 2);
  for (let i = 0; i < crackCount; i++) {
    const hx = cx - 8 + (mix(salt, 2, i, 0) % 16);
    const hy = cy - 4 + (mix(salt, 3, i, 0) % 8);
    lineHard(ctx, { x: hx, y: hy }, { x: hx + 2, y: hy + (mix(salt, 4, i, 0) % 2) }, gradeHex(shadeHex(PAL.dirt0, -0.5), variant));
  }
  // Place stones.
  const stoneCount = 1 + (mix(salt, 5, 0, 0) % 2);
  for (let i = 0; i < stoneCount; i++) {
    const px = cx - 8 + (mix(salt, 6, i, 0) % 16);
    const py = cy - 4 + (mix(salt, 7, i, 0) % 8);
    fillPolyHard(ctx, [{ x: px, y: py }, { x: px + 1, y: py }], gradeHex(PAL.stone1, variant));
  }
  // Add puddle.
  if (salt % 5 === 0) {
    const px = cx - 3 + (mix(salt, 8, 0, 0) % 6);
    const py = cy - 1 + (mix(salt, 9, 0, 0) % 2);
    ditherPolyHard(ctx, [
      { x: px, y: py - 1 },
      { x: px + 3, y: py },
      { x: px, y: py + 1 },
      { x: px - 3, y: py }
    ], gradeHex(PAL.riv2, variant), 9);
  }
}

function drawIslandUnderside(ctx: CanvasRenderingContext2D, d: District, seed: number, originX: number, originY: number, drop: number, variant: Variant): void {
  for (let ty = 0; ty < d.height; ty++) {
    for (let tx = 0; tx < d.width; tx++) {
      if (!insideIsland(d, tx, ty)) continue;
      const cx = originX + isoX(tx, ty);
      const cy = originY + isoY(tx, ty);
      const tile = d.tile[ty * d.width + tx];
      // Check bottom-left neighbour.
      if (ty + 1 >= d.height || !insideIsland(d, tx, ty + 1)) {
        const a = { x: cx - 16, y: cy + (tile === Tile.Water ? drop : 0) };
        const b = { x: cx, y: cy + 8 + (tile === Tile.Water ? drop : 0) };
        const h = 40 - (tile === Tile.Water ? drop : 0);
        let yOff = 0;
        // Topsoil band.
        const topCol = tile === Tile.Water ? shadeHex(PAL.dirt1, -0.3) : shadeHex(PAL.dirt0, -0.2);
        const topH = tile === Tile.Water ? 4 : 5;
        fillPolyHard(ctx, [
          { x: a.x, y: a.y + yOff },
          { x: b.x, y: b.y + yOff },
          { x: b.x, y: b.y + yOff + topH },
          { x: a.x, y: a.y + yOff + topH }
        ], gradeHex(shadeHex(topCol, -0.14), variant));
        yOff += topH;
        // Dither seam.
        ditherPolyHard(ctx, [
          { x: a.x, y: a.y + yOff - 2 },
          { x: b.x, y: b.y + yOff - 2 },
          { x: b.x, y: b.y + yOff },
          { x: a.x, y: a.y + yOff }
        ], gradeHex(shadeHex(PAL.ochre0, -0.14), variant), 8);
        // Subsoil band.
        fillPolyHard(ctx, [
          { x: a.x, y: a.y + yOff },
          { x: b.x, y: b.y + yOff },
          { x: b.x, y: b.y + yOff + 12 },
          { x: a.x, y: a.y + yOff + 12 }
        ], gradeHex(shadeHex(PAL.ochre0, -0.14), variant));
        yOff += 12;
        // Dither seam.
        ditherPolyHard(ctx, [
          { x: a.x, y: a.y + yOff - 2 },
          { x: b.x, y: b.y + yOff - 2 },
          { x: b.x, y: b.y + yOff },
          { x: a.x, y: a.y + yOff }
        ], gradeHex(shadeHex(PAL.soot1, -0.14), variant), 8);
        // Rock band.
        const rockH = h - yOff;
        fillPolyHard(ctx, [
          { x: a.x, y: a.y + yOff },
          { x: b.x, y: b.y + yOff },
          { x: b.x, y: b.y + yOff + rockH },
          { x: a.x, y: a.y + yOff + rockH }
        ], gradeHex(shadeHex(PAL.soot1, -0.14), variant));
        // Ragged bottom.
        ditherPolyHard(ctx, [
          { x: a.x, y: a.y + yOff + rockH - 4 },
          { x: b.x, y: b.y + yOff + rockH - 4 },
          { x: b.x, y: b.y + yOff + rockH },
          { x: a.x, y: a.y + yOff + rockH }
        ], gradeHex(shadeHex(PAL.soot0, -0.14), variant), 8);
        // Roots for park/yard.
        if (tile === Tile.Park || tile === Tile.Yard) {
          const rootCount = 2 + (mix(seed, 57, tx, ty) % 2);
          for (let i = 0; i < rootCount; i++) {
            const rx = a.x + (mix(seed, 58, tx, ty + i) % 14) + 1;
            const ryStart = a.y + 2;
            const rootLen = 4 + (mix(seed, 60, tx, ty + i) % 6);
            lineHard(ctx, { x: rx, y: ryStart }, { x: rx, y: ryStart + rootLen }, gradeHex(shadeHex(PAL.wood0, -0.2), variant));
            if (mix(seed, 61, tx, ty + i) % 3 === 0) {
              lineHard(ctx, { x: rx, y: ryStart + rootLen - 1 }, { x: rx + 1, y: ryStart + rootLen - 1 }, gradeHex(shadeHex(PAL.wood0, -0.2), variant));
            }
          }
        }
      }
      // Check bottom-right neighbour.
      if (tx + 1 >= d.width || !insideIsland(d, tx + 1, ty)) {
        const a = { x: cx, y: cy + 8 + (tile === Tile.Water ? drop : 0) };
        const b = { x: cx + 16, y: cy + (tile === Tile.Water ? drop : 0) };
        const h = 40 - (tile === Tile.Water ? drop : 0);
        let yOff = 0;
        // Topsoil band.
        const topCol = tile === Tile.Water ? shadeHex(PAL.dirt1, -0.3) : shadeHex(PAL.dirt0, -0.2);
        const topH = tile === Tile.Water ? 4 : 5;
        fillPolyHard(ctx, [
          { x: a.x, y: a.y + yOff },
          { x: b.x, y: b.y + yOff },
          { x: b.x, y: b.y + yOff + topH },
          { x: a.x, y: a.y + yOff + topH }
        ], gradeHex(topCol, variant));
        yOff += topH;
        // Dither seam.
        ditherPolyHard(ctx, [
          { x: a.x, y: a.y + yOff - 2 },
          { x: b.x, y: b.y + yOff - 2 },
          { x: b.x, y: b.y + yOff },
          { x: a.x, y: a.y + yOff }
        ], gradeHex(PAL.ochre0, variant), 8);
        // Subsoil band.
        fillPolyHard(ctx, [
          { x: a.x, y: a.y + yOff },
          { x: b.x, y: b.y + yOff },
          { x: b.x, y: b.y + yOff + 12 },
          { x: a.x, y: a.y + yOff + 12 }
        ], gradeHex(PAL.ochre0, variant));
        yOff += 12;
        // Dither seam.
        ditherPolyHard(ctx, [
          { x: a.x, y: a.y + yOff - 2 },
          { x: b.x, y: b.y + yOff - 2 },
          { x: b.x, y: b.y + yOff },
          { x: a.x, y: a.y + yOff }
        ], gradeHex(PAL.soot1, variant), 8);
        // Rock band.
        const rockH = h - yOff;
        fillPolyHard(ctx, [
          { x: a.x, y: a.y + yOff },
          { x: b.x, y: b.y + yOff },
          { x: b.x, y: b.y + yOff + rockH },
          { x: a.x, y: a.y + yOff + rockH }
        ], gradeHex(PAL.soot1, variant));
        // Ragged bottom.
        ditherPolyHard(ctx, [
          { x: a.x, y: a.y + yOff + rockH - 4 },
          { x: b.x, y: b.y + yOff + rockH - 4 },
          { x: b.x, y: b.y + yOff + rockH },
          { x: a.x, y: a.y + yOff + rockH }
        ], gradeHex(PAL.soot0, variant), 8);
        // Caves.
        if (mix(seed, 59, tx, ty) % 23 === 0) {
          const caveX = a.x + 3;
          const caveY = a.y + yOff + 2;
          fillPolyHard(ctx, [
            { x: caveX, y: caveY },
            { x: caveX + 3, y: caveY - 2 },
            { x: caveX + 7, y: caveY - 2 },
            { x: caveX + 7, y: caveY + 3 },
            { x: caveX, y: caveY + 3 }
          ], gradeHex(PAL.soot0, variant));
          lineHard(ctx, { x: caveX, y: caveY - 1 }, { x: caveX + 7, y: caveY - 1 }, PAL.stone1);
        }
      }
    }
  }
}


/** Surfaces a kerb separates: the made road and its footways, not the yards. */
const PAVED = new Set<number>([
  Tile.Street, Tile.Alley, Tile.Square, Tile.Embankment, Tile.Wharf, Tile.Rail, Tile.Bridge,
]);

/**
 * Kerbs and gutters.
 *
 * The streets were the last flat surface in the frame: a made road in 1890
 * has a raised kerb and a channel running beside it, and without that edge the
 * paving simply washed into the yards it abuts. The gutter also gives the rain
 * somewhere to go, which is why it runs only when it is raining.
 */
function drawKerbs(
  ctx: CanvasRenderingContext2D, city: City, d: District,
  originX: number, originY: number, variant: Variant, precipitation: number,
): void {
  const HW = TILE_W / 2;
  const HH = TILE_H / 2;
  // Each edge of the diamond, its neighbour, and the inward step that carries
  // the footway onto the road cell rather than under the building.
  const EDGES = [
    { dx: -1, dy: 0, ax: -HW, ay: 0, bx: 0, by: -HH, nx: 2, ny: 1 },
    { dx: 0, dy: -1, ax: 0, ay: -HH, bx: HW, by: 0, nx: -2, ny: 1 },
    { dx: 1, dy: 0, ax: HW, ay: 0, bx: 0, by: HH, nx: -2, ny: -1 },
    { dx: 0, dy: 1, ax: 0, ay: HH, bx: -HW, by: 0, nx: 2, ny: -1 },
  ];
  for (let ty = 0; ty < d.height; ty++) {
    for (let tx = 0; tx < d.width; tx++) {
      const k = cellKey(d, tx, ty);
      const tile = d.tile[k];
      if (!PAVED.has(tile) || tile === Tile.Bridge) continue;
      if (!insideIsland(d, tx, ty)) continue;
      const cx = originX + isoX(tx, ty);
      const cy = originY + isoY(tx, ty);
      const polite = d.polite[k] === 1;
      for (const e of EDGES) {
        const nx = tx + e.dx;
        const ny = ty + e.dy;
        if (nx < 0 || ny < 0 || nx >= d.width || ny >= d.height) continue;
        const nk = cellKey(d, nx, ny);
        const nTile = d.tile[nk];
        // The footway runs where the road meets a frontage or a plot. Two road
        // cells share a carriageway, and the quay wall already edges the water.
        if (PAVED.has(nTile) || nTile === Tile.Water || nTile === Tile.Void) continue;
        const a = { x: cx + e.ax, y: cy + e.ay };
        const b = { x: cx + e.bx, y: cy + e.by };
        // Flagged footway, laid ON the road cell so the building in front of it
        // does not cover the very thing it fronts onto.
        const ia = { x: a.x + e.nx * 2, y: a.y + e.ny * 2 };
        const ib = { x: b.x + e.nx * 2, y: b.y + e.ny * 2 };
        fillPolyHard(ctx, [a, b, ib, ia],
          gradeHex(shadeHex(polite ? PAL.stone3 : PAL.stone2, -0.1), variant));
        // Flag joints across the footway, then the kerb along its road edge.
        const flags = 3;
        for (let i = 1; i < flags; i++) {
          const t = i / flags;
          lineHard(ctx,
            { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
            { x: ia.x + (ib.x - ia.x) * t, y: ia.y + (ib.y - ia.y) * t },
            gradeHex(shadeHex(polite ? PAL.stone3 : PAL.stone2, -0.35), variant));
        }
        lineHard(ctx, ia, ib, gradeHex(polite ? PAL.stone4 : PAL.stone3, variant));
        // The channel, immediately below the kerb on the road side.
        const g0 = { x: ia.x + e.nx / 2, y: ia.y + e.ny / 2 };
        const g1 = { x: ib.x + e.nx / 2, y: ib.y + e.ny / 2 };
        lineHard(ctx, g0, g1, gradeHex(shadeHex(PAL.cobble0, -0.35), variant));
        if (precipitation > 0) {
          // Rain finds the channel. Dashes rather than a line, because running
          // water catches the light in pieces.
          const h = mix(city.seed, Stream.Weather, k, e.dx * 3 + e.dy);
          const runs = precipitation === 2 ? 3 : 2;
          for (let i = 0; i < runs; i++) {
            const t = 0.15 + (((h >>> (i * 4)) % 65) / 100);
            const px = Math.round(g0.x + (g1.x - g0.x) * t);
            const py = Math.round(g0.y + (g1.y - g0.y) * t);
            ctx.fillStyle = gradeHex((h >>> 12) % 3 === 0 ? PAL.rivGlint : PAL.riv2, variant);
            ctx.fillRect(px, py, 2, 1);
          }
        }
      }
    }
  }
}

/**
 * The crossings, as structures rather than painted strips.
 *
 * A bridge was a flat run of deck colour with nothing at its edges, so it read
 * as a plank laid on the water instead of something built. Stone crossings get
 * an ashlar deck and a balustrade; timber ones get planking and a post rail.
 * Parapets are drawn after the whole ground plane so the deck the player walks
 * on is never cut into by the water it spans.
 */
function drawBridgeDecks(
  ctx: CanvasRenderingContext2D, city: City, d: District,
  originX: number, originY: number, drop: number, variant: Variant,
): void {
  const HW = TILE_W / 2;
  const HH = TILE_H / 2;
  for (const bridge of city.river.bridges) {
    const width = bridge.stone ? 2 : 1;
    for (let ty = bridge.y0; ty <= bridge.y1; ty++) {
      for (let dx = 0; dx < width; dx++) {
        const tx = bridge.x + dx;
        if (tx < 0 || ty < 0 || tx >= d.width || ty >= d.height) continue;
        const k = cellKey(d, tx, ty);
        if (d.tile[k] !== Tile.Bridge) continue;
        const cx = originX + isoX(tx, ty);
        const cy = originY + isoY(tx, ty);
        const overWater = ty > bridge.y0 && ty < bridge.y1;
        // A stone crossing has a stone deck. The ground bake paints every
        // bridge cell in timber because the tile does not know which kind of
        // crossing it belongs to, which left ashlar parapets on a plank road.
        if (bridge.stone) {
          drawIsoDiamond(ctx, cx, cy, gradeHex(shadeHex(PAL.stone2, -0.2), variant));
        }
        // Deck: ashlar blocks across a stone crossing, planks across a timber
        // one, both running the way the traffic does.
        // The joint has to clear the quantiser: a two-step wash off the deck
        // colour lands in the same palette entry and draws nothing at all.
        const deckLine = gradeHex(
          bridge.stone ? shadeHex(PAL.stone2, -0.4) : shadeHex(PAL.wood1, -0.3), variant,
        );
        const steps = bridge.stone ? 3 : 5;
        for (let i = 1; i < steps; i++) {
          const t = i / steps;
          lineHard(ctx,
            { x: cx - HW + HW * t, y: cy + HH * t },
            { x: cx + HW * t, y: cy - HH + HH * t }, deckLine);
        }
        // Parapets on the outer edges only, so a two-cell stone bridge does
        // not grow a wall down the middle of its own carriageway.
        for (const side of [0, 1]) {
          if (side === 0 && dx !== 0) continue;
          if (side === 1 && dx !== width - 1) continue;
          const a = side === 0 ? { x: cx - HW, y: cy } : { x: cx + HW, y: cy };
          const b = side === 0 ? { x: cx, y: cy - HH } : { x: cx, y: cy + HH };
          const H = bridge.stone ? 6 : 5;
          if (bridge.stone) {
            fillPolyHard(ctx, [
              { x: a.x, y: a.y - H }, { x: b.x, y: b.y - H },
              { x: b.x, y: b.y }, { x: a.x, y: a.y },
            ], gradeHex(side === 0 ? shadeHex(PAL.stone2, -0.1) : shadeHex(PAL.stone2, -0.22), variant));
            // Coping along the top, and balusters below it.
            lineHard(ctx, { x: a.x, y: a.y - H }, { x: b.x, y: b.y - H },
              gradeHex(PAL.stone3, variant));
            const n = 5;
            for (let i = 1; i < n; i++) {
              const t = i / n;
              const px = Math.round(a.x + (b.x - a.x) * t);
              const py = Math.round(a.y + (b.y - a.y) * t);
              ctx.fillStyle = gradeHex(shadeHex(PAL.stone1, -0.15), variant);
              ctx.fillRect(px, py - H + 2, 1, H - 3);
            }
          } else {
            // Timber: a top rail on posts, with daylight between them.
            const n = 4;
            for (let i = 0; i <= n; i++) {
              const t = i / n;
              const px = Math.round(a.x + (b.x - a.x) * t);
              const py = Math.round(a.y + (b.y - a.y) * t);
              ctx.fillStyle = gradeHex(PAL.wood0, variant);
              ctx.fillRect(px, py - H, 1, H);
            }
            lineHard(ctx, { x: a.x, y: a.y - H }, { x: b.x, y: b.y - H },
              gradeHex(PAL.wood1, variant));
            lineHard(ctx, { x: a.x, y: a.y - H + 3 }, { x: b.x, y: b.y - H + 3 },
              gradeHex(shadeHex(PAL.wood0, 0.1), variant));
          }
        }
        // A cutwater at the pier: the pointed prow that splits the current,
        // standing in the channel below the deck on the upstream side.
        if (overWater && bridge.stone && dx === 0 && drop >= 4) {
          const px = cx - HW;
          const py = cy + drop;
          fillPolyHard(ctx, [
            { x: px, y: py - drop + 2 }, { x: px - 5, y: py - 1 },
            { x: px, y: py + 2 },
          ], gradeHex(shadeHex(PAL.stone1, -0.2), variant));
          lineHard(ctx, { x: px, y: py - drop + 2 }, { x: px - 5, y: py - 1 },
            gradeHex(PAL.stone2, variant));
        }
      }
    }
  }
}


/**
 * How far a storey throws its shadow, in cells, by the light of the hour.
 *
 * The sun is low at either end of the day and high in the middle, and an
 * overcast sky throws no shadow at all: the light is coming off the whole
 * dome rather than one point in it, which is a real and very visible thing
 * about weather that the grade alone cannot say.
 */
const SHADOW_REACH: Record<Variant, number> = {
  dawn: 1.7,
  day: 0.55,
  golden: 1.5,
  dusk: 2.0,
  night: 0,
  smallhours: 0,
  overcastday: 0,
  gloom: 0,
  fogpale: 0,
};

/**
 * Cast shadows.
 *
 * The district had a contact shadow under each footprint and nothing else, so
 * three hundred buildings stood on a flat map with no sunlight crossing it:
 * the hour changed the colour of the light without changing the shape of
 * anything. This walks back from every open cell toward the sun and asks
 * whether something tall enough stands in the way, which costs one grid pass
 * at bake time and gives the whole town a direction the light comes from.
 *
 * The key light in this art has always come from the screen-left, so shadows
 * fall along +x, which is screen right and down. Rotating the sun through the
 * day would fight every baked wall face in the game, so the hour changes the
 * LENGTH of the shadow and never its direction.
 */
function drawCastShadows(
  ctx: CanvasRenderingContext2D, city: City, d: District,
  originX: number, originY: number, variant: Variant,
): void {
  const reach = SHADOW_REACH[variant] ?? 0;
  if (reach <= 0) return;
  let tallest = 1;
  for (const b of city.buildings) if (b.storeys > tallest) tallest = b.storeys;
  const maxStep = Math.max(1, Math.ceil(tallest * reach));
  const near = gradeHex(PAL.soot0, variant);
  for (let ty = 0; ty < d.height; ty++) {
    for (let tx = 0; tx < d.width; tx++) {
      const k = cellKey(d, tx, ty);
      const tile = d.tile[k];
      if (tile === Tile.Void || tile === Tile.Water) continue;
      if (!insideIsland(d, tx, ty)) continue;
      // A cell under a building already has its own contact shadow, and the
      // building sprite covers it in any case.
      if (d.buildingId[k] >= 0) continue;
      let depth = 0;
      for (let step = 1; step <= maxStep; step++) {
        const sx = tx - step;
        if (sx < 0) break;
        const bid = d.buildingId[cellKey(d, sx, ty)];
        if (bid < 0) continue;
        const b = city.buildings[bid];
        if (!b) continue;
        if (b.storeys * reach >= step) { depth = step; break; }
      }
      if (depth === 0) continue;
      // The far end of a shadow is softer than its root: one step of density
      // is all the palette allows, and it is enough to keep a long evening
      // shadow from reading as a painted stripe.
      const cx = originX + isoX(tx, ty);
      const cy = originY + isoY(tx, ty);
      ditherPolyHard(ctx, [
        { x: cx, y: cy - TILE_H / 2 }, { x: cx + TILE_W / 2, y: cy },
        { x: cx, y: cy + TILE_H / 2 }, { x: cx - TILE_W / 2, y: cy },
      ], near, depth <= 1 ? 11 : depth <= 2 ? 9 : depth <= 4 ? 7 : 5);
    }
  }
}


/**
 * Where the river leaves the island.
 *
 * The channel used to stop dead against the soil cliff, which read as a pool
 * cut off rather than a river running somewhere. On a district that hangs in
 * the air there is only one honest thing for the water to do at the edge, so
 * it goes over: a lip of foam, falling water down the cliff face, and mist
 * where it disappears into the void.
 */
function drawOutfalls(
  ctx: CanvasRenderingContext2D, city: City, d: District,
  originX: number, originY: number, drop: number, variant: Variant,
): void {
  const HW = TILE_W / 2;
  const HH = TILE_H / 2;
  const level = riverLevelAt(city.seed, city.tick);
  if (level === 0) return;
  const pale = gradeHex(PAL.rivGlint, variant);
  const deep = gradeHex(shadeHex(PAL.riv1, -0.2), variant);
  for (let ty = 0; ty < d.height; ty++) {
    for (let tx = 0; tx < d.width; tx++) {
      const k = cellKey(d, tx, ty);
      if (d.tile[k] !== Tile.Water) continue;
      // Only the cells that actually sit on the brink: the two camera-facing
      // sides are the ones a fall would be visible on.
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const nx = tx + dx;
        const ny = ty + dy;
        const off = nx >= d.width || ny >= d.height || !insideIsland(d, nx, ny)
          || d.tile[cellKey(d, nx, ny)] === Tile.Void;
        if (!off) continue;
        const cx = originX + isoX(tx, ty);
        const cy = originY + isoY(tx, ty) + drop;
        const a = dx === 1 ? { x: cx + HW, y: cy } : { x: cx, y: cy + HH };
        const b = dx === 1 ? { x: cx, y: cy + HH } : { x: cx - HW, y: cy };
        // The lip: a bright line of broken water right at the edge.
        lineHard(ctx, a, b, pale);
        // Only the permanently wet stain is baked. The falling sheet and both
        // foam banks move per frame in drawOutfallFx, after the ground blit.
        const H = 34;
        ditherPolyHard(ctx, [
          { x: a.x, y: a.y + 2 }, { x: b.x, y: b.y + 2 },
          { x: b.x, y: b.y + H }, { x: a.x, y: a.y + H },
        ], deep, 3);
      }
    }
  }
}
