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
import { hardenAlpha, ditherPolyHard, lineHard, fillPolyHard } from './raster';
import { buildCartRoutes } from './fx';
import type { CartRoute } from './fx';
import type { HouseSpec, HouseSkin, RoofShape, Finial, Frontage } from './house';
import type { WallMaterial, WindowLight } from './detail';
import { mix, Stream } from '../sim/rng';
import { buildMarketProps, buildProps, buildSquareProps, buildStreetProps, textureCell } from './props';
import type { Prop } from './props';
import { worksStageFor, latestOrderFor } from '../sim/works';
import { isDeputationActive } from '../sim/deputations';
import { activePublicVisit } from '../sim/civic-visits';
import { disasterAt, isBuildingClosed, isDisasterActive } from '../sim/disasters';
import type { WardKind } from '../sim/gen/wards';
import { weatherAt, WEATHER_WATCH_MINUTES } from '../sim/weather';
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
  shelterRevision: number;
  occasionRevision: number;
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
  townhall: { roof: [PAL.verd2, PAL.verd1, PAL.verd3], wall: [PAL.stone4, PAL.stone2], shape: 'dome', trim: PAL.gold, dormers: 1, material: 'ashlar', finial: 'dome', finialH: 10, cresting: true },
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

function specFor(city: City, b: Building, grime: number, variant: Variant): HouseSpec {
  const fam = FAMILY[b.kind] ?? DEFAULT_FAMILY;
  const def = DEFS[b.kind];
  const salt = mix(city.seed, 41, b.id);
  const polite = city.district.polite[cellKey(city.district, b.ox, b.oy)] === 1;
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
    chimney: gradeHex(shadeHex(soot > 0.18 ? PAL.soot2 : PAL.brick1, -soot * 0.5), variant),
    // Lit windows at dusk and after. A gaslight-era city with no lit window in it
    // was the single most conspicuous absence in the build: variantFor and the
    // palette entries both existed and neither had ever been called.
    // Ordinary windows are baked dark and lit per frame (see drawWindowLights),
    // so a house lights and empties one room at a time. windowLit here only still
    // drives the landmark glazing (dome drums, cupolas, the winter garden).
    window: PAL.litWindow,
    windowLit: variant !== 'day',
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
    sign: fam.shop === true,
    awning: gradeHex(pickFrom(AWNINGS, salt, 7), variant),
    // Dormers need a slope deep enough to sit one on.
    dormers: fam.dormers && roofH >= 12 && shape !== 'sawtooth' ? fam.dormers : 0,
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
    washing: !polite && dwelling && ((salt >>> 11) % (wardKind === 'courts' ? 2 : 3) === 0),
    cresting: fam.cresting === true || ((wardKind === 'garden' || polite) && b.kind === 'villa'),
    railings: (polite || wardKind === 'garden' || wardKind === 'civic')
      && (b.kind === 'villa' || b.kind === 'bank' || b.kind === 'townhall' || b.kind === 'terrace'),
    worksStage,
    drainState,
    // A mill or foundry has a fire in it around the clock; a scorched shell does
    // not, and neither does an idle collapsed one.
    furnace: (b.kind === 'mill' || b.kind === 'foundry') && !scorched && damage === 'none',
    rainStrength: weatherAt(city.seed, city.tick).precipitation,
    finial,
    finialH: fam.finialH ?? 0,
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
  ctx.fillStyle = variant === 'day' ? g(PAL.buntRed) : g(PAL.gas2, true);
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
export function buildScene(city: City, variant: Variant = variantFor(minuteOfDay(city.tick))): Scene {
  const b = worldBounds();
  const weather = weatherAt(city.seed, city.tick);
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
  const streetProps = buildStreetProps(d, city.seed, variant, city.wards);
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
        // Shallows at the bank, deep water in the channel.
        const dep = depth[k];
        colour = dep <= 1 ? PAL.riv2 : dep === 2 ? PAL.riv1 : shadeHex(PAL.riv1, -0.15);
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
      drawIsoDiamond(gctx, originX + isoX(tx, ty), originY + isoY(tx, ty), gradeHex(colour, variant));
      textureCell(gctx, city.seed, tx, ty, tile, originX, originY, variant, d.polite[k] === 1);

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
    shelterRevision: city.shelters.revision,
    occasionRevision: city.occasions.revision,
    ground, props, idBuffer, idCtx, statics, originX, originY,
  };
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
