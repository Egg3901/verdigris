// Civic Market Day is a bounded public occasion. It owns a small real group,
// sends them through the street graph, and never turns a calendar entry into a
// crowd unless bodies actually reach the square.
import type { City } from './city';
import { pushLog, resumeCurrentBlock, sendToNode } from './city';
import { civicHouseholdBurden } from './civic-memory';
import { isDeputationActive } from './deputations';
import { emit } from './events';
import { gateOrdinanceTarget } from './ordinances';
import { mix, Stream } from './rng';
import type { Activity, BuildingId, SoulId } from './types';
import { MIN_PER_DAY, minuteOfDay } from './clock';
import { isWetWeather, weatherAt } from './weather';

export type OccasionStatus = 'assembling' | 'open' | 'thin' | 'rainedOut';

export interface MarketOccasion {
  id: number;
  squareNode: number;
  hallId: BuildingId;
  day: number;
  startedAt: number;
  endsAt: number;
  vendorIds: SoulId[];
  visitorIds: SoulId[];
  attendeeIds: SoulId[];
  arrivedIds: SoulId[];
  servedIds: SoulId[];
  rejectedCount: number;
  status: OccasionStatus;
}

export interface MarketOutcome {
  day: number;
  hallId: BuildingId;
  status: Exclude<OccasionStatus, 'assembling'>;
  arrived: number;
  invited: number;
  endedAt: number;
}

export interface OccasionState {
  current: MarketOccasion | null;
  lastOutcome: MarketOutcome | null;
  lastDay: number;
  nextId: number;
  revision: number;
}

const MARKET_MINUTE = 600;
const DURATION = 240;
const MAX_VENDORS = 3;
const MAX_VISITORS = 5;
const OPEN_THRESHOLD = 4;

export function newOccasions(): OccasionState {
  return { current: null, lastOutcome: null, lastDay: -1, nextId: 0, revision: 0 };
}

export function isOccasionActive(city: City): boolean {
  const current = city.occasions.current;
  return Boolean(current && city.tick < current.endsAt);
}

/** Every district has one market day in six, offset by its seed. */
export function isMarketDay(city: City, day = Math.floor(city.tick / MIN_PER_DAY)): boolean {
  return day % 6 === mix(city.seed, Stream.Crowd, 711, 0) % 6;
}

function hallOf(city: City): BuildingId {
  return city.buildingsByKind.get('townhall')?.[0] ?? -1;
}

function canRun(city: City): string | null {
  if (city.occasions.current) return 'The square is already occupied.';
  if (isDeputationActive(city)) return 'A deputation has the square.';
  if (city.shelters.current) return 'The refuge has priority in the square.';
  const weather = weatherAt(city.seed, city.tick);
  if (weather.kind !== 'fair' && weather.kind !== 'overcast') return 'The weather has kept the market in.';
  if (city.squareNode < 0 || city.squareNode >= city.graph.n) return 'The civic square has no route.';
  if (hallOf(city) < 0) return 'There is no Civic Hall.';
  return null;
}

function eligible(city: City, soulId: SoulId): boolean {
  const s = city.souls[soulId];
  return Boolean(s && s.inId >= 0 && s.returnAt < 0 && s.overrideUntil <= city.tick
    && s.age >= 14 && s.activity !== 'asleep' && s.activity !== 'held' && s.activity !== 'dead');
}

function sortByTie(city: City, ids: SoulId[], salt: number): SoulId[] {
  return ids.sort((a, b) => {
    const sa = city.souls[a];
    const sb = city.souls[b];
    const burdenA = civicHouseholdBurden(city, sa.householdId);
    const burdenB = civicHouseholdBurden(city, sb.householdId);
    if (burdenA !== burdenB) return burdenB - burdenA;
    const distA = Math.abs(city.graph.cx[city.buildings[sa.homeId]?.doorNode ?? 0] - city.graph.cx[city.squareNode])
      + Math.abs(city.graph.cy[city.buildings[sa.homeId]?.doorNode ?? 0] - city.graph.cy[city.squareNode]);
    const distB = Math.abs(city.graph.cx[city.buildings[sb.homeId]?.doorNode ?? 0] - city.graph.cx[city.squareNode])
      + Math.abs(city.graph.cy[city.buildings[sb.homeId]?.doorNode ?? 0] - city.graph.cy[city.squareNode]);
    if (distA !== distB) return distA - distB;
    return mix(city.seed, Stream.Crowd, city.tick, a + salt) - mix(city.seed, Stream.Crowd, city.tick, b + salt) || a - b;
  });
}

function candidateIds(city: City): { vendors: SoulId[]; visitors: SoulId[] } {
  const all = city.souls.filter((s) => eligible(city, s.id)).map((s) => s.id);
  const vendors = sortByTie(city, all.filter((id) => city.souls[id].trade === 'shopkeeper'), 101).slice(0, MAX_VENDORS);
  const vendorSet = new Set(vendors);
  const visitors = sortByTie(city, all.filter((id) => !vendorSet.has(id)
    && city.souls[id].trade !== 'constable' && city.souls[id].trade !== 'lamplighter'), 307).slice(0, MAX_VISITORS);
  return { vendors, visitors };
}

/** Starts a market immediately for QA and tests, or returns zero when conditions refuse it. */
export function startMarketDay(city: City): number {
  if (canRun(city)) return 0;
  const hallId = hallOf(city);
  const { vendors, visitors } = candidateIds(city);
  const proposed = vendors.concat(visitors);
  const attendeeIds: SoulId[] = [];
  const priorArrivals: Activity[] = [];
  let rejectedCount = 0;
  for (const id of proposed) {
    const s = city.souls[id];
    const prior = s.arriveActivity;
    s.arriveActivity = 'gathering';
    const permitted = gateOrdinanceTarget(city, s, hallId, 'gathering') === hallId;
    if (!permitted) {
      s.arriveActivity = prior;
      rejectedCount++;
      continue;
    }
    attendeeIds.push(id);
    priorArrivals.push(prior);
  }
  const vendorIds = vendors.filter((id) => attendeeIds.includes(id));
  if (attendeeIds.length < 2 || vendorIds.length === 0) {
    for (let i = 0; i < attendeeIds.length; i++) {
      city.souls[attendeeIds[i]].arriveActivity = priorArrivals[i];
    }
    return 0;
  }
  const visitorIds = visitors.filter((id) => attendeeIds.includes(id));
  const occasion: MarketOccasion = {
    id: city.occasions.nextId++, squareNode: city.squareNode, hallId, day: Math.floor(city.tick / MIN_PER_DAY),
    startedAt: city.tick, endsAt: city.tick + DURATION, vendorIds, visitorIds, attendeeIds,
    arrivedIds: [], servedIds: [], rejectedCount, status: 'assembling',
  };
  city.occasions.current = occasion;
  city.occasions.revision++;
  for (const id of attendeeIds) {
    const s = city.souls[id];
    s.overrideUntil = occasion.endsAt + 1;
    sendToNode(city, s, occasion.squareNode, 'gathering', 'gathering');
  }
  emit(city.events, 'marketOpened', hallId, attendeeIds.slice(), 200, city.tick);
  pushLog(city, `${attendeeIds.length} people are making for market in ${city.squareName}.`, 'info');
  return attendeeIds.length;
}

function present(city: City, occasion: MarketOccasion, id: SoulId): boolean {
  const s = city.souls[id];
  return Boolean(s && s.inId < 0 && s.activity === 'gathering' && s.atNode === occasion.squareNode && s.toNode < 0);
}

function owns(city: City, occasion: MarketOccasion, id: SoulId): boolean {
  const s = city.souls[id];
  return Boolean(s && s.inId < 0 && s.activity === 'gathering'
    && (s.destNode === occasion.squareNode || s.atNode === occasion.squareNode));
}

function close(city: City, occasion: MarketOccasion, status: OccasionStatus, text: string): void {
  occasion.status = status;
  for (const id of occasion.attendeeIds) {
    if (!owns(city, occasion, id)) continue;
    const s = city.souls[id];
    s.overrideUntil = city.tick;
    resumeCurrentBlock(city, s);
  }
  city.occasions.lastOutcome = {
    day: occasion.day, hallId: occasion.hallId,
    status: status === 'assembling' ? 'thin' : status,
    arrived: occasion.arrivedIds.length, invited: occasion.attendeeIds.length, endedAt: city.tick,
  };
  city.occasions.current = null;
  city.occasions.revision++;
  pushLog(city, text, status === 'thin' || status === 'rainedOut' ? 'loss' : 'gain');
}

function serveMarket(city: City, occasion: MarketOccasion): void {
  if (!occasion.vendorIds.some((id) => present(city, occasion, id))) return;
  let changed = false;
  for (const id of occasion.visitorIds) {
    if (!present(city, occasion, id) || occasion.servedIds.includes(id)) continue;
    const s = city.souls[id];
    s.hunger = Math.max(0, s.hunger - 55);
    s.grievance = Math.max(0, s.grievance - 12);
    occasion.servedIds.push(id);
    changed = true;
  }
  for (const id of occasion.vendorIds) {
    if (!present(city, occasion, id) || occasion.servedIds.includes(id)) continue;
    city.souls[id].purse += 4;
    occasion.servedIds.push(id);
    changed = true;
  }
  if (changed) city.occasions.revision++;
}

function missMarket(city: City, day: number, status: 'thin' | 'rainedOut', text: string): void {
  const hallId = hallOf(city);
  city.occasions.lastOutcome = { day, hallId, status, arrived: 0, invited: 0, endedAt: city.tick };
  city.occasions.revision++;
  pushLog(city, text, 'loss');
}

/** Start the seeded calendar entry, then follow arrivals and weather until close. */
export function tickOccasions(city: City): void {
  const day = Math.floor(city.tick / MIN_PER_DAY);
  const minute = minuteOfDay(city.tick);
  if (!city.occasions.current && minute === MARKET_MINUTE && city.occasions.lastDay !== day) {
    city.occasions.lastDay = day;
    city.occasions.revision++;
    if (isMarketDay(city, day)) {
      const weather = weatherAt(city.seed, city.tick);
      if (weather.kind !== 'fair' && weather.kind !== 'overcast') {
        missMarket(city, day, 'rainedOut', 'The weather has kept the market in.');
      } else if (isDeputationActive(city) || city.shelters.current) {
        missMarket(city, day, 'thin', 'The square was needed elsewhere. The market did not open.');
      } else if (startMarketDay(city) === 0) {
        missMarket(city, day, 'thin', 'Too few people could make a market of the square.');
      }
    }
  }
  const occasion = city.occasions.current;
  if (!occasion) return;
  if (isWetWeather(weatherAt(city.seed, city.tick))) {
    close(city, occasion, 'rainedOut', 'The rain has driven the market from the square.');
    return;
  }
  for (const id of occasion.attendeeIds) {
    if (present(city, occasion, id) && !occasion.arrivedIds.includes(id)) {
      occasion.arrivedIds.push(id);
      city.occasions.revision++;
    }
  }
  const vendorPresent = occasion.vendorIds.some((id) => present(city, occasion, id));
  if (occasion.status === 'assembling' && occasion.arrivedIds.length >= OPEN_THRESHOLD && vendorPresent) {
    occasion.status = 'open';
    city.occasions.revision++;
  }
  if (occasion.status === 'open') serveMarket(city, occasion);
  if (city.tick >= occasion.endsAt) {
    const thin = occasion.arrivedIds.length < OPEN_THRESHOLD || !vendorPresent;
    close(city, occasion, thin ? 'thin' : 'open', thin
      ? 'Too few people reached the square. The market never properly opened.'
      : `${occasion.arrivedIds.length} people made a market of ${city.squareName}.`);
  }
}

export function occasionSummary(city: City, buildingId: BuildingId): string {
  const occasion = city.occasions.current;
  if (occasion && buildingId === occasion.hallId && isOccasionActive(city)) {
    const state = occasion.status === 'open' ? 'OPEN' : 'ASSEMBLING';
    return `MARKET ${state} · ${occasion.arrivedIds.length}/${occasion.attendeeIds.length} ARRIVED`;
  }
  const last = city.occasions.lastOutcome;
  if (!last || buildingId !== last.hallId) return '';
  const state = last.status === 'rainedOut' ? 'RAINED OUT' : last.status === 'thin' ? 'TOO THIN' : 'CLOSED';
  return `LAST MARKET ${state} · ${last.arrived}/${last.invited} ARRIVED`;
}
