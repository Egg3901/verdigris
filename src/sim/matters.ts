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
import { DAILY_MINUTE, dayOf } from './clock';
import { DEFS } from './buildings';
import { fullName } from './souls';
import { isRunning, isStruck } from './firms';
import { pressureOf } from './pressures';
import { serviceAt } from './networks';
import { activeOrderFor, expediteFiledOrder, latestOrderFor, worksNeededAt } from './works';
import { isWetWeather, weatherAt, weatherLabel, WEATHER_WATCH_MINUTES } from './weather';
import type { BuildingId, FirmId, InterventionKind, SoulId, Target } from './types';

export type MatterKind = 'repair' | 'labour' | 'refuge';
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
  partyIds: SoulId[];
  title: string;
  petition: string;
  cause: string;
  test: string;
  response: InterventionKind | null;
  /** One further use of influence while the city is still deciding. */
  pressedAt: number;
  standingDelta: number;
  outcome: string;
}

export interface CivicRelation {
  soulId: SoulId;
  /** -2..2. Positive is a patron; negative is estranged. */
  regard: number;
  since: number;
  lastMatterId: number;
}

export interface RatepayerMeeting {
  tick: number;
  outcome: 'carried' | 'divided' | 'lost';
  standing: number;
  supporterId: SoulId;
  opponentId: SoulId;
  exposedActs: number;
  influenceCap: number;
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
export const FIRST_MEETING_AT = MEETING_PERIOD + DAILY_MINUTE;

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

function addMatter(city: City, matter: Omit<Matter, 'id' | 'status' | 'respondedAt' | 'resolvedAt' | 'response' | 'pressedAt' | 'standingDelta' | 'outcome'>): Matter {
  const added: Matter = {
    ...matter,
    id: city.matters.nextId++,
    status: 'open',
    respondedAt: -1,
    resolvedAt: -1,
    response: null,
    pressedAt: -1,
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

/** Called after the dead-hour accounts. Some days genuinely produce fewer matters. */
export function openDailyMatters(city: City): void {
  if (activeMatters(city.matters).length >= MAX_ACTIVE) return;
  for (const open of [openRepair, openLabour, openRefuge]) {
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
    relation = { soulId, regard: 0, since: city.tick, lastMatterId: matterId };
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

export function regardFor(city: City, soulId: SoulId): number {
  return city.matters.relations.find((item) => item.soulId === soulId)?.regard ?? 0;
}

/** Match an intervention to a petition. The eventual verdict still comes from state. */
export function noteMatterResponse(city: City, kind: InterventionKind, target: Target): void {
  const matter = activeMatters(city.matters).find((m) => {
    if (m.status !== 'open') return false;
    if (m.kind === 'repair') return (kind === 'fileWorks' || kind === 'callDeputation') && target.id === m.target.id;
    if (m.kind === 'labour') {
      return kind === 'fundStrike' && (target.id === m.target.id || target.id === m.subjectId);
    }
    return kind === 'openShelter' && target.id === m.target.id;
  });
  if (!matter) return;
  if (matter.kind === 'repair') {
    // fileWorks creates the order before this hook runs. Bind the promise to
    // that exact case so later work at the same address cannot claim its credit.
    matter.subjectId = latestOrderFor(city, matter.target.id)?.id ?? matter.subjectId;
  }
  matter.status = 'pending';
  matter.respondedAt = city.tick;
  matter.response = kind;
  city.matters.revision++;
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
  city.matters.revision++;
  city.log.push({ tick: city.tick, text: matter.outcome, kind: 'loss' });
  if (city.log.length > 200) city.log.splice(0, city.log.length - 200);
  return true;
}

export function canPressMatter(city: City, id: number): string | null {
  const matter = city.matters.items.find((item) => item.id === id);
  if (!matter || matter.status !== 'pending') return 'Only a pending promise can be pressed.';
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
  } else {
    const shelter = city.shelters.current;
    if (shelter?.providerId === matter.target.id) shelter.endsAt += 180;
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
export function holdRatepayerMeeting(city: City): boolean {
  if (city.tick < city.matters.nextMeetingAt) return false;
  const previous = city.matters.meetings.at(-1)?.tick ?? 0;
  const mobilisedThisTerm = (item: CivicRelation): boolean => {
    const matter = city.matters.items.find((candidate) => candidate.id === item.lastMatterId);
    const heardAt = matter ? Math.max(matter.openedAt, matter.resolvedAt) : -1;
    return heardAt >= previous && city.souls[item.soulId]?.age >= 18;
  };
  const supporters = city.matters.relations
    .filter((item) => item.regard > 0 && mobilisedThisTerm(item))
    .sort((a, b) => b.regard - a.regard || a.since - b.since || a.soulId - b.soulId);
  const opponents = city.matters.relations
    .filter((item) => item.regard < 0 && mobilisedThisTerm(item))
    .sort((a, b) => a.regard - b.regard || a.since - b.since || a.soulId - b.soulId);
  const support = supporters.reduce((sum, item) => sum + item.regard, 0);
  const opposition = opponents.reduce((sum, item) => sum + Math.abs(item.regard), 0);
  const exposedActs = city.nudges.filter((nudge) =>
    nudge.tick >= previous && nudge.tick < city.tick && nudge.exposure === 'deniable' && nudge.traced).length;
  const margin = city.matters.standing - 500 + (support - opposition) * 20 - exposedActs * 45;
  const outcome: RatepayerMeeting['outcome'] = margin >= 60 ? 'carried' : margin <= -60 ? 'lost' : 'divided';
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
  const text = `${verdict} Older business recedes; standing opens at ${standingAfter}/1000.`;
  city.matters.meetings.push({
    tick: city.tick, outcome, standing: city.matters.standing,
    supporterId, opponentId, exposedActs, influenceCap, text,
  });
  if (city.matters.meetings.length > 8) city.matters.meetings.shift();
  city.matters.influenceCap = influenceCap;
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
  const b = city.buildings[matter.target.id];
  const gas = b && (!DEFS[b.kind].needsGas || serviceAt(city.networks.gas, b.id));
  const drains = b && (!DEFS[b.kind].needsDrain || serviceAt(city.networks.drain, b.id));
  return `${who} has looked at the room: heat ${gas ? 'served' : 'failed'}, drains ${drains ? 'served' : 'failed'}.`;
}

export function recommendedFor(matter: Matter): InterventionKind[] {
  if (matter.kind === 'repair') return ['fileWorks', 'callDeputation', 'fundBunting'];
  if (matter.kind === 'labour') return ['fundStrike', 'tipOff', 'rumour', 'plantStory'];
  return ['openShelter', 'quarantine', 'delayTram'];
}
