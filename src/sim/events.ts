// Observable things, and who saw them.
//
// An event is the bridge between the mechanical layer (a segment broke, a firm
// closed) and the social one (people now believe something). Witnesses are
// computed from actual positions: occupants of the place plus souls standing on
// the graph nodes next to it. Nobody learns anything by magic.
import { CAPS } from './types';
import type { BuildingId, SoulId } from './types';
import type { City } from './city';

export interface SimEvent {
  tick: number;
  kind: string;
  placeId: BuildingId;
  subjects: SoulId[];
  severity: number;
}

export interface EventState {
  events: SimEvent[];
  head: number;
}

export function newEvents(): EventState {
  return {
    events: new Array(CAPS.eventRing).fill(null).map(() => ({
      tick: -1, kind: '', placeId: -1, subjects: [] as SoulId[], severity: 0,
    })),
    head: 0,
  };
}

export function emit(
  st: EventState, kind: string, placeId: BuildingId, subjects: SoulId[], severity: number, tick: number,
): SimEvent {
  const slot = st.events[st.head];
  slot.tick = tick;
  slot.kind = kind;
  slot.placeId = placeId;
  slot.subjects = subjects;
  slot.severity = severity;
  st.head = (st.head + 1) % CAPS.eventRing;
  return slot;
}

/** Occupants of the place, plus anyone outdoors on an adjacent graph node. */
export function witnessesOf(city: City, placeId: BuildingId): SoulId[] {
  const out: SoulId[] = [];
  const b = city.buildings[placeId];
  if (!b) return out;
  for (const id of b.occupants) out.push(id);
  const door = b.doorNode;
  if (door < 0) return out;
  const near = new Set<number>([door]);
  for (let e = city.graph.edgeStart[door]; e < city.graph.edgeStart[door + 1]; e++) {
    near.add(city.graph.edgeTo[e]);
  }
  for (const s of city.souls) {
    if (s.inId >= 0) continue;
    if (near.has(s.atNode) || near.has(s.toNode)) out.push(s.id);
  }
  return out;
}

export function recentEvents(st: EventState, sinceTick: number, limit = 20): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 1; i <= CAPS.eventRing && out.length < limit; i++) {
    const e = st.events[(st.head - i + CAPS.eventRing) % CAPS.eventRing];
    if (e.tick < 0 || e.tick < sinceTick) continue;
    out.push(e);
  }
  return out;
}
