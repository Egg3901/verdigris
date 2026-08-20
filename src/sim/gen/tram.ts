// Stage 8: the tram line.
//
// The tram is not a separate world. It rides the same graph nodes the souls walk,
// which is what lets a delayed tram push people onto the pavement past whatever
// else the player is doing that morning.
import { NodeKind } from '../types';
import type { NodeId } from '../types';
import type { StreetGraph } from '../graph';
import { stepToward } from '../graph';

export interface TramLine {
  /** Node ids in route order, terminus to terminus. */
  route: NodeId[];
  stops: number[];
  stopNames: string[];
}

function pathNodes(g: StreetGraph, from: NodeId, to: NodeId): NodeId[] {
  const out: NodeId[] = [from];
  let cur = from;
  let guard = 0;
  while (cur !== to && guard++ < 2000) {
    const next = stepToward(g, cur, to);
    if (next < 0) break;
    out.push(next);
    cur = next;
  }
  return out;
}

export function layTram(
  g: StreetGraph, squareNode: NodeId, waypoints: NodeId[], termini: [NodeId, NodeId],
): TramLine {
  const order: NodeId[] = [termini[0]];
  const via = [squareNode, ...waypoints].filter((n) => n >= 0);
  for (const w of via) order.push(w);
  order.push(termini[1]);

  const route: NodeId[] = [];
  for (let i = 0; i < order.length - 1; i++) {
    const seg = pathNodes(g, order[i], order[i + 1]);
    for (let j = i === 0 ? 0 : 1; j < seg.length; j++) route.push(seg[j]);
  }

  // Seven stops, at least six nodes apart, with the square and both termini forced.
  const stops: number[] = [];
  const forced = new Set<NodeId>([termini[0], termini[1], squareNode, ...waypoints]);
  for (let i = 0; i < route.length; i++) {
    if (!forced.has(route[i])) continue;
    if (stops.length && i - stops[stops.length - 1] < 4) continue;
    stops.push(i);
  }
  for (let i = 0; i < route.length && stops.length < 7; i++) {
    if (stops.includes(i)) continue;
    if (stops.some((s) => Math.abs(s - i) < 6)) continue;
    stops.push(i);
    stops.sort((a, b) => a - b);
  }
  stops.sort((a, b) => a - b);

  for (const s of stops) g.kind[route[s]] = NodeKind.Stop;

  return {
    route,
    stops,
    stopNames: stops.map((_, i) => `Stop ${i + 1}`),
  };
}
