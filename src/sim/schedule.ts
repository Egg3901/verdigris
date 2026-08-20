// Daily patterns, and the wheel that fires them.
//
// Schedules with interrupts, deliberately NOT utility AI or GOAP. Cheaper, far
// more testable, and crucially more legible: this game only works if a soul's day
// is predictable enough that a DEVIATION reads as meaningful. An agent that does
// something surprising every day is noise, not character.
import { MIN_PER_DAY } from './clock';
import type { Activity, BuildingKind, Trade, SoulId } from './types';

export type PlaceRef =
  | { at: 'home' }
  | { at: 'work' }
  | { at: 'kind'; kind: BuildingKind }
  | { at: 'building'; id: number }
  | { at: 'node'; id: number };

export interface Block {
  fromMin: number;
  activity: Activity;
  place: PlaceRef;
  /** Minutes of jitter allowed either side, so a shift change is a crowd and not a rank. */
  slack: number;
}

export interface Pattern {
  id: number;
  label: string;
  trades: Trade[];
  blocks: Block[];
}

const HOME: PlaceRef = { at: 'home' };
const WORK: PlaceRef = { at: 'work' };
const PUB: PlaceRef = { at: 'kind', kind: 'pub' };
const SHOP: PlaceRef = { at: 'kind', kind: 'shop' };
const CHAPEL: PlaceRef = { at: 'kind', kind: 'chapel' };
const SCHOOL: PlaceRef = { at: 'kind', kind: 'school' };

export const PATTERNS: readonly Pattern[] = [
  {
    id: 0,
    label: 'mill shift',
    trades: ['millhand', 'docker', 'lighterman', 'printer', 'seamstress', 'laundress'],
    blocks: [
      { fromMin: 0, activity: 'asleep', place: HOME, slack: 0 },
      { fromMin: 330, activity: 'waking', place: HOME, slack: 10 },
      { fromMin: 360, activity: 'commuting', place: WORK, slack: 10 },
      { fromMin: 420, activity: 'working', place: WORK, slack: 0 },
      { fromMin: 750, activity: 'eating', place: WORK, slack: 10 },
      { fromMin: 780, activity: 'working', place: WORK, slack: 0 },
      { fromMin: 1080, activity: 'commuting', place: HOME, slack: 15 },
      { fromMin: 1140, activity: 'eating', place: HOME, slack: 10 },
      { fromMin: 1200, activity: 'drinking', place: PUB, slack: 20 },
      { fromMin: 1320, activity: 'asleep', place: HOME, slack: 15 },
    ],
  },
  {
    id: 1,
    label: 'counting house',
    trades: ['clerk', 'alderman', 'engineer'],
    blocks: [
      { fromMin: 0, activity: 'asleep', place: HOME, slack: 0 },
      { fromMin: 420, activity: 'waking', place: HOME, slack: 15 },
      { fromMin: 480, activity: 'commuting', place: WORK, slack: 15 },
      { fromMin: 540, activity: 'working', place: WORK, slack: 0 },
      { fromMin: 780, activity: 'eating', place: PUB, slack: 20 },
      { fromMin: 840, activity: 'working', place: WORK, slack: 0 },
      { fromMin: 1080, activity: 'commuting', place: HOME, slack: 20 },
      { fromMin: 1140, activity: 'eating', place: HOME, slack: 10 },
      { fromMin: 1230, activity: 'visiting', place: HOME, slack: 20 },
      { fromMin: 1350, activity: 'asleep', place: HOME, slack: 15 },
    ],
  },
  {
    id: 2,
    label: 'counter and till',
    trades: ['shopkeeper', 'publican', 'nurse', 'curate', 'lamplighter', 'conductor'],
    blocks: [
      { fromMin: 0, activity: 'asleep', place: HOME, slack: 0 },
      { fromMin: 390, activity: 'waking', place: HOME, slack: 15 },
      { fromMin: 430, activity: 'commuting', place: WORK, slack: 10 },
      { fromMin: 480, activity: 'working', place: WORK, slack: 0 },
      { fromMin: 810, activity: 'eating', place: WORK, slack: 15 },
      { fromMin: 840, activity: 'working', place: WORK, slack: 0 },
      { fromMin: 1230, activity: 'commuting', place: HOME, slack: 20 },
      { fromMin: 1290, activity: 'eating', place: HOME, slack: 10 },
      { fromMin: 1350, activity: 'asleep', place: HOME, slack: 15 },
    ],
  },
  {
    id: 3,
    label: 'the beat',
    trades: ['constable'],
    blocks: [
      { fromMin: 0, activity: 'loitering', place: { at: 'kind', kind: 'constabulary' }, slack: 20 },
      { fromMin: 300, activity: 'commuting', place: HOME, slack: 20 },
      { fromMin: 360, activity: 'asleep', place: HOME, slack: 0 },
      { fromMin: 780, activity: 'waking', place: HOME, slack: 20 },
      { fromMin: 840, activity: 'eating', place: HOME, slack: 15 },
      { fromMin: 900, activity: 'commuting', place: WORK, slack: 15 },
      { fromMin: 960, activity: 'working', place: WORK, slack: 0 },
      { fromMin: 1200, activity: 'loitering', place: { at: 'kind', kind: 'constabulary' }, slack: 30 },
    ],
  },
  {
    id: 4,
    label: 'school and street',
    trades: ['child'],
    blocks: [
      { fromMin: 0, activity: 'asleep', place: HOME, slack: 0 },
      { fromMin: 420, activity: 'waking', place: HOME, slack: 20 },
      { fromMin: 510, activity: 'commuting', place: SCHOOL, slack: 20 },
      { fromMin: 555, activity: 'working', place: SCHOOL, slack: 0 },
      { fromMin: 720, activity: 'loitering', place: SCHOOL, slack: 15 },
      { fromMin: 780, activity: 'working', place: SCHOOL, slack: 0 },
      { fromMin: 960, activity: 'loitering', place: HOME, slack: 30 },
      { fromMin: 1110, activity: 'eating', place: HOME, slack: 15 },
      { fromMin: 1230, activity: 'asleep', place: HOME, slack: 20 },
    ],
  },
  {
    id: 5,
    label: 'at home',
    trades: ['none'],
    blocks: [
      { fromMin: 0, activity: 'asleep', place: HOME, slack: 0 },
      { fromMin: 400, activity: 'waking', place: HOME, slack: 25 },
      { fromMin: 540, activity: 'errand', place: SHOP, slack: 30 },
      { fromMin: 640, activity: 'visiting', place: HOME, slack: 25 },
      { fromMin: 780, activity: 'eating', place: HOME, slack: 20 },
      { fromMin: 900, activity: 'worshipping', place: CHAPEL, slack: 40 },
      { fromMin: 1020, activity: 'visiting', place: HOME, slack: 30 },
      { fromMin: 1290, activity: 'asleep', place: HOME, slack: 25 },
    ],
  },
];

const BY_TRADE = new Map<Trade, number[]>();
for (const p of PATTERNS) {
  for (const t of p.trades) {
    if (!BY_TRADE.has(t)) BY_TRADE.set(t, []);
    (BY_TRADE.get(t) as number[]).push(p.id);
  }
}

export function patternFor(trade: Trade, age: number, salt: number): number {
  if (age < 14) return 4;
  if (age >= 68) return 5;
  const ids = BY_TRADE.get(trade);
  if (!ids || !ids.length) return 5;
  return ids[salt % ids.length];
}

/** The wheel: minuteOfDay to the souls whose block boundary lands there. Built once
 *  at worldgen, patched when a soul changes pattern. Most ticks fire nobody, which
 *  is the entire point. */
export function buildDueWheel(
  count: number, scheduleIdOf: (i: number) => number, jitterOf: (i: number, blockIdx: number) => number,
): SoulId[][] {
  const wheel: SoulId[][] = Array.from({ length: MIN_PER_DAY }, () => []);
  for (let i = 0; i < count; i++) {
    const p = PATTERNS[scheduleIdOf(i)];
    for (let b = 0; b < p.blocks.length; b++) {
      const at = blockStart(p, b, jitterOf(i, b));
      wheel[at].push(i);
    }
  }
  return wheel;
}

export function blockStart(p: Pattern, blockIdx: number, jitter: number): number {
  const blk = p.blocks[blockIdx];
  const slack = blk.slack;
  const off = slack === 0 ? 0 : (jitter % (slack * 2 + 1)) - slack;
  let m = blk.fromMin + off;
  if (m < 0) m += MIN_PER_DAY;
  return m % MIN_PER_DAY;
}

/** Which block a pattern is in at a given minute, ignoring jitter. Used to place
 *  souls correctly at tick 0 rather than teleporting them at the first boundary. */
export function blockAt(p: Pattern, minute: number): number {
  let idx = p.blocks.length - 1;
  for (let i = 0; i < p.blocks.length; i++) {
    if (p.blocks[i].fromMin <= minute) idx = i;
    else break;
  }
  return idx;
}
