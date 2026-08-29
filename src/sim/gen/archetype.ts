// Stage 0: what KIND of district this seed is.
//
// One hash-picked archetype, chosen before any land is touched, and every later
// stage reads its parameters instead of hardcoding the crossing-town numbers.
// The archetype never lands in stored state as anything but its consequences,
// so replay determinism is untouched: same seed, same archetype, same world.
import type { BuildingKind } from '../types';
import { Tile } from '../types';
import type { District } from '../district';
import { cellKey, inBounds, insideIsland, setTile, tileAt } from '../district';
import { Stream, mulberry32, mix, range } from '../rng';
import type { RiverPlan } from './river';

export type ArchetypeKind = 'milltown' | 'port' | 'garden' | 'crossing';

export interface Archetype {
  kind: ArchetypeKind;
  /** River centreline as percent of grid height, inclusive integer range. */
  riverFracPct: [number, number];
  /** Meander amplitude range. Floats are fine here: never stored in state. */
  riverAmp: [number, number];
  /** Clamp for the channel half width. */
  halfWidthMax: number;
  /** Extra half width ramping up toward the east mouth. */
  mouthExtra: number;
  bridgeMin: number;
  bridgeMax: number;
  /** Civic square width range. */
  squareMin: number;
  squareMax: number;
  /** Wooded rim depth in cells. */
  rimDepth: number;
  /** Percent chance a rim cell is left bare. */
  rimSkipPct: number;
  /** Count range of inner park blobs on the polite bank. */
  parkBlobs: [number, number];
  /** Count range of wharf jetties poking into the water at the mouth. */
  jetties: [number, number];
  /** 0 = none; else trim land rows where abs(y - cy) exceeds this, raggedly. */
  coastShaveY: number;
  /**
   * How far across a block may run before a passage is cut through it. This is
   * the district's grain in one number: a mill town is cut tight and mean, a
   * garden borough is left in long plots nobody walks through.
   */
  blockSpan: number;
  /** Extra frontage cells the block grain allows on top of the base. */
  grainBonus: number;
  /** Extra cells plots may run back from the street before the interior begins. */
  depthBonus: number;
  /** Percent of plots that take a single-cell frontage. The rest widen. */
  narrowFrontPct: number;
  /** Percent of plots that stop two cells deep, leaving back land behind them. */
  shallowPct: number;
  quota: Partial<Record<BuildingKind, { min: number; max: number }>>;
  residueWeight: Partial<Record<BuildingKind, number>>;
}

export const ARCHETYPES: Record<ArchetypeKind, Archetype> = {
  // The river hugs the north edge, the works bank takes most of the island, and
  // the terraces pack in tight around the mills. The square is a working square.
  milltown: {
    kind: 'milltown',
    riverFracPct: [38, 42],
    riverAmp: [2.0, 3.5],
    halfWidthMax: 2,
    mouthExtra: 0,
    bridgeMin: 2,
    bridgeMax: 2,
    squareMin: 5,
    squareMax: 6,
    rimDepth: 1,
    rimSkipPct: 40,
    parkBlobs: [0, 0],
    jetties: [0, 0],
    coastShaveY: 19,
    blockSpan: 7,
    grainBonus: 0,
    depthBonus: 0,
    narrowFrontPct: 70,
    shallowPct: 26,
    quota: {
      mill: { min: 2, max: 3 },
      foundry: { min: 2, max: 2 },
      workshop: { min: 3, max: 4 },
      wharfshed: { min: 2, max: 3 },
      warehouse: { min: 1, max: 2 },
      shop: { min: 6, max: 9 },
    },
    residueWeight: { terrace: 1.7, tenement: 1.4, villa: 0.35, lodging: 1.1 },
  },
  // A wide mouth, a long quay, jetties in the water, and warehouses stacked
  // behind the wharf sheds. Industry here is cargo, not smoke.
  port: {
    kind: 'port',
    riverFracPct: [46, 54],
    riverAmp: [3.0, 5.0],
    halfWidthMax: 2,
    mouthExtra: 2,
    bridgeMin: 2,
    bridgeMax: 3,
    squareMin: 6,
    squareMax: 7,
    rimDepth: 2,
    rimSkipPct: 25,
    parkBlobs: [0, 1],
    jetties: [3, 5],
    coastShaveY: 0,
    blockSpan: 8,
    grainBonus: 1,
    depthBonus: 0,
    narrowFrontPct: 44,
    shallowPct: 46,
    quota: {
      wharfshed: { min: 5, max: 8 },
      warehouse: { min: 4, max: 6 },
      mill: { min: 1, max: 1 },
      foundry: { min: 1, max: 1 },
      shop: { min: 7, max: 10 },
    },
    residueWeight: { lodging: 1.6, tenement: 1.3, villa: 0.5 },
  },
  // The polite bank takes most of the island. A narrow river, one crossing
  // fewer, real parks, and villas where the tenements would have gone.
  garden: {
    kind: 'garden',
    riverFracPct: [56, 61],
    riverAmp: [2.5, 4.0],
    halfWidthMax: 1,
    mouthExtra: 0,
    bridgeMin: 1,
    bridgeMax: 2,
    squareMin: 6,
    squareMax: 8,
    rimDepth: 3,
    rimSkipPct: 10,
    parkBlobs: [2, 4],
    jetties: [0, 0],
    coastShaveY: 0,
    blockSpan: 7,
    grainBonus: 0,
    depthBonus: 1,
    narrowFrontPct: 58,
    shallowPct: 34,
    quota: {
      wharfshed: { min: 2, max: 3 },
      warehouse: { min: 1, max: 2 },
      mill: { min: 1, max: 1 },
      workshop: { min: 2, max: 2 },
      shop: { min: 8, max: 12 },
    },
    residueWeight: { villa: 3.0, terrace: 0.7, tenement: 0.35, lodging: 0.6 },
  },
  // The classic layout: river through the middle, balanced banks. Every value
  // here reproduces the pre-archetype generator exactly, and carveRiver keeps
  // the legacy draw sequence for it, so a crossing seed is bit-identical to
  // what that seed generated before archetypes existed.
  crossing: {
    kind: 'crossing',
    riverFracPct: [47, 53],
    riverAmp: [3.2, 5.6],
    halfWidthMax: 2,
    mouthExtra: 0,
    bridgeMin: 2,
    bridgeMax: 3,
    squareMin: 6,
    squareMax: 9,
    rimDepth: 2,
    rimSkipPct: 22,
    parkBlobs: [0, 0],
    jetties: [0, 0],
    coastShaveY: 0,
    blockSpan: 7,
    grainBonus: 0,
    depthBonus: 0,
    narrowFrontPct: 55,
    shallowPct: 40,
    quota: {},
    residueWeight: {},
  },
};

/** Weighted pick, pure in the seed. Crossing stays the most common town. */
export function pickArchetype(seed: number): Archetype {
  const roll = mix(seed, Stream.GenArchetype, 0) % 100;
  if (roll < 30) return ARCHETYPES.crossing;
  if (roll < 58) return ARCHETYPES.milltown;
  if (roll < 80) return ARCHETYPES.port;
  return ARCHETYPES.garden;
}

/**
 * Elongate the island along the river by shaving the far north and south rows.
 * Ragged, not a clean cut: a straight coastline reads as a map border.
 */
export function shapeCoast(d: District, seed: number, arch: Archetype): void {
  if (arch.coastShaveY <= 0) return;
  const cy = (d.height - 1) / 2;
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      const key = cellKey(d, x, y);
      if (!d.land[key]) continue;
      const limit = arch.coastShaveY + (mix(seed, Stream.GenArchetype, x, y) % 3);
      if (Math.abs(y - cy) > limit) d.land[key] = 0;
    }
  }
}

/**
 * Inner parks on the polite bank, claimed from Void before the blocks are, for
 * the same reason the rim is: nothing is ever left over afterwards.
 */
export function reserveParks(d: District, seed: number, arch: Archetype): void {
  const rng = mulberry32(mix(seed, Stream.GenArchetype, 5));
  const n = range(rng, arch.parkBlobs[0], arch.parkBlobs[1]);
  if (n === 0) return;
  let placed = 0;
  for (let attempt = 0; attempt < 60 && placed < n; attempt++) {
    const x = range(rng, 4, d.width - 5);
    const y = range(rng, 4, d.height - 5);
    if (!insideIsland(d, x, y)) continue;
    if (tileAt(d, x, y) !== Tile.Void) continue;
    if (d.polite[cellKey(d, x, y)] !== 1) continue;
    const radius = range(rng, 2, 3);
    let claimed = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > radius) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(d, nx, ny) || !insideIsland(d, nx, ny)) continue;
        if (tileAt(d, nx, ny) !== Tile.Void) continue;
        setTile(d, nx, ny, Tile.Park);
        claimed++;
      }
    }
    // A sliver against a street is still green, but it does not count as a park.
    if (claimed >= 6) placed++;
  }
}

/**
 * Jetties: short wharf fingers into the channel from the working bank, near the
 * mouth. Only where the river is wide, never near a bridge, and never past the
 * centreline, so the channel is never dammed.
 */
export function addJetties(d: District, seed: number, river: RiverPlan, arch: Archetype): void {
  const rng = mulberry32(mix(seed, Stream.GenArchetype, 9));
  const count = range(rng, arch.jetties[0], arch.jetties[1]);
  if (count === 0) return;

  const startX = Math.round(d.width * 0.55);
  const endX = d.width - 6;
  const candidates: number[] = [];
  for (let x = startX; x <= endX; x++) {
    if (river.halfWidth[x] < 2) continue;
    if (!insideIsland(d, x, river.centre[x])) continue;
    if (river.bridges.some((b) => Math.abs(x - b.x) <= 3)) continue;
    candidates.push(x);
  }
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = range(rng, 0, i);
    const t = candidates[i];
    candidates[i] = candidates[j];
    candidates[j] = t;
  }

  const placedX: number[] = [];
  for (const x of candidates) {
    if (placedX.length >= count) break;
    if (placedX.some((px) => Math.abs(px - x) < 4)) continue;
    const cy = river.centre[x];
    const hw = river.halfWidth[x];
    // Working bank is south of the centreline. Take the two southmost water
    // cells of the channel; rows cy - hw through cy + hw - 2 stay open water.
    const y1 = cy + hw;
    const y2 = cy + hw - 1;
    if (tileAt(d, x, y1) !== Tile.Water || tileAt(d, x, y2) !== Tile.Water) continue;
    setTile(d, x, y1, Tile.Wharf);
    setTile(d, x, y2, Tile.Wharf);
    placedX.push(x);
  }
}
