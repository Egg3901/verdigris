// State-driven sentence assembly.
//
// Three parts, in this order:
//   A. SENSE LINE  the top passing fragments from the lexicon, joined as a list
//   B. STANDING FACT  a grudge with a negative sinceTick, rendered in years
//   C. LIVE CLAUSE  only if something is actually happening, otherwise omitted
//
// Part B is the trick that makes day one feel like year eleven. The generator
// invented a past before the player arrived, so "an argument about drainage that
// has run for eleven years" is a true statement about stored state and costs
// nothing at runtime.
//
// Selection uses streamAt(seed, Prose, hourBucket, entity), so the text is stable
// within a game-hour and breathes across hours. It never uses the wall clock.
import { MIN_PER_DAY } from './clock';
import type { City } from './city';
import { DEFS } from './buildings';
import type { Building, Grudge } from './buildings';
import { SENSES, activityPhrase, joinList } from './lexicon';
import { fullName } from './souls';
import type { Soul } from './souls';
import { Stream, streamAt } from './rng';
import { addressOf } from './worldgen';
import type { SoulId } from './types';

const MAX_SENSES = 3;

function hourBucket(tick: number): number {
  return Math.floor(tick / 60);
}

export function yearsSince(g: Grudge, tick: number): number {
  const minutes = tick - g.sinceTick;
  return Math.max(1, Math.floor(minutes / (MIN_PER_DAY * 365)));
}

/** The one line of prose on the inspector card. */
export function describeBuilding(city: City, id: number): string {
  const b = city.buildings[id];
  if (!b) return '';

  const passing = SENSES.filter((f) => f.when(city, b));
  const rng = streamAt(city.seed, Stream.Prose, hourBucket(city.tick), b.id);
  // Sort by salience, break ties with the hour stream so the line breathes.
  const ranked = passing
    .map((f) => ({ f, jitter: rng() }))
    .sort((p, q) => q.f.salience - p.f.salience || p.jitter - q.jitter)
    .slice(0, MAX_SENSES)
    .map((x) => x.f.token);

  const parts: string[] = [];
  if (ranked.length) {
    const list = joinList(ranked);
    parts.push(list.charAt(0).toUpperCase() + list.slice(1));
  }

  const grudge = pickGrudge(city, b);
  if (grudge) {
    const years = yearsSince(grudge, city.tick);
    parts.push(`an argument about ${grudge.topic} that has run for ${years} year${years === 1 ? '' : 's'}`);
  }

  // A single short token ("Dust.") is not a sentence anybody wants to read, so a
  // thin line gets the building's own label to lean on. Every kind carries at
  // least one identity fragment in the lexicon, so this is a floor, not a crutch.
  if (parts.length && ranked.length < 2 && ranked[0].length < 14) {
    parts.push(`not much else the ${DEFS[b.kind].label.toLowerCase()} will admit to`);
  }
  let line = parts.length ? `${joinList(parts)}.` : `${DEFS[b.kind].label}, and not much else.`;

  const live = liveClause(city, b);
  if (live) line += ` ${live}`;
  return line;
}

function pickGrudge(city: City, b: Building): Grudge | null {
  if (!b.grudges.length) return null;
  const rng = streamAt(city.seed, Stream.Prose, hourBucket(city.tick), b.id + 7919);
  return b.grudges[Math.floor(rng() * b.grudges.length) % b.grudges.length];
}

/** Absence is information: a building with nothing happening gets no clause. */
function liveClause(city: City, b: Building): string {
  if (b.lastIncidentTick >= 0 && city.tick - b.lastIncidentTick < 240) {
    return 'Something happened here this morning and nobody has written it down yet.';
  }
  if (b.fabric < 220) return 'The building is not safe and everyone concerned knows it.';
  if (b.occupants.length > DEFS[b.kind].capacity * 1.5) return 'It is fuller than it should be.';
  return '';
}

export interface InsideLine {
  soulId: SoulId;
  line: string;
}

/**
 * The INSIDE list.
 *
 * Needs no generation beyond a verb lookup, and that is the point: it reads the
 * actual activity enum off the actual occupants, so it is guaranteed truthful.
 */
export function insideList(city: City, id: number, limit = 8): { lines: InsideLine[]; more: number } {
  const b = city.buildings[id];
  if (!b) return { lines: [], more: 0 };
  const lines: InsideLine[] = [];
  for (const sid of b.occupants) {
    if (lines.length >= limit) break;
    const s = city.souls[sid];
    lines.push({
      soulId: sid,
      line: `${fullName(s)}, ${activityPhrase(s.activity, s.trade, s.fatigue, s.grievance, s.hunger)}`,
    });
  }
  return { lines, more: Math.max(0, b.occupants.length - lines.length) };
}

export function describeSoul(city: City, id: number): string {
  const s = city.souls[id];
  if (!s) return '';
  const home = city.buildings[s.homeId];
  const where = home ? addressOf(city, home) : 'nowhere fixed';
  const trade = s.trade === 'none' ? 'no trade left' : s.trade === 'child' ? 'still at school' : s.trade;
  const doing = activityPhrase(s.activity, s.trade, s.fatigue, s.grievance, s.hunger);
  return `${s.age}, ${trade}, of ${where}. Currently ${doing}.`;
}

/** Where a soul is going, for the BOUND FOR line on the inspector. */
export function boundFor(city: City, s: Soul): string {
  if (s.inId >= 0) return '';
  if (s.destBuilding >= 0) {
    const b = city.buildings[s.destBuilding];
    if (b) return b.name;
  }
  return 'nowhere in particular';
}

export function carrying(city: City, s: Soul): string {
  const bits: string[] = [];
  if (s.purse > 200) bits.push('a full purse');
  else if (s.purse < 20) bits.push('nothing worth taking');
  if (s.hunger > 800) bits.push('an empty stomach');
  if (s.grievance > 700) bits.push('a grievance');
  if (s.beliefs.length) bits.push(`${s.beliefs.length} thing${s.beliefs.length === 1 ? '' : 's'} heard secondhand`);
  void city;
  return bits.length ? joinList(bits) : 'nothing in particular';
}
