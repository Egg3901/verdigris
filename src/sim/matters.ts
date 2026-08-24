// Matters before the alderman.
//
// The simulation used to generate hundreds of facts and then wait for the player
// to invent a reason to care about one. Matters reverse that relationship: named
// residents bring a real condition to the desk, the player may investigate and
// answer it, and the ledger records what the simulation eventually did.
//
// A matter is never a random quest. Its cause, deadline and verdict are all read
// from existing city state. Pressing the suggested button is not success: a works
// case can still be skimmed, a strike can still be cleared, and a refuge only
// counts if somebody physically reaches it.
import type { City } from './city';
import { MIN_PER_DAY, dayOf } from './clock';
import { DEFS } from './buildings';
import { fullName } from './souls';
import { isRunning, isStruck } from './firms';
import { pressureOf } from './pressures';
import { serviceAt } from './networks';
import { activeOrderFor, expediteFiledOrder, latestOrderFor, worksNeededAt } from './works';
import { isWetWeather, weatherAt, weatherLabel, WEATHER_WATCH_MINUTES } from './weather';
import type { BuildingId, FirmId, InterventionKind, SoulId, Target } from './types';
import {
  nextVisitTime, pendingMeetingVisit, reinforceMeetingVisit, scheduleCivicVisit,
} from './civic-visits';

export type MatterKind = 'repair' | 'labour' | 'refuge' | 'sanitation' | 'inquiry' | 'turnout';
export type MatterStatus = 'open' | 'pending' | 'kept' | 'failed' | 'declined' | 'overtaken';

export interface Matter {
  id: number;
  kind: MatterKind;
  status: MatterStatus;
  openedAt: number;
  dueAt: number;
  respondedAt: number;
  resolvedAt: number;
  target: Target;
  /** Firm or weather-watch id, depending on kind. */
  subjectId: number;
  /** Kind-specific starting count, credibility, or threshold. */
  baseline: number;
  /** Exact order, claim, soul, or street used to judge the chosen response. */
  evidenceId: number;
  partyIds: SoulId[];
  title: string;
  petition: string;
  cause: string;
  test: string;
  response: InterventionKind | null;
  /** One further use of influence while the city is still deciding. */
  pressedAt: number;
  /** When at least one named petitioner physically reached Civic Hall. */
  presentedAt: number;
  standingDelta: number;
  outcome: string;
}

export interface CivicRelation {
  soulId: SoulId;
  /** -2..2. Positive is a patron; negative is estranged. */
  regard: number;
  since: number;
  lastMatterId: number;
  /** Last time this citizen physically spoke for or against the chair. */
  lastActAt: number;
}

export interface RatepayerMeeting {
  tick: number;
  outcome: 'carried' | 'divided' | 'lost';
  standing: number;
  supporterId: SoulId;
  opponentId: SoulId;
  exposedActs: number;
  influenceCap: number;
  attendeeIds: SoulId[];
  text: string;
}

export interface MatterState {
  items: Matter[];
  nextId: number;
  /** Political standing, not a moral score. Kept local promises move it. */
  standing: number;
  relations: CivicRelation[];
  nextMeetingAt: number;
  influenceCap: number;
  meetings: RatepayerMeeting[];
  revision: number;
}

const MAX_ACTIVE = 3;
const KEPT_DELTA = 25;
const FAILED_DELTA = -18;
const DECLINED_DELTA = -6;
export const MEETING_PERIOD = 7 * 1440;
export const FIRST_MEETING_AT = MEETING_PERIOD + 480;

export function newMatters(): MatterState {
  return {
    items: [], nextId: 0, standing: 500, relations: [],
    nextMeetingAt: FIRST_MEETING_AT, influenceCap: 3, meetings: [], revision: 0,
  };
}

export function activeMatters(state: MatterState): Matter[] {
  return state.items.filter((m) => m.status === 'open' || m.status === 'pending');
}

function hasActive(state: MatterState, kind: MatterKind, targetId: number): boolean {
  return activeMatters(state).some((m) => m.kind === kind && m.target.id === targetId);
}

function recentlyHeard(state: MatterState, kind: MatterKind, targetId: number, tick: number): boolean {
  return state.items.some((m) => m.kind === kind && m.target.id === targetId && tick - m.openedAt < 3 * 1440);
}

function addMatter(city: City, matter: Omit<Matter, 'id' | 'status' | 'respondedAt' | 'resolvedAt' | 'response' | 'pressedAt' | 'presentedAt' | 'baseline' | 'evidenceId' | 'standingDelta' | 'outcome'>): Matter {
  const added: Matter = {
    ...matter,
    id: city.matters.nextId++,
    status: 'open',
    respondedAt: -1,
    resolvedAt: -1,
    response: null,
    pressedAt: -1,
    presentedAt: -1,
    baseline: 0,
    evidenceId: -1,
    standingDelta: 0,
    outcome: '',
  };
  city.matters.items.push(added);
  // The ledger is bounded. Resolved entries are history, not an unbounded save.
  if (city.matters.items.length > 24) {
    const firstResolved = city.matters.items.findIndex((m) => !['open', 'pending'].includes(m.status));
    if (firstResolved >= 0) city.matters.items.splice(firstResolved, 1);
  }
  city.matters.revision++;
  if (added.kind !== 'turnout') {
    scheduleCivicVisit(city, 'petition', added.partyIds, nextVisitTime(city.tick, 420), added.id);
  }
  return added;
}

function residentParties(city: City, buildingId: BuildingId, limit = 3): SoulId[] {
  const b = city.buildings[buildingId];
  if (!b) return [];
  return b.householdIds
    .flatMap((id) => city.households[id]?.memberIds ?? [])
    .filter((id) => city.souls[id] && city.souls[id].age >= 14)
    .sort((a, bId) => city.souls[bId].grievance - city.souls[a].grievance || a - bId)
    .slice(0, limit);
}

function names(city: City, ids: SoulId[]): string {
  const shown = ids.map((id) => fullName(city.souls[id]));
  if (shown.length < 2) return shown[0] ?? 'The residents';
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

function openRepair(city: City): boolean {
  const candidate = city.buildings
    .filter((b) => b.householdIds.length > 0 && worksNeededAt(city, b.id))
    .filter((b) => !hasActive(city.matters, 'repair', b.id)
      && !recentlyHeard(city.matters, 'repair', b.id, city.tick))
    .sort((a, b) => a.fabric - b.fabric || b.householdIds.length - a.householdIds.length || a.id - b.id)[0];
  if (!candidate) return false;
  const parties = residentParties(city, candidate.id);
  const need = worksNeededAt(city, candidate.id) ?? 'fabric';
  const street = city.streets[candidate.streetId]?.name ?? city.squareName;
  const defect = need === 'fabric' ? 'failing fabric' : need === 'drain' ? 'failed drains' : 'a failed gas main';
  const matter = addMatter(city, {
    kind: 'repair',
    openedAt: city.tick,
    dueAt: city.tick + 2 * 1440,
    target: { kind: 'building', id: candidate.id },
    subjectId: candidate.id,
    partyIds: parties,
    title: `${street}: a house that will not wait`,
    petition: `${names(city, parties)} ask the hall to answer ${candidate.name}'s ${defect}.`,
    cause: `Fabric ${candidate.fabric}/1000; treasury ${pressureOf(city.press, 'coin')}/1000; civic rot ${pressureOf(city.press, 'rot')}/1000.`,
    test: 'A real repair must be completed. A number, scaffold or fresh paint is not enough.',
  });
  // Competence is not punished. If the address was already in the register,
  // the new petition attaches to that exact live order instead of demanding a
  // duplicate button press.
  const order = activeOrderFor(city, candidate.id);
  if (order) {
    matter.status = 'pending';
    matter.respondedAt = order.filedAt;
    matter.response = 'fileWorks';
    matter.subjectId = order.id;
  }
  return true;
}

function averageGrievance(city: City, workerIds: SoulId[]): number {
  if (!workerIds.length) return 0;
  return Math.round(workerIds.reduce((sum, id) => sum + city.souls[id].grievance, 0) / workerIds.length);
}

function openLabour(city: City): boolean {
  const candidate = city.firms
    .filter((f) => f.workerIds.length >= 4 && !isStruck(f, city.tick) && isRunning(f, city.tick))
    .filter((f) => !hasActive(city.matters, 'labour', f.buildingId)
      && !recentlyHeard(city.matters, 'labour', f.buildingId, city.tick))
    .map((firm) => ({ firm, grievance: averageGrievance(city, firm.workerIds) }))
    // A petition arrives before a crisis. At 360 the default district produced
    // no labour matter until several bad days had already passed, so the desk
    // opened as a one-button repair tutorial instead of a choice.
    .filter((item) => item.grievance >= 230)
    .sort((a, b) => b.grievance - a.grievance || b.firm.workerIds.length - a.firm.workerIds.length || a.firm.id - b.firm.id)[0];
  if (!candidate) return false;
  const parties = candidate.firm.workerIds
    .slice()
    .sort((a, b) => city.souls[b].grievance - city.souls[a].grievance || a - b)
    .slice(0, 3);
  addMatter(city, {
    kind: 'labour',
    openedAt: city.tick,
    dueAt: city.tick + 1440,
    target: { kind: 'building', id: candidate.firm.buildingId },
    subjectId: candidate.firm.id,
    partyIds: parties,
    title: `${candidate.firm.name}: the hands want an answer`,
    petition: `${names(city, parties)} ask for backing before the next rent falls due.`,
    cause: `${candidate.firm.workerIds.length} hands average ${candidate.grievance}/1000 grievance; treasury ${pressureOf(city.press, 'coin')}/1000.`,
    test: 'Their stoppage must hold beyond the constables\' first attempt to clear it.',
  });
  return true;
}

function nextWetWatch(city: City): number {
  // Give the player six hours' notice. A watch already under way at the 3AM
  // accounts could otherwise expire while the opening warp was still running.
  for (let tick = city.tick + 360; tick <= city.tick + 1440; tick += 60) {
    if (isWetWeather(weatherAt(city.seed, tick))) return Math.floor(tick / WEATHER_WATCH_MINUTES);
  }
  return -1;
}

function openRefuge(city: City): boolean {
  const watch = nextWetWatch(city);
  if (watch < 0) return false;
  const providers = city.buildings
    .filter((b) => b.kind === 'chapel' || b.kind === 'bathhouse' || b.kind === 'dispensary' || b.kind === 'townhall')
    .filter((b) => !hasActive(city.matters, 'refuge', b.id)
      && !recentlyHeard(city.matters, 'refuge', b.id, city.tick))
    .map((b) => {
      const gas = !DEFS[b.kind].needsGas || serviceAt(city.networks.gas, b.id);
      const drains = !DEFS[b.kind].needsDrain || serviceAt(city.networks.drain, b.id);
      return { b, safe: Number(gas) + Number(drains), room: DEFS[b.kind].capacity - b.occupants.length, gas, drains };
    })
    .filter((item) => item.room > 0)
    .sort((a, b) => b.safe - a.safe || b.room - a.room || a.b.id - b.b.id);
  const provider = providers[0];
  if (!provider) return false;
  const vulnerable = city.souls
    .filter((s) => s.age < 14 || s.health < 560 || s.warmth < 460)
    .sort((a, b) => a.health - b.health || a.age - b.age || a.id - b.id)
    .slice(0, 3)
    .map((s) => s.id);
  const watchTick = watch * WEATHER_WATCH_MINUTES;
  const weather = weatherAt(city.seed, watchTick);
  addMatter(city, {
    kind: 'refuge',
    openedAt: city.tick,
    dueAt: watchTick + WEATHER_WATCH_MINUTES,
    target: { kind: 'building', id: provider.b.id },
    subjectId: watch,
    partyIds: vulnerable,
    title: `${weatherLabel(weather)}: a public door`,
    petition: `${names(city, vulnerable)} are among those who will need a dry room when the weather turns.`,
    cause: `${provider.b.name} has room for ${provider.room}; gas ${provider.gas ? 'served' : 'failed'}; drains ${provider.drains ? 'served' : 'failed'}.`,
    test: 'Open the refuge while the rain is falling, and somebody vulnerable must reach it.',
  });
  return true;
}

function sickOnStreet(city: City, streetId: number): SoulId[] {
  return city.souls
    .filter((soul) => city.buildings[soul.homeId]?.streetId === streetId && soul.health < 500)
    .sort((a, b) => a.health - b.health || a.id - b.id)
    .map((soul) => soul.id);
}

function openSanitation(city: City): boolean {
  const candidate = city.streets
    .map((street) => {
      const sick = sickOnStreet(city, street.id);
      const buildings = city.buildings.filter((building) => building.streetId === street.id && building.householdIds.length > 0);
      const drain = buildings.find((building) => worksNeededAt(city, building.id) === 'drain');
      const target = drain ?? city.buildings[city.souls[sick[0]]?.homeId];
      return { street, sick, target };
    })
    .filter((item) => item.sick.length >= 2 && item.target
      && !hasActive(city.matters, 'sanitation', item.target.id)
      && !recentlyHeard(city.matters, 'sanitation', item.target.id, city.tick))
    .sort((a, b) => b.sick.length - a.sick.length || a.street.id - b.street.id)[0];
  if (!candidate?.target) return false;
  const parties = candidate.sick
    .map((id) => city.souls[id])
    .filter((soul) => soul.age >= 14)
    .slice(0, 3)
    .map((soul) => soul.id);
  if (!parties.length) {
    const adult = city.souls.find((soul) => city.buildings[soul.homeId]?.streetId === candidate.street.id && soul.age >= 18);
    if (adult) parties.push(adult.id);
  }
  const matter = addMatter(city, {
    kind: 'sanitation', openedAt: city.tick, dueAt: city.tick + 720,
    target: { kind: 'building', id: candidate.target.id }, subjectId: candidate.street.id,
    partyIds: parties,
    title: `${candidate.street.name}: sickness behind the doors`,
    petition: `${names(city, parties)} ask the hall to contain sickness before another household takes ill.`,
    cause: `${candidate.sick.length} residents on the street are below 500 health; drains at ${candidate.target.name} ${serviceAt(city.networks.drain, candidate.target.id) ? 'are served' : 'have failed'}.`,
    test: 'After six hours, no more residents may be sick; a completed drain repair also keeps the promise.',
  });
  matter.baseline = candidate.sick.length;
  return true;
}

function openInquiry(city: City): boolean {
  const incident = city.incidents.live
    .filter((item) => item.defId === 'inquiry' || item.defId === 'riot' || item.defId === 'outbreak')
    .filter((item) => item.soulIds.some((id) => city.souls[id]?.age >= 18))
    .filter((item) => item.placeId >= 0 && !hasActive(city.matters, 'inquiry', item.placeId)
      && !recentlyHeard(city.matters, 'inquiry', item.placeId, city.tick))
    .sort((a, b) => b.tick - a.tick || b.id - a.id)[0];
  if (!incident) return false;
  const parties = incident.soulIds
    .filter((id) => city.souls[id]?.age >= 18)
    .sort((a, b) => city.souls[b].boldness - city.souls[a].boldness || a - b)
    .slice(0, 3);
  if (!parties.length) {
    const clerk = city.souls.find((soul) => soul.trade === 'clerk' || soul.trade === 'constable');
    if (clerk) parties.push(clerk.id);
  }
  if (!parties.length) return false;
  const matter = addMatter(city, {
    kind: 'inquiry', openedAt: city.tick, dueAt: city.tick + 1440,
    target: { kind: 'building', id: incident.placeId }, subjectId: incident.id,
    partyIds: parties,
    title: `${city.buildings[incident.placeId]?.name ?? 'The hall'}: an account will be printed`,
    petition: `${names(city, parties)} ask which account of the incident will stand before the inquiry closes.`,
    cause: `${incident.defId} was witnessed here by ${incident.soulIds.length}; paper credibility ${city.paperCredibility}/1000; suspicion ${pressureOf(city.press, 'suspicion')}/1000.`,
    test: 'A named detention must still hold after an hour, or a credible account must remain in the paper.',
  });
  matter.baseline = city.paperCredibility;
  return true;
}

function openTurnout(city: City): boolean {
  const visit = pendingMeetingVisit(city);
  if (!visit || visit.startsAt - city.tick > 360) return false;
  const hall = city.buildingsByKind.get('townhall')?.[0] ?? -1;
  if (hall < 0 || hasActive(city.matters, 'turnout', hall)
    || recentlyHeard(city.matters, 'turnout', hall, city.tick)) return false;
  const related = visit.actorIds
    .filter((id) => regardFor(city, id) !== 0)
    .slice(0, 3);
  const parties = related.length ? related : visit.actorIds.slice(0, 3);
  const matter = addMatter(city, {
    kind: 'turnout', openedAt: city.tick, dueAt: city.matters.nextMeetingAt,
    target: { kind: 'building', id: hall }, subjectId: city.matters.nextMeetingAt,
    partyIds: parties,
    title: `${city.squareName}: confidence will be counted`,
    petition: `${names(city, parties)} ask the chair to bring enough friends into the square to carry confidence.`,
    cause: `${visit.actorIds.length} ratepayers are called; standing ${city.matters.standing}/1000; ${city.matters.relations.filter((item) => item.regard < 0).length} named opponents remain.`,
    test: 'Confidence must actually carry when the people present are counted.',
  });
  matter.baseline = visit.actorIds.length;
  return true;
}

/** Called after the dead-hour accounts. Some days genuinely produce fewer matters. */
export function openDailyMatters(city: City): void {
  if (activeMatters(city.matters).length >= MAX_ACTIVE) return;
  // Acute witnessed business is heard before the recurring works and wage rolls.
  // Otherwise those dependable petitions occupy every seat and the living city
  // can be visibly sick without ever putting sanitation on the alderman's desk.
  for (const open of [openTurnout, openInquiry, openSanitation, openRepair, openLabour, openRefuge]) {
    if (activeMatters(city.matters).length >= MAX_ACTIVE) break;
    open(city);
  }
}

function resolve(city: City, matter: Matter, status: Extract<MatterStatus, 'kept' | 'failed'>, outcome: string): void {
  matter.status = status;
  matter.resolvedAt = city.tick;
  matter.outcome = outcome;
  matter.standingDelta = status === 'kept' ? KEPT_DELTA : FAILED_DELTA;
  city.matters.standing = Math.max(0, Math.min(1000, city.matters.standing + matter.standingDelta));
  for (const soulId of matter.partyIds) adjustRegard(city, soulId, status === 'kept' ? 1 : -1, matter.id);
  schedulePoliticalReaction(city, matter, status === 'kept' ? 'support' : 'opposition');
  city.matters.revision++;
  city.log.push({ tick: city.tick, text: outcome, kind: status === 'kept' ? 'gain' : 'loss' });
  if (city.log.length > 200) city.log.splice(0, city.log.length - 200);
}

function overtake(city: City, matter: Matter, outcome: string): void {
  matter.status = 'overtaken';
  matter.resolvedAt = city.tick;
  matter.outcome = outcome;
  city.matters.revision++;
  city.log.push({ tick: city.tick, text: outcome, kind: 'info' });
  if (city.log.length > 200) city.log.splice(0, city.log.length - 200);
}

function adjustRegard(city: City, soulId: SoulId, delta: number, matterId: number): void {
  if (!city.souls[soulId]) return;
  let relation = city.matters.relations.find((item) => item.soulId === soulId);
  if (!relation) {
    relation = { soulId, regard: 0, since: city.tick, lastMatterId: matterId, lastActAt: -1 };
    city.matters.relations.push(relation);
  }
  const before = relation.regard;
  relation.regard = Math.max(-2, Math.min(2, relation.regard + delta));
  relation.lastMatterId = matterId;
  if (before === 0 && relation.regard !== 0) relation.since = city.tick;
  // The relationship ledger is bounded, preferring people who still care.
  if (city.matters.relations.length > 40) {
    city.matters.relations.sort((a, b) => Math.abs(b.regard) - Math.abs(a.regard) || b.since - a.since || a.soulId - b.soulId);
    city.matters.relations.length = 40;
  }
}

function schedulePoliticalReaction(city: City, matter: Matter, kind: 'support' | 'opposition'): void {
  const actor = matter.partyIds
    .map((id) => city.souls[id])
    .filter((soul) => soul?.age >= 18 && soul.activity !== 'dead')
    .sort((a, b) => {
      const ar = regardFor(city, a.id);
      const br = regardFor(city, b.id);
      return kind === 'support' ? br - ar || b.boldness - a.boldness || a.id - b.id
        : ar - br || b.boldness - a.boldness || a.id - b.id;
    })[0];
  if (!actor) return;
  const wanted = kind === 'support' ? 'newspaper' : 'pub';
  const destination = city.buildingsByKind.get(wanted)?.[0]
    ?? city.buildingsByKind.get(kind === 'support' ? 'pub' : 'newspaper')?.[0]
    ?? city.buildingsByKind.get('townhall')?.[0]
    ?? -1;
  scheduleCivicVisit(city, kind, [actor.id], nextVisitTime(city.tick, 1080), matter.id, destination);
}

export function regardFor(city: City, soulId: SoulId): number {
  return city.matters.relations.find((item) => item.soulId === soulId)?.regard ?? 0;
}

/** Match an intervention to a petition. The eventual verdict still comes from state. */
export function noteMatterResponse(city: City, kind: InterventionKind, target: Target): void {
  const matches = activeMatters(city.matters).filter((m) => {
    if (m.status !== 'open') return false;
    if (m.kind === 'repair') return (kind === 'fileWorks' || kind === 'callDeputation') && target.id === m.target.id;
    if (m.kind === 'labour') {
      return kind === 'fundStrike' && (target.id === m.target.id || target.id === m.subjectId);
    }
    if (m.kind === 'refuge') return kind === 'openShelter' && target.id === m.target.id;
    if (m.kind === 'sanitation') {
      return (kind === 'quarantine' || kind === 'fileWorks') && target.id === m.target.id;
    }
    if (m.kind === 'inquiry') {
      const relatedClaim = target.kind === 'claim'
        && m.partyIds.some((id) => city.souls[id]?.beliefs.some((belief) => belief.claimId === target.id));
      const relatedSoul = target.kind === 'soul' && m.partyIds.includes(target.id);
      return (kind === 'plantStory' && (relatedClaim || relatedSoul)) || (kind === 'tipOff'
        && (target.id === m.target.id || relatedSoul));
    }
    return m.kind === 'turnout' && (kind === 'fundBunting'
      || (kind === 'tipOff' && m.partyIds.includes(target.id)));
  });
  for (const matter of matches) {
    if (matter.kind === 'repair') {
      // fileWorks creates the order before this hook runs. Bind the promise to
      // that exact case so later work at the same address cannot claim its credit.
      matter.subjectId = latestOrderFor(city, matter.target.id)?.id ?? matter.subjectId;
    }
    if (matter.kind === 'sanitation') {
      matter.evidenceId = kind === 'fileWorks'
        ? latestOrderFor(city, matter.target.id)?.id ?? -1
        : city.buildings[matter.target.id]?.streetId ?? -1;
    }
    if (matter.kind === 'inquiry') {
      matter.evidenceId = kind === 'plantStory'
        ? target.kind === 'claim' ? target.id : city.souls[target.id]?.beliefs[0]?.claimId ?? -1
        : target.kind === 'soul' ? target.id : -1;
    }
    if (matter.kind === 'turnout' && kind === 'fundBunting') reinforceMeetingVisit(city);
    matter.status = 'pending';
    matter.respondedAt = city.tick;
    matter.response = kind;
    city.matters.revision++;
  }
}

/** A free political choice. Declining saves influence and costs only local standing. */
export function declineMatter(city: City, id: number): boolean {
  const matter = city.matters.items.find((m) => m.id === id);
  if (!matter || matter.status !== 'open') return false;
  matter.status = 'declined';
  matter.resolvedAt = city.tick;
  matter.outcome = `${matter.title} was declined without an answer.`;
  matter.standingDelta = DECLINED_DELTA;
  city.matters.standing = Math.max(0, city.matters.standing + matter.standingDelta);
  if (matter.partyIds[0] !== undefined) adjustRegard(city, matter.partyIds[0], -1, matter.id);
  schedulePoliticalReaction(city, matter, 'opposition');
  city.matters.revision++;
  city.log.push({ tick: city.tick, text: matter.outcome, kind: 'loss' });
  if (city.log.length > 200) city.log.splice(0, city.log.length - 200);
  return true;
}

export function canPressMatter(city: City, id: number): string | null {
  const matter = city.matters.items.find((item) => item.id === id);
  if (!matter || matter.status !== 'pending') return 'Only a pending promise can be pressed.';
  if (matter.kind === 'inquiry' || (matter.kind === 'sanitation' && matter.response !== 'fileWorks')) {
    return 'There is no clerk who can press this kind of promise.';
  }
  if (matter.pressedAt >= 0) return 'This matter has already been pressed.';
  if (city.budgetLeft <= 0) return 'No influence remains today.';
  return null;
}

/** Spend one further influence to lean on the institution already holding it. */
export function pressMatter(city: City, id: number): boolean {
  if (canPressMatter(city, id)) return false;
  const matter = city.matters.items.find((item) => item.id === id) as Matter;
  city.budgetLeft--;
  matter.pressedAt = city.tick;
  if (matter.kind === 'repair') {
    const order = city.works.orders[matter.subjectId];
    if (order) {
      order.pressed = true;
      expediteFiledOrder(city, order.id, city.tick + 60);
    }
  } else if (matter.kind === 'labour') {
    const firm = city.firms[matter.subjectId as FirmId];
    if (firm) firm.strikeUntil = Math.max(firm.strikeUntil, matter.respondedAt + 1440);
  } else if (matter.kind === 'refuge') {
    const shelter = city.shelters.current;
    if (shelter?.providerId === matter.target.id) shelter.endsAt += 180;
  } else if (matter.kind === 'sanitation') {
    const order = city.works.orders[matter.evidenceId];
    if (order) {
      order.pressed = true;
      expediteFiledOrder(city, order.id, city.tick + 60);
    }
  } else if (matter.kind === 'turnout') {
    reinforceMeetingVisit(city);
  }
  matter.outcome = 'A clerk has been sent after it. The extra attention will be noticed.';
  city.matters.revision++;
  city.log.push({ tick: city.tick, text: `${matter.title}: the alderman pressed the matter.`, kind: 'info' });
  if (city.log.length > 200) city.log.splice(0, city.log.length - 200);
  return true;
}

/**
 * Every seventh dawn, named ratepayers test whether the chair can still move
 * the ward. Losing narrows next week's influence, but the chair and the city
 * remain in play and the vote can reverse at the next meeting.
 */
function mobilisedRelations(city: City): CivicRelation[] {
  const previous = city.matters.meetings.at(-1)?.tick ?? 0;
  return city.matters.relations.filter((item) => {
    const matter = city.matters.items.find((candidate) => candidate.id === item.lastMatterId);
    const heardAt = matter ? Math.max(matter.openedAt, matter.resolvedAt) : -1;
    return heardAt >= previous && city.souls[item.soulId]?.age >= 18;
  });
}

export function scheduleRatepayerSitting(city: City): boolean {
  if (city.tick >= city.matters.nextMeetingAt) return false;
  if (city.matters.nextMeetingAt - city.tick >= MIN_PER_DAY) return false;
  if (city.civicVisits.visits.some((visit) => visit.kind === 'meeting' && visit.status !== 'ended')) return false;
  const related = mobilisedRelations(city).map((item) => item.soulId);
  const relatedSet = new Set(related);
  const otherAdults = city.souls
    .filter((soul) => soul.age >= 18 && soul.activity !== 'dead' && !relatedSet.has(soul.id))
    .sort((a, b) => (city.households[b.householdId]?.standing ?? 0) - (city.households[a.householdId]?.standing ?? 0)
      || b.boldness - a.boldness || a.id - b.id)
    .slice(0, Math.max(0, 8 - related.length))
    .map((soul) => soul.id);
  return Boolean(scheduleCivicVisit(city, 'meeting', related.concat(otherAdults).slice(0, 8), city.matters.nextMeetingAt - 45));
}

export function holdRatepayerMeeting(city: City, attendeeIds?: SoulId[]): boolean {
  if (city.tick < city.matters.nextMeetingAt) return false;
  const previous = city.matters.meetings.at(-1)?.tick ?? 0;
  const present = attendeeIds ? new Set(attendeeIds) : null;
  const mobilised = mobilisedRelations(city).filter((item) => !present || present.has(item.soulId));
  const supporters = mobilised
    .filter((item) => item.regard > 0)
    .sort((a, b) => b.regard - a.regard || a.since - b.since || a.soulId - b.soulId);
  const opponents = mobilised
    .filter((item) => item.regard < 0)
    .sort((a, b) => a.regard - b.regard || a.since - b.since || a.soulId - b.soulId);
  const support = supporters.reduce((sum, item) => sum + item.regard, 0);
  const opposition = opponents.reduce((sum, item) => sum + Math.abs(item.regard), 0);
  const exposedActs = city.nudges.filter((nudge) =>
    nudge.tick >= previous && nudge.tick < city.tick && nudge.exposure === 'deniable' && nudge.traced).length;
  const attendanceMargin = attendeeIds ? (attendeeIds.length - 6) * 10 : 0;
  const margin = city.matters.standing - 500 + (support - opposition) * 20
    - exposedActs * 45 + attendanceMargin;
  const thin = Boolean(attendeeIds && attendeeIds.length < 2);
  const outcome: RatepayerMeeting['outcome'] = thin ? 'divided'
    : margin >= 35 ? 'carried' : margin <= -35 ? 'lost' : 'divided';
  const influenceCap = outcome === 'carried' ? 4 : outcome === 'lost' ? 2 : 3;
  const supporterId = supporters[0]?.soulId ?? -1;
  const opponentId = opponents[0]?.soulId ?? -1;
  const supporter = supporterId >= 0 ? fullName(city.souls[supporterId]) : 'No established patron';
  const opponent = opponentId >= 0 ? fullName(city.souls[opponentId]) : 'No established opponent';
  const standingAfter = Math.round((city.matters.standing * 4 + 500) / 5);
  const dividedText = supporterId < 0 && opponentId < 0
    ? 'No named ratepayer could carry the room. The chair keeps three measures each day.'
    : `${supporter} and ${opponent} left the room divided. The chair keeps three measures each day.`;
  const verdict = outcome === 'carried'
    ? `${supporter} spoke for the chair. The ratepayers carried confidence; four measures may be moved each day.`
    : outcome === 'lost'
      ? `${opponent} spoke against the chair. Confidence was lost; only two measures may be moved each day.`
      : dividedText;
  const attendance = attendeeIds ? `${attendeeIds.length} ratepayers reached the square. ` : '';
  const text = `${attendance}${verdict} Older business recedes; standing opens at ${standingAfter}/1000.`;
  const oldCap = city.matters.influenceCap;
  const spentToday = Math.max(0, oldCap - city.budgetLeft);
  city.matters.meetings.push({
    tick: city.tick, outcome, standing: city.matters.standing,
    supporterId, opponentId, exposedActs, influenceCap, attendeeIds: attendeeIds?.slice() ?? [], text,
  });
  if (city.matters.meetings.length > 8) city.matters.meetings.shift();
  city.matters.influenceCap = influenceCap;
  city.budgetLeft = Math.max(0, influenceCap - spentToday);
  city.matters.standing = standingAfter;
  do city.matters.nextMeetingAt += MEETING_PERIOD;
  while (city.matters.nextMeetingAt <= city.tick);
  city.matters.revision++;
  city.log.push({ tick: city.tick, text, kind: outcome === 'carried' ? 'gain' : outcome === 'lost' ? 'loss' : 'info' });
  if (city.log.length > 200) city.log.splice(0, city.log.length - 200);
  return true;
}

/** Resolve promises against the world, once a minute. */
export function tickMatters(city: City): void {
  for (const matter of activeMatters(city.matters)) {
    if (matter.status === 'open' && matter.kind === 'repair'
      && (!city.buildings[matter.target.id] || !worksNeededAt(city, matter.target.id))) {
      overtake(city, matter, `${matter.title}: events overtook the petition before the desk answered it.`);
      continue;
    }
    if (matter.status === 'open' && matter.kind === 'labour') {
      const firm = city.firms[matter.subjectId as FirmId];
      if (!firm || firm.workerIds.length < 4 || isStruck(firm, city.tick)
        || averageGrievance(city, firm.workerIds) < 180) {
        overtake(city, matter, `${matter.title}: events overtook the petition before the desk answered it.`);
        continue;
      }
    }
    if (matter.status === 'open' && matter.kind === 'sanitation'
      && sickOnStreet(city, matter.subjectId).length === 0) {
      overtake(city, matter, `${matter.title}: the sickness passed before the desk answered it.`);
      continue;
    }
    if (matter.kind === 'repair' && matter.status === 'pending') {
      const order = city.works.orders[matter.subjectId];
      if (order?.status === 'completed') {
        resolve(city, matter, 'kept', `${matter.title}: the repair was actually made.`);
        continue;
      }
      if (order?.status === 'skimmed' || order?.status === 'shelved') {
        resolve(city, matter, 'failed', `${matter.title}: the case ended in ${order.status === 'skimmed' ? 'fresh paint and the same defect' : 'the shelf'}.`);
        continue;
      }
    }
    if (matter.kind === 'labour' && matter.status === 'pending') {
      const firm = city.firms[matter.subjectId as FirmId];
      const contestAt = matter.respondedAt + 240;
      if (city.tick < contestAt) continue;
      if (firm && firm.strikeUntil > contestAt) {
        resolve(city, matter, 'kept', `${matter.title}: the stoppage held, and the hands know who backed it.`);
        continue;
      }
      if (city.tick >= contestAt) {
        resolve(city, matter, 'failed', `${matter.title}: the picket was cleared before it could hold.`);
        continue;
      }
    }
    if (matter.kind === 'refuge' && matter.status === 'pending') {
      const shelter = city.shelters.current;
      if (shelter?.providerId === matter.target.id && shelter.relievedIds.length > 0) {
        resolve(city, matter, 'kept', `${matter.title}: ${shelter.relievedIds.length} people reached the refuge and were helped.`);
        continue;
      }
    }
    if (matter.kind === 'sanitation' && matter.status === 'pending') {
      if (matter.response === 'fileWorks') {
        const order = city.works.orders[matter.evidenceId];
        if (order?.status === 'completed') {
          resolve(city, matter, 'kept', `${matter.title}: the failed drain was put back into service.`);
          continue;
        }
        if (order?.status === 'skimmed' || order?.status === 'shelved') {
          resolve(city, matter, 'failed', `${matter.title}: the works case did not restore the drain.`);
          continue;
        }
      } else if (city.tick >= matter.respondedAt + 360) {
        const sick = sickOnStreet(city, matter.subjectId).length;
        resolve(city, matter, sick <= matter.baseline ? 'kept' : 'failed', sick <= matter.baseline
          ? `${matter.title}: the cordon held the sickness to ${sick} residents.`
          : `${matter.title}: ${sick} residents are now sick despite the cordon.`);
        continue;
      }
    }
    if (matter.kind === 'inquiry' && matter.status === 'pending' && city.tick >= matter.respondedAt + 60) {
      const held = matter.response === 'tipOff' && matter.evidenceId >= 0
        && city.souls[matter.evidenceId]?.activity === 'held';
      const claim = matter.response === 'plantStory' && matter.evidenceId >= 0
        ? city.claims.claims[matter.evidenceId] : null;
      const printed = Boolean(claim && claim.salience >= 900 && city.paperCredibility >= matter.baseline - 100);
      resolve(city, matter, held || printed ? 'kept' : 'failed', held
        ? `${matter.title}: the named witness was still held when the clerk closed the file.`
        : printed ? `${matter.title}: a credible account remained in print.`
          : `${matter.title}: neither a detention nor a credible printed account survived.`);
      continue;
    }
    if (matter.kind === 'turnout') {
      const meeting = city.matters.meetings.find((item) => item.tick === matter.subjectId);
      if (meeting) {
        resolve(city, matter, meeting.outcome === 'carried' ? 'kept' : 'failed', meeting.outcome === 'carried'
          ? `${matter.title}: confidence carried with ${meeting.attendeeIds.length} ratepayers physically present.`
          : `${matter.title}: the room was ${meeting.outcome}; ${meeting.attendeeIds.length} ratepayers reached the square.`);
        continue;
      }
    }
    if (city.tick >= matter.dueAt) {
      resolve(city, matter, 'failed', `${matter.title}: the deadline passed before the promise was kept.`);
    }
  }
}

export function matterDay(matter: Matter): number {
  return dayOf(matter.dueAt);
}

export function matterInsight(city: City, matter: Matter): string {
  const patron = matter.partyIds.find((id) => regardFor(city, id) > 0);
  if (patron === undefined) return '';
  const who = fullName(city.souls[patron]);
  if (matter.kind === 'repair') {
    const b = city.buildings[matter.target.id];
    const pneumatic = Boolean(b && b.postSeg >= 0 && serviceAt(city.networks.post, b.id));
    const sound = pressureOf(city.press, 'coin') >= 360 && pressureOf(city.press, 'rot') < 520;
    return `${who} says the case will travel ${pneumatic ? 'by pneumatic post' : 'by hand'}; ${sound ? 'the money and the hall look sound' : 'either the money or the hall looks doubtful'}.`;
  }
  if (matter.kind === 'labour') {
    return `${who} says the first four hours will decide it; ${pressureOf(city.press, 'coin') < 320 ? 'the hall is ready to clear the gate' : 'the hall can afford to let the hands stand'}.`;
  }
  if (matter.kind === 'sanitation') {
    const sick = sickOnStreet(city, matter.subjectId).length;
    return `${who} has counted ${sick} sick residents now, against ${matter.baseline} when the petition opened.`;
  }
  if (matter.kind === 'inquiry') {
    return `${who} says the paper stands at ${city.paperCredibility}/1000 credibility; a false first-hand story will be retracted.`;
  }
  if (matter.kind === 'turnout') {
    const visit = pendingMeetingVisit(city);
    return `${who} expects ${visit?.actorIds.length ?? 0} named ratepayers to set out for the square.`;
  }
  const b = city.buildings[matter.target.id];
  const gas = b && (!DEFS[b.kind].needsGas || serviceAt(city.networks.gas, b.id));
  const drains = b && (!DEFS[b.kind].needsDrain || serviceAt(city.networks.drain, b.id));
  return `${who} has looked at the room: heat ${gas ? 'served' : 'failed'}, drains ${drains ? 'served' : 'failed'}.`;
}

export function recommendedFor(matter: Matter): InterventionKind[] {
  if (matter.kind === 'repair') return ['fileWorks', 'callDeputation', 'fundBunting'];
  if (matter.kind === 'labour') return ['fundStrike', 'tipOff', 'rumour', 'plantStory'];
  if (matter.kind === 'refuge') return ['openShelter', 'quarantine', 'delayTram'];
  if (matter.kind === 'sanitation') return ['quarantine', 'fileWorks'];
  if (matter.kind === 'inquiry') return ['tipOff', 'plantStory'];
  return ['fundBunting', 'tipOff'];
}
