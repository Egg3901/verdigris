// The generation stages, in order, plus the validator.
//
// The whole world is a pure function of one seed string. Nothing here reads the
// clock, the DOM or Math.random, and every stage draws from its own RNG stream so
// that inserting a stage later does not reshuffle the stages before it.
import { CAPS, NodeKind, Tile } from './types';
import type { BuildingId, NodeId } from './types';
import type { District } from './district';
import { cellKey, dumpDistrict, inBounds, insideIsland, newDistrict, tileAt } from './district';
import { carveRiver, layBanks } from './gen/river';
import { addJetties, pickArchetype, reserveParks, shapeCoast } from './gen/archetype';
import type { Archetype } from './gen/archetype';
import type { RiverPlan } from './gen/river';
import { layStreets } from './gen/streets';
import type { StreetPlan } from './gen/streets';
import { subdivideBlocks } from './gen/blocks';
import type { Block } from './gen/blocks';
import { assignWards, wardBlockAdjacency } from './gen/wards';
import type { Ward } from './gen/wards';
import { subdividePlots, pruneUnreachablePaving } from './gen/plots';
import type { Plot } from './gen/plots';
import { assignBuildings } from './gen/assign';
import { nameStreets, nameSquare } from './gen/naming';
import type { Street } from './gen/naming';
import { populate } from './gen/populate';
import { layTram } from './gen/tram';
import type { TramLine } from './gen/tram';
import { buildGraph, buildNextHop, isConnected, largestComponent } from './graph';
import type { StreetGraph } from './graph';
import { attachBuildings, buildNet } from './networks';
import type { Networks } from './networks';
import { DEFS } from './buildings';
import type { Building } from './buildings';
import type { Firm } from './firms';
import type { Household } from './households';
import type { Soul } from './souls';
import { hashString, mulberry32, mix, pick, range, Stream } from './rng';
import { LANDMARK_NAMES, PUB_HEAD, PUB_TAIL, SHOP_TRADE, FAMILY } from './names';

export interface World {
  seedStr: string;
  seed: number;
  /** What kind of district this seed grew: pure in the seed, decided first. */
  archetype: Archetype;
  district: District;
  river: RiverPlan;
  streetPlan: StreetPlan;
  squareName: string;
  blocks: Block[];
  wards: Ward[];
  plots: Plot[];
  buildings: Building[];
  streets: Street[];
  graph: StreetGraph;
  networks: Networks;
  tram: TramLine;
  /** A guaranteed graph destination on the civic square for outdoor gatherings. */
  squareNode: NodeId;
  souls: Soul[];
  households: Household[];
  firms: Firm[];
  doorNodes: Int16Array;
}

const TARGET_SOULS = 340;

export function generateWorld(seedStr: string): World {
  const seed = hashString(seedStr);
  const arch = pickArchetype(seed);
  const district = newDistrict(seed);
  shapeCoast(district, seed, arch);

  const river = carveRiver(district, seed, arch);
  layBanks(district, river);
  const streetPlan = layStreets(district, seed, river, arch);
  addJetties(district, seed, river, arch);
  reserveRim(district, seed, arch);
  reserveParks(district, seed, arch);
  const blocks = subdivideBlocks(district, seed);
  const wards = assignWards(district, seed, blocks, streetPlan, river);
  const plots = subdividePlots(district, seed, blocks);
  pruneUnreachablePaving(
    district,
    streetPlan.squareX + (streetPlan.squareW >> 1),
    streetPlan.squareY + (streetPlan.squareW >> 1),
  );
  const placements = assignBuildings(district, seed, plots, streetPlan, river, wards, arch);
  const streets = nameStreets(district, seed);
  const squareName = nameSquare(seed);

  // Buildings. The origin is the SOUTH corner of the footprint, which the depth
  // sort depends on, so it is computed once here and never recomputed.
  const buildings: Building[] = [];
  const usedNames = new Set<string>();
  for (const p of placements) {
    const def = DEFS[p.kind];
    const id = buildings.length;
    const cells: number[] = [];
    for (let j = 0; j < p.d; j++) {
      for (let i = 0; i < p.w; i++) {
        const k = cellKey(district, p.ox + i, p.oy + j);
        cells.push(k);
        district.buildingId[k] = id;
      }
    }
    const doorX = Math.min(Math.max(p.plot.doorX, p.ox), p.ox + p.w - 1);
    const doorY = Math.min(Math.max(p.plot.doorY, p.oy), p.oy + p.d - 1);
    const streetId = district.streetId[cellKey(district, p.plot.frontX, p.plot.frontY)];
    buildings.push({
      id, kind: p.kind, name: '', plotId: p.plot.id,
      ox: p.ox, oy: p.oy, w: p.w, d: p.d, cells: Int16Array.from(cells),
      doorNode: -1, doorX, doorY, streetId, number: 0,
      fabric: def.baseFabric, facade: def.baseFacade, storeys: def.storeys,
      gasSeg: -1, drainSeg: -1, postSeg: -1,
      firmId: -1, householdIds: [], occupants: [],
      grudges: [], lastIncidentTick: -1, heat: 0, peeked: false, burntAt: -1,
    });
  }

  // Plots nobody built on are back gardens and waste ground, not holes.
  const built = new Set(placements.map((p) => p.plot.id));
  for (const p of plots) {
    if (built.has(p.id)) continue;
    for (const k of p.cells) {
      if (district.tile[k] === Tile.Plot || district.tile[k] === Tile.Court) district.tile[k] = Tile.Yard;
    }
  }

  // House numbers, then names. Odds one side of a street, evens the other, so
  // addressOf yields "14 Foundry Row" and the prose layer never invents a place.
  numberBuildings(district, buildings, streets);
  for (const b of buildings) nameBuilding(seed, b, streets, squareName, usedNames);

  // Landmarks get a one-tile no-walk apron on their south and west sides, so a
  // 3x3 or 4x4 sprite can never sort in front of a soul standing beside it.
  for (const b of buildings) {
    if (!DEFS[b.kind].landmark || (b.w <= 2 && b.d <= 2)) continue;
    for (let i = -1; i <= b.w; i++) markApron(district, b.ox + i, b.oy + b.d);
    for (let j = -1; j <= b.d; j++) markApron(district, b.ox - 1, b.oy + j);
  }

  // Graph. Every door cell is forced to be a node, so a soul walks to an actual
  // doorway rather than to the nearest junction.
  const forced: { x: number; y: number; kind: (typeof NodeKind)[keyof typeof NodeKind] }[] = [];
  for (const b of buildings) {
    const p = plots[b.plotId];
    forced.push({ x: p.frontX, y: p.frontY, kind: NodeKind.Door });
  }
  for (const bridge of river.bridges) {
    forced.push({ x: bridge.x, y: bridge.y0, kind: NodeKind.Bridgehead });
    forced.push({ x: bridge.x, y: bridge.y1, kind: NodeKind.Bridgehead });
  }
  for (const a of streetPlan.anchors) {
    if (a.label === 'gate') forced.push({ x: a.x, y: a.y, kind: NodeKind.Gate });
  }
  const graph = buildGraph(district, { forced });
  buildNextHop(graph);

  const doorNodes = new Int16Array(buildings.length).fill(-1);
  for (const b of buildings) {
    const p = plots[b.plotId];
    const node = district.nodeId[cellKey(district, p.frontX, p.frontY)];
    b.doorNode = node;
    doorNodes[b.id] = node;
  }

  // Networks. Gas from the gasworks, drains to the river outfall, post as a star
  // from the exchange to the dozen subscribers who can afford a tube.
  const nodeOf = (kind: string): NodeId => {
    const b = buildings.find((x) => x.kind === kind);
    return b && b.doorNode >= 0 ? b.doorNode : 0;
  };
  const outfallNode = nearestNode(district, graph, river.outfallX, river.outfallY);
  const networks: Networks = {
    gas: buildNet(graph, nodeOf('gasworks'), null),
    drain: buildNet(graph, outfallNode, null),
    post: buildNet(graph, nodeOf('postexchange'), null),
  };
  attachBuildings(networks.gas, doorNodes);
  attachBuildings(networks.drain, doorNodes);
  const subscribers = new Set<BuildingId>();
  for (const b of buildings) {
    if (['townhall', 'exchange', 'newspaper', 'bank', 'mill', 'villa', 'postexchange', 'constabulary'].includes(b.kind)) {
      subscribers.add(b.id);
    }
  }
  attachBuildings(networks.post, doorNodes, subscribers);
  for (const b of buildings) {
    b.gasSeg = DEFS[b.kind].needsGas ? networks.gas.buildingSeg[b.id] : -1;
    b.drainSeg = DEFS[b.kind].needsDrain ? networks.drain.buildingSeg[b.id] : -1;
    b.postSeg = networks.post.buildingSeg[b.id];
  }

  // Tram. Terminus to terminus through the square, the mill gate and the wharf.
  const squareNode = nearestNode(district, graph, streetPlan.squareX + (streetPlan.squareW >> 1), streetPlan.squareY + (streetPlan.squareW >> 1));
  const gateNodes: NodeId[] = [];
  for (let i = 0; i < graph.n; i++) if (graph.kind[i] === NodeKind.Gate) gateNodes.push(i);
  const termini: [NodeId, NodeId] = pickTermini(graph, gateNodes, squareNode);
  const waypoints: NodeId[] = [];
  for (const kind of ['mill', 'tramdepot', 'wharfshed', 'mast']) {
    const b = buildings.find((x) => x.kind === kind);
    if (b && b.doorNode >= 0) waypoints.push(b.doorNode);
  }
  const tram = layTram(graph, squareNode, waypoints, termini);

  const { souls, households, firms } = populate(seed, buildings, TARGET_SOULS);

  return {
    seedStr, seed, archetype: arch, district, river, streetPlan, squareName,
    blocks, wards, plots, buildings, streets, graph, networks, tram, squareNode,
    souls, households, firms, doorNodes,
  };
}

/**
 * A wooded rim around the island.
 *
 * There used to be a pass at the end of worldgen turning any leftover Void island
 * cell into Park, and it produced ZERO park cells in every seed. Nothing is ever
 * leftover: subdivideBlocks floods every Void cell into a block and subdividePlots
 * assigns every block cell. So the green edge never existed, the district cut hard
 * against the void, and props.ts never once took its "parks are 46% wooded"
 * branch. The rim has to be claimed BEFORE the blocks are, not after.
 */
function reserveRim(d: District, seed: number, arch: Archetype): void {
  const depth = arch.rimDepth;
  const rim: number[] = [];
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      if (!insideIsland(d, x, y)) continue;
      if (tileAt(d, x, y) !== Tile.Void) continue;
      // Distance to the edge of the island, measured by looking outward.
      let edge = false;
      for (let r = 1; r <= depth && !edge; r++) {
        for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
          if (!insideIsland(d, x + dx, y + dy)) { edge = true; break; }
        }
      }
      if (edge) rim.push(cellKey(d, x, y));
    }
  }
  // Ragged, not a uniform band: a perfectly even ring of trees reads as a hedge
  // somebody planted rather than as the edge of a town running out of town.
  for (const k of rim) {
    const x = k % d.width;
    const y = (k - x) / d.width;
    if (mix(seed, 63, x, y) % 100 < arch.rimSkipPct) continue;
    d.tile[k] = Tile.Park;
  }
}

function markApron(d: District, x: number, y: number): void {
  if (!inBounds(d, x, y)) return;
  const k = cellKey(d, x, y);
  if (d.tile[k] === Tile.Void) d.tile[k] = Tile.Yard;
}

function nearestNode(d: District, g: StreetGraph, x: number, y: number): NodeId {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < g.n; i++) {
    const dist = Math.abs(g.cx[i] - x) + Math.abs(g.cy[i] - y);
    if (dist < bestDist) { bestDist = dist; best = i; }
  }
  void d;
  return best;
}

function pickTermini(g: StreetGraph, gates: NodeId[], fallback: NodeId): [NodeId, NodeId] {
  if (gates.length < 2) return [fallback, fallback];
  let a = gates[0];
  let b = gates[1];
  let bestSpan = -1;
  for (let i = 0; i < gates.length; i++) {
    for (let j = i + 1; j < gates.length; j++) {
      const span = Math.abs(g.cx[gates[i]] - g.cx[gates[j]]) + Math.abs(g.cy[gates[i]] - g.cy[gates[j]]);
      if (span > bestSpan) { bestSpan = span; a = gates[i]; b = gates[j]; }
    }
  }
  return [a, b];
}

function numberBuildings(d: District, buildings: Building[], streets: Street[]): void {
  const byStreet = new Map<number, Building[]>();
  for (const b of buildings) {
    if (b.streetId < 0) continue;
    if (!byStreet.has(b.streetId)) byStreet.set(b.streetId, []);
    (byStreet.get(b.streetId) as Building[]).push(b);
  }
  for (const [sid, list] of byStreet) {
    const street = streets[sid];
    const horizontal = street ? street.horizontal : true;
    list.sort((p, q) => (horizontal ? p.ox - q.ox || p.oy - q.oy : p.oy - q.oy || p.ox - q.ox));
    let odd = 1;
    let even = 2;
    for (const b of list) {
      // Which side of the street the building sits on decides odd or even, which
      // is how real numbering works and how a player can navigate by address.
      const front = d.polite[cellKey(d, b.doorX, b.doorY)] === 1;
      if (front) { b.number = odd; odd += 2; } else { b.number = even; even += 2; }
    }
  }
}

function nameBuilding(seed: number, b: Building, streets: Street[], squareName: string, used: Set<string>): void {
  const r = mulberry32(mix(seed, Stream.GenNames, 5, b.id));
  const fixed = LANDMARK_NAMES[b.kind];
  if (fixed && !used.has(fixed)) { b.name = fixed; used.add(fixed); return; }
  switch (b.kind) {
    case 'pub': {
      let n = `${pick(r, PUB_HEAD)} ${pick(r, PUB_TAIL)}`;
      let guard = 0;
      while (used.has(n) && guard++ < 24) n = `${pick(r, PUB_HEAD)} ${pick(r, PUB_TAIL)}`;
      b.name = n;
      used.add(n);
      return;
    }
    case 'shop':
      b.name = `${pick(r, FAMILY)} the ${pick(r, SHOP_TRADE)}`;
      return;
    case 'mill':
      b.name = `${pick(r, FAMILY)}'s Mill`;
      return;
    case 'foundry':
      b.name = `${pick(r, FAMILY)} Foundry`;
      return;
    case 'workshop':
      b.name = `The ${pick(r, SHOP_TRADE)}'s Workshop`;
      return;
    case 'warehouse':
      b.name = `Bonded Warehouse ${range(r, 1, 9)}`;
      return;
    case 'wharfshed':
      b.name = `${pick(r, ['North', 'South', 'Lower', 'Upper', 'Old'])} Wharf Shed`;
      return;
    default: {
      const street = streets[b.streetId];
      const where = street ? street.name : squareName;
      b.name = b.number > 0 ? `${b.number} ${where}` : where;
    }
  }
}

export function addressOf(w: World, b: Building): string {
  const street = w.streets[b.streetId];
  const where = street ? street.name : w.squareName;
  return b.number > 0 ? `${b.number} ${where}` : where;
}

/**
 * Every violation here is also a vitest assertion. An empty array means the
 * district is playable; anything else means a soul somewhere cannot get to work
 * and the schedule tests will only find out after a wasted game-hour.
 */
export function validateWorld(w: World): string[] {
  const errs: string[] = [];
  const { district: d, graph: g, buildings, souls } = w;

  if (g.n > CAPS.nodes) errs.push(`graph has ${g.n} nodes, cap ${CAPS.nodes}`);
  if (!isConnected(g)) {
    errs.push(`street graph is not one component (largest ${largestComponent(g)} of ${g.n})`);
  }
  if (buildings.length < 260 || buildings.length > 360) {
    errs.push(`building count ${buildings.length} outside [260, 360]`);
  }
  if (buildings.length > CAPS.buildings) errs.push(`building count ${buildings.length} over cap ${CAPS.buildings}`);
  if (souls.length > CAPS.souls) errs.push(`soul count ${souls.length} over cap ${CAPS.souls}`);

  if (w.wards.length !== 6) errs.push(`ward count ${w.wards.length}, expected 6`);
  for (const ward of w.wards) {
    if (ward.blockIds.length < 3) errs.push(`ward ${ward.name} has only ${ward.blockIds.length} blocks`);
  }
  const wardAdjacency = wardBlockAdjacency(d, w.blocks);
  for (const ward of w.wards) {
    const wanted = new Set(ward.blockIds);
    const reached = new Set<number>();
    const queue = ward.blockIds.length ? [ward.blockIds[0]] : [];
    if (queue.length) reached.add(queue[0]);
    for (let head = 0; head < queue.length; head++) {
      for (const other of wardAdjacency[queue[head]]) {
        if (!wanted.has(other) || reached.has(other)) continue;
        reached.add(other);
        queue.push(other);
      }
    }
    if (reached.size !== wanted.size) errs.push(`ward ${ward.name} has disconnected blocks`);
  }
  for (const block of w.blocks) {
    if (block.wardId < 0 || block.wardId >= w.wards.length) errs.push(`block ${block.id} has invalid ward ${block.wardId}`);
  }
  for (const plot of w.plots) {
    if (plot.wardId < 0 || plot.wardId >= w.wards.length) errs.push(`plot ${plot.id} has invalid ward ${plot.wardId}`);
    if (w.blocks[plot.blockId]?.wardId !== plot.wardId) errs.push(`plot ${plot.id} disagrees with block ward`);
  }
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      if (!insideIsland(d, x, y)) continue;
      const k = cellKey(d, x, y);
      if (d.tile[k] !== Tile.Water && (d.wardId[k] < 0 || d.wardId[k] >= w.wards.length)) {
        errs.push(`land cell ${x},${y} has invalid ward ${d.wardId[k]}`);
      }
    }
  }
  const seenCell = new Set<number>();
  for (const b of buildings) {
    if (b.doorNode < 0) errs.push(`building ${b.id} (${b.kind}) has no door node`);
    if (w.plots[b.plotId]?.wardId === undefined) errs.push(`building ${b.id} has no ward`);
    if (!DEFS[b.kind].landmark && (b.w > 2 || b.d > 2)) {
      errs.push(`building ${b.id} (${b.kind}) is ${b.w}x${b.d}, non-landmarks cap at 2x2`);
    }
    for (const k of b.cells) {
      if (seenCell.has(k)) errs.push(`building ${b.id} overlaps another at cell ${k}`);
      seenCell.add(k);
      const x = k % d.width;
      const y = (k - x) / d.width;
      const t = tileAt(d, x, y);
      if (t === Tile.Water) errs.push(`building ${b.id} sits on water`);
      if (t === Tile.Street || t === Tile.Square) errs.push(`building ${b.id} sits on paving`);
    }
  }

  for (const q of [
    'townhall', 'exchange', 'newspaper', 'constabulary', 'gasworks', 'pumphouse',
    'tramdepot', 'mast', 'chapel', 'dispensary', 'postexchange', 'school', 'bathhouse',
  ]) {
    if (!buildings.some((b) => b.kind === q)) errs.push(`quota kind missing: ${q}`);
  }

  if (!w.plots.some((p) => p.court)) {
    errs.push('no court generated: the rot geography must exist');
  }

  for (const s of souls) {
    if (s.homeId < 0 || s.homeId >= buildings.length) errs.push(`soul ${s.id} has no home`);
  }

  if (w.tram.route.length < 8) errs.push(`tram route is only ${w.tram.route.length} nodes`);
  if (w.tram.stops.length < 5) errs.push(`tram has only ${w.tram.stops.length} stops`);

  return errs;
}

export { dumpDistrict };
