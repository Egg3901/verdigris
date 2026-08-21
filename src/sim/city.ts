// The city: the only module the app touches.
//
// One tick is one game-minute. The float simMin lives in main.ts and never enters
// here, so the world is fully determined by (seedStr, tickCount, nudges) and a
// replay is exact. hashWorld exists from day one because it is the anchor for
// every determinism test in the suite.
import { DAILY_MINUTE, MIN_PER_DAY, minuteOfDay } from './clock';
import type { Building } from './buildings';
import { DEFS } from './buildings';
import { cellKey } from './district';
import { isRunning } from './firms';
import { generateWorld, validateWorld } from './worldgen';
import type { World } from './worldgen';
import { newPressures, applyPressure, decayPressuresHourly, pressureOf } from './pressures';
import type { PressureState } from './pressures';
import { serviceAt, servedCount, connectedCount } from './networks';
import { PATTERNS, blockAt, blockStart, buildDueWheel } from './schedule';
import type { PlaceRef } from './schedule';
import { advanceSoul, isTravelling } from './souls';
import type { Soul } from './souls';
import { mix } from './rng';
import { CAPS } from './types';
import type { Activity, BuildingId, BuildingKind, ClaimKind, PressureKey, SoulId, Trade } from './types';
import { newClaims, gossipSlice, convictionOf, decayBeliefsDaily, seedClaim, implant } from './claims';
import type { ClaimState } from './claims';
import { buildRelations, neighboursOf } from './relations';
import type { Relations } from './relations';
import { newEvents, emit, witnessesOf } from './events';
import { newTramCars } from './gen/tram';
import type { TramCar } from './gen/tram';
import { edgeCostBetween } from './graph';
import { TRAM_MILLICELL_PER_MIN } from './types';
import type { EventState } from './events';
import { checkIncidents, newIncidents } from './incidents';
import type { IncidentState } from './incidents';
import type { Nudge } from './interventions';
import { DAILY_BUDGET } from './interventions';

export interface LogEvent {
  tick: number;
  text: string;
  kind: 'loss' | 'gain' | 'info';
}

/**
 * Trades whose work happens ON THE STREET.
 *
 * The errand system deliberately never pulls anyone off a shift, which is right,
 * but it meant the district emptied during working hours: 12 souls outdoors at
 * ten in the morning. The mistake was treating "working" as "indoors" for
 * everyone. A constable on the beat, a lamplighter on his round, a conductor on
 * the tram and a docker on the quay are all at work and all outside, and putting
 * them where they belong fixes the emptiness with more truth rather than less.
 */
const OUTDOOR_TRADES = new Set<Trade>([
  'constable', 'lamplighter', 'conductor', 'docker', 'lighterman',
]);

/**
 * Trades that get sent OUT during a shift, on a delivery.
 *
 * Excluding everyone at work from the errand pass is correct for a mill hand and
 * wrong for the district: measured at the reference tick of 10:41, ten souls out
 * of two hundred were on the street. But an errand boy, a shop assistant with a
 * parcel, a laundress with a basket and a printer with a proof are all at work
 * AND all outside, several times a day. This is the population the streets were
 * missing, and it is period-accurate rather than a fudge.
 */
const DELIVERY_TRADES = new Set<Trade>([
  'child', 'shopkeeper', 'printer', 'laundress', 'seamstress', 'clerk', 'docker',
]);

/** Buildings a soul might head to by kind rather than by name. Resolved once per
 *  soul at startup: everyone has a local, and it is always the same local. */
const FAVOURITE_KINDS: readonly BuildingKind[] = ['pub', 'shop', 'chapel', 'school', 'constabulary', 'dispensary'];

export interface City extends World {
  tick: number;
  press: PressureState;
  log: LogEvent[];
  /** minuteOfDay to the souls whose block boundary lands there. Most minutes are empty. */
  dueWheel: SoulId[][];
  /** favourite[kind][soulId] = building id. */
  favourite: Record<string, Int16Array>;
  buildingsByKind: Map<BuildingKind, BuildingId[]>;
  lampsLit: number;

  claims: ClaimState;
  relations: Relations;
  events: EventState;
  incidents: IncidentState;

  /** The save format. Everything else is replayable from (seedStr, tick, nudges). */
  nudges: Nudge[];
  budgetLeft: number;
  /** How many high-heat nudges have been traced back toward the player. */
  traced: number;

  tramDelayedUntil: number;
  buntingUntil: number;
  quarantined: Set<number>;
  /** Falls permanently when a planted story is retracted. */
  paperCredibility: number;
  /** Cars on the line. Two, running opposite directions. */
  trams: TramCar[];
}

export function newCity(seedStr: string): City {
  const world = generateWorld(seedStr);
  const city: City = {
    ...world,
    tick: 0,
    press: newPressures(),
    log: [],
    dueWheel: [],
    favourite: {},
    buildingsByKind: new Map(),
    lampsLit: 0,
    claims: newClaims(),
    relations: buildRelations(world.seed, world.souls, world.households, world.firms),
    events: newEvents(),
    incidents: newIncidents(),
    nudges: [],
    budgetLeft: DAILY_BUDGET,
    traced: 0,
    tramDelayedUntil: -1,
    buntingUntil: -1,
    quarantined: new Set<number>(),
    paperCredibility: 800,
    trams: [],
  };

  for (const b of city.buildings) {
    if (!city.buildingsByKind.has(b.kind)) city.buildingsByKind.set(b.kind, []);
    (city.buildingsByKind.get(b.kind) as BuildingId[]).push(b.id);
  }

  // Everyone's local, chosen once by distance from home. Cheap, deterministic,
  // and it means a soul's day is legible: the same pub every evening.
  for (const kind of FAVOURITE_KINDS) {
    const arr = new Int16Array(city.souls.length).fill(-1);
    const candidates = city.buildingsByKind.get(kind) ?? [];
    for (const s of city.souls) {
      const home = city.buildings[s.homeId];
      let best = -1;
      let bestDist = Infinity;
      for (const bid of candidates) {
        const b = city.buildings[bid];
        const dist = Math.abs(b.ox - home.ox) + Math.abs(b.oy - home.oy);
        if (dist < bestDist) { bestDist = dist; best = bid; }
      }
      arr[s.id] = best;
    }
    city.favourite[kind] = arr;
  }

  city.dueWheel = buildDueWheel(
    city.souls.length,
    (i) => city.souls[i].scheduleId,
    (i, b) => mix(city.seed, 20, i, b) % 4096,
  );

  // Place everyone where their pattern says they should be at midnight, rather
  // than teleporting them at the first block boundary of the run.
  for (const s of city.souls) {
    const p = PATTERNS[s.scheduleId];
    s.blockIdx = blockAt(p, 0);
    const blk = p.blocks[s.blockIdx];
    const target = resolvePlace(city, s, blk.place);
    s.inId = target >= 0 ? target : s.homeId;
    s.activity = blk.activity;
    s.arriveActivity = blk.activity;
    s.atNode = city.buildings[s.inId]?.doorNode ?? -1;
    s.toNode = -1;
    s.destNode = -1;
    s.destBuilding = -1;
    s.progressMilli = 0;
  }
  city.trams = newTramCars(city.tram, 2);
  rebuildOccupants(city);
  seedPrehistoryClaims(city);
  return city;
}

/**
 * Three or four true things nobody has acted on yet, held by a handful of people
 * before tick 0.
 *
 * The district has to have a past for the present to read as a present. A player
 * who follows somebody on day one and finds they already know something is the
 * whole effect, and it costs four claims.
 */
function seedPrehistoryClaims(city: City): void {
  const kinds: ClaimKind[] = ['affair', 'graft', 'debt', 'theft'];
  for (let i = 0; i < kinds.length; i++) {
    const subject = city.souls[(mix(city.seed, 88, i) >>> 0) % Math.max(1, city.souls.length)];
    if (!subject) continue;
    const id = seedClaim(city.claims, kinds[i], subject.id, -1, subject.homeId, 1, -1440 * 30 * (i + 1));
    for (const other of neighboursOf(city.relations, subject.id).slice(0, 3)) {
      implant(city.claims, city.souls[other], id, 420 + i * 40, subject.id, -1440);
    }
  }
}

export function newValidatedCity(seedStr: string): { city: City; errors: string[] } {
  const city = newCity(seedStr);
  return { city, errors: validateWorld(city) };
}

function resolvePlace(city: City, s: Soul, place: PlaceRef): BuildingId {
  switch (place.at) {
    case 'home': return s.homeId;
    case 'work': return s.workId >= 0 ? s.workId : s.homeId;
    case 'building': return place.id;
    case 'node': return -1;
    case 'kind': {
      const fav = city.favourite[place.kind];
      if (fav && fav[s.id] >= 0) return fav[s.id];
      const list = city.buildingsByKind.get(place.kind);
      return list && list.length ? list[s.id % list.length] : s.homeId;
    }
    default: return s.homeId;
  }
}

/** Start the block a soul is due for. Either it is already there, or it walks. */
function beginBlock(city: City, s: Soul, blockIdx: number): void {
  const p = PATTERNS[s.scheduleId];
  s.blockIdx = blockIdx;
  const blk = p.blocks[blockIdx];
  const target = resolvePlace(city, s, blk.place);
  s.arriveActivity = blk.activity;

  if (target < 0 || target === s.inId) {
    s.activity = blk.activity;
    s.activitySince = city.tick;
    s.inId = target < 0 ? s.inId : target;
    s.destNode = -1;
    s.toNode = -1;
    s.destBuilding = -1;
    return;
  }

  const dest = city.buildings[target];
  if (!dest || dest.doorNode < 0) {
    s.activity = blk.activity;
    s.inId = target;
    s.activitySince = city.tick;
    return;
  }

  // Step out of the door and walk. If the soul is already outdoors, keep the
  // node it is standing on.
  if (s.atNode < 0) s.atNode = city.buildings[s.inId]?.doorNode ?? dest.doorNode;
  s.inId = -1;
  s.destBuilding = target;
  s.destNode = dest.doorNode;
  s.activity = blk.activity === 'asleep' || blk.activity === 'waking' ? 'commuting' : travelVerbFor(blk.activity);
  s.activitySince = city.tick;
  s.toNode = -1;
  s.progressMilli = 0;
  s.route.length = 0;
  s.routeIdx = 0;
}

/** Send a soul walking to a building, with the verb to use on the way and the one
 *  to adopt on arrival. Shared by the schedule and by errands. */
function sendTo(city: City, s: Soul, target: BuildingId, travelAs: Activity, arriveAs: Activity): void {
  const dest = city.buildings[target];
  if (!dest || dest.doorNode < 0 || target === s.inId) return;
  if (s.atNode < 0) s.atNode = city.buildings[s.inId]?.doorNode ?? dest.doorNode;
  s.inId = -1;
  s.destBuilding = target;
  s.destNode = dest.doorNode;
  s.arriveActivity = arriveAs;
  s.activity = travelAs;
  s.activitySince = city.tick;
  s.toNode = -1;
  s.progressMilli = 0;
  s.route.length = 0;
  s.routeIdx = 0;
}

/**
 * A handful of souls step out every five minutes, for about half an hour.
 *
 * Deterministic: who goes is a hash of (seed, tick bucket, soul), never a stored
 * cursor and never Math.random. Nobody is pulled out of bed or off a shift, so
 * the schedule stays the thing that governs a day and this only fills the gaps.
 */
function startErrands(city: City, tick: number): void {
  const mod = minuteOfDay(tick);
  if (mod < 390 || mod > 1290) return;
  const bucket = Math.floor(tick / 5);
  // Measured before this: a peak of 65 souls outdoors out of 200, and 16 at the
  // reference tick of 10:41. Over an island of this size that is one person per
  // seventeen thousand square pixels, and the biggest single reason the place
  // looked like a model rather than a town.
  // Concurrency is roughly wanted x (duration / 5), minus whoever is ineligible.
  // Tuned by measurement against the whole day, not guessed: at 14 the median was
  // 35 and the reference tick of 10:41 showed 16.
  const wanted = mod > 1080 || mod < 480 ? 7 : 13;
  let sent = 0;
  const n = city.souls.length;
  if (!n) return;
  const start = mix(city.seed, 25, bucket, 0) % n;
  for (let i = 0; i < n && sent < wanted; i++) {
    const s = city.souls[(start + i * 37) % n];
    if (s.inId < 0 || s.returnAt >= 0 || s.overrideUntil > tick) continue;
    if (s.activity === 'asleep' || s.activity === 'held') continue;
    if (s.age < 8) continue;
    if (s.activity === 'working') {
      // A shift is not interrupted lightly: only delivery trades, and only about
      // a third as often as somebody who is free.
      if (!DELIVERY_TRADES.has(s.trade)) continue;
      if ((mix(city.seed, 27, bucket, s.id) >>> 0) % 3 !== 0) continue;
    }
    const kind = mix(city.seed, 25, bucket, s.id) % 3 === 0 ? 'pub' : 'shop';
    const fav = city.favourite[kind];
    const target = fav ? fav[s.id] : -1;
    if (target < 0 || target === s.inId) continue;
    const onShift = s.activity === 'working';
    s.returnTo = s.inId;
    // A delivery is a there-and-back, not an afternoon off.
    s.returnAt = tick + (onShift ? 14 : 30) + (mix(city.seed, 25, s.id, bucket) % (onShift ? 16 : 34));
    // overrideUntil covers the errand ITSELF and nothing more.
    //
    // It used to run 100 minutes past the return, as a cooldown. But this flag
    // also suppresses schedule blocks, so it was doing two jobs, and the second
    // one was the real cap on street population: with a two-hour lockout only
    // about seven souls per five-minute bucket could ever be eligible, however
    // high the quota was set. Raising the quota from 14 to 24 moved the median
    // from 35 to 38, which is what told me the quota was never the limit.
    s.overrideUntil = s.returnAt + 5;
    sendTo(city, s, target, 'errand', onShift ? 'errand' : kind === 'pub' ? 'drinking' : 'shopping');
    sent++;
  }
}

/** The next stop on a beat: somewhere near the workplace, never the same twice
 *  running, so the walk covers ground instead of pacing one street. */
function beatTarget(city: City, s: Soul, tick: number): BuildingId {
  const home = city.buildings[s.workId];
  if (!home) return -1;
  const n = city.buildings.length;
  const start = mix(city.seed, 26, s.id, Math.floor(tick / 30)) % n;
  for (let i = 0; i < 48; i++) {
    const b = city.buildings[(start + i * 13) % n];
    if (!b || b.doorNode < 0) continue;
    const dist = Math.abs(b.ox - home.ox) + Math.abs(b.oy - home.oy);
    if (dist < 3 || dist > 16) continue;
    return b.id;
  }
  return -1;
}

function travelVerbFor(a: Activity): Activity {
  switch (a) {
    case 'working': return 'commuting';
    case 'shopping':
    case 'errand': return 'errand';
    case 'gathering': return 'gathering';
    default: return 'commuting';
  }
}

function rebuildOccupants(city: City): void {
  for (const b of city.buildings) b.occupants.length = 0;
  for (const s of city.souls) {
    if (s.inId >= 0) city.buildings[s.inId].occupants.push(s.id);
  }
}

/** Exactly one game-minute. */
export function tickCity(city: City): void {
  city.tick++;
  const tick = city.tick;
  const mod = minuteOfDay(tick);

  // 1. Schedule boundaries. Usually nobody; at a shift change, up to eighty.
  const due = city.dueWheel[mod];
  if (due && due.length) {
    for (const id of due) {
      const s = city.souls[id];
      if (s.overrideUntil > tick) continue;
      const p = PATTERNS[s.scheduleId];
      const jitter = mix(city.seed, 20, id, 0) % 4096;
      let idx = -1;
      for (let b = 0; b < p.blocks.length; b++) {
        if (blockStart(p, b, mix(city.seed, 20, id, b) % 4096) === mod) { idx = b; break; }
      }
      void jitter;
      if (idx >= 0) beginBlock(city, s, idx);
    }
  }

  // 2. Errands. The return leg of an errand, and the errands themselves, are what
  //    keep the district alive between shift changes.
  //
  //    Without this the streets are empty at ten in the morning: every soul in a
  //    pattern transitions within a few minutes of every other soul in that
  //    pattern, so the whole day is two rushes and eleven hours of nothing. A city
  //    you watch from above has to have somebody in it whenever you look.
  if (mod % 5 === 0) startErrands(city, tick);
  for (const s of city.souls) {
    if (s.returnAt !== tick) continue;
    s.returnAt = -1;
    const home = s.returnTo;
    s.returnTo = -1;
    // Long enough to walk home without the schedule yanking them mid-street.
    s.overrideUntil = tick + 30;
    sendTo(city, s, home, 'errand', 'visiting');
  }

  // 3. Movement. Only the souls actually outdoors, typically 15 to 40 percent by
  //    day and near zero at night.
  for (const s of city.souls) {
    if (!isTravelling(s) && s.destNode < 0) continue;
    if (s.inId >= 0) continue;
    const arrived = advanceSoul(city.graph, s);
    if (!arrived) continue;
    const target = s.destBuilding;
    s.destBuilding = -1;
    s.destNode = -1;
    if (target >= 0) {
      // A beat trade at work does not go inside: it arrives, and moves on. The
      // effect is a soul permanently in transit around its workplace, which is
      // what a beat IS.
      if (s.arriveActivity === 'working' && OUTDOOR_TRADES.has(s.trade) && s.workId >= 0) {
        const next = beatTarget(city, s, tick);
        if (next >= 0 && next !== target) {
          sendTo(city, s, next, 'working', 'working');
          continue;
        }
      }
      s.inId = target;
      s.activity = s.arriveActivity;
      s.activitySince = tick;
    } else {
      s.activity = 'loitering';
    }
  }

  // 4. Needs, sliced ten ways by id so the cost is flat and the phase is stable
  //    across a save.
  const slice = tick % 10;
  for (const s of city.souls) {
    if (s.id % 10 !== slice) continue;
    tickNeeds(city, s);
  }

  // 5. Gossip, sliced sixty ways so the cost is flat and the spread feels
  //    continuous rather than arriving in an hourly lump.
  gossipSlice(city.claims, city.souls, city.seed, tick, (s) => neighboursOf(city.relations, s.id));

  rebuildOccupants(city);

  tickTrams(city);

  if (mod % 60 === 0) tickHour(city);
  if (mod === DAILY_MINUTE) tickDay(city);
}

/**
 * Move the cars.
 *
 * The line is a polyline of graph nodes, so a car is (idx, progress, dir) exactly
 * as a soul is (atNode, toNode, progress). Delaying the tram halves its speed and
 * doubles its dwell, which is what "the tram is not running properly" looks like
 * rather than the tram vanishing.
 */
function tickTrams(city: City): void {
  const route = city.tram.route;
  if (route.length < 2) return;
  const delayed = city.tramDelayedUntil > city.tick;
  const speed = delayed ? TRAM_MILLICELL_PER_MIN / 2 : TRAM_MILLICELL_PER_MIN;

  for (const car of city.trams) {
    if (car.dwell > 0) { car.dwell--; continue; }
    const next = car.idx + car.dir;
    if (next < 0 || next >= route.length) {
      // Terminus: turn round rather than run off the end of the rails.
      car.dir = car.dir === 1 ? -1 : 1;
      car.dwell = delayed ? 8 : 3;
      continue;
    }
    const cost = Math.max(1, edgeCostBetween(city.graph, route[car.idx], route[next]));
    car.progressMilli += speed;
    if (car.progressMilli >= cost * 1000) {
      car.progressMilli = 0;
      car.idx = next;
      if (city.tram.stops.includes(car.idx)) car.dwell = delayed ? 5 : 2;
    }
  }
}

function tickNeeds(city: City, s: Soul): void {
  const asleep = s.activity === 'asleep';
  s.fatigue = clamp(s.fatigue + (asleep ? -34 : 9));
  s.hunger = clamp(s.hunger + (s.activity === 'eating' ? -160 : 7));
  s.drink = clamp(s.drink + (s.activity === 'drinking' ? 70 : -6));

  const home = city.buildings[s.homeId];
  const warm = home && (!DEFS[home.kind].needsGas || serviceAt(city.networks.gas, home.id));
  s.warmth = clamp(s.warmth + (s.inId === s.homeId ? (warm ? 12 : -14) : -2));

  // Health follows sanitation and warmth, which is how a broken drain becomes a
  // person in the dispensary rather than a number going down.
  const san = pressureOf(city.press, 'sanitation');
  const drag = (san < 350 ? -6 : san > 650 ? 3 : 0) + (s.warmth < 250 ? -5 : 0) + (s.hunger > 850 ? -7 : 0);
  s.health = clamp(s.health + drag + 2);

  if (s.hunger > 880 || s.warmth < 180) s.grievance = clamp(s.grievance + 4);
  else if (s.mood > 700) s.grievance = clamp(s.grievance - 2);
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 1000 ? 1000 : Math.round(v);
}

function tickHour(city: City): void {
  const tick = city.tick;

  // Gas service is measured, never assumed: the pressure is a REPORT of how many
  // buildings the tree still reaches, so cutting a main moves it as a consequence.
  const connected = connectedCount(city.networks.gas);
  const served = servedCount(city.networks.gas);
  city.lampsLit = served;
  if (connected > 0) {
    const want = Math.round((served / connected) * 1000);
    const have = pressureOf(city.press, 'gas');
    const delta = Math.trunc((want - have) / 3);
    if (delta !== 0) applyPressure(city.press, 'gas', delta, 'network', served, 'gas mains', tick);
  }

  // Fabric decays, facade does not. rot decides whether the repair that was
  // ordered actually happened, which is the entire thesis expressed as one branch.
  const rot = pressureOf(city.press, 'rot');
  const coin = pressureOf(city.press, 'coin');
  // Fabric decays four times a day, not twenty-four. Hourly decay condemned every
  // building in the district by day twenty, which is not a slow rot, it is a fire.
  // Measured target: from about 650 at the start to about 400 after a month, with
  // the worst buildings in real trouble and most merely shabby.
  const decayHour = tick % 360 === 0;
  for (const b of city.buildings) {
    const wet = !serviceAt(city.networks.drain, b.id) ? 1 : 0;
    if (decayHour) b.fabric = clamp(b.fabric - 1 - wet - Math.trunc(rot / 300));
    // A repair only happens if there is money AND the rot has not already
    // eaten the order. This single branch is where 'the repair was ordered' turns
    // into 'the repair never happened'.
    // Repairs run on the SAME cadence as decay, or the arithmetic is off by the
    // ratio between them: hourly repairs against six-hourly decay made fabric
    // climb to the ceiling across the whole district by day thirty.
    //
    // Funded and honest, a building nets roughly minus four a day and the
    // district holds. Once rot passes its threshold the repair branch stops
    // firing entirely, and that is the moment "ordered" stops meaning "done".
    const repaired = decayHour && coin > 400 && rot < 520
      && ((b.id + Math.trunc(tick / 360)) % 5 === 0);
    if (repaired) b.fabric = clamp(b.fabric + 6);
    if (b.facade > 0 && (b.id + Math.trunc(tick / 60)) % 96 === 0) b.facade = clamp(b.facade - 1);
  }

  for (const f of city.firms) {
    if (!isRunning(f, tick)) { f.output = 0; continue; }
    const b = city.buildings[f.buildingId];
    const hasGas = !DEFS[b.kind].needsGas || serviceAt(city.networks.gas, b.id);
    const tram = pressureOf(city.press, 'tram');
    const staffing = Math.min(1000, Math.round((tram + 200) * 0.8));
    f.output = Math.round((f.orders / 1000) * (hasGas ? 1 : 0.45) * (staffing / 1000) * 100);
    f.orders = clamp(f.orders + (f.output > 55 ? 3 : -4));
  }

  recomputeBaselines(city);

  // What the district believes feeds back into what it feels. Suspicion is the
  // aggregate conviction in the accusatory kinds; mood pays for the rest.
  const suspicious = Math.round(
    (convictionOf(city.claims, city.souls, 'informer')
      + convictionOf(city.claims, city.souls, 'sabotage')
      + convictionOf(city.claims, city.souls, 'graft')) / 3,
  );
  const have = pressureOf(city.press, 'suspicion');
  if (suspicious > have) {
    applyPressure(city.press, 'suspicion', Math.trunc((suspicious - have) / 4), 'claim', 0, 'what people are saying', tick);
  }
  const grim = convictionOf(city.claims, city.souls, 'sickness') + convictionOf(city.claims, city.souls, 'collapse');
  if (grim > 200) applyPressure(city.press, 'mood', -Math.trunc(grim / 60), 'claim', 0, 'what people are saying', tick);

  // The tram runs badly while it is delayed, and the bunting keeps the mood up
  // while it is up. Both are state, both expire, neither is a hidden timer.
  if (city.tramDelayedUntil > tick) {
    applyPressure(city.press, 'tram', -20, 'intervention', 0, 'the tram is still not right', tick);
  }
  if (city.buntingUntil > tick) {
    applyPressure(city.press, 'mood', 8, 'intervention', 0, 'the flags are still up', tick);
  }

  checkIncidents(city, tick);
  decayPressuresHourly(city.press, tick);
}

/**
 * The baselines are FUNCTIONS OF THE WORLD, not constants.
 *
 * This is the difference between a district and a diorama. With fixed baselines
 * the hourly decay pulls every pressure back to where it started, nothing ever
 * crosses an incident threshold, and three game-days pass with an empty log:
 * measured, not guessed. Making the baseline the place the district WOULD settle
 * given its current fabric, service and money means decay drags the city toward
 * its actual condition, and the condition is what the player is changing.
 *
 * rot is the one that matters. It rises whenever the repair money is short, and
 * it makes fabric decay faster, which makes sanitation worse, which lowers mood,
 * which the facade spending then papers over. That loop is the whole thesis, and
 * it does not exist unless the baselines move.
 */
function recomputeBaselines(city: City): void {
  const p = city.press.pressures;
  const b = city.buildings;
  if (!b.length) return;

  let fabric = 0;
  let facade = 0;
  for (const x of b) { fabric += x.fabric; facade += x.facade; }
  fabric = Math.round(fabric / b.length);
  facade = Math.round(facade / b.length);

  const drainConnected = connectedCount(city.networks.drain);
  const drainServed = servedCount(city.networks.drain);
  const drainFrac = drainConnected ? drainServed / drainConnected : 1;

  let running = 0;
  let output = 0;
  for (const f of city.firms) {
    if (!isRunning(f, city.tick)) continue;
    running++;
    output += f.output;
  }
  const avgOutput = running ? output / running : 0;

  // Sanitation follows the drains and the fabric they run through.
  p.sanitation.baseline = clamp(Math.round(120 + drainFrac * 420 + fabric * 0.35));

  // Wages follow what the firms are actually producing, and a struck or shut
  // firm pays nobody.
  const workingFrac = city.firms.length ? running / city.firms.length : 1;
  p.wages.baseline = clamp(Math.round(180 + avgOutput * 3.4 + workingFrac * 240));

  // The treasury is rates on a working district, minus what rot skims.
  p.coin.baseline = clamp(Math.round(240 + workingFrac * 420 - p.rot.value * 0.35));

  // ROT: unfunded repairs. When there is no money the repairs are ordered and not
  // done, and the gap between what the buildings look like and what they are is
  // exactly the measure of it.
  const show = Math.max(0, facade - fabric);
  p.rot.baseline = clamp(Math.round(180 + show * 0.9 + Math.max(0, 500 - p.coin.value) * 0.42));

  // Mood is what living here is like: lit streets, paid wages, working drains,
  // and whether the flags are up.
  p.mood.baseline = clamp(Math.round(
    120
    + p.gas.value * 0.18
    + p.wages.value * 0.30
    + p.sanitation.value * 0.22
    + (city.buntingUntil > city.tick ? 90 : 0)
    - p.suspicion.value * 0.16,
  ));

  // The tram is only as good as its depot, and it stays bad while it is delayed.
  const depot = city.buildingsByKind.get('tramdepot')?.[0];
  const depotFabric = depot !== undefined ? city.buildings[depot].fabric : 600;
  p.tram.baseline = clamp(Math.round(
    (city.tramDelayedUntil > city.tick ? 120 : 380) + depotFabric * 0.45,
  ));

  // Suspicion settles where the constabulary and the rot leave it.
  const constables = city.souls.filter((s) => s.trade === 'constable').length;
  p.suspicion.baseline = clamp(Math.round(60 + p.rot.value * 0.30 + constables * 6));

  // Gas is reported directly from the network above, so its baseline just follows
  // the value rather than fighting it.
  p.gas.baseline = p.gas.value;
}

function tickDay(city: City): void {
  const tick = city.tick;
  city.budgetLeft = DAILY_BUDGET;
  decayBeliefsDaily(city.claims, city.souls);
  // Quarantines are lifted after a day: a cordon nobody maintains is not a cordon.
  city.quarantined.clear();

  // Wages, then rent. In that order, because the point of a strike is that the
  // rent still falls due.
  const wagePress = pressureOf(city.press, 'wages');
  for (const f of city.firms) {
    if (!isRunning(f, tick)) continue;
    const perHead = Math.max(1, Math.round((f.wageBase + f.wageOffset) * (0.5 + wagePress / 1000)));
    for (const id of f.workerIds) city.souls[id].purse += perHead;
  }

  for (const h of city.households) {
    let purse = h.purse;
    for (const id of h.memberIds) {
      purse += city.souls[id].purse;
      city.souls[id].purse = 0;
    }
    purse -= h.rentPerDay;
    if (purse < 0) {
      h.arrearsDays++;
      h.purse = 0;
      for (const id of h.memberIds) city.souls[id].grievance = clamp(city.souls[id].grievance + 30);
      if (h.arrearsDays === 3) {
        pushLog(city, `The ${h.name} household is three days behind on the rent.`, 'loss');
      }
    } else {
      h.arrearsDays = 0;
      h.purse = purse;
    }
  }

  const arrears = city.households.filter((h) => h.arrearsDays > 0).length;
  if (arrears > 0) {
    applyPressure(city.press, 'mood', -Math.min(40, arrears), 'firm', arrears, 'rent arrears', tick);
  }
}

export function pushLog(city: City, text: string, kind: LogEvent['kind']): void {
  city.log.push({ tick: city.tick, text, kind });
  if (city.log.length > 200) city.log.splice(0, city.log.length - 200);
}

/** Run n minutes without a frame budget. QA moves time only through this. */
export function warp(city: City, minutes: number): void {
  for (let i = 0; i < minutes; i++) tickCity(city);
}

/**
 * FNV-1a over the canonical integer state. The anchor for every determinism test
 * and for the screenshot goldens. Deliberately covers positions, activities,
 * needs, fabric and facade: anything a player could see change.
 */
/** Where a car is, in cells. The renderer interpolates from here. */
export function tramPos(city: City, car: TramCar): { cx: number; cy: number; dx: number; dy: number } {
  const route = city.tram.route;
  const a = route[car.idx];
  const next = car.idx + car.dir;
  const b = next >= 0 && next < route.length ? route[next] : a;
  const cost = Math.max(1, edgeCostBetween(city.graph, a, b));
  const t = Math.min(1, car.progressMilli / (cost * 1000));
  const ax = city.graph.cx[a];
  const ay = city.graph.cy[a];
  const bx = city.graph.cx[b];
  const by = city.graph.cy[b];
  return { cx: ax + (bx - ax) * t, cy: ay + (by - ay) * t, dx: bx - ax, dy: by - ay };
}

export function hashWorld(city: City): number {
  let h = 2166136261 >>> 0;
  const put = (v: number) => {
    h ^= (v | 0) >>> 0;
    h = Math.imul(h, 16777619);
  };
  put(city.tick);
  for (const k of Object.keys(city.press.pressures).sort()) {
    put(city.press.pressures[k as PressureKey].value);
  }
  for (const s of city.souls) {
    put(s.id);
    put(s.atNode);
    put(s.toNode);
    put(s.progressMilli);
    put(s.inId);
    put(s.activity.length * 31 + s.activity.charCodeAt(0));
    put(s.hunger);
    put(s.fatigue);
    put(s.health);
    put(s.grievance);
    put(s.purse);
  }
  for (const car of city.trams) {
    put(car.idx);
    put(car.progressMilli);
    put(car.dir);
    put(car.dwell);
  }
  for (const b of city.buildings) {
    put(b.fabric);
    put(b.facade);
    put(b.occupants.length);
  }
  return h >>> 0;
}

/** Souls currently inside a building, with what they are doing. The INSIDE list
 *  reads this and nothing else, which is why it can never lie. */
export function occupantsOf(city: City, b: Building): Soul[] {
  return b.occupants.map((id) => city.souls[id]);
}

export function cellOfBuilding(city: City, b: Building): number {
  return cellKey(city.district, b.ox, b.oy);
}

export function soulsOutdoors(city: City): number {
  let n = 0;
  for (const s of city.souls) if (s.inId < 0) n++;
  return n;
}

export { CAPS, MIN_PER_DAY };
export { emit, witnessesOf };
