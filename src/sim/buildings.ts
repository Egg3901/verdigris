// Building definitions, quotas and the Building record.
//
// FOOTPRINT RULE: ordinary buildings cap at 2x2. Wider sprites sort wrong against
// agents standing beside them, because a 4x1 anchored at its south corner has a
// depth key that puts it in front of a soul who is visibly further south than its
// west end. Landmarks may go to 4x4 and are placed with a one-tile no-walk apron
// on their south and west sides. That apron is enforced here, in the sim, not in
// the renderer.
import type { BuildingKind, BuildingId, FirmId, HouseholdId, SoulId, NodeId } from './types';

export interface BuildingDef {
  label: string;
  /** Cells of street frontage the plot must offer. */
  minFrontage: number;
  /** Max footprint in cells, [w, d]. Anything over 2x2 is a landmark. */
  maxFoot: [number, number];
  /** How many souls may be inside at once. */
  capacity: number;
  needsGas: boolean;
  needsDrain: boolean;
  publicAccess: boolean;
  /** 0..1000 starting condition. Fabric is the structure, facade is the show. */
  baseFabric: number;
  baseFacade: number;
  /** Height in storeys, drives the sprite recipe and the peek verb. */
  storeys: number;
  landmark: boolean;
}

function def(
  label: string, minFrontage: number, maxFoot: [number, number], capacity: number,
  opts: Partial<BuildingDef> = {},
): BuildingDef {
  return {
    label, minFrontage, maxFoot, capacity,
    needsGas: true, needsDrain: true, publicAccess: false,
    baseFabric: 700, baseFacade: 700, storeys: 2, landmark: false,
    ...opts,
  };
}

export const DEFS: Record<BuildingKind, BuildingDef> = {
  // Landmarks. The postcard.
  townhall: def('Civic Hall', 4, [4, 4], 40, { publicAccess: true, baseFacade: 980, baseFabric: 640, storeys: 3, landmark: true }),
  exchange: def('Corn Exchange', 3, [3, 3], 30, { publicAccess: true, baseFacade: 900, storeys: 2, landmark: true }),
  newspaper: def('Newspaper Office', 2, [3, 2], 18, { publicAccess: true, baseFabric: 600, storeys: 3, landmark: true }),
  constabulary: def('Constabulary', 2, [3, 2], 14, { publicAccess: true, storeys: 2, landmark: true }),
  gasworks: def('Gasworks', 3, [4, 3], 12, { needsGas: false, baseFacade: 300, baseFabric: 560, storeys: 2, landmark: true }),
  pumphouse: def('Pumphouse', 2, [2, 2], 6, { baseFacade: 400, storeys: 1, landmark: true }),
  tramdepot: def('Tram Depot', 3, [4, 3], 16, { baseFacade: 420, storeys: 1, landmark: true }),
  mast: def('Mooring Mast', 2, [2, 2], 4, { needsDrain: false, baseFacade: 880, baseFabric: 720, storeys: 6, landmark: true }),
  chapel: def('Chapel', 3, [3, 3], 60, { publicAccess: true, baseFacade: 820, baseFabric: 520, storeys: 2, landmark: true }),
  dispensary: def('Dispensary', 2, [2, 2], 20, { publicAccess: true, storeys: 2, landmark: true }),
  postexchange: def('Pneumatic Exchange', 2, [3, 2], 10, { baseFacade: 860, storeys: 2, landmark: true }),
  school: def('Board School', 3, [3, 3], 70, { publicAccess: true, baseFabric: 660, storeys: 2, landmark: true }),
  bathhouse: def('Public Baths', 2, [3, 2], 24, { publicAccess: true, baseFacade: 780, baseFabric: 540, storeys: 2, landmark: true }),
  glasshouse: def('Winter Garden', 3, [3, 3], 30, { publicAccess: true, baseFacade: 920, baseFabric: 500, storeys: 2, landmark: true }),

  // Industry.
  mill: def('Mill', 4, [4, 3], 45, { baseFacade: 260, baseFabric: 580, storeys: 4, landmark: true }),
  foundry: def('Foundry', 3, [3, 3], 30, { baseFacade: 240, baseFabric: 560, storeys: 2, landmark: true }),
  workshop: def('Workshop', 2, [2, 2], 12, { baseFacade: 420, baseFabric: 600, storeys: 2 }),
  warehouse: def('Warehouse', 2, [2, 2], 8, { needsGas: false, baseFacade: 330, storeys: 3 }),
  wharfshed: def('Wharf Shed', 2, [2, 2], 10, { needsGas: false, needsDrain: false, baseFacade: 280, baseFabric: 520, storeys: 1 }),

  // Trade.
  pub: def('Public House', 1, [2, 2], 30, { publicAccess: true, baseFacade: 620, storeys: 3 }),
  shop: def('Shop', 1, [2, 2], 12, { publicAccess: true, baseFacade: 700, storeys: 3 }),
  bank: def('Bank', 2, [2, 2], 12, { publicAccess: true, baseFacade: 960, baseFabric: 800, storeys: 2, landmark: true }),

  // Dwellings.
  terrace: def('Terrace House', 1, [1, 2], 8, { storeys: 2 }),
  tenement: def('Tenement', 2, [2, 2], 26, { baseFacade: 430, baseFabric: 480, storeys: 4 }),
  courtdwelling: def('Court Dwelling', 1, [1, 1], 10, { needsGas: false, baseFacade: 250, baseFabric: 340, storeys: 2 }),
  villa: def('Villa', 2, [2, 2], 10, { baseFacade: 900, baseFabric: 840, storeys: 2 }),
  lodging: def('Lodging House', 1, [2, 2], 22, { baseFacade: 480, baseFabric: 460, storeys: 3 }),
};

export interface Quota {
  kind: BuildingKind;
  min: number;
  max: number;
}

/** Forced placements run first, on their best-scoring eligible plot. The residue
 *  fills afterwards by weighted pick. */
export const QUOTAS: readonly Quota[] = [
  { kind: 'townhall', min: 1, max: 1 },
  { kind: 'exchange', min: 1, max: 1 },
  { kind: 'newspaper', min: 1, max: 1 },
  { kind: 'constabulary', min: 1, max: 1 },
  { kind: 'gasworks', min: 1, max: 1 },
  { kind: 'pumphouse', min: 1, max: 1 },
  { kind: 'tramdepot', min: 1, max: 1 },
  { kind: 'mast', min: 1, max: 1 },
  { kind: 'chapel', min: 1, max: 1 },
  { kind: 'dispensary', min: 1, max: 1 },
  { kind: 'postexchange', min: 1, max: 1 },
  { kind: 'school', min: 1, max: 1 },
  { kind: 'bathhouse', min: 1, max: 1 },
  { kind: 'glasshouse', min: 1, max: 1 },
  { kind: 'bank', min: 1, max: 1 },
  { kind: 'mill', min: 1, max: 2 },
  { kind: 'foundry', min: 1, max: 1 },
  { kind: 'workshop', min: 2, max: 3 },
  { kind: 'pub', min: 3, max: 5 },
  { kind: 'shop', min: 8, max: 12 },
  { kind: 'wharfshed', min: 3, max: 6 },
  { kind: 'warehouse', min: 2, max: 4 },
];

/** Kinds the residue draws from, with weights. */
export const RESIDUE: readonly BuildingKind[] = ['terrace', 'tenement', 'courtdwelling', 'villa', 'lodging'];

export interface Grudge {
  topic: string;
  /** Negative for prehistory. This is what buys "eleven years" on day one. */
  sinceTick: number;
  withSoul: SoulId;
  heat: number;
}

export interface Building {
  id: BuildingId;
  kind: BuildingKind;
  name: string;
  plotId: number;
  /** Origin is the SOUTH corner: (ox + w - 1, oy + d - 1). Load-bearing for depth sort. */
  ox: number;
  oy: number;
  w: number;
  d: number;
  cells: Int16Array;
  doorNode: NodeId;
  doorX: number;
  doorY: number;
  streetId: number;
  number: number;
  /** 0..1000. Fabric is the structure and it decays. Facade is the show and it gets
   *  money. The gap between them over a month is the whole thesis. */
  fabric: number;
  facade: number;
  storeys: number;
  gasSeg: number;
  drainSeg: number;
  postSeg: number;
  firmId: FirmId;
  householdIds: HouseholdId[];
  occupants: SoulId[];
  grudges: Grudge[];
  lastIncidentTick: number;
  heat: number;
  /** Set by the peek verb. Render swaps in the roof-cut sprite. */
  peeked: boolean;
}
