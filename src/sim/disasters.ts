// Physical disasters: small, stateful failures that the district can actually
// suffer and repair. They are deliberately separate from the ticker incidents:
// an incident says what the district noticed, while a disaster owns the damaged
// building, the broken main, and the cleanup clock.
import type { City } from './city';
import { pushLog, resumeCurrentBlock, sendTo, sendToNode } from './city';
import { DEFS } from './buildings';
import type { Building } from './buildings';
import { seedClaim, implant } from './claims';
import { emit, witnessesOf } from './events';
import { breakSegment, serviceAt } from './networks';
import { applyPressure, pressureOf } from './pressures';
import { mix, Stream } from './rng';
import type { BuildingId, SoulId } from './types';
import { weatherAt } from './weather';
import { cellKey } from './district';
import { openCivicDisaster } from './civic-memory';
import { IDX } from './ordinances';

export type DisasterKind = 'fire' | 'flood' | 'collapse' | 'boilerBurst' | 'outbreak' | 'riot' | 'tramWreck';
export type DisasterStatus = 'active' | 'contained';

export interface Disaster {
  id: number;
  kind: DisasterKind;
  buildingId: BuildingId;
  /** Outdoor focus for crowds and wreckage. */
  nodeId: number;
  /** A fixed small list for the renderer and inspector, never a district scan. */
  affectedBuildingIds: number[];
  evacuatedIds: SoulId[];
  /** Named people injured, infected, assembled, or otherwise caught in it. */
  involvedIds: SoulId[];
  startedAt: number;
  containedAt: number;
  clearsAt: number;
  severity: number;
  status: DisasterStatus;
  /** The gas or drain tree node broken by this event, or -1. */
  brokenSegment: number;
}

export interface DisasterState {
  events: Disaster[];
  /** Changes only at visible lifecycle boundaries. */
  revision: number;
  next: number;
  /** One entry per KIND_ORDER member. */
  lastStartedAt: number[];
}

export const DISASTER_KINDS: readonly DisasterKind[] = [
  'collapse', 'fire', 'flood', 'boilerBurst', 'outbreak', 'riot', 'tramWreck',
];
const KIND_ORDER = DISASTER_KINDS;
const KIND_INDEX: Record<DisasterKind, number> = {
  collapse: 0, fire: 1, flood: 2, boilerBurst: 3, outbreak: 4, riot: 5, tramWreck: 6,
};
const ACTIVE_MINUTES: Record<DisasterKind, number> = {
  fire: 360, flood: 480, collapse: 720, boilerBurst: 300, outbreak: 2880, riot: 720, tramWreck: 720,
};
const CLEAR_MINUTES: Record<DisasterKind, number> = {
  fire: 1440, flood: 1440, collapse: 1440, boilerBurst: 1440,
  outbreak: 4320, riot: 1440, tramWreck: 1800,
};
const COOLDOWN_MINUTES: Record<DisasterKind, number> = {
  fire: 1440, flood: 1440, collapse: 2880, boilerBurst: 2880,
  outbreak: 4320, riot: 2880, tramWreck: 4320,
};
const MAX_LIVE_DISASTERS = 4;

export function newDisasters(): DisasterState {
  return { events: [], revision: 0, next: 0, lastStartedAt: KIND_ORDER.map(() => -1_000_000) };
}

function kindLabel(kind: DisasterKind): string {
  switch (kind) {
    case 'fire': return 'a building fire';
    case 'flood': return 'river water in the streets';
    case 'collapse': return 'a structural collapse';
    case 'boilerBurst': return 'a boiler burst';
    case 'outbreak': return 'an outbreak of fever';
    case 'riot': return 'a riot';
    case 'tramWreck': return 'a tram wreck';
  }
}

function candidateSeverity(city: City, kind: DisasterKind, buildingId: number): number {
  const b = city.buildings[buildingId];
  const rot = pressureOf(city.press, 'rot');
  if (kind === 'fire') return Math.min(1000, rot + Math.max(0, 600 - b.fabric));
  if (kind === 'flood') return Math.min(1000, weatherAt(city.seed, city.tick).precipitation * 120
    + Math.max(0, 520 - pressureOf(city.press, 'sanitation')) + Math.max(0, 680 - b.fabric));
  if (kind === 'collapse') return Math.min(1000, rot + Math.max(0, 360 - b.fabric));
  if (kind === 'boilerBurst') return Math.round(Math.min(1000, 420 + rot / 2 + Math.max(0, 650 - b.fabric)));
  if (kind === 'outbreak') return Math.max(0, Math.min(1000, 820 - pressureOf(city.press, 'sanitation')
    + b.householdIds.length * 35));
  if (kind === 'riot') return Math.round(Math.max(0, Math.min(1000, 900 - pressureOf(city.press, 'mood')
    + pressureOf(city.press, 'suspicion') / 3)));
  return Math.max(0, Math.min(1000, 850 - pressureOf(city.press, 'tram') + Math.max(0, 600 - b.fabric)));
}

function isFirmTarget(city: City, buildingId: number): boolean {
  const b = city.buildings[buildingId];
  return Boolean(b && b.firmId >= 0 && b.householdIds.length === 0 && !DEFS[b.kind].landmark);
}

function isBoilerTarget(city: City, buildingId: number): boolean {
  const kind = city.buildings[buildingId]?.kind;
  return kind === 'mill' || kind === 'foundry' || kind === 'workshop'
    || kind === 'pumphouse' || kind === 'gasworks';
}

function isTargetFor(city: City, kind: DisasterKind, buildingId: number): boolean {
  const b = city.buildings[buildingId];
  if (!b) return false;
  if (kind === 'outbreak') return b.householdIds.length > 0 && b.streetId >= 0;
  if (kind === 'riot') return b.kind === 'townhall' || b.kind === 'pub';
  if (kind === 'tramWreck') return b.kind === 'tramdepot';
  if (kind === 'boilerBurst') return isBoilerTarget(city, buildingId);
  return isFirmTarget(city, buildingId);
}

function eligible(city: City, kind: DisasterKind, buildingId: number): boolean {
  if (!isTargetFor(city, kind, buildingId) || disasterAt(city, buildingId)) return false;
  const b = city.buildings[buildingId];
  const rot = pressureOf(city.press, 'rot');
  const weather = weatherAt(city.seed, city.tick);
  if (kind === 'fire') {
    return weather.precipitation === 0 && rot >= 620 && b.fabric < 520
      && b.gasSeg >= 0 && b.gasSeg !== city.networks.gas.root
      && serviceAt(city.networks.gas, b.id);
  }
  if (kind === 'flood') {
    const x = b.doorX;
    const riverY = city.river.centre[x];
    const bank = city.river.halfWidth[x];
    // Snow is precipitation that has not run anywhere yet: it floods nothing
    // until it thaws, and the thaw is not modelled.
    return weather.precipitation > 0 && weather.kind !== 'snow'
      && pressureOf(city.press, 'sanitation') < 380 && b.fabric < 560
      && riverY >= 0 && Math.abs(b.doorY - riverY) <= bank + 3
      && b.drainSeg >= 0 && b.drainSeg !== city.networks.drain.root
      && serviceAt(city.networks.drain, b.id);
  }
  if (kind === 'collapse') return rot >= 690 && b.fabric < (weather.kind === 'storm' ? 220 : 180);
  if (kind === 'boilerBurst') return rot >= 720 && b.fabric < 420 && city.firms[b.firmId]?.output > 0;
  if (kind === 'outbreak') return pressureOf(city.press, 'sanitation') < 320
    && b.householdIds.some((id) => city.households[id]?.memberIds.some((soulId) => city.souls[soulId]?.health < 620));
  if (kind === 'riot') return pressureOf(city.press, 'mood') < 260
    && city.souls.filter((s) => s.age >= 14 && s.grievance > 620).length >= 6;
  return pressureOf(city.press, 'tram') < 260 && b.fabric < 520;
}

function chooseNaturalTarget(city: City, kind: DisasterKind): number {
  let chosen = -1;
  let bestSeverity = -1;
  let bestTie = 0xffffffff;
  const hour = Math.trunc(city.tick / 60);
  for (const b of city.buildings) {
    if (!eligible(city, kind, b.id)) continue;
    const severity = candidateSeverity(city, kind, b.id);
    const tie = mix(city.seed, Stream.Disaster, hour, b.id);
    if (severity > bestSeverity || (severity === bestSeverity && tie < bestTie)) {
      chosen = b.id;
      bestSeverity = severity;
      bestTie = tie;
    }
  }
  return chosen;
}

function nearbyFloodBuildings(city: City, buildingId: number): number[] {
  const target = city.buildings[buildingId];
  return city.buildings
    .filter((b) => Math.abs(b.doorX - target.doorX) + Math.abs(b.doorY - target.doorY) <= 5)
    .sort((a, b) => (Math.abs(a.doorX - target.doorX) + Math.abs(a.doorY - target.doorY))
      - (Math.abs(b.doorX - target.doorX) + Math.abs(b.doorY - target.doorY)) || a.id - b.id)
    .slice(0, 4)
    .map((b) => b.id);
}

/**
 * Whether the ward boss may loose this disaster on this building right now, and
 * the plain reason when not. Mirrors the guards inside startDisaster so a power
 * can be greyed out before it is pressed.
 */
export function canStartDisaster(city: City, kind: DisasterKind, buildingId: number): string | null {
  const st = city.disasters;
  if (st.events.length >= MAX_LIVE_DISASTERS) return 'Too much is already going wrong at once.';
  if (st.events.some((e) => e.kind === kind)) return 'That is already happening somewhere.';
  const b = city.buildings[buildingId];
  if (!b) return 'Nothing there to strike.';
  if (!isTargetFor(city, kind, buildingId)) {
    if (kind === 'outbreak') return 'Choose an occupied dwelling for the first fever cases.';
    if (kind === 'riot') return 'A riot must gather at a public house or the Town Hall.';
    if (kind === 'tramWreck') return 'The wreck must be laid at the tram depot.';
    if (kind === 'boilerBurst') return 'Choose works with a steam plant.';
    return 'Only a workplace can be struck like this.';
  }
  if (disasterAt(city, buildingId)) return 'That building already has trouble enough.';
  if (kind === 'flood') {
    const riverY = city.river.centre[b.doorX];
    if (riverY < 0 || Math.abs(b.doorY - riverY) > city.river.halfWidth[b.doorX] + 4) {
      return 'No water near enough to flood this.';
    }
  }
  return null;
}

/** Start an explicitly selected disaster, or return null when the slot is unavailable. */
export function startDisaster(city: City, kind: DisasterKind, buildingId?: number): Disaster | null {
  const st = city.disasters;
  if (!KIND_ORDER.includes(kind)) return null;
  if (st.events.length >= MAX_LIVE_DISASTERS) return null;
  if (st.events.some((e) => e.kind === kind)) return null;
  const targetId = buildingId === undefined ? chooseNaturalTarget(city, kind) : buildingId;
  if (!isTargetFor(city, kind, targetId) || disasterAt(city, targetId)) return null;
  const b = city.buildings[targetId];
  if (!b) return null;

  const severity = candidateSeverity(city, kind, targetId);
  const nodeId = kind === 'riot' && b.kind === 'townhall' ? city.squareNode : b.doorNode;
  const startedAt = city.tick;
  const containedAt = startedAt + ACTIVE_MINUTES[kind];
  const clearsAt = startedAt + CLEAR_MINUTES[kind];
  let brokenSegment = -1;
  let affectedBuildingIds: number[] = [targetId];
  if (kind === 'fire' && b.gasSeg >= 0 && b.gasSeg !== city.networks.gas.root && serviceAt(city.networks.gas, b.id)) {
    brokenSegment = b.gasSeg;
    // The broken tree stores every downstream outage. They are dark, but they
    // are not all on fire, so the disaster itself remains at one address.
    breakSegment(city.networks.gas, brokenSegment, startedAt);
  } else if (kind === 'flood') {
    affectedBuildingIds = nearbyFloodBuildings(city, targetId);
    if (b.drainSeg >= 0 && b.drainSeg !== city.networks.drain.root && serviceAt(city.networks.drain, b.id)) {
      brokenSegment = b.drainSeg;
      breakSegment(city.networks.drain, brokenSegment, startedAt);
    }
  }
  if (!affectedBuildingIds.includes(targetId)) affectedBuildingIds.unshift(targetId);

  const witnesses = witnessesOf(city, targetId).slice(0, 12);
  const evacuatedIds: SoulId[] = [];
  const involvedIds: SoulId[] = [];
  const unsafe = new Set(affectedBuildingIds);
  const civicHall = city.buildings.find((building) => building.kind === 'townhall' && !unsafe.has(building.id))?.id ?? -1;
  const evacuates = kind === 'fire' || kind === 'flood' || kind === 'collapse' || kind === 'boilerBurst';
  for (const affectedId of evacuates ? affectedBuildingIds : []) {
    const affected = city.buildings[affectedId];
    if (!affected) continue;
    for (const id of affected.occupants.slice()) {
      const s = city.souls[id];
      if (!s || s.inId !== affected.id || evacuatedIds.includes(id)) continue;
      evacuatedIds.push(id);
      s.grievance = Math.min(1000, s.grievance + (kind === 'collapse' ? 180 : kind === 'boilerBurst' ? 160 : 110));
      s.health = Math.max(0, s.health - (kind === 'fire' ? 70 : kind === 'flood' ? 35
        : kind === 'boilerBurst' ? 180 : 100));
      if (kind === 'boilerBurst') involvedIds.push(id);
      const refuge = !unsafe.has(s.homeId) ? s.homeId : civicHall;
      if (refuge >= 0) sendTo(city, s, refuge, 'commuting', 'visiting');
    }
  }

  const damage = kind === 'fire' ? 180 : kind === 'flood' ? 95 : kind === 'collapse' ? 1000
    : kind === 'boilerBurst' ? 320 : kind === 'tramWreck' ? 130 : 0;
  b.fabric = Math.max(0, b.fabric - damage);
  if (damage > 0) {
    b.facade = Math.max(0, Math.round(b.facade * (kind === 'collapse' ? 0.35
      : kind === 'fire' ? 0.65 : kind === 'boilerBurst' ? 0.55 : 0.82)));
  }
  b.lastIncidentTick = startedAt;
  // A fire brands the building. The scar outlives the event and is only cleared
  // when the fabric is genuinely made good.
  if (kind === 'fire') b.burntAt = startedAt;
  for (const id of affectedBuildingIds) {
    if (id === b.id) continue;
    const other = city.buildings[id];
    if (other) other.fabric = Math.max(0, other.fabric - (kind === 'flood' ? 25 : 0));
  }
  if (kind === 'outbreak') {
    const residents = b.householdIds.flatMap((id) => city.households[id]?.memberIds ?? [])
      .filter((id) => city.souls[id]?.activity !== 'dead').slice(0, 4);
    for (const id of residents) {
      const soul = city.souls[id];
      involvedIds.push(id);
      soul.health = Math.max(0, soul.health - 150);
      if (soul.health < 620) soul.activity = 'ailing';
      soul.grievance = Math.min(1000, soul.grievance + 50);
    }
  } else if (kind === 'riot') {
    const candidates = city.souls.filter((s) => s.age >= 14 && s.trade !== 'constable' && s.trade !== 'alderman'
      && s.activity !== 'dead' && s.activity !== 'held')
      .sort((a, z) => z.grievance + z.boldness - a.grievance - a.boldness || a.id - z.id).slice(0, 16);
    for (const soul of candidates) {
      involvedIds.push(soul.id);
      soul.overrideUntil = containedAt + 1;
      sendToNode(city, soul, nodeId, 'gathering', 'gathering');
    }
    const order = city.laws.slots[IDX.publicOrder];
    if (order.inForce && !order.captured) {
      for (const soul of city.souls.filter((s) => s.trade === 'constable'
        && s.activity !== 'dead' && s.activity !== 'held').slice(0, 6)) {
        soul.overrideUntil = containedAt + 1;
        sendToNode(city, soul, nodeId, 'commuting', 'gathering');
      }
    }
  } else if (kind === 'tramWreck') {
    city.tramStoppedUntil = Math.max(city.tramStoppedUntil, containedAt);
    for (const soul of city.souls.filter((s) => s.trade === 'conductor'
      && s.activity !== 'dead' && s.activity !== 'held').slice(0, 5)) {
      involvedIds.push(soul.id);
      soul.health = Math.max(0, soul.health - 110);
      soul.grievance = Math.min(1000, soul.grievance + 90);
      if (soul.health < 620) soul.activity = 'ailing';
    }
  }
  const firm = city.firms[b.firmId];
  if (firm) firm.closedUntil = Math.max(firm.closedUntil, containedAt);

  const event: Disaster = {
    id: st.next++, kind, buildingId: targetId, nodeId, affectedBuildingIds, evacuatedIds, involvedIds,
    startedAt, containedAt, clearsAt, severity, status: 'active', brokenSegment,
  };
  st.events.push(event);
  st.lastStartedAt[KIND_INDEX[kind]] = startedAt;
  st.revision++;
  openCivicDisaster(city, event);

  emit(city.events, kind, targetId, witnesses, severity, startedAt);
  if (witnesses.length) {
    const claimKind = kind === 'collapse' ? 'collapse' : kind === 'flood' || kind === 'outbreak' ? 'sickness' : 'sabotage';
    const claim = seedClaim(city.claims, claimKind, witnesses[0], -1, targetId, 1, startedAt);
    for (const id of witnesses) implant(city.claims, city.souls[id], claim, 720, -1, startedAt);
  }
  applyPressure(city.press, 'mood', kind === 'collapse' ? -150 : kind === 'fire' ? -105
    : kind === 'riot' ? -180 : kind === 'tramWreck' ? -95 : kind === 'boilerBurst' ? -125 : -70,
    'incident', event.id, kindLabel(kind), startedAt);
  if (kind === 'flood') applyPressure(city.press, 'sanitation', -90, 'incident', event.id, 'flooded drains', startedAt);
  if (kind === 'outbreak') applyPressure(city.press, 'sanitation', -120, 'incident', event.id, 'fever in the close', startedAt);
  if (kind === 'tramWreck') applyPressure(city.press, 'tram', -260, 'incident', event.id, 'the wrecked car', startedAt);
  pushLog(city, `${kindLabel(kind)} at ${b.name}.`, 'loss');
  return event;
}

/** The largest number of addresses a single fire may reach. A fire that ate the
 *  whole district would be a reset, not a disaster; the point is a legible scar
 *  across a corner of a quarter, not a crater. */
const FIRE_MAX_SPREAD = 5;

/** Char an occupied building the fire has jumped to: damage the fabric, drive the
 *  people out to safety, and brand it. Mirrors the primary-ignition bookkeeping
 *  in startDisaster without opening a second event. */
function igniteFromSpread(city: City, event: Disaster, buildingId: number): void {
  const b = city.buildings[buildingId];
  if (!b) return;
  b.fabric = Math.max(0, b.fabric - 150);
  b.facade = Math.max(0, Math.round(b.facade * 0.6));
  b.lastIncidentTick = city.tick;
  b.burntAt = city.tick;
  event.affectedBuildingIds.push(buildingId);
  const unsafe = new Set(event.affectedBuildingIds);
  const civicHall = city.buildings.find((building) => building.kind === 'townhall' && !unsafe.has(building.id))?.id ?? -1;
  for (const id of b.occupants.slice()) {
    const s = city.souls[id];
    if (!s || s.inId !== b.id || event.evacuatedIds.includes(id)) continue;
    event.evacuatedIds.push(id);
    s.grievance = Math.min(1000, s.grievance + 130);
    s.health = Math.max(0, s.health - 70);
    const refuge = !unsafe.has(s.homeId) ? s.homeId : civicHall;
    if (refuge >= 0) sendTo(city, s, refuge, 'commuting', 'visiting');
  }
  const firm = city.firms[b.firmId];
  if (firm) firm.closedUntil = Math.max(firm.closedUntil, event.containedAt);
  applyPressure(city.press, 'mood', -60, 'incident', event.id, 'the fire spread', city.tick);
  pushLog(city, `The fire spreads to ${b.name}.`, 'loss');
}

/** Can this building catch from a neighbouring blaze? Stone civic landmarks
 *  resist; timber and shabby fabric go up. */
function canCatch(city: City, buildingId: number): boolean {
  const b = city.buildings[buildingId];
  if (!b) return false;
  if (DEFS[b.kind].landmark && b.fabric > 300) return false;
  if (b.fabric <= 0) return false;
  if (disasterAt(city, buildingId)) return false;
  return b.fabric < 760;
}

/**
 * Wind-driven fire spread.
 *
 * Once an hour, an active fire may jump to ONE adjacent building. Adjacency is
 * physical: a candidate qualifies only if one of its cells touches a burning
 * cell, so the fire creeps along a terrace and across a court rather than
 * teleporting. Dryness, rot and the downwind direction raise the odds; rain
 * stops it dead. Everything is a pure function of (seed, hour, ids), so a replay
 * burns the same houses in the same order.
 */
function spreadFire(city: City, event: Disaster): void {
  if (event.status !== 'active') return;
  if (event.affectedBuildingIds.length >= FIRE_MAX_SPREAD) return;
  const weather = weatherAt(city.seed, city.tick);
  if (weather.precipitation > 0) return;
  const rot = pressureOf(city.press, 'rot');
  const d = city.district;

  // The burning frontier, as a set of cells.
  const hot = new Set<number>();
  for (const id of event.affectedBuildingIds) {
    const b = city.buildings[id];
    if (!b) continue;
    for (const k of b.cells) hot.add(k);
  }

  const hour = Math.trunc(city.tick / 60);
  let chosen = -1;
  let bestScore = -1;
  let bestTie = 0xffffffff;
  const affected = new Set(event.affectedBuildingIds);
  for (const b of city.buildings) {
    if (affected.has(b.id) || !canCatch(city, b.id)) continue;
    // Touching a burning cell? Chebyshev-1 against the hot set.
    let touches = false;
    let downwind = false;
    for (const k of b.cells) {
      const x = k % d.width;
      const y = (k - x) / d.width;
      for (let dy = -1; dy <= 1 && !touches; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= d.width || ny >= d.height) continue;
          if (!hot.has(cellKey(d, nx, ny))) continue;
          touches = true;
          // Caught cell sits downwind of the burning cell it touched.
          if (weather.windX !== 0 && Math.sign(x - nx) === Math.sign(weather.windX)) downwind = true;
          break;
        }
      }
    }
    if (!touches) continue;
    // Score: dry rotten shabby fabric downwind is the worst case.
    const score = rot + Math.max(0, 640 - b.fabric) + (downwind ? 260 : 0)
      + (DEFS[b.kind].needsGas && serviceAt(city.networks.gas, b.id) ? 120 : 0);
    const tie = mix(city.seed, Stream.Disaster, hour, b.id) >>> 0;
    if (score > bestScore || (score === bestScore && tie < bestTie)) {
      chosen = b.id;
      bestScore = score;
      bestTie = tie;
    }
  }
  if (chosen < 0) return;
  // A gate, so a fire in damp still air can burn out without taking the street.
  // The drier and more rotten the quarter, the more surely it jumps.
  const roll = (mix(city.seed, Stream.Disaster, hour * 131 + 7, event.id) >>> 0) % 1000;
  const chance = Math.min(900, 240 + rot + Math.max(0, bestScore - rot - 300));
  if (roll >= chance) return;
  igniteFromSpread(city, event, chosen);
  city.disasters.revision++;
}

/** A flood is bounded, like a fire, so it soaks a low corner rather than the map.
 *  It starts small at the breach and rises to this over the hours it runs. */
const FLOOD_MAX_SPREAD = 12;

/** River distance for a building's door: how far its ground sits from the channel
 *  centre, as a proxy for how low it lies. Smaller means wetter. */
function riverReach(city: City, b: Building): number {
  const riverY = city.river.centre[b.doorX];
  if (riverY < 0) return 999;
  return Math.abs(b.doorY - riverY) - city.river.halfWidth[b.doorX];
}

/** Water reaches another building: soak the fabric, drive people to dry ground. */
function floodInto(city: City, event: Disaster, buildingId: number): void {
  const b = city.buildings[buildingId];
  if (!b) return;
  b.fabric = Math.max(0, b.fabric - 25);
  b.lastIncidentTick = city.tick;
  event.affectedBuildingIds.push(buildingId);
  const unsafe = new Set(event.affectedBuildingIds);
  const civicHall = city.buildings.find((building) => building.kind === 'townhall' && !unsafe.has(building.id))?.id ?? -1;
  for (const id of b.occupants.slice()) {
    const s = city.souls[id];
    if (!s || s.inId !== b.id || event.evacuatedIds.includes(id)) continue;
    event.evacuatedIds.push(id);
    s.grievance = Math.min(1000, s.grievance + 90);
    s.health = Math.max(0, s.health - 35);
    const refuge = !unsafe.has(s.homeId) ? s.homeId : civicHall;
    if (refuge >= 0) sendTo(city, s, refuge, 'commuting', 'visiting');
  }
  applyPressure(city.press, 'sanitation', -20, 'incident', event.id, 'the water spread', city.tick);
  pushLog(city, `Flood water reaches ${b.name}.`, 'loss');
}

/**
 * Rising flood water.
 *
 * While the rain holds, the water creeps once an hour to ONE more building that
 * touches the flooded ground, preferring whatever lies lowest (nearest the
 * channel). When the rain stops it stops spreading and the event runs down to
 * containment. Deterministic from (seed, hour, ids), like the fire.
 */
function spreadFlood(city: City, event: Disaster): void {
  if (event.status !== 'active') return;
  if (event.affectedBuildingIds.length >= FLOOD_MAX_SPREAD) return;
  const weather = weatherAt(city.seed, city.tick);
  if (weather.precipitation === 0) return;

  // Water crosses streets and yards, so the flooded frontier is measured by door
  // proximity rather than building contact: a candidate is reachable if its door
  // sits within a few tiles of an already-flooded door. Fire needs touching
  // roofs; a flood only needs low ground between here and there.
  const affected = new Set(event.affectedBuildingIds);
  const hour = Math.trunc(city.tick / 60);
  let chosen = -1;
  let bestScore = -1e9;
  let bestTie = 0xffffffff;
  for (const b of city.buildings) {
    if (affected.has(b.id) || b.fabric <= 0) continue;
    let near = false;
    for (const id of event.affectedBuildingIds) {
      const w = city.buildings[id];
      if (w && Math.abs(w.doorX - b.doorX) + Math.abs(w.doorY - b.doorY) <= 3) { near = true; break; }
    }
    if (!near) continue;
    // Lower ground floods first: a smaller river reach scores higher.
    const score = 400 - riverReach(city, b) * 30 + Math.max(0, 600 - b.fabric);
    const tie = mix(city.seed, Stream.Disaster, hour, b.id) >>> 0;
    if (score > bestScore || (score === bestScore && tie < bestTie)) {
      chosen = b.id;
      bestScore = score;
      bestTie = tie;
    }
  }
  if (chosen < 0) return;
  // Harder rain drives the water on more surely.
  const roll = (mix(city.seed, Stream.Disaster, hour * 149 + 3, event.id) >>> 0) % 1000;
  const chance = weather.precipitation === 2 ? 820 : 520;
  if (roll >= chance) return;
  floodInto(city, event, chosen);
  city.disasters.revision++;
}

const OUTBREAK_MAX_ADDRESSES = 8;

function containEvent(city: City, event: Disaster, text: string): void {
  if (event.status !== 'active') return;
  event.status = 'contained';
  event.containedAt = city.tick;
  event.clearsAt = Math.min(event.clearsAt, city.tick + 720);
  city.disasters.revision++;
  pushLog(city, text, 'info');
}

/** Fever follows households and bad drains rather than damaging masonry. A
 * quarantine or restored sanitary service therefore changes its course. */
function spreadOutbreak(city: City, event: Disaster): void {
  if (event.status !== 'active') return;
  const first = city.buildings[event.buildingId];
  if (!first) return;
  if (city.quarantined.has(first.streetId)) {
    containEvent(city, event, `The cordon on ${city.streets[first.streetId]?.name ?? 'the street'} checks the fever.`);
    return;
  }
  const sanitary = pressureOf(city.press, 'sanitation');
  const allDrained = event.affectedBuildingIds.every((id) => serviceAt(city.networks.drain, id));
  if (sanitary >= 680 && allDrained) {
    containEvent(city, event, 'Sound drains and house calls check the fever.');
    return;
  }
  if (event.affectedBuildingIds.length >= OUTBREAK_MAX_ADDRESSES) return;
  const affected = new Set(event.affectedBuildingIds);
  const candidates = city.buildings.filter((b) => !affected.has(b.id) && b.streetId === first.streetId
    && b.householdIds.length > 0 && b.fabric > 0);
  if (!candidates.length) return;
  candidates.sort((a, b) => {
    const aRisk = (serviceAt(city.networks.drain, a.id) ? 0 : 500) + a.householdIds.length * 80 + 1000 - a.fabric;
    const bRisk = (serviceAt(city.networks.drain, b.id) ? 0 : 500) + b.householdIds.length * 80 + 1000 - b.fabric;
    return bRisk - aRisk || a.id - b.id;
  });
  const hour = Math.trunc(city.tick / 60);
  const chance = Math.min(920, 240 + Math.max(0, 600 - sanitary)
    + (allDrained ? 0 : 180));
  if ((mix(city.seed, Stream.Disaster, hour * 173 + event.id, candidates[0].id) >>> 0) % 1000 >= chance) return;
  const next = candidates[0];
  event.affectedBuildingIds.push(next.id);
  const residents = next.householdIds.flatMap((id) => city.households[id]?.memberIds ?? [])
    .filter((id) => !event.involvedIds.includes(id) && city.souls[id]?.activity !== 'dead').slice(0, 3);
  for (const id of residents) {
    const soul = city.souls[id];
    event.involvedIds.push(id);
    soul.health = Math.max(0, soul.health - 120);
    soul.grievance = Math.min(1000, soul.grievance + 45);
    if (soul.health < 620) soul.activity = 'ailing';
  }
  applyPressure(city.press, 'sanitation', -35, 'incident', event.id, 'fever reached another house', city.tick);
  pushLog(city, `Fever is reported at ${next.name}.`, 'loss');
  city.disasters.revision++;
}

function nodeDistance(city: City, soulId: number, nodeId: number): number {
  const soul = city.souls[soulId];
  if (!soul || soul.inId >= 0 || soul.atNode < 0 || nodeId < 0) return 999;
  return Math.abs(city.graph.cx[soul.atNode] - city.graph.cx[nodeId])
    + Math.abs(city.graph.cy[soul.atNode] - city.graph.cy[nodeId]);
}

function endRiot(city: City, event: Disaster, controlled: boolean): void {
  const order = city.laws.slots[IDX.publicOrder];
  let held = -1;
  if (controlled && order.inForce && !order.captured) {
    held = event.involvedIds.slice().sort((a, b) => city.souls[b].boldness - city.souls[a].boldness || a - b)[0] ?? -1;
  }
  for (const id of event.involvedIds) {
    const soul = city.souls[id];
    if (!soul) continue;
    soul.overrideUntil = city.tick;
    if (id === held) {
      soul.activity = 'held';
      soul.activitySince = city.tick;
      soul.inId = -1;
      soul.toNode = -1;
      soul.destNode = -1;
    } else {
      resumeCurrentBlock(city, soul);
    }
  }
  for (const soul of city.souls) {
    if (soul.trade !== 'constable' || soul.overrideUntil <= city.tick) continue;
    soul.overrideUntil = city.tick;
    resumeCurrentBlock(city, soul);
  }
  containEvent(city, event, controlled
    ? held >= 0 ? `${city.souls[held].given} ${city.souls[held].family} is taken as the square is cleared.`
      : 'The constables clear the square.'
    : 'The crowd thins and leaves the square.');
}

/** Rioters are actual souls walking to the square. Damage happens only after a
 * crowd arrives, and only while the constables on the spot are overmatched. */
function progressRiot(city: City, event: Disaster): void {
  if (event.status !== 'active') return;
  const present = event.involvedIds.filter((id) => nodeDistance(city, id, event.nodeId) <= 1);
  if (present.length < 3) return;
  const constables = city.souls.filter((s) => s.trade === 'constable' && nodeDistance(city, s.id, event.nodeId) <= 1);
  const order = city.laws.slots[IDX.publicOrder];
  const strength = constables.length * 3 + (order.inForce && !order.captured ? 3 : 0);
  if (strength >= present.length) {
    order.enforced += present.length;
    endRiot(city, event, true);
    return;
  }
  if (event.affectedBuildingIds.length >= 7) return;
  const sx = city.graph.cx[event.nodeId];
  const sy = city.graph.cy[event.nodeId];
  const affected = new Set(event.affectedBuildingIds);
  const target = city.buildings.filter((b) => !affected.has(b.id) && b.fabric > 0
    && (b.kind === 'shop' || b.kind === 'pub' || b.kind === 'bank' || b.kind === 'townhall'))
    .sort((a, b) => {
      const ad = Math.abs(a.doorX - sx) + Math.abs(a.doorY - sy);
      const bd = Math.abs(b.doorX - sx) + Math.abs(b.doorY - sy);
      return ad - bd || a.id - b.id;
    })[0];
  if (!target) return;
  event.affectedBuildingIds.push(target.id);
  target.facade = Math.max(0, target.facade - 150);
  target.fabric = Math.max(1, target.fabric - 45);
  target.lastIncidentTick = city.tick;
  const firm = city.firms[target.firmId];
  if (firm) firm.closedUntil = Math.max(firm.closedUntil, city.tick + 360);
  applyPressure(city.press, 'mood', -45, 'incident', event.id, 'damage at the square', city.tick);
  pushLog(city, `The crowd breaks the frontage of ${target.name}.`, 'loss');
  city.disasters.revision++;
}

/** Advance cleanup, then permit only one naturally arising failure this hour. */
export function tickDisastersHourly(city: City): void {
  const st = city.disasters;
  for (const event of st.events) {
    if (event.kind === 'fire') spreadFire(city, event);
    else if (event.kind === 'flood') spreadFlood(city, event);
    else if (event.kind === 'outbreak') spreadOutbreak(city, event);
    else if (event.kind === 'riot') progressRiot(city, event);
  }
  for (const event of st.events) {
    if (event.status === 'active' && city.tick >= event.containedAt) {
      if (event.kind === 'riot') endRiot(city, event, false);
      else containEvent(city, event,
        `The immediate danger at ${city.buildings[event.buildingId]?.name ?? 'the site'} is contained.`);
    }
  }
  const before = st.events.length;
  st.events = st.events.filter((event) => city.tick < event.clearsAt);
  if (st.events.length !== before) st.revision++;
  if (st.events.length >= MAX_LIVE_DISASTERS) return;

  for (const kind of KIND_ORDER) {
    if (st.events.some((event) => event.kind === kind)) continue;
    if (city.tick - st.lastStartedAt[KIND_INDEX[kind]] < COOLDOWN_MINUTES[kind]) continue;
    const buildingId = chooseNaturalTarget(city, kind);
    if (buildingId >= 0) {
      startDisaster(city, kind, buildingId);
      return;
    }
  }
}

export function disasterAt(city: City, buildingId: number): Disaster | null {
  for (let i = city.disasters.events.length - 1; i >= 0; i--) {
    const event = city.disasters.events[i];
    if (event.buildingId === buildingId || event.affectedBuildingIds.includes(buildingId)) return event;
  }
  return null;
}

export function isDisasterActive(city: City, eventOrBuilding: Disaster | number): boolean {
  const event = typeof eventOrBuilding === 'number' ? disasterAt(city, eventOrBuilding) : eventOrBuilding;
  return event !== null && event.status === 'active';
}

/** Collapsed firm buildings remain unavailable until physical works raise fabric. */
export function isBuildingClosed(city: City, buildingId: number): boolean {
  const event = disasterAt(city, buildingId);
  // Fever marks an occupied house; it does not make the address cease to be a
  // home. A cordon handles movement separately and keeps residents there.
  if (event?.status === 'active' && event.kind !== 'outbreak') return true;
  const b = city.buildings[buildingId];
  return Boolean(b && b.firmId >= 0 && b.fabric === 0);
}

export function disasterSummary(city: City, buildingId: number): string {
  const event = disasterAt(city, buildingId);
  if (!event) return '';
  const state = event.status === 'active' ? 'ACTIVE' : 'CONTAINED';
  const label = event.kind === 'fire' ? 'FIRE' : event.kind === 'flood' ? 'FLOOD'
    : event.kind === 'collapse' ? 'COLLAPSE' : event.kind === 'boilerBurst' ? 'BOILER BURST'
      : event.kind === 'outbreak' ? 'FEVER' : event.kind === 'riot' ? 'RIOT' : 'TRAM WRECK';
  return `${label} ${state}`;
}
