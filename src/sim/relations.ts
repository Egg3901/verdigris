// Who knows whom. CSR adjacency, built once, edited rarely.
//
// Only principals carry a full relationship graph. Two hundred souls is more
// names than any player will read, so the writing and the gossip cost are both
// concentrated on the forty who will actually be looked at.
import type { SoulId } from './types';
import type { Soul } from './souls';
import type { Household } from './households';
import type { Firm } from './firms';
import { mix } from './rng';

export type TieKind = 'kin' | 'household' | 'workmate' | 'neighbour' | 'drinking' | 'rival';

export interface Relations {
  start: Int32Array;
  to: Int16Array;
  kind: Uint8Array;
  strength: Uint8Array;
}

const KIND_CODE: Record<TieKind, number> = {
  kin: 0, household: 1, workmate: 2, neighbour: 3, drinking: 4, rival: 5,
};

export function buildRelations(
  seed: number, souls: Soul[], households: Household[], firms: Firm[],
): Relations {
  const adj: { to: number; kind: number; strength: number }[][] =
    Array.from({ length: souls.length }, () => []);

  const link = (a: SoulId, b: SoulId, kind: TieKind, strength: number) => {
    if (a === b || a < 0 || b < 0) return;
    if (adj[a].some((e) => e.to === b)) return;
    adj[a].push({ to: b, kind: KIND_CODE[kind], strength });
    adj[b].push({ to: a, kind: KIND_CODE[kind], strength });
  };

  // Household first: the strongest ties in a Victorian district are the ones you
  // cannot get away from.
  for (const h of households) {
    for (let i = 0; i < h.memberIds.length; i++) {
      for (let j = i + 1; j < h.memberIds.length; j++) {
        link(h.memberIds[i], h.memberIds[j], 'household', 230);
      }
    }
  }

  // Workmates, capped: a mill hand knows a dozen people on the floor, not all
  // forty-five, and linking everyone to everyone makes gossip instantaneous.
  for (const f of firms) {
    const w = f.workerIds;
    for (let i = 0; i < w.length; i++) {
      for (let k = 1; k <= 4 && i + k < w.length; k++) {
        link(w[i], w[i + k], 'workmate', 150);
      }
    }
  }

  // Neighbours: same building, and the building next door by id adjacency.
  const byHome = new Map<number, SoulId[]>();
  for (const s of souls) {
    if (!byHome.has(s.homeId)) byHome.set(s.homeId, []);
    (byHome.get(s.homeId) as SoulId[]).push(s.id);
  }
  for (const [homeId, list] of byHome) {
    const next = byHome.get(homeId + 1);
    if (!next) continue;
    for (let i = 0; i < Math.min(3, list.length); i++) {
      for (let j = 0; j < Math.min(3, next.length); j++) link(list[i], next[j], 'neighbour', 110);
    }
  }

  // A handful of drinking companions and one rival each, for the principals.
  for (const s of souls) {
    if (s.depth !== 'principal') continue;
    for (let i = 0; i < 3; i++) {
      const other = (mix(seed, 61, s.id, i) >>> 0) % souls.length;
      link(s.id, other, 'drinking', 90);
    }
    const rival = (mix(seed, 62, s.id) >>> 0) % souls.length;
    link(s.id, rival, 'rival', 70);
  }

  const start = new Int32Array(souls.length + 1);
  for (let i = 0; i < souls.length; i++) start[i + 1] = start[i] + adj[i].length;
  const total = start[souls.length];
  const to = new Int16Array(total);
  const kind = new Uint8Array(total);
  const strength = new Uint8Array(total);
  for (let i = 0; i < souls.length; i++) {
    let at = start[i];
    for (const e of adj[i]) {
      to[at] = e.to;
      kind[at] = e.kind;
      strength[at] = Math.min(255, e.strength);
      at++;
    }
  }
  return { start, to, kind, strength };
}

export function neighboursOf(r: Relations, id: SoulId): SoulId[] {
  const out: SoulId[] = [];
  for (let i = r.start[id]; i < r.start[id + 1]; i++) out.push(r.to[i]);
  return out;
}

export function tieStrength(r: Relations, a: SoulId, b: SoulId): number {
  for (let i = r.start[a]; i < r.start[a + 1]; i++) if (r.to[i] === b) return r.strength[i];
  return 0;
}

export function adjustTie(r: Relations, a: SoulId, b: SoulId, delta: number): void {
  for (let i = r.start[a]; i < r.start[a + 1]; i++) {
    if (r.to[i] === b) r.strength[i] = Math.max(0, Math.min(255, r.strength[i] + delta));
  }
  for (let i = r.start[b]; i < r.start[b + 1]; i++) {
    if (r.to[i] === a) r.strength[i] = Math.max(0, Math.min(255, r.strength[i] + delta));
  }
}
