// Civic politics in the street graph.
//
// A petition may be readable as soon as the morning papers reach the desk, but
// its authors still come to Civic Hall. Later, patrons and opponents carry the
// verdict into a newspaper office or public house. Nothing in this module
// teleports a crowd or fires an effect before a named body arrives.
import type { City } from './city';
import { pushLog, resumeCurrentBlock, sendTo, sendToNode } from './city';
import { MIN_PER_DAY, minuteOfDay } from './clock';
import { seedClaim, implant } from './claims';
import { emit, witnessesOf } from './events';
import { applyPressure } from './pressures';
import { adjustTie } from './relations';
import { fullName } from './souls';
import type { BuildingId, SoulId } from './types';

export type CivicVisitKind = 'petition' | 'support' | 'opposition' | 'meeting';
export type CivicVisitStatus = 'scheduled' | 'travelling' | 'gathered' | 'resolved' | 'ended';

export interface CivicVisit {
  id: number;
  kind: CivicVisitKind;
  matterId: number;
  actorIds: SoulId[];
  arrivedIds: SoulId[];
  destinationId: BuildingId;
  nodeId: number;
  startsAt: number;
  resolvesAt: number;
  endsAt: number;
  resolvedAt: number;
  endedAt: number;
  status: CivicVisitStatus;
}

export interface CivicVisitState {
  visits: CivicVisit[];
  nextId: number;
  nextAvailableAt: number;
  revision: number;
}

export interface CivicVisitUpdate {
  meetingPresent: SoulId[] | null;
}

const VISIT_DURATION = 90;
const RESOLVE_DELAY = 45;

export function newCivicVisits(): CivicVisitState {
  return { visits: [], nextId: 0, nextAvailableAt: 0, revision: 0 };
}

function hallOf(city: City): BuildingId {
  return city.buildingsByKind.get('townhall')?.[0] ?? -1;
}

export function nextVisitTime(tick: number, minute: number): number {
  const dayStart = tick - minuteOfDay(tick);
  const today = dayStart + minute;
  return today > tick ? today : today + MIN_PER_DAY;
}

/** Queue one bounded visit. The queue serialises public groups so formations do not overlap. */
export function scheduleCivicVisit(
  city: City,
  kind: CivicVisitKind,
  actorIds: SoulId[],
  preferredAt: number,
  matterId = -1,
  destinationId = hallOf(city),
): CivicVisit | null {
  const actors = actorIds.filter((id, index) => city.souls[id] && actorIds.indexOf(id) === index).slice(0, 12);
  if (!actors.length || destinationId < 0) return null;
  const publicTail = city.civicVisits.visits.reduce((latest, visit) =>
    publicVisit(visit) && visit.status !== 'ended' ? Math.max(latest, visit.endsAt) : latest, 0);
  const startsAt = kind === 'petition' ? Math.max(preferredAt, publicTail) : preferredAt;
  const visit: CivicVisit = {
    id: city.civicVisits.nextId++, kind, matterId, actorIds: actors, arrivedIds: [],
    destinationId, nodeId: kind === 'support' || kind === 'opposition'
      ? city.buildings[destinationId]?.doorNode ?? -1
      : city.squareNode,
    startsAt, resolvesAt: startsAt + RESOLVE_DELAY, endsAt: startsAt + VISIT_DURATION,
    resolvedAt: -1, endedAt: -1, status: 'scheduled',
  };
  if (kind === 'meeting') {
    let cursor = visit.endsAt;
    for (const queued of city.civicVisits.visits) {
      if (queued.kind !== 'petition' || queued.status !== 'scheduled'
        || queued.endsAt <= visit.startsAt || queued.startsAt >= visit.endsAt) continue;
      const duration = queued.endsAt - queued.startsAt;
      const resolveDelay = queued.resolvesAt - queued.startsAt;
      queued.startsAt = cursor;
      queued.resolvesAt = cursor + resolveDelay;
      queued.endsAt = cursor + duration;
      cursor = queued.endsAt;
    }
  }
  city.civicVisits.visits.push(visit);
  city.civicVisits.nextAvailableAt = Math.max(0,
    ...city.civicVisits.visits.map((item) => item.kind === 'petition' && item.status !== 'ended' ? item.endsAt : 0));
  if (city.civicVisits.visits.length > 32) {
    const ended = city.civicVisits.visits.findIndex((item) => item.status === 'ended');
    if (ended >= 0) city.civicVisits.visits.splice(ended, 1);
  }
  city.civicVisits.revision++;
  return visit;
}

function publicVisit(visit: CivicVisit): boolean {
  return visit.kind === 'petition' || visit.kind === 'meeting';
}

function squareOccupied(city: City): boolean {
  return Boolean((city.deputations.current && city.tick < city.deputations.current.endsAt)
    || city.occasions.current || city.shelters.current
    || city.civicVisits.visits.some((visit) => publicVisit(visit)
      && visit.status !== 'scheduled' && visit.status !== 'ended'));
}

function start(city: City, visit: CivicVisit): void {
  if (visit.kind === 'petition' && squareOccupied(city)) {
    visit.startsAt++;
    visit.resolvesAt++;
    visit.endsAt++;
    city.civicVisits.nextAvailableAt = Math.max(city.civicVisits.nextAvailableAt, visit.endsAt);
    return;
  }
  const admitted: SoulId[] = [];
  for (const id of visit.actorIds) {
    const soul = city.souls[id];
    if (!soul || soul.activity === 'held' || soul.activity === 'dead' || soul.overrideUntil > city.tick) continue;
    soul.overrideUntil = visit.endsAt + 1;
    if (publicVisit(visit)) sendToNode(city, soul, visit.nodeId, 'gathering', 'gathering');
    else sendTo(city, soul, visit.destinationId, 'commuting', 'visiting');
    admitted.push(id);
  }
  if (!admitted.length && visit.actorIds.some((id) => city.souls[id]?.activity !== 'dead')) {
    visit.startsAt += 15;
    visit.resolvesAt += 15;
    visit.endsAt += 15;
    city.civicVisits.nextAvailableAt = Math.max(city.civicVisits.nextAvailableAt, visit.endsAt);
    return;
  }
  visit.actorIds = admitted;
  visit.status = 'travelling';
  city.civicVisits.revision++;
  emit(city.events, `civic-${visit.kind}-called`, visit.destinationId, admitted.slice(), 180, city.tick);
}

function present(city: City, visit: CivicVisit, id: SoulId): boolean {
  const soul = city.souls[id];
  if (!soul) return false;
  if (publicVisit(visit)) {
    return soul.inId < 0 && soul.activity === 'gathering'
      && soul.atNode === visit.nodeId && soul.toNode < 0;
  }
  return soul.inId === visit.destinationId && soul.activity === 'visiting';
}

function owned(city: City, visit: CivicVisit, id: SoulId): boolean {
  const soul = city.souls[id];
  if (!soul) return false;
  if (publicVisit(visit)) {
    return soul.inId < 0 && soul.activity === 'gathering'
      && (soul.destNode === visit.nodeId || soul.atNode === visit.nodeId);
  }
  return soul.destBuilding === visit.destinationId
    || (soul.inId === visit.destinationId && soul.activity === 'visiting');
}

function resolveVisit(city: City, visit: CivicVisit): SoulId[] | null {
  const presentIds = visit.actorIds.filter((id) => present(city, visit, id));
  visit.resolvedAt = city.tick;
  visit.status = 'resolved';
  city.civicVisits.revision++;
  if (visit.kind === 'petition') {
    const matter = city.matters.items.find((item) => item.id === visit.matterId);
    if (matter && presentIds.length) matter.presentedAt = city.tick;
    emit(city.events, 'petitionPresented', visit.destinationId, presentIds, 160, city.tick);
    if (presentIds.length) {
      const lead = fullName(city.souls[presentIds[0]]);
      const company = presentIds.length > 1 ? ` and ${presentIds.length - 1} other${presentIds.length === 2 ? '' : 's'}` : '';
      const subject = matter?.title ?? 'a petition';
      const text = matter?.status === 'kept'
        ? `${lead}${company} came to Civic Hall after their promise was kept: ${subject}.`
        : matter?.status === 'failed' || matter?.status === 'declined'
          ? `${lead}${company} came to Civic Hall to protest the answer: ${subject}.`
          : matter?.status === 'overtaken'
            ? `${lead}${company} came to Civic Hall to put the overtaken petition on record: ${subject}.`
            : `${lead}${company} presented ${subject} at Civic Hall.`;
      pushLog(city, text, matter?.status === 'kept' ? 'gain'
        : matter?.status === 'failed' || matter?.status === 'declined' ? 'loss' : 'info');
    }
    return null;
  }
  if (visit.kind === 'meeting') {
    emit(city.events, 'ratepayersMet', visit.destinationId, presentIds, 300, city.tick);
    return presentIds;
  }
  const actor = presentIds[0] === undefined ? null : city.souls[presentIds[0]];
  if (!actor) return null;
  const witnesses = witnessesOf(city, visit.destinationId).filter((id) => id !== actor.id).slice(0, 10);
  const relation = city.matters.relations.find((item) => item.soulId === actor.id);
  if (relation) relation.lastActAt = city.tick;
  if (visit.kind === 'support') {
    for (const id of witnesses) {
      city.souls[id].grievance = Math.max(0, city.souls[id].grievance - 12);
      adjustTie(city.relations, actor.id, id, 10);
    }
    applyPressure(city.press, 'suspicion', -Math.min(30, 8 + witnesses.length * 2),
      'claim', actor.id, `${fullName(actor)} speaking for the chair`, city.tick);
    pushLog(city, `${fullName(actor)} spoke for the chair in front of ${witnesses.length} people.`, 'gain');
    emit(city.events, 'patronSpoke', visit.destinationId, [actor.id, ...witnesses], 180, city.tick);
    return null;
  }
  const alderman = city.souls.find((soul) => soul.trade === 'alderman') ?? actor;
  const claim = seedClaim(city.claims, 'graft', alderman.id, actor.id, visit.destinationId, 0, city.tick);
  implant(city.claims, actor, claim, 760, actor.id, city.tick);
  for (const id of witnesses) implant(city.claims, city.souls[id], claim, 560, actor.id, city.tick);
  applyPressure(city.press, 'suspicion', Math.min(40, 14 + witnesses.length * 3),
    'claim', claim, `${fullName(actor)} speaking against the chair`, city.tick);
  pushLog(city, `${fullName(actor)} spoke against the chair in front of ${witnesses.length} people.`, 'loss');
  emit(city.events, 'opponentSpoke', visit.destinationId, [actor.id, ...witnesses], 260, city.tick);
  return null;
}

function finish(city: City, visit: CivicVisit): void {
  for (const id of visit.actorIds) {
    if (!owned(city, visit, id)) continue;
    const soul = city.souls[id];
    soul.overrideUntil = city.tick;
    resumeCurrentBlock(city, soul);
  }
  visit.endedAt = city.tick;
  visit.status = 'ended';
  city.civicVisits.revision++;
}

/** Called after movement. Returned attendees let the city resolve a physical weekly vote. */
export function tickCivicVisits(city: City): CivicVisitUpdate {
  let meetingPresent: SoulId[] | null = null;
  for (const visit of city.civicVisits.visits) {
    if (visit.status === 'scheduled' && city.tick >= visit.startsAt) start(city, visit);
    if (visit.status === 'scheduled') continue;
    for (const id of visit.actorIds) {
      if (present(city, visit, id) && !visit.arrivedIds.includes(id)) {
        visit.arrivedIds.push(id);
        city.civicVisits.revision++;
      }
    }
    if ((visit.status === 'travelling' || visit.status === 'gathered') && city.tick >= visit.resolvesAt) {
      meetingPresent = resolveVisit(city, visit) ?? meetingPresent;
    }
    if (visit.status === 'travelling' && visit.arrivedIds.length) visit.status = 'gathered';
    if (city.tick >= visit.endsAt && visit.status !== 'ended') finish(city, visit);
  }
  return { meetingPresent };
}

export function activePublicVisit(city: City): CivicVisit | null {
  return city.civicVisits.visits.find((visit) => publicVisit(visit)
    && visit.status !== 'scheduled' && visit.status !== 'ended') ?? null;
}

export function visitForMatter(city: City, matterId: number): CivicVisit | null {
  for (let i = city.civicVisits.visits.length - 1; i >= 0; i--) {
    const visit = city.civicVisits.visits[i];
    if (visit.matterId === matterId && visit.kind === 'petition') return visit;
  }
  return null;
}

export function pendingMeetingVisit(city: City): CivicVisit | null {
  return city.civicVisits.visits.find((visit) => visit.kind === 'meeting'
    && visit.status !== 'resolved' && visit.status !== 'ended') ?? null;
}

/** Bunting can bring two more named adults to a published sitting, never bodies from nowhere. */
export function reinforceMeetingVisit(city: City): number {
  const visit = pendingMeetingVisit(city);
  if (!visit || visit.status !== 'scheduled') return 0;
  const included = new Set(visit.actorIds);
  const additions = city.souls
    .filter((soul) => soul.age >= 18 && soul.activity !== 'dead' && !included.has(soul.id))
    .sort((a, b) => {
      const ar = city.matters.relations.find((item) => item.soulId === a.id)?.regard ?? 0;
      const br = city.matters.relations.find((item) => item.soulId === b.id)?.regard ?? 0;
      return br - ar || b.mood - a.mood || b.boldness - a.boldness || a.id - b.id;
    })
    .slice(0, 2);
  for (const soul of additions) visit.actorIds.push(soul.id);
  if (additions.length) city.civicVisits.revision++;
  return additions.length;
}

export function civicVisitSummary(city: City, buildingId: BuildingId): string {
  const visits = city.civicVisits.visits.filter((visit) => visit.destinationId === buildingId
    && visit.status !== 'scheduled' && visit.status !== 'ended');
  if (!visits.length) return '';
  const visit = visits[0];
  const label = visit.kind === 'petition' ? 'PETITIONERS AT CIVIC HALL'
    : visit.kind === 'meeting' ? 'RATEPAYERS GATHERING'
      : visit.kind === 'support' ? 'A PATRON IS SPEAKING HERE' : 'AN OPPONENT IS SPEAKING HERE';
  return `${label} · ${visit.arrivedIds.length}/${visit.actorIds.length} ARRIVED`;
}
