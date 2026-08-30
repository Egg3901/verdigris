// Calls made while the alderman is out in the ward.
//
// These are deliberately small, daily and tied to an address. A call does not
// push a pressure meter. It establishes a named civic relationship, gives the
// inspector of nuisances evidence for a real works case, or brings a real
// ratepayer into the next ward meeting. The larger simulation decides what
// follows from those facts.
import type { City } from './city';
import { MIN_PER_DAY, dayOf } from './clock';
import { fullName } from './souls';
import { activeMatters, recordWardContact, regardFor } from './matters';
import { activeOrderFor, expediteFiledOrder, worksNeededAt } from './works';

export type WardCallKind = 'hear' | 'inspect' | 'canvass';

export interface WardCall {
  tick: number;
  buildingId: number;
  kind: WardCallKind;
  soulId: number;
  favourable: boolean;
}

export interface WardRoundState {
  callsLeft: number;
  day: number;
  calls: WardCall[];
  /** An inspection remains evidence for three days. */
  inspectedUntil: Int32Array;
  revision: number;
}

export const CALLS_PER_DAY = 3;

export function newWardRounds(buildingCount: number): WardRoundState {
  return {
    callsLeft: CALLS_PER_DAY,
    day: 0,
    calls: [],
    inspectedUntil: new Int32Array(buildingCount),
    revision: 0,
  };
}

export function resetWardRounds(city: City): void {
  city.wardRounds.day = dayOf(city.tick);
  city.wardRounds.callsLeft = CALLS_PER_DAY;
  city.wardRounds.revision++;
}

function calledToday(city: City, buildingId: number): boolean {
  const start = Math.floor(city.tick / MIN_PER_DAY) * MIN_PER_DAY;
  return city.wardRounds.calls.some((call) => call.buildingId === buildingId && call.tick >= start);
}

function peopleAtAddress(city: City, buildingId: number): number[] {
  const b = city.buildings[buildingId];
  if (!b) return [];
  return b.occupants
    .filter((id) => city.souls[id]?.age >= 14 && city.souls[id].activity !== 'dead')
    .sort((a, bId) => city.souls[bId].grievance - city.souls[a].grievance || a - bId);
}

function ratepayersAtAddress(city: City, buildingId: number): number[] {
  const b = city.buildings[buildingId];
  if (!b) return [];
  const householdIds = new Set(b.householdIds);
  return b.occupants
    .filter((id) => {
      const soul = city.souls[id];
      return soul?.age >= 21 && soul.homeId === buildingId && householdIds.has(soul.householdId)
        && soul.activity !== 'dead';
    })
    .sort((a, bId) => {
      const ah = city.households[city.souls[a].householdId]?.standing ?? 0;
      const bh = city.households[city.souls[bId].householdId]?.standing ?? 0;
      return bh - ah || city.souls[bId].age - city.souls[a].age || a - bId;
    });
}

export function canMakeWardCall(city: City, kind: WardCallKind, buildingId: number): string | null {
  if (!city.buildings[buildingId]) return 'There is no such address.';
  if (city.wardRounds.callsLeft <= 0) return 'The ward book is full for today.';
  if (calledToday(city, buildingId)) return 'You have already called at this address today.';
  if (kind === 'hear' && !peopleAtAddress(city, buildingId).length) return 'No one answers just now.';
  if (kind === 'inspect' && !worksNeededAt(city, buildingId) && !activeOrderFor(city, buildingId)) {
    return 'No nuisance or structural defect calls for a return.';
  }
  if (kind === 'canvass' && !ratepayersAtAddress(city, buildingId).length) {
    return 'No ratepayer is at home just now.';
  }
  return null;
}

function remember(city: City, call: WardCall): void {
  city.wardRounds.calls.push(call);
  if (city.wardRounds.calls.length > 48) city.wardRounds.calls.splice(0, city.wardRounds.calls.length - 48);
  city.wardRounds.callsLeft--;
  city.wardRounds.revision++;
}

export function makeWardCall(city: City, kind: WardCallKind, buildingId: number): string | null {
  if (canMakeWardCall(city, kind, buildingId)) return null;
  const b = city.buildings[buildingId];

  if (kind === 'hear') {
    const matter = activeMatters(city.matters).find((item) => item.target.id === buildingId);
    const people = peopleAtAddress(city, buildingId);
    const soulId = matter?.partyIds.find((id) => people.includes(id)) ?? people[0];
    const soul = city.souls[soulId];
    recordWardContact(city, soulId, 1, matter?.id ?? -1, false);
    remember(city, { tick: city.tick, buildingId, kind, soulId, favourable: true });
    return `${fullName(soul)} is heard at ${b.name}. The account goes into the ward book under their own name.`;
  }

  if (kind === 'inspect') {
    const defect = worksNeededAt(city, buildingId) ?? activeOrderFor(city, buildingId)?.kind ?? 'fabric';
    city.wardRounds.inspectedUntil[buildingId] = city.tick + 3 * MIN_PER_DAY;
    const order = activeOrderFor(city, buildingId);
    if (order) {
      order.inspected = true;
      expediteFiledOrder(city, order.id, city.tick + 60);
      city.works.revision++;
    }
    remember(city, { tick: city.tick, buildingId, kind, soulId: -1, favourable: true });
    const subject = defect === 'drain' ? 'the defective drain' : defect === 'gas' ? 'the failed gas service' : 'the unsound fabric';
    return `The inspector of nuisances makes a return on ${subject} at ${b.name}. Any works case now has an official view behind it.`;
  }

  const soulId = ratepayersAtAddress(city, buildingId)[0];
  const soul = city.souls[soulId];
  const previous = regardFor(city, soulId);
  const caseForChair = city.matters.standing - city.traced * 25;
  const resistance = Math.max(260, soul.grievance - 80 + (previous < 0 ? 120 : 0));
  const favourable = caseForChair >= resistance;
  recordWardContact(city, soulId, favourable ? 1 : -1, -1, true);
  remember(city, { tick: city.tick, buildingId, kind, soulId, favourable });
  return favourable
    ? `${fullName(soul)} gives a pledge at the door and will be reckoned at the next ratepayers' meeting.`
    : `${fullName(soul)} refuses a pledge at the door and means to speak against the chair.`;
}

export function wardCallSummary(city: City, buildingId: number): string {
  const call = [...city.wardRounds.calls].reverse().find((item) => item.buildingId === buildingId);
  if (!call) return '';
  const age = city.tick - call.tick;
  if (age >= 3 * MIN_PER_DAY) return '';
  if (call.kind === 'inspect') {
    const days = Math.max(0, Math.ceil((city.wardRounds.inspectedUntil[buildingId] - city.tick) / MIN_PER_DAY));
    return `WARD BOOK · PREMISES VIEWED · RETURN GOOD FOR ${days} DAY${days === 1 ? '' : 'S'}`;
  }
  const who = city.souls[call.soulId];
  return who ? `WARD BOOK · ${call.kind === 'hear' ? 'ACCOUNT HEARD FROM' : call.favourable ? 'PLEDGE GIVEN BY' : 'PLEDGE REFUSED BY'} ${fullName(who).toUpperCase()}` : '';
}
