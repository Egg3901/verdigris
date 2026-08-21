// What the district believes, and how it comes to believe it.
//
// A claim is a proposition about somebody. It has a truth value the player can
// never see directly, and a separate conviction per soul who holds it. Claims
// spread along the relationship graph in the gossip slice, and every transmission
// can DISTORT: the child claim keeps a parentId, so a rumour has a lineage you
// can walk back to whoever started it. That lineage is most of what makes an
// intervention legible three days later.
import { CAPS } from './types';
import type { ClaimId, ClaimKind, SoulId } from './types';
import { mix, streamAt, Stream } from './rng';
import type { Belief, Soul } from './souls';

export interface Claim {
  id: ClaimId;
  kind: ClaimKind;
  subjectA: SoulId;
  subjectB: SoulId;
  placeId: number;
  /** 1 true, 0 false. Never shown to the player, only to the consequences. */
  truth: 0 | 1;
  bornTick: number;
  parentId: ClaimId;
  generation: number;
  severity: number;
  salience: number;
  carriers: number;
  /** -1 unless the player started it. Drives the tracing and the heat. */
  plantedBy: number;
}

export interface ClaimState {
  claims: Claim[];
  byKind: Map<ClaimKind, number>;
}

export function newClaims(): ClaimState {
  return { claims: [], byKind: new Map() };
}

const KIND_SEVERITY: Record<ClaimKind, number> = {
  affair: 380, theft: 520, graft: 640, sickness: 700, sabotage: 780,
  closure: 560, debt: 340, informer: 820, miracle: 260, collapse: 900,
  bylaw: 480,
};

export function seedClaim(
  st: ClaimState, kind: ClaimKind, subjectA: SoulId, subjectB: SoulId,
  placeId: number, truth: 0 | 1, tick: number, plantedBy = -1,
): ClaimId {
  if (st.claims.length >= CAPS.claims) pruneClaims(st);
  const id = st.claims.length;
  st.claims.push({
    id, kind, subjectA, subjectB, placeId, truth,
    bornTick: tick, parentId: -1, generation: 0,
    severity: KIND_SEVERITY[kind], salience: KIND_SEVERITY[kind],
    carriers: 0, plantedBy,
  });
  st.byKind.set(kind, (st.byKind.get(kind) ?? 0) + 1);
  return id;
}

export function implant(
  st: ClaimState, s: Soul, claimId: ClaimId, conviction: number, from: SoulId, tick: number,
): void {
  const existing = s.beliefs.find((b) => b.claimId === claimId);
  if (existing) {
    // Hearing a thing twice from two people is what makes it true to you.
    existing.conviction = Math.min(1000, existing.conviction + Math.round(conviction / 3));
    existing.heardTick = tick;
    return;
  }
  const belief: Belief = { claimId, conviction, heardFrom: from, heardTick: tick };
  s.beliefs.push(belief);
  st.claims[claimId].carriers++;
  // Eight beliefs per soul. Past that the weakest is forgotten, which is both a
  // cap and a decent model of how people work.
  s.beliefs.sort((a, b) => b.conviction - a.conviction);
  if (s.beliefs.length > CAPS.beliefsPerSoul) {
    const dropped = s.beliefs.pop();
    if (dropped) st.claims[dropped.claimId].carriers--;
  }
}

/** Fork a claim on transmission: the subject slips, or the severity grows. */
export function distort(st: ClaimState, parent: Claim, newSubject: SoulId, tick: number): ClaimId {
  if (st.claims.length >= CAPS.claims) return parent.id;
  const id = st.claims.length;
  st.claims.push({
    id, kind: parent.kind,
    subjectA: newSubject >= 0 ? newSubject : parent.subjectA,
    subjectB: parent.subjectA,
    placeId: parent.placeId,
    truth: 0,
    bornTick: tick,
    parentId: parent.id,
    generation: parent.generation + 1,
    severity: Math.min(1000, parent.severity + 60),
    salience: Math.min(1000, parent.salience + 40),
    carriers: 0,
    plantedBy: parent.plantedBy,
  });
  st.byKind.set(parent.kind, (st.byKind.get(parent.kind) ?? 0) + 1);
  return id;
}

/** Walk a rumour back to whoever started it. */
export function lineageOf(st: ClaimState, id: ClaimId): Claim[] {
  const out: Claim[] = [];
  let cur = st.claims[id];
  let guard = 0;
  while (cur && guard++ < 32) {
    out.push(cur);
    if (cur.parentId < 0) break;
    cur = st.claims[cur.parentId];
  }
  return out;
}

/** District-wide conviction in a kind of claim, 0..1000. Feeds suspicion and mood. */
export function convictionOf(st: ClaimState, souls: Soul[], kind: ClaimKind): number {
  let total = 0;
  let held = 0;
  for (const s of souls) {
    for (const b of s.beliefs) {
      if (st.claims[b.claimId]?.kind !== kind) continue;
      total += b.conviction;
      held++;
    }
  }
  if (!held) return 0;
  return Math.min(1000, Math.round((total / souls.length) * 1.4));
}

export function pruneClaims(st: ClaimState): void {
  // Drop the least-carried claims, never the most-believed ones.
  const order = st.claims.slice().sort((a, b) => a.carriers - b.carriers || a.bornTick - b.bornTick);
  const drop = new Set(order.slice(0, Math.floor(CAPS.claims * 0.2)).map((c) => c.id));
  for (const c of st.claims) if (drop.has(c.id)) c.salience = 0;
}

/**
 * The gossip pass, sliced sixty ways by soul id.
 *
 * Each speaking soul picks up to two partners weighted by tie strength and
 * co-location, and transmits at most one claim. Spreading this across sixty
 * minute-ticks gives a flat cost and continuous-feeling gossip instead of an
 * hourly spike.
 */
export function gossipSlice(
  st: ClaimState, souls: Soul[], seed: number, tick: number,
  partnersOf: (s: Soul) => SoulId[],
): void {
  const slice = tick % 60;
  for (const s of souls) {
    if (s.id % 60 !== slice) continue;
    if (s.depth !== 'principal') continue;
    if (!s.beliefs.length) continue;
    if (s.activity === 'asleep' || s.activity === 'dead') continue;

    const rng = streamAt(seed, Stream.Gossip, tick, s.id);
    const partners = partnersOf(s);
    if (!partners.length) continue;

    const belief = s.beliefs[0];
    const claim = st.claims[belief.claimId];
    if (!claim || claim.salience <= 0) continue;

    for (let i = 0; i < Math.min(2, partners.length); i++) {
      const other = souls[partners[(mix(seed, Stream.Gossip, tick, s.id + i) >>> 0) % partners.length]];
      if (!other || other.id === s.id) continue;
      if (other.activity === 'asleep') continue;

      // Whether it lands is conviction, listener credulity and how juicy it is.
      const chance = (belief.conviction * 0.4 + other.credulity * 0.35 + claim.salience * 0.25) / 1000;
      if (rng() > chance * 0.5) continue;

      // Chinese whispers: sometimes the name changes on the way.
      const willDistort = rng() < 0.14 && claim.generation < 4;
      const target = willDistort
        ? distort(st, claim, partners[(mix(seed, 77, tick, other.id) >>> 0) % partners.length], tick)
        : claim.id;

      implant(st, other, target, Math.round(belief.conviction * 0.7), s.id, tick);
      s.lastSpokeTick = tick;
    }
  }
}

/** Beliefs fade. Without this every claim is eternal and the district calcifies. */
export function decayBeliefsDaily(st: ClaimState, souls: Soul[]): void {
  for (const s of souls) {
    for (let i = s.beliefs.length - 1; i >= 0; i--) {
      const b = s.beliefs[i];
      b.conviction = Math.round(b.conviction * 0.88);
      if (b.conviction < 60) {
        st.claims[b.claimId].carriers--;
        s.beliefs.splice(i, 1);
      }
    }
  }
}
