// Public deputations are actual residents making an actual journey. A filed
// case can be heard sooner, but the crowd never repairs a wall or pipe itself.
import type { City } from './city';
import { pushLog, resumeCurrentBlock, sendToNode } from './city';
import { emit } from './events';
import { gateOrdinanceTarget, wouldAllowGathering } from './ordinances';
import { mix, Stream } from './rng';
import { expediteFiledOrder, latestOrderFor } from './works';
import type { BuildingId, SoulId } from './types';
import { civicHouseholdBurden, recordCivicHearing } from './civic-memory';

export type DeputationStatus = 'gathering' | 'heard' | 'thin' | 'dispersed';

export interface Deputation {
  id: number;
  buildingId: BuildingId;
  orderId: number;
  hallId: BuildingId;
  squareNode: number;
  attendeeIds: SoulId[];
  arrivedIds: SoulId[];
  rejectedCount: number;
  startedAt: number;
  heardAt: number;
  endsAt: number;
  endedAt: number;
  resolvedAt: number;
  status: DeputationStatus;
}

export interface DeputationState {
  current: Deputation | null;
  /** Changes when the Hall's temporary banner must be rebaked. */
  revision: number;
  nextId: number;
  squareNode: number;
}

const HEARING_DELAY = 60;
const DURATION = 180;
const HEARD_THRESHOLD = 5;

export function newDeputations(squareNode: number): DeputationState {
  return { current: null, revision: 0, nextId: 0, squareNode };
}

export function isDeputationActive(city: City): boolean {
  const current = city.deputations.current;
  return Boolean(current && city.tick < current.endsAt);
}

function hallOf(city: City): BuildingId {
  return city.buildingsByKind.get('townhall')?.[0] ?? -1;
}

function eligibleFromStreet(city: City, buildingId: BuildingId): SoulId[] {
  const target = city.buildings[buildingId];
  if (!target || target.streetId < 0) return [];
  const out: SoulId[] = [];
  for (const s of city.souls) {
    const home = city.buildings[s.homeId];
    if (!home || home.streetId !== target.streetId) continue;
    if (s.inId < 0 || s.returnAt >= 0 || s.overrideUntil > city.tick || s.age < 14) continue;
    if (s.activity === 'asleep' || s.activity === 'held' || s.activity === 'dead') continue;
    out.push(s.id);
  }
  out.sort((a, b) => {
    const sa = city.souls[a];
    const sb = city.souls[b];
    const atAddressA = sa.homeId === buildingId ? 1 : 0;
    const atAddressB = sb.homeId === buildingId ? 1 : 0;
    if (atAddressA !== atAddressB) return atAddressB - atAddressA;
    const burdenA = civicHouseholdBurden(city, sa.householdId);
    const burdenB = civicHouseholdBurden(city, sb.householdId);
    if (burdenA !== burdenB) return burdenB - burdenA;
    if (sa.grievance !== sb.grievance) return sb.grievance - sa.grievance;
    const ha = mix(city.seed, Stream.Crowd, city.tick, a + buildingId * 257);
    const hb = mix(city.seed, Stream.Crowd, city.tick, b + buildingId * 257);
    return ha - hb || a - b;
  });
  return out;
}

/** Reason suitable for the disabled intervention row, or null when callable. */
export function canCallDeputation(city: City, buildingId: BuildingId): string | null {
  if (isDeputationActive(city)) return 'Another street is already before the hall.';
  const target = city.buildings[buildingId];
  if (!target) return 'Nothing there.';
  if (target.streetId < 0) return 'No street can answer for this address.';
  const order = latestOrderFor(city, buildingId);
  if (!order || order.status !== 'filed') return 'File this address in the works register first.';
  if (city.deputations.squareNode < 0 || city.deputations.squareNode >= city.graph.n) {
    return 'The civic square has no route.';
  }
  if (hallOf(city) < 0) return 'There is no Civic Hall.';
  const candidates = eligibleFromStreet(city, buildingId);
  if (!candidates.length) return 'Nobody from this street can leave just now.';
  if (!candidates.slice(0, 8).some((id) => wouldAllowGathering(city, city.souls[id], hallOf(city)))) {
    return 'The ordinances will not let this street assemble.';
  }
  return null;
}

/**
 * Call up to eight residents from the selected street. Public-order compliance
 * is decided through the existing law gate before anyone is put on the road.
 */
export function callDeputation(city: City, buildingId: BuildingId, maxParticipants = 8): number {
  if (canCallDeputation(city, buildingId)) return 0;
  const order = latestOrderFor(city, buildingId);
  const hallId = hallOf(city);
  if (!order || order.status !== 'filed' || hallId < 0) return 0;

  const candidates = eligibleFromStreet(city, buildingId).slice(0, Math.max(1, maxParticipants));
  const attendeeIds: SoulId[] = [];
  let rejectedCount = 0;
  const heardAt = city.tick + HEARING_DELAY;
  const endsAt = city.tick + DURATION;

  for (const id of candidates) {
    const s = city.souls[id];
    const priorArrive = s.arriveActivity;
    s.arriveActivity = 'gathering';
    const permitted = gateOrdinanceTarget(city, s, hallId, 'gathering') === hallId;
    if (!permitted) {
      s.arriveActivity = priorArrive;
      rejectedCount++;
      continue;
    }
    s.overrideUntil = endsAt + 1;
    sendToNode(city, s, city.deputations.squareNode, 'gathering', 'gathering');
    attendeeIds.push(id);
  }

  // A direct call with a smaller cap can still select only compliant residents.
  // Record the law's enforcement, but do not invent a banner or an empty crowd.
  if (!attendeeIds.length) return 0;

  const current: Deputation = {
    id: city.deputations.nextId++, buildingId, orderId: order.id, hallId,
    squareNode: city.deputations.squareNode, attendeeIds, arrivedIds: [], rejectedCount,
    startedAt: city.tick, heardAt, endsAt, endedAt: -1, resolvedAt: -1, status: 'gathering',
  };
  city.deputations.current = current;
  city.deputations.revision++;
  emit(city.events, 'deputationCalled', hallId, attendeeIds.slice(), 300, city.tick);
  return attendeeIds.length;
}

function presentAtSquare(city: City, current: Deputation, soulId: SoulId): boolean {
  const s = city.souls[soulId];
  return Boolean(s && s.inId < 0 && s.activity === 'gathering'
    && s.atNode === current.squareNode && s.toNode < 0);
}

function stillOwned(city: City, current: Deputation, soulId: SoulId): boolean {
  const s = city.souls[soulId];
  if (!s || s.inId >= 0 || s.activity !== 'gathering') return false;
  return s.destNode === current.squareNode || s.atNode === current.squareNode;
}

function resolveHearing(city: City, current: Deputation): void {
  if (current.status !== 'gathering' || city.tick < current.heardAt) return;
  const present = current.attendeeIds.filter((id) => presentAtSquare(city, current, id));
  current.resolvedAt = city.tick;
  if (present.length >= HEARD_THRESHOLD) {
    current.status = 'heard';
    recordCivicHearing(city, current.orderId, true);
    const moved = expediteFiledOrder(city, current.orderId, city.tick + 60);
    pushLog(city, moved
      ? `${present.length} neighbours were heard at Civic Hall. Their works case has been brought forward.`
      : `${present.length} neighbours were heard at Civic Hall. Their works case was already moving.`,
    moved ? 'gain' : 'info');
    emit(city.events, 'deputationHeard', current.hallId, present, 360, city.tick);
    return;
  }
  current.status = current.rejectedCount > 0 ? 'dispersed' : 'thin';
  recordCivicHearing(city, current.orderId, false);
  if (current.status === 'dispersed') current.endsAt = city.tick;
  pushLog(city, current.status === 'dispersed'
    ? 'The public-order men kept enough neighbours from Civic Hall that no case was heard.'
    : 'Too few neighbours reached Civic Hall. The works case was not heard.', 'loss');
  emit(city.events, 'deputationFailed', current.hallId, present, 220, city.tick);
}

/** Track physical arrivals, resolve the hearing, and later restore owned souls. */
export function tickDeputation(city: City): void {
  const current = city.deputations.current;
  if (!current || current.endedAt >= 0) return;

  for (const id of current.attendeeIds) {
    if (presentAtSquare(city, current, id) && !current.arrivedIds.includes(id)) current.arrivedIds.push(id);
  }
  resolveHearing(city, current);
  if (city.tick < current.endsAt) return;

  const released: SoulId[] = [];
  for (const id of current.attendeeIds) {
    if (!stillOwned(city, current, id)) continue;
    const s = city.souls[id];
    s.overrideUntil = city.tick;
    resumeCurrentBlock(city, s);
    released.push(id);
  }
  emit(city.events, 'deputationEnded', current.hallId, released, 160, city.tick);
  current.endedAt = city.tick;
  city.deputations.revision++;
}

export function deputationSummary(city: City, buildingId: BuildingId): string {
  const current = city.deputations.current;
  if (!current || current.buildingId !== buildingId || city.tick >= current.endsAt) return '';
  const present = current.attendeeIds.filter((id) => presentAtSquare(city, current, id)).length;
  if (current.status === 'heard') return `DEPUTATION ${current.id + 1} \u00b7 ${present} HEARD AT CIVIC HALL`;
  if (current.status === 'dispersed') return `DEPUTATION ${current.id + 1} \u00b7 DISPERSED UNDER PUBLIC ORDER`;
  if (current.status === 'thin') return `DEPUTATION ${current.id + 1} \u00b7 TOO FEW TO BE HEARD`;
  return `DEPUTATION ${current.id + 1} \u00b7 ${present} OF ${current.attendeeIds.length} ON THE SQUARE`;
}
