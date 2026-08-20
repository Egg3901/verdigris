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
import type { Activity, BuildingId, BuildingKind, PressureKey, SoulId } from './types';

export interface LogEvent {
  tick: number;
  text: string;
  kind: 'loss' | 'gain' | 'info';
}

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
  rebuildOccupants(city);
  return city;
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
  const wanted = mod > 1080 || mod < 480 ? 4 : 7;
  let sent = 0;
  const n = city.souls.length;
  if (!n) return;
  const start = mix(city.seed, 25, bucket, 0) % n;
  for (let i = 0; i < n && sent < wanted; i++) {
    const s = city.souls[(start + i * 37) % n];
    if (s.inId < 0 || s.returnAt >= 0 || s.overrideUntil > tick) continue;
    if (s.activity === 'asleep' || s.activity === 'working' || s.activity === 'held') continue;
    if (s.age < 8) continue;
    const kind = mix(city.seed, 25, bucket, s.id) % 3 === 0 ? 'pub' : 'shop';
    const fav = city.favourite[kind];
    const target = fav ? fav[s.id] : -1;
    if (target < 0 || target === s.inId) continue;
    s.returnTo = s.inId;
    s.returnAt = tick + 24 + (mix(city.seed, 25, s.id, bucket) % 26);
    s.overrideUntil = s.returnAt + 100;
    sendTo(city, s, target, 'errand', kind === 'pub' ? 'drinking' : 'shopping');
    sent++;
  }
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
    s.overrideUntil = tick + 90;
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

  rebuildOccupants(city);

  if (mod % 60 === 0) tickHour(city);
  if (mod === DAILY_MINUTE) tickDay(city);
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
  for (const b of city.buildings) {
    const wet = !serviceAt(city.networks.drain, b.id) ? 2 : 0;
    b.fabric = clamp(b.fabric - 1 - wet - Math.trunc(rot / 400));
    const repaired = coin > 400 && rot < 500 && ((b.id + Math.trunc(tick / 60)) % 24 === 0);
    if (repaired) b.fabric = clamp(b.fabric + 18);
    if (b.facade > 0 && (b.id + Math.trunc(tick / 60)) % 31 === 0) b.facade = clamp(b.facade - 1);
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

  decayPressuresHourly(city.press, tick);
}

function tickDay(city: City): void {
  const tick = city.tick;

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
