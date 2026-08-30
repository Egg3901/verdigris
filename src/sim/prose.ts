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
import { latestOrderFor } from './works';
import { isDeputationActive } from './deputations';
import { disasterAt, isBuildingClosed } from './disasters';
import { weatherAt } from './weather';
import { serviceAt } from './networks';
import { isShelterActive } from './shelters';
import { civicBuildingClause, civicHouseholdClause } from './civic-memory';
import { isOccasionActive } from './occasions';

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

  // The sense line and the standing fact are two SENTENCES, not two items in one
  // list. Feeding both through joinList produced "Raw cotton, dust, and soot on
  // the sills and an argument about an unpaid account", which has two "and"s
  // doing different jobs and reads as a run-on.
  const senseTokens = ranked.slice();
  const sentences: string[] = [];
  if (senseTokens.length) {
    const list = joinList(senseTokens);
    sentences.push(`${list.charAt(0).toUpperCase()}${list.slice(1)}.`);
  }

  const grudge = pickGrudge(city, b);
  if (grudge) {
    const years = yearsSince(grudge, city.tick);
    sentences.push(`An argument about ${grudge.topic} has run here for ${years} year${years === 1 ? '' : 's'}.`);
  }

  let line = sentences.length ? sentences.join(' ') : `No more can be learned from the street than that it is a ${DEFS[b.kind].label.toLowerCase()}.`;

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
  const disaster = disasterAt(city, b.id);
  if (disaster) {
    const active = disaster.status === 'active';
    if (disaster.kind === 'fire') {
      return active
        ? 'A fire is burning here, and the gas main below it has failed.'
        : 'The fire is contained, but the damage and the broken main remain.';
    }
    if (disaster.kind === 'flood') {
      return active
        ? 'Floodwater is around the foundations and the drains have failed.'
        : 'The flood has gone down, but the drains and the fabric remain damaged.';
    }
    return active
      ? 'The structure has collapsed and the site is closed.'
      : 'The collapse has been contained, but the site remains closed until it is repaired.';
  }
  if (b.fabric === 0 && isBuildingClosed(city, b.id)) {
    return 'The structure remains collapsed and closed until structural work is done.';
  }
  const shelter = city.shelters.current;
  if (shelter && shelter.providerId === b.id && isShelterActive(city)) {
    if (DEFS[b.kind].needsDrain && !serviceAt(city.networks.drain, b.id)) {
      return 'The storm refuge is open, but its drain has failed and the crowded room is turning foul.';
    }
    if (!shelter.arrivedIds.length) return 'A storm refuge has opened here and the first people are still on their way.';
    return `${shelter.arrivedIds.length} ${shelter.arrivedIds.length === 1 ? 'person has' : 'people have'} reached the storm refuge inside.`;
  }
  const market = city.occasions.current;
  if (market && market.hallId === b.id && isOccasionActive(city)) {
    if (market.status === 'open') return `${market.arrivedIds.length} people have made a market in the square outside.`;
    return 'The market is assembling in the square outside.';
  }
  const weather = weatherAt(city.seed, city.tick);
  if (weather.precipitation > 0 && DEFS[b.kind].needsDrain && !serviceAt(city.networks.drain, b.id)) {
    return weather.kind === 'storm'
      ? 'Water is spilling from the broken rain goods and backing through the drain.'
      : 'Rain is finding the broken drain and darkening the lower brickwork.';
  }
  if (weather.precipitation > 0 && b.firmId >= 0 && city.firms[b.firmId]?.kind === 'wharf') {
    return weather.kind === 'storm'
      ? 'Hard rain has slowed the quay to dangerous, deliberate work.'
      : 'The quay work is carrying on more slowly in the rain.';
  }
  const deputation = city.deputations.current;
  if (deputation && deputation.buildingId === b.id && isDeputationActive(city)) {
    if (deputation.status === 'heard') return 'Its deputation has been heard beneath the Town Hall windows.';
    if (deputation.status === 'dispersed') return 'Its deputation is being broken up beneath the Town Hall windows.';
    if (deputation.status === 'thin') return 'Too few from this address reached the Town Hall to be heard.';
    return 'Its neighbours are making for the Town Hall as a public deputation.';
  }
  const order = latestOrderFor(city, b.id);
  if (order?.status === 'working') return 'A works gang has the frontage behind poles and canvas.';
  if (order?.status === 'filed') return 'A blue survey mark says the address has entered the works register.';
  if (order?.status === 'skimmed') return 'The defect remains behind fresh paint and a new brass plaque.';
  if (order?.status === 'shelved') return 'A numbered works notice is pasted by the door, already curling at the corners.';
  const civic = civicBuildingClause(city, b.id);
  if (civic) return civic;
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
      line: `${fullName(s)}, ${activityPhrase(s.activity, s.trade, s.fatigue, s.grievance, s.hunger, s.id)}`,
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
  const doing = activityPhrase(s.activity, s.trade, s.fatigue, s.grievance, s.hunger, s.id);
  const weather = weatherAt(city.seed, city.tick);
  const exposure = s.inId < 0 && weather.precipitation > 0
    ? weather.kind === 'storm' ? ' The hard rain has got through every layer.' : ' Out in the rain.'
    : '';
  const civic = civicHouseholdClause(city, s.householdId);
  return `${s.age}, ${trade}, of ${where}. ${doing.charAt(0).toUpperCase()}${doing.slice(1)}.${exposure}${civic ? ` ${civic}` : ''}`;
}

/** Where a soul is going, for the BOUND FOR line on the inspector. */
export function boundFor(city: City, s: Soul): string {
  if (s.inId >= 0) return '';
  if (s.destBuilding >= 0) {
    const b = city.buildings[s.destBuilding];
    if (b) return b.name;
  }
  return 'walking without a stated errand';
}

export function carrying(city: City, s: Soul): string {
  const bits: string[] = [];
  if (s.purse > 200) bits.push('a full purse');
  else if (s.purse < 20) bits.push('an almost empty purse');
  if (s.hunger > 800) bits.push('an empty stomach');
  if (s.grievance > 700) bits.push('a grievance');
  if (s.beliefs.some((b) => city.claims.claims[b.claimId]?.kind === 'bylaw')) {
    bits.push('a grievance against the hall');
  } else if (s.beliefs.length) {
    bits.push(`${s.beliefs.length} report${s.beliefs.length === 1 ? '' : 's'} heard at second hand`);
  }
  return bits.length ? joinList(bits) : 'no parcel or paper of note';
}
