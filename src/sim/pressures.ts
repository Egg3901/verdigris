// The eight pressures, and the cause ring that makes them legible.
//
// applyPressure is the ONLY writer. Every write appends to a 512-entry ring, so
// explain('gas') can walk backward and say "the tram is late because the depot
// lost gas because you cut the main on Foundry Row". Legibility is a data
// structure here, not a UI trick, and it costs one array write per change.
//
// rot is the thesis engine. It does nothing visible on its own. It quietly turns
// "a repair was ordered" into "the repair never happened", so fabric decays while
// facade spending continues. The city looks better every week and is structurally
// worse every week, and the player can watch both numbers.
import { CAPS, PRESSURE_KEYS } from './types';
import type { PressureKey } from './types';

export interface Pressure {
  value: number;
  baseline: number;
  /** Permille of the gap closed per game-hour. */
  decayPerHour: number;
}

export type CauseKind = 'intervention' | 'incident' | 'claim' | 'decay' | 'firm' | 'network' | 'weather' | 'seed';

export interface Cause {
  tick: number;
  key: PressureKey;
  delta: number;
  causeKind: CauseKind;
  causeRef: number;
  note: string;
}

export interface PressureState {
  pressures: Record<PressureKey, Pressure>;
  causes: Cause[];
  causeHead: number;
}

const START: Record<PressureKey, [number, number, number]> = {
  //          value, baseline, decay permille per hour
  gas: [820, 820, 120],
  tram: [760, 780, 140],
  wages: [520, 540, 60],
  sanitation: [430, 460, 70],
  mood: [640, 600, 90],
  suspicion: [180, 160, 110],
  rot: [340, 360, 20],
  coin: [600, 620, 40],
};

export function newPressures(): PressureState {
  const pressures = {} as Record<PressureKey, Pressure>;
  for (const k of PRESSURE_KEYS) {
    const [value, baseline, decayPerHour] = START[k];
    pressures[k] = { value, baseline, decayPerHour };
  }
  return {
    pressures,
    causes: new Array(CAPS.causeRing).fill(null).map(() => ({
      tick: -1, key: 'gas' as PressureKey, delta: 0,
      causeKind: 'seed' as CauseKind, causeRef: -1, note: '',
    })),
    causeHead: 0,
  };
}

export function applyPressure(
  st: PressureState, key: PressureKey, delta: number,
  causeKind: CauseKind, causeRef: number, note: string, tick: number,
): void {
  if (delta === 0) return;
  const p = st.pressures[key];
  const before = p.value;
  p.value = Math.max(0, Math.min(1000, Math.round(p.value + delta)));
  const actual = p.value - before;
  if (actual === 0) return;
  const slot = st.causes[st.causeHead];
  slot.tick = tick;
  slot.key = key;
  slot.delta = actual;
  slot.causeKind = causeKind;
  slot.causeRef = causeRef;
  slot.note = note;
  st.causeHead = (st.causeHead + 1) % CAPS.causeRing;
}

export function pressureOf(st: PressureState, key: PressureKey): number {
  return st.pressures[key].value;
}

/** Hourly pull back toward the baseline. Logged like everything else, so a player
 *  who asks why the mood fell never gets an unexplained number. */
export function decayPressuresHourly(st: PressureState, tick: number): void {
  for (const k of PRESSURE_KEYS) {
    const p = st.pressures[k];
    const gap = p.baseline - p.value;
    if (gap === 0) continue;
    const step = Math.trunc((gap * p.decayPerHour) / 1000);
    const delta = step === 0 ? Math.sign(gap) : step;
    applyPressure(st, k, delta, 'decay', 0, 'settling back', tick);
  }
}

/** The most recent causes for a key, newest first. This is the legibility contract. */
export function explain(st: PressureState, key: PressureKey, limit = 6): Cause[] {
  const out: Cause[] = [];
  for (let i = 1; i <= CAPS.causeRing && out.length < limit; i++) {
    const c = st.causes[(st.causeHead - i + CAPS.causeRing) % CAPS.causeRing];
    if (c.tick < 0) continue;
    if (c.key !== key) continue;
    if (c.causeKind === 'decay') continue;
    out.push(c);
  }
  return out;
}

/** Everything the ring remembers, newest first, whatever the key. */
export function recentCauses(st: PressureState, limit = 12): Cause[] {
  const out: Cause[] = [];
  for (let i = 1; i <= CAPS.causeRing && out.length < limit; i++) {
    const c = st.causes[(st.causeHead - i + CAPS.causeRing) % CAPS.causeRing];
    if (c.tick < 0 || c.causeKind === 'decay') continue;
    out.push(c);
  }
  return out;
}
