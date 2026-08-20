// Gas, drains and pneumatic post. Three trees sharing one implementation.
//
// These trees exist so that cutting a gas main has a SHAPE. If cutGas were just
// applyPressure('gas', -300) the game would be a slider board. Instead it breaks
// one segment of one tree, a specific set of buildings downstream of it goes
// dark, and the pressure change is a consequence of that rather than the move.
import type { BuildingId, NodeId } from './types';
import type { StreetGraph } from './graph';

export interface Net {
  root: NodeId;
  /** Spanning tree parent per node, -1 at the root and for unreachable nodes. */
  parent: Int16Array;
  /** Broken flag per node, meaning the segment from that node up to its parent. */
  segBroken: Uint8Array;
  /** Depth from root, used to order repairs and to explain a blast radius. */
  depth: Int16Array;
  /** Which node each building draws from. -1 means the building is not connected. */
  buildingSeg: Int16Array;
  brokenSince: Int32Array;
}

export interface Networks {
  gas: Net;
  drain: Net;
  post: Net;
}

/** Minimum spanning tree by Prim over the street graph, rooted where the works are. */
export function buildNet(g: StreetGraph, root: NodeId, subscribers: readonly NodeId[] | null): Net {
  const parent = new Int16Array(g.n).fill(-1);
  const depth = new Int16Array(g.n).fill(-1);
  const inTree = new Uint8Array(g.n);
  const best = new Float64Array(g.n).fill(Infinity);
  const from = new Int16Array(g.n).fill(-1);

  best[root] = 0;
  for (let iter = 0; iter < g.n; iter++) {
    let u = -1;
    let bu = Infinity;
    for (let i = 0; i < g.n; i++) if (!inTree[i] && best[i] < bu) { bu = best[i]; u = i; }
    if (u < 0) break;
    inTree[u] = 1;
    parent[u] = from[u];
    depth[u] = u === root ? 0 : depth[from[u]] + 1;
    for (let e = g.edgeStart[u]; e < g.edgeStart[u + 1]; e++) {
      const v = g.edgeTo[e];
      if (inTree[v]) continue;
      const w = g.edgeCost[e];
      if (w < best[v]) { best[v] = w; from[v] = u; }
    }
  }

  const net: Net = {
    root, parent, depth,
    segBroken: new Uint8Array(g.n),
    buildingSeg: new Int16Array(0),
    brokenSince: new Int32Array(g.n).fill(-1),
  };
  // A star network (the pneumatic post) only serves its subscribers; the tree is
  // still built over the whole graph so the pipe run is drawable.
  void subscribers;
  return net;
}

export function attachBuildings(net: Net, doorNodes: Int16Array, subscribers?: Set<BuildingId>): void {
  const seg = new Int16Array(doorNodes.length).fill(-1);
  for (let b = 0; b < doorNodes.length; b++) {
    if (subscribers && !subscribers.has(b)) continue;
    const node = doorNodes[b];
    if (node < 0 || net.depth[node] < 0) continue;
    seg[b] = node;
  }
  net.buildingSeg = seg;
}

/** Walk to the root. Trees are shallow in practice, so this stays a handful of steps. */
export function serviceAt(net: Net, building: BuildingId): boolean {
  const start = net.buildingSeg[building];
  if (start === undefined || start < 0) return false;
  let cur: number = start;
  let guard = 0;
  while (cur !== net.root && cur >= 0 && guard++ < 600) {
    if (net.segBroken[cur]) return false;
    cur = net.parent[cur];
  }
  return cur === net.root;
}

/** Break a segment and report exactly who loses service. That list IS the
 *  explanation the inspector shows, so it must be computed, never estimated. */
export function breakSegment(net: Net, seg: NodeId, tick: number): BuildingId[] {
  if (seg < 0 || seg >= net.segBroken.length) return [];
  net.segBroken[seg] = 1;
  net.brokenSince[seg] = tick;
  const lost: BuildingId[] = [];
  for (let b = 0; b < net.buildingSeg.length; b++) {
    if (net.buildingSeg[b] < 0) continue;
    if (!serviceAt(net, b)) lost.push(b);
  }
  return lost;
}

export function repairSegment(net: Net, seg: NodeId): void {
  if (seg < 0 || seg >= net.segBroken.length) return;
  net.segBroken[seg] = 0;
  net.brokenSince[seg] = -1;
}

export function brokenSegments(net: Net): NodeId[] {
  const out: NodeId[] = [];
  for (let i = 0; i < net.segBroken.length; i++) if (net.segBroken[i]) out.push(i);
  return out;
}

/** How many buildings currently have service. Drives the gas pressure each hour. */
export function servedCount(net: Net): number {
  let n = 0;
  for (let b = 0; b < net.buildingSeg.length; b++) {
    if (net.buildingSeg[b] >= 0 && serviceAt(net, b)) n++;
  }
  return n;
}

export function connectedCount(net: Net): number {
  let n = 0;
  for (let b = 0; b < net.buildingSeg.length; b++) if (net.buildingSeg[b] >= 0) n++;
  return n;
}
