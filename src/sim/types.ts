// Shared ids, tile codes and vocabularies. Everything else imports from here, so
// nothing forms an import cycle.
//
// No TypeScript enums anywhere in this project: tsconfig sets erasableSyntaxOnly,
// and enums are not erasable. Const objects plus union types instead.

export type BuildingId = number;
export type SoulId = number;
export type NodeId = number;
export type PlotId = number;
export type BlockId = number;
export type ClaimId = number;
export type FirmId = number;
export type HouseholdId = number;

// The single grid. 64x64 cells at 6m, drawn at TILE_W 32 / TILE_H 16.
// The island mask keeps the playable district dense rather than filling the box.
export const GRID_W = 64;
export const GRID_H = 64;
export const CELL_MM = 6000;

/** Millicells per game-minute. 2500 = 15m/min, so crossing the district is ~20 minutes.
 *  This is a game-feel dial, not a realism one: realistic walking makes souls fly
 *  across the screen at any watchable speed, and it would leave the tram pointless. */
export const WALK_MILLICELL_PER_MIN = 2500;
export const TRAM_MILLICELL_PER_MIN = 10000;

export const Tile = {
  Void: 0,
  Water: 1,
  Wharf: 2,
  Embankment: 3,
  Street: 4,
  Alley: 5,
  Rail: 6,
  Yard: 7,
  Court: 8,
  Plot: 9,
  Square: 10,
  Park: 11,
  Bridge: 12,
} as const;
export type TileCode = (typeof Tile)[keyof typeof Tile];

/** Tiles a soul may stand on. Water, void and plots are not walkable.
 *  Yard is deliberately absent: yards are the one-tile no-walk apron that keeps a
 *  4x4 landmark from sorting in front of a soul standing beside it. */
export const WALKABLE: readonly TileCode[] = [
  Tile.Wharf, Tile.Embankment, Tile.Street, Tile.Alley, Tile.Rail,
  Tile.Court, Tile.Square, Tile.Bridge,
];

export type BuildingKind =
  | 'townhall' | 'exchange' | 'newspaper' | 'constabulary' | 'gasworks'
  | 'pumphouse' | 'tramdepot' | 'mast' | 'chapel' | 'dispensary'
  | 'postexchange' | 'school' | 'bathhouse' | 'glasshouse'
  | 'mill' | 'foundry' | 'workshop' | 'warehouse' | 'wharfshed'
  | 'pub' | 'shop' | 'bank'
  | 'terrace' | 'tenement' | 'courtdwelling' | 'villa' | 'lodging';

export type Trade =
  | 'clerk' | 'millhand' | 'lighterman' | 'engineer' | 'lamplighter' | 'conductor'
  | 'constable' | 'printer' | 'publican' | 'shopkeeper' | 'seamstress' | 'laundress'
  | 'docker' | 'nurse' | 'curate' | 'alderman' | 'child' | 'none';

export type Activity =
  | 'asleep' | 'waking' | 'eating' | 'working' | 'commuting' | 'errand'
  | 'shopping' | 'drinking' | 'worshipping' | 'loitering' | 'visiting'
  | 'ailing' | 'arguing' | 'mourning' | 'striking' | 'gathering'
  | 'hiding' | 'held' | 'dead';

/** Activities during which a soul is on the street graph rather than indoors. */
export const TRAVEL_ACTIVITIES: readonly Activity[] = ['commuting', 'errand', 'loitering', 'gathering'];

export type PressureKey =
  | 'gas' | 'tram' | 'wages' | 'sanitation' | 'mood' | 'suspicion' | 'rot' | 'coin';

export const PRESSURE_KEYS: readonly PressureKey[] = [
  'gas', 'tram', 'wages', 'sanitation', 'mood', 'suspicion', 'rot', 'coin',
];

export type ClaimKind =
  | 'affair' | 'theft' | 'graft' | 'sickness' | 'sabotage'
  | 'closure' | 'debt' | 'informer' | 'miracle' | 'collapse'
  | 'bylaw';

export type OrdinanceKind =
  | 'curfew' | 'licensingHours' | 'cartBylaw' | 'drainageAct' | 'dogTax'
  | 'pewRents' | 'breadAssize' | 'childLabour' | 'inspectorPowers' | 'publicOrder';

export type InterventionKind =
  | 'rumour' | 'cutGas' | 'delayTram' | 'tipOff'
  | 'fundStrike' | 'plantStory' | 'quarantine' | 'fundBunting' | 'fileWorks'
  | 'callDeputation' | 'openShelter'
  | 'setFire' | 'floodOut' | 'condemn';

export type TargetKind = 'soul' | 'building' | 'street' | 'segment' | 'firm' | 'claim' | 'line' | 'square';

export interface Target {
  kind: TargetKind;
  id: number;
}

/** Graph node roles. Door nodes hang off a street node; stops and bridgeheads are junctions. */
export const NodeKind = {
  Junction: 0,
  Door: 1,
  Stop: 2,
  Gate: 3,
  Bridgehead: 4,
} as const;
export type NodeKindCode = (typeof NodeKind)[keyof typeof NodeKind];

/** Hard caps, asserted by validateWorld and by tests. They are the perf budget. */
export const CAPS = {
  souls: 512,
  buildings: 384,
  nodes: 640,
  claims: 4096,
  beliefsPerSoul: 8,
  eventRing: 4096,
  causeRing: 512,
  routeCache: 512,
  proseCache: 64,
} as const;
