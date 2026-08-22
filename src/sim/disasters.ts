// Physical disasters: small, stateful failures that the district can actually
// suffer and repair. They are deliberately separate from the ticker incidents:
// an incident says what the district noticed, while a disaster owns the damaged
// building, the broken main, and the cleanup clock.
import type { City } from './city';
import { pushLog, sendTo } from './city';
import { DEFS } from './buildings';
import { seedClaim, implant } from './claims';
import { emit, witnessesOf } from './events';
import { breakSegment, serviceAt } from './networks';
import { applyPressure, pressureOf } from './pressures';
import { mix, Stream } from './rng';
import type { BuildingId, SoulId } from './types';
import { weatherAt } from './weather';

export type DisasterKind = 'fire' | 'flood' | 'collapse';
export type DisasterStatus = 'active' | 'contained';

export interface Disaster {
  id: number;
  kind: DisasterKind;
  buildingId: BuildingId;
  /** A fixed small list for the renderer and inspector, never a district scan. */
  affectedBuildingIds: number[];
  evacuatedIds: SoulId[];
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
  /** collapse, fire, flood. */
  lastStartedAt: [number, number, number];
}

const KIND_ORDER: readonly DisasterKind[] = ['collapse', 'fire', 'flood'];
const KIND_INDEX: Record<DisasterKind, 0 | 1 | 2> = { collapse: 0, fire: 1, flood: 2 };
const ACTIVE_MINUTES: Record<DisasterKind, number> = { fire: 360, flood: 480, collapse: 720 };
const COOLDOWN_MINUTES: Record<DisasterKind, number> = { fire: 1440, flood: 1440, collapse: 2880 };

export function newDisasters(): DisasterState {
  return { events: [], revision: 0, next: 0, lastStartedAt: [-1_000_000, -1_000_000, -1_000_000] };
}

function kindLabel(kind: DisasterKind): string {
  return kind === 'fire' ? 'a building fire' : kind === 'flood' ? 'river water in the streets' : 'a structural collapse';
}

function candidateSeverity(city: City, kind: DisasterKind, buildingId: number): number {
  const b = city.buildings[buildingId];
  const rot = pressureOf(city.press, 'rot');
  if (kind === 'fire') return Math.min(1000, rot + Math.max(0, 600 - b.fabric));
  if (kind === 'flood') return Math.min(1000, weatherAt(city.seed, city.tick).precipitation * 120
    + Math.max(0, 520 - pressureOf(city.press, 'sanitation')) + Math.max(0, 680 - b.fabric));
  return Math.min(1000, rot + Math.max(0, 360 - b.fabric));
}

function isFirmTarget(city: City, buildingId: number): boolean {
  const b = city.buildings[buildingId];
  return Boolean(b && b.firmId >= 0 && b.householdIds.length === 0 && !DEFS[b.kind].landmark);
}

function eligible(city: City, kind: DisasterKind, buildingId: number): boolean {
  if (!isFirmTarget(city, buildingId) || disasterAt(city, buildingId)) return false;
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
    return weather.precipitation > 0 && pressureOf(city.press, 'sanitation') < 380 && b.fabric < 560
      && riverY >= 0 && Math.abs(b.doorY - riverY) <= bank + 3
      && b.drainSeg >= 0 && b.drainSeg !== city.networks.drain.root
      && serviceAt(city.networks.drain, b.id);
  }
  return rot >= 690 && b.fabric < (weather.kind === 'storm' ? 220 : 180);
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
    .slice(0, 8)
    .map((b) => b.id);
}

/** Start an explicitly selected disaster, or return null when the slot is unavailable. */
export function startDisaster(city: City, kind: DisasterKind, buildingId?: number): Disaster | null {
  const st = city.disasters;
  if (!KIND_ORDER.includes(kind)) return null;
  if (st.events.length >= 2) return null;
  if (st.events.some((e) => e.kind === kind)) return null;
  const targetId = buildingId === undefined ? chooseNaturalTarget(city, kind) : buildingId;
  if (!isFirmTarget(city, targetId) || disasterAt(city, targetId)) return null;
  const b = city.buildings[targetId];
  if (!b) return null;

  const severity = candidateSeverity(city, kind, targetId);
  const startedAt = city.tick;
  const containedAt = startedAt + ACTIVE_MINUTES[kind];
  const clearsAt = startedAt + 1440;
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
  const unsafe = new Set(affectedBuildingIds);
  const civicHall = city.buildings.find((building) => building.kind === 'townhall' && !unsafe.has(building.id))?.id ?? -1;
  for (const affectedId of affectedBuildingIds) {
    const affected = city.buildings[affectedId];
    if (!affected) continue;
    for (const id of affected.occupants.slice()) {
      const s = city.souls[id];
      if (!s || s.inId !== affected.id || evacuatedIds.includes(id)) continue;
      evacuatedIds.push(id);
      s.grievance = Math.min(1000, s.grievance + (kind === 'collapse' ? 180 : 110));
      s.health = Math.max(0, s.health - (kind === 'fire' ? 70 : kind === 'flood' ? 35 : 100));
      const refuge = !unsafe.has(s.homeId) ? s.homeId : civicHall;
      if (refuge >= 0) sendTo(city, s, refuge, 'commuting', 'visiting');
    }
  }

  const damage = kind === 'fire' ? 180 : kind === 'flood' ? 95 : 1000;
  b.fabric = Math.max(0, b.fabric - damage);
  b.facade = Math.max(0, Math.round(b.facade * (kind === 'collapse' ? 0.35 : kind === 'fire' ? 0.65 : 0.82)));
  b.lastIncidentTick = startedAt;
  for (const id of affectedBuildingIds) {
    if (id === b.id) continue;
    const other = city.buildings[id];
    if (other) other.fabric = Math.max(0, other.fabric - (kind === 'flood' ? 25 : 0));
  }
  const firm = city.firms[b.firmId];
  if (firm) firm.closedUntil = Math.max(firm.closedUntil, containedAt);

  const event: Disaster = {
    id: st.next++, kind, buildingId: targetId, affectedBuildingIds, evacuatedIds,
    startedAt, containedAt, clearsAt, severity, status: 'active', brokenSegment,
  };
  st.events.push(event);
  st.lastStartedAt[KIND_INDEX[kind]] = startedAt;
  st.revision++;

  emit(city.events, kind, targetId, witnesses, severity, startedAt);
  if (witnesses.length) {
    const claimKind = kind === 'collapse' ? 'collapse' : kind === 'flood' ? 'sickness' : 'sabotage';
    const claim = seedClaim(city.claims, claimKind, witnesses[0], -1, targetId, 1, startedAt);
    for (const id of witnesses) implant(city.claims, city.souls[id], claim, 720, -1, startedAt);
  }
  applyPressure(city.press, 'mood', kind === 'collapse' ? -150 : kind === 'fire' ? -105 : -70,
    'incident', event.id, kindLabel(kind), startedAt);
  if (kind === 'flood') applyPressure(city.press, 'sanitation', -90, 'incident', event.id, 'flooded drains', startedAt);
  pushLog(city, `${kindLabel(kind)} at ${b.name}.`, 'loss');
  return event;
}

/** Advance cleanup, then permit only one naturally arising failure this hour. */
export function tickDisastersHourly(city: City): void {
  const st = city.disasters;
  for (const event of st.events) {
    if (event.status === 'active' && city.tick >= event.containedAt) {
      event.status = 'contained';
      st.revision++;
      pushLog(city, `The immediate danger at ${city.buildings[event.buildingId]?.name ?? 'the site'} is contained.`, 'info');
    }
  }
  const before = st.events.length;
  st.events = st.events.filter((event) => city.tick < event.clearsAt);
  if (st.events.length !== before) st.revision++;
  if (st.events.length >= 2) return;

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
  if (event?.status === 'active') return true;
  const b = city.buildings[buildingId];
  return Boolean(b && b.firmId >= 0 && b.fabric === 0);
}

export function disasterSummary(city: City, buildingId: number): string {
  const event = disasterAt(city, buildingId);
  if (!event) return '';
  const state = event.status === 'active' ? 'ACTIVE' : 'CONTAINED';
  const label = event.kind === 'fire' ? 'FIRE' : event.kind === 'flood' ? 'FLOOD' : 'COLLAPSE';
  return `${label} ${state}`;
}
