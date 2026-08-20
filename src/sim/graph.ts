// The street graph, and the reason this game can afford 200 walking souls.
//
// There is NO runtime pathfinding. The graph is small by construction (junctions,
// door nodes, tram stops, bridgeheads, capped at 512), so an all-pairs next-hop
// matrix is 512 KB and about 50 ms to build once at worldgen. Travel is then a
// single array read: nextHop[from * n + to]. Per-agent A* is the classic mistake
// in a game shaped like this one, and it is bought off here for half a megabyte.
//
// Closures (quarantine, picket, collapse) are an OVERLAY, not a rebuild: a soul
// whose next hop crosses a closed edge runs a bounded A* and the answer is cached
// by (from, to, closureVersion). Because closures are rare and clustered, the
// first soul to hit a cordon pays the search and everyone behind reads the cache.
// That is also good fiction: word about the way round spreads.
import { CAPS, NodeKind, Tile } from './types';
import type { NodeId, NodeKindCode } from './types';
import type { District } from './district';
import { cellKey, inBounds } from './district';

export interface StreetGraph {
  n: number;
  cx: Int16Array;
  cy: Int16Array;
  kind: Uint8Array;
  /** CSR adjacency. edgeStart has length n+1. */
  edgeStart: Int32Array;
  edgeTo: Int16Array;
  edgeCost: Uint16Array;
  edgeId: Int16Array;
  edgeClosed: Uint8Array;
  edgeCount: number;
  nextHop: Int16Array;
  closureVersion: number;
}

const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];

const PAVED = new Uint8Array(16);
for (const t of [Tile.Street, Tile.Alley, Tile.Embankment, Tile.Wharf, Tile.Bridge, Tile.Square, Tile.Court, Tile.Park, Tile.Rail]) {
  PAVED[t] = 1;
}

function paved(d: District, x: number, y: number): boolean {
  return inBounds(d, x, y) && PAVED[d.tile[cellKey(d, x, y)]] === 1;
}

function pavedDegree(d: District, x: number, y: number): number {
  let n = 0;
  for (let i = 0; i < 4; i++) if (paved(d, x + DX[i], y + DY[i])) n++;
  return n;
}

export interface GraphSeed {
  /** Cells that must become nodes whatever their degree: doors, stops, bridgeheads. */
  forced: { x: number; y: number; kind: NodeKindCode }[];
}

export function buildGraph(d: District, seedCells: GraphSeed): StreetGraph {
  const nodeAt = new Int16Array(d.width * d.height).fill(-1);
  const cxs: number[] = [];
  const cys: number[] = [];
  const kinds: number[] = [];

  const addNode = (x: number, y: number, kind: NodeKindCode): NodeId => {
    const k = cellKey(d, x, y);
    if (nodeAt[k] !== -1) {
      // A forced role beats a plain junction, so a tram stop stays a tram stop.
      if (kind !== NodeKind.Junction) kinds[nodeAt[k]] = kind;
      return nodeAt[k];
    }
    const id = cxs.length;
    nodeAt[k] = id;
    cxs.push(x);
    cys.push(y);
    kinds.push(kind);
    return id;
  };

  // Junctions and dead ends first, so their ids are stable across seeds of the
  // forced list. Fixed scan order, which is the determinism requirement.
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      if (!paved(d, x, y)) continue;
      const deg = pavedDegree(d, x, y);
      if (deg !== 2) addNode(x, y, NodeKind.Junction);
    }
  }
  for (const f of seedCells.forced) {
    if (paved(d, f.x, f.y)) addNode(f.x, f.y, f.kind);
  }

  const n = cxs.length;
  const adjTo: number[][] = Array.from({ length: n }, () => []);
  const adjCost: number[][] = Array.from({ length: n }, () => []);
  const adjEdge: number[][] = Array.from({ length: n }, () => []);
  let edgeCount = 0;

  // Trace corridors: from each node, follow each paved neighbour through
  // degree-2 cells until another node is reached.
  for (let a = 0; a < n; a++) {
    const ax = cxs[a];
    const ay = cys[a];
    for (let i = 0; i < 4; i++) {
      let px = ax;
      let py = ay;
      let x = ax + DX[i];
      let y = ay + DY[i];
      if (!paved(d, x, y)) continue;
      let steps = 1;
      let guard = 0;
      while (nodeAt[cellKey(d, x, y)] === -1 && guard++ < 512) {
        let nx = -1;
        let ny = -1;
        for (let j = 0; j < 4; j++) {
          const tx = x + DX[j];
          const ty = y + DY[j];
          if (tx === px && ty === py) continue;
          if (!paved(d, tx, ty)) continue;
          nx = tx;
          ny = ty;
          break;
        }
        if (nx < 0) break;
        px = x; py = y; x = nx; y = ny;
        steps++;
      }
      const b = nodeAt[cellKey(d, x, y)];
      if (b === -1 || b === a) continue;
      // One direction only per traversal; the mirror is found from b's own scan.
      adjTo[a].push(b);
      adjCost[a].push(Math.max(1, steps));
      adjEdge[a].push(edgeCount++);
    }
  }

  const edgeStart = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) edgeStart[i + 1] = edgeStart[i] + adjTo[i].length;
  const total = edgeStart[n];
  const edgeTo = new Int16Array(total);
  const edgeCost = new Uint16Array(total);
  const edgeId = new Int16Array(total);
  for (let i = 0; i < n; i++) {
    let at = edgeStart[i];
    for (let j = 0; j < adjTo[i].length; j++, at++) {
      edgeTo[at] = adjTo[i][j];
      edgeCost[at] = adjCost[i][j];
      edgeId[at] = adjEdge[i][j];
    }
  }

  const g: StreetGraph = {
    n, cx: Int16Array.from(cxs), cy: Int16Array.from(cys), kind: Uint8Array.from(kinds),
    edgeStart, edgeTo, edgeCost, edgeId,
    edgeClosed: new Uint8Array(edgeCount),
    edgeCount,
    nextHop: new Int16Array(0),
    closureVersion: 0,
  };
  for (let i = 0; i < g.n; i++) {
    const k = cellKey(d, g.cx[i], g.cy[i]);
    d.nodeId[k] = i;
  }
  return g;
}

/** n Dijkstras, once, at worldgen. Everything downstream is an O(1) array read. */
export function buildNextHop(g: StreetGraph): void {
  const n = g.n;
  if (n > CAPS.nodes) throw new Error(`street graph has ${n} nodes, cap is ${CAPS.nodes}`);
  const next = new Int16Array(n * n).fill(-1);
  const dist = new Float64Array(n);
  const parent = new Int32Array(n);
  const done = new Uint8Array(n);
  const open: number[] = [];

  for (let s = 0; s < n; s++) {
    dist.fill(Infinity);
    parent.fill(-1);
    done.fill(0);
    open.length = 0;
    dist[s] = 0;
    open.push(s);
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (dist[open[i]] < dist[open[bi]]) bi = i;
      const u = open[bi];
      open[bi] = open[open.length - 1];
      open.pop();
      if (done[u]) continue;
      done[u] = 1;
      for (let e = g.edgeStart[u]; e < g.edgeStart[u + 1]; e++) {
        const v = g.edgeTo[e];
        const nd = dist[u] + g.edgeCost[e];
        if (nd < dist[v]) { dist[v] = nd; parent[v] = u; open.push(v); }
      }
    }
    for (let t = 0; t < n; t++) {
      if (t === s || dist[t] === Infinity) continue;
      let cur = t;
      while (parent[cur] !== s && parent[cur] !== -1) cur = parent[cur];
      next[s * n + t] = parent[cur] === -1 ? -1 : cur;
    }
  }
  g.nextHop = next;
}

export function stepToward(g: StreetGraph, from: NodeId, to: NodeId): NodeId {
  if (from === to) return -1;
  return g.nextHop[from * g.n + to];
}

export function edgeBetween(g: StreetGraph, from: NodeId, to: NodeId): number {
  for (let e = g.edgeStart[from]; e < g.edgeStart[from + 1]; e++) {
    if (g.edgeTo[e] === to) return e;
  }
  return -1;
}

export function edgeCostBetween(g: StreetGraph, from: NodeId, to: NodeId): number {
  const e = edgeBetween(g, from, to);
  return e < 0 ? 1 : g.edgeCost[e];
}

/** Is the whole graph one component? Asserted by validateWorld: a marooned door
 *  node means a soul who can never get to work, and the schedule tests catch it
 *  only after a wasted hour of simulation. */
export function isConnected(g: StreetGraph): boolean {
  if (g.n === 0) return false;
  const seen = new Uint8Array(g.n);
  const stack = [0];
  seen[0] = 1;
  let count = 1;
  while (stack.length) {
    const u = stack.pop() as number;
    for (let e = g.edgeStart[u]; e < g.edgeStart[u + 1]; e++) {
      const v = g.edgeTo[e];
      if (!seen[v]) { seen[v] = 1; count++; stack.push(v); }
    }
  }
  return count === g.n;
}

export function largestComponent(g: StreetGraph): number {
  const seen = new Uint8Array(g.n);
  let best = 0;
  for (let s = 0; s < g.n; s++) {
    if (seen[s]) continue;
    let count = 0;
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const u = stack.pop() as number;
      count++;
      for (let e = g.edgeStart[u]; e < g.edgeStart[u + 1]; e++) {
        const v = g.edgeTo[e];
        if (!seen[v]) { seen[v] = 1; stack.push(v); }
      }
    }
    if (count > best) best = count;
  }
  return best;
}
