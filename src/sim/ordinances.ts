// Named ordinances, and the rule that keeps them honest.
//
// HARD RULE: a law must never be a direct pressure poke. If curfew were
// applyPressure('mood', -40) the game would be a slider board. It changes a
// specific rule that specific souls read when they decide to leave the house,
// a specific set of people stay in or go out anyway, and the pressures move as
// a CONSEQUENCE of that, reported by the hourly pass. Unenforced is a real
// outcome: the constables are on a schedule, rot decides whether an order to
// turn out is actually carried, and a curfew written for after their shift is
// a dead letter you can watch from above.
//
// BACKFIRES ARE STATE CONDITIONS, NOT DICE. Every ordinance has a documented
// world state under which it does the opposite of what you wanted, or does
// nothing while still costing somebody. A player who learns the state can
// predict the backfire.
import type { City } from './city';
import { pushLog, sendTo } from './city';
import { applyPressure, pressureOf } from './pressures';
import { connectBuilding, disconnectBuilding } from './networks';
import { seedClaim, implant } from './claims';
import { emit } from './events';
import { mix, Stream } from './rng';
import { minuteOfDay, MIN_PER_DAY } from './clock';
import type { Activity, BuildingId, OrdinanceKind, SoulId } from './types';
import type { Soul } from './souls';
import type { Building } from './buildings';

export const ORDINANCE_KINDS: readonly OrdinanceKind[] = [
  'curfew', 'licensingHours', 'cartBylaw', 'drainageAct', 'dogTax',
  'pewRents', 'breadAssize', 'childLabour', 'inspectorPowers', 'publicOrder',
];

export const IDX: Record<OrdinanceKind, number> = {
  curfew: 0, licensingHours: 1, cartBylaw: 2, drainageAct: 3, dogTax: 4,
  pewRents: 5, breadAssize: 6, childLabour: 7, inspectorPowers: 8, publicOrder: 9,
};

export interface OrdinanceDef {
  kind: OrdinanceKind;
  label: string;
  blurb: string;
  /** Integer parameter: a closing minute, a fee in farthings, a street id. */
  defaultParam: number;
  /** What that integer MEANS, so the vestry can render a control for it rather
   *  than a bare number. Descriptive metadata: the sim never reads it. */
  param?: ParamSpec;
}

export interface ParamSpec {
  /** hour: a minute of the day. fee: farthings. street: a street id, chosen by
   *  clicking a building. none: the ordinance takes no setting. */
  kind: 'hour' | 'fee' | 'street' | 'none';
  label: string;
  min: number;
  max: number;
  step: number;
}

const PARAM: Partial<Record<OrdinanceKind, ParamSpec>> = {
  curfew: { kind: 'hour', label: 'From', min: 1020, max: 1380, step: 30 },
  licensingHours: { kind: 'hour', label: 'Last orders', min: 1140, max: 1410, step: 30 },
  childLabour: { kind: 'hour', label: 'Off by', min: 600, max: 1020, step: 60 },
  dogTax: { kind: 'fee', label: 'Fee', min: 1, max: 16, step: 1 },
  pewRents: { kind: 'fee', label: 'Rent', min: 2, max: 24, step: 2 },
  cartBylaw: { kind: 'street', label: 'Street', min: -1, max: 999, step: 1 },
};

export function paramSpecOf(kind: OrdinanceKind): ParamSpec {
  return PARAM[kind] ?? { kind: 'none', label: '', min: 0, max: 0, step: 0 };
}

export interface Ordinance {
  kind: OrdinanceKind;
  inForce: 0 | 1;
  enactedTick: number;
  param: number;
  /** 1 when rot packed the vestry at the sitting. The mechanism is then the
   *  corrupt one documented on the def, not a milder version of the real one. */
  captured: 0 | 1;
  enforced: number;
  breached: number;
}

export interface Act {
  tick: number;
  kind: OrdinanceKind;
  /** 1 passed, 0 repealed. */
  enact: 0 | 1;
  param: number;
}

export interface Petition {
  kind: OrdinanceKind;
  /** 1 want it passed, 0 want it repealed. */
  want: 0 | 1;
  mover: SoulId;
  supporters: number;
  bornTick: number;
}

export const FACTIONS = ['vestry', 'chapel', 'victuallers', 'mill', 'courts'] as const;
export type FactionId = 0 | 1 | 2 | 3 | 4;

export interface LawState {
  slots: Ordinance[];
  acts: Act[];
  vestry: SoulId[];
  petitions: Petition[];
  keepsDog: Uint8Array;
  publicanOf: Int16Array;
  shopkeeperOf: Int16Array;
  condemnedUntil: Int32Array;
  shebeenId: number;
  breadStashId: number;
  curateId: number;
  enforcement: number;
  lastSat: number;
  factionGrievance: Int16Array;
  pendingKind: number;
  pendingParam: number;
  pendingRepeal: 0 | 1;
  active: number;
}

export const ORDINANCES: readonly OrdinanceDef[] = [
  {
    kind: 'curfew',
    label: 'the curfew',
    blurb: 'Persons found abroad after the hour may be turned back, if constables are actually on the beat.',
    defaultParam: 1200,
  },
  {
    kind: 'licensingHours',
    label: 'the licensing hours',
    blurb: 'Public houses cease serving at the hour. A publican may obey, keep a lock-in, or send custom to a shebeen.',
    defaultParam: 1260,
  },
  {
    kind: 'cartBylaw',
    label: 'the cart bylaw',
    blurb: 'Heavy carts are excluded from one named street. Carriers take the longer road and shop deliveries wait.',
    defaultParam: -1,
  },
  {
    kind: 'drainageAct',
    label: 'the drainage act',
    blurb: 'Court dwellings are to be put on the mains. The rate may be collected before the pipe is laid.',
    defaultParam: 1,
  },
  {
    kind: 'dogTax',
    label: 'the dog tax',
    blurb: 'A daily rate is charged upon every household keeping a dog. Default brings seizure and sale.',
    defaultParam: 4,
  },
  {
    kind: 'pewRents',
    label: 'pew rents',
    blurb: 'Seats in chapel are let by the week. Empty pews may enrich the roof fund and still leave the poor outside.',
    defaultParam: 8,
  },
  {
    kind: 'breadAssize',
    label: 'the bread assize',
    blurb: 'The four-pound loaf has a fixed price. Licensed shops comply; illicit stock moves through warehouses.',
    defaultParam: 1,
  },
  {
    kind: 'childLabour',
    label: 'the half-time act',
    blurb: 'Young persons must leave the mill at the appointed hour and may not be kept upon deliveries.',
    defaultParam: 780,
  },
  {
    kind: 'inspectorPowers',
    label: 'the inspector of nuisances',
    blurb: 'The inspector of nuisances may enter premises, make a return, and seek a notice to abate. Which doors he enters remains the question.',
    defaultParam: 1,
  },
  {
    kind: 'publicOrder',
    label: 'the public order act',
    blurb: 'An assembly of five may be dispersed. Pickets, lock-out gatherings, and the square after closing all count.',
    defaultParam: 5,
  },
];

function clamp(v: number): number {
  return v < 0 ? 0 : v > 1000 ? 1000 : Math.round(v);
}

function emptySlot(kind: OrdinanceKind): Ordinance {
  return {
    kind, inForce: 0, enactedTick: -1, param: 0, captured: 0, enforced: 0, breached: 0,
  };
}

export function newLaws(city: City): LawState {
  const n = city.souls.length;
  const bN = city.buildings.length;
  const slots: Ordinance[] = [];
  for (let i = 0; i < ORDINANCE_KINDS.length; i++) slots.push(emptySlot(ORDINANCE_KINDS[i]));

  const keepsDog = new Uint8Array(n);
  for (const s of city.souls) {
    if (s.age < 14 || s.age > 70) continue;
    const home = city.buildings[s.homeId];
    if (!home || (home.kind !== 'villa' && home.kind !== 'terrace')) continue;
    if (mix(city.seed, Stream.Law, 1, s.id) % 5 === 0) keepsDog[s.id] = 1;
  }

  const publicanOf = new Int16Array(bN).fill(-1);
  const shopkeeperOf = new Int16Array(bN).fill(-1);
  let curateId = -1;
  for (const s of city.souls) {
    if (s.trade === 'publican' && s.workId >= 0) publicanOf[s.workId] = s.id;
    if (s.trade === 'shopkeeper' && s.workId >= 0) shopkeeperOf[s.workId] = s.id;
    if (s.trade === 'curate' && curateId < 0) curateId = s.id;
  }

  const vestry: SoulId[] = [];
  for (const s of city.souls) {
    if (s.trade === 'alderman' || s.trade === 'curate') vestry.push(s.id);
  }
  for (const h of city.households) {
    if (vestry.length >= 9) break;
    const home = city.buildings[h.buildingId];
    if (!home || home.kind !== 'villa') continue;
    const head = h.memberIds[0];
    if (head === undefined) continue;
    let seen = false;
    for (let i = 0; i < vestry.length; i++) if (vestry[i] === head) { seen = true; break; }
    if (!seen) vestry.push(head);
  }

  const condemnedUntil = new Int32Array(bN).fill(-1);

  // The courts were never put on the mains. That is the geography the drainage
  // act exists to change: a specific set of buildings, not a sanitation slider.
  for (const b of city.buildings) {
    if (b.kind !== 'courtdwelling') continue;
    disconnectBuilding(city.networks.drain, b.id);
    b.drainSeg = -1;
  }

  const petitions: Petition[] = [];
  for (let i = 0; i < 8; i++) {
    petitions.push({ kind: 'curfew', want: 0, mover: -1, supporters: 0, bornTick: -1 });
  }

  return {
    slots, acts: [], vestry, petitions, keepsDog, publicanOf, shopkeeperOf,
    condemnedUntil, shebeenId: -1, breadStashId: -1, curateId, enforcement: 400,
    lastSat: -1, factionGrievance: new Int16Array(FACTIONS.length),
    pendingKind: -1, pendingParam: 0, pendingRepeal: 0, active: 0,
  };
}

export function inForce(city: City, kind: OrdinanceKind): boolean {
  const i = IDX[kind];
  return i !== undefined && city.laws.slots[i].inForce === 1;
}

export function ordinanceOf(city: City, kind: OrdinanceKind): Ordinance {
  return city.laws.slots[IDX[kind]];
}

export function canEnact(city: City, kind: OrdinanceKind): string | null {
  const i = IDX[kind];
  if (i === undefined) return 'No such ordinance.';
  if (city.laws.slots[i].inForce) return 'That is already in force.';
  if (satToday(city)) return 'The council has already sat today.';
  return null;
}

export function canRepeal(city: City, kind: OrdinanceKind): string | null {
  const i = IDX[kind];
  if (i === undefined) return 'No such ordinance.';
  if (!city.laws.slots[i].inForce) return 'That is not in force.';
  if (satToday(city)) return 'The council has already sat today.';
  return null;
}

function satToday(city: City): boolean {
  if (city.laws.lastSat < 0) return false;
  return Math.floor(city.laws.lastSat / MIN_PER_DAY) === Math.floor(city.tick / MIN_PER_DAY);
}

/**
 * Compliance for this soul, this ordinance, this hour.
 *
 * Derived from traits and circumstances and the live enforcement number. Never
 * a stored cursor: mix(seed, Law, hour, soul*16+idx) is the whole of the draw.
 * Desperate households (rent arrears) and the people a law is aimed at (publicans
 * vs licensing, shopkeepers vs the assize) are less likely to go along.
 */
export function willComply(city: City, s: Soul, idx: number): boolean {
  const ord = city.laws.slots[idx];
  if (!ord.inForce) return true;
  if (s.trade === 'constable' && (idx === IDX.curfew || idx === IDX.publicOrder)) return true;
  const h = city.households[s.householdId];
  const desperate = h && h.arrearsDays > 0 ? 160 : 0;
  let will = Math.trunc(
    (s.piety * 3 + (1000 - s.boldness) * 3 + (1000 - s.grievance) * 2 + s.credulity + s.literacy + city.laws.enforcement * 2) / 12,
  );
  will -= desperate;
  if (idx === IDX.licensingHours && s.trade === 'publican') will -= 200;
  if (idx === IDX.breadAssize && s.trade === 'shopkeeper') will -= 220;
  if (idx === IDX.childLabour && s.age >= 16 && h) {
    for (let i = 0; i < h.memberIds.length; i++) {
      const kid = city.souls[h.memberIds[i]];
      if (kid && kid.age < 16 && kid.trade !== 'child' && kid.trade !== 'none') { will -= 140; break; }
    }
  }
  if (will < 50) will = 50;
  if (will > 950) will = 950;
  const roll = mix(city.seed, Stream.Law, Math.floor(city.tick / 60), s.id * 16 + idx) % 1000;
  return roll < will;
}

/**
 * How well the district is policed.
 *
 * This counted only constables on the street THIS MINUTE, so it returned 0 for
 * every hour they were off shift, which is most of the day. Smoothing it then
 * dragged the whole number toward zero and made every ordinance a dead letter:
 * measured 1, then 169, then 18 over an afternoon.
 *
 * A law is enforced by an institution, not solely by whoever happens to be on a
 * corner. The force exists around the clock and its size and honesty set the
 * floor; who is actually out sets how much more than the floor you get. Rot
 * still eats it, which is the point: a rotten parish cannot enforce anything
 * however many constables it employs.
 */
function reportEnforcement(city: City): number {
  const rot = pressureOf(city.press, 'rot');
  let force = 0;
  let beat = 0;
  let station = 0;
  for (const s of city.souls) {
    if (s.trade !== 'constable') continue;
    force++;
    if (s.activity === 'asleep' || s.activity === 'held' || s.activity === 'dead') continue;
    if (s.activity === 'working') beat += 3;
    else if (s.inId < 0) beat += 2;
    else if (rot < 480) station += 1;
  }
  // The standing capacity of the force, whatever the hour.
  const institution = force * 110;
  const presence = beat * 70 + station * 30;
  return clamp(institution + presence - Math.trunc(rot * 0.6));
}

function townhallId(city: City): BuildingId {
  return city.buildingsByKind.get('townhall')?.[0] ?? 0;
}

function memberAye(city: City, s: Soul, idx: number): boolean {
  const kind = ORDINANCE_KINDS[idx];
  const home = city.buildings[s.homeId];
  switch (kind) {
    case 'curfew':
    case 'licensingHours':
    case 'publicOrder':
      if (s.trade === 'publican') return false;
      return s.piety > 480 || s.trade === 'alderman' || s.trade === 'curate' || s.trade === 'constable';
    case 'cartBylaw':
      if (s.trade === 'docker' || s.trade === 'lighterman') return false;
      return s.trade === 'alderman' || (!!home && home.kind === 'villa');
    case 'drainageAct':
    case 'inspectorPowers':
      return s.trade === 'alderman' || s.trade === 'nurse' || s.trade === 'curate' || s.health < 620;
    case 'dogTax':
      if (s.trade === 'alderman') return true;
      return city.laws.keepsDog[s.id] === 0 && (s.trade === 'curate' || s.piety > 400);
    case 'pewRents':
      return s.trade === 'curate' || s.trade === 'alderman' || s.piety > 700;
    case 'breadAssize':
      if (s.trade === 'shopkeeper') return false;
      return s.trade === 'alderman' || s.trade === 'curate' || s.grievance > 500;
    case 'childLabour':
      return s.trade === 'curate' || s.piety > 560 || s.trade === 'alderman';
    default:
      return s.piety > 500;
  }
}

function sitVestry(city: City, idx: number): boolean {
  const members = city.laws.vestry;
  if (!members.length) return true;
  const packed = pressureOf(city.press, 'rot') > 580;
  let aye = 0;
  let nay = 0;
  let villaAye = 0;
  let villaN = 0;
  for (let i = 0; i < members.length; i++) {
    const s = city.souls[members[i]];
    if (!s) continue;
    const yes = memberAye(city, s, idx);
    const home = city.buildings[s.homeId];
    if (home && home.kind === 'villa') {
      villaN++;
      if (yes) villaAye++;
    }
    if (yes) aye++; else nay++;
  }
  if (packed && villaN > 0) return villaAye * 2 >= villaN;
  return aye >= nay;
}

export function enact(city: City, kind: OrdinanceKind, param?: number): boolean {
  const why = canEnact(city, kind);
  if (why) return false;
  const idx = IDX[kind];
  const def = ORDINANCES[idx];
  const p = param === undefined ? def.defaultParam : (param | 0);
  city.laws.acts.push({ tick: city.tick, kind, enact: 1, param: p });
  const aye = sitVestry(city, idx);
  city.laws.lastSat = city.tick;
  if (!aye) {
    pushLog(city, `The council rejected ${def.label}. A petition is being got up against the decision.`, 'info');
    queuePetition(city, kind, 1, city.laws.vestry[0] ?? 0);
    return false;
  }
  const rot = pressureOf(city.press, 'rot');
  const coin = pressureOf(city.press, 'coin');
  const captured: 0 | 1 = (rot > 580 || (kind === 'drainageAct' && coin < 280)) ? 1 : 0;
  const slot = city.laws.slots[idx];
  slot.inForce = 1;
  slot.enactedTick = city.tick;
  slot.param = captured && kind === 'curfew' ? Math.max(p, 1380) : p;
  slot.captured = captured;
  slot.enforced = 0;
  slot.breached = 0;
  city.laws.active++;
  applyImmediate(city, idx);
  seedResentment(city, idx);
  emit(city.events, 'ordinance', townhallId(city), city.laws.vestry, 400, city.tick);
  if (captured) {
    pushLog(city, `${def.label} passed, but the packed council altered the minute to suit itself.`, 'loss');
  } else {
    pushLog(city, `${def.label} is in force.`, 'info');
  }
  return true;
}

export function repeal(city: City, kind: OrdinanceKind): boolean {
  const why = canRepeal(city, kind);
  if (why) return false;
  const idx = IDX[kind];
  const def = ORDINANCES[idx];
  const slot = city.laws.slots[idx];
  city.laws.acts.push({ tick: city.tick, kind, enact: 0, param: slot.param });
  city.laws.lastSat = city.tick;
  for (let i = 0; i < city.laws.vestry.length; i++) {
    const s = city.souls[city.laws.vestry[i]];
    if (s && memberAye(city, s, idx)) s.grievance = clamp(s.grievance + 25);
  }
  slot.inForce = 0;
  slot.enactedTick = -1;
  slot.captured = 0;
  city.laws.active = Math.max(0, city.laws.active - 1);
  if (kind === 'licensingHours') city.laws.shebeenId = -1;
  if (kind === 'breadAssize') city.laws.breadStashId = -1;
  pushLog(city, `${def.label} is repealed.`, 'gain');
  return true;
}

export function propose(city: City, kind: OrdinanceKind, param?: number): boolean {
  const i = IDX[kind];
  if (i === undefined) return false;
  city.laws.pendingKind = i;
  city.laws.pendingParam = param === undefined ? ORDINANCES[i].defaultParam : (param | 0);
  city.laws.pendingRepeal = 0;
  return true;
}

export function sitPending(city: City): void {
  if (city.laws.pendingKind < 0) return;
  const kind = ORDINANCE_KINDS[city.laws.pendingKind];
  const param = city.laws.pendingParam;
  const wantRepeal = city.laws.pendingRepeal;
  city.laws.pendingKind = -1;
  if (wantRepeal) repeal(city, kind);
  else enact(city, kind, param);
}

function applyImmediate(city: City, idx: number): void {
  const kind = ORDINANCE_KINDS[idx];
  const slot = city.laws.slots[idx];
  switch (kind) {
    case 'drainageAct':
      applyDrainage(city, slot.captured === 1);
      break;
    case 'licensingHours':
      city.laws.shebeenId = pickHideout(city, 41);
      break;
    case 'breadAssize':
      city.laws.breadStashId = pickHideout(city, 42);
      break;
    case 'inspectorPowers':
      condemnWorst(city, slot.captured === 1);
      break;
    case 'cartBylaw':
      if (slot.param < 0) slot.param = defaultCartStreet(city, slot.captured === 1);
      break;
    default:
      break;
  }
}

function pickHideout(city: City, salt: number): BuildingId {
  const kinds = ['warehouse', 'courtdwelling', 'wharfshed', 'lodging'] as const;
  for (let k = 0; k < kinds.length; k++) {
    const list = city.buildingsByKind.get(kinds[k]);
    if (!list || !list.length) continue;
    return list[mix(city.seed, Stream.Law, salt, 0) % list.length];
  }
  return -1;
}

function defaultCartStreet(city: City, captured: boolean): number {
  if (captured) {
    for (const b of city.buildings) {
      if (b.kind === 'courtdwelling' && b.streetId >= 0) return b.streetId;
    }
  }
  const hall = city.buildingsByKind.get('townhall')?.[0];
  if (hall !== undefined) return city.buildings[hall].streetId;
  return 0;
}

function applyDrainage(city: City, captured: boolean): void {
  let charged = 0;
  let connected = 0;
  for (const h of city.households) {
    const home = city.buildings[h.buildingId];
    const fee = home && home.kind === 'courtdwelling' ? 12 : home && home.kind === 'tenement' ? 6 : 2;
    if (h.purse >= fee) h.purse -= fee;
    else { h.purse = 0; h.arrearsDays++; }
    charged++;
  }
  if (!captured) {
    for (const b of city.buildings) {
      if (b.kind !== 'courtdwelling') continue;
      if (b.doorNode < 0) continue;
      connectBuilding(city.networks.drain, b.id, b.doorNode);
      b.drainSeg = city.networks.drain.buildingSeg[b.id];
      b.fabric = clamp(b.fabric + 10);
      connected++;
    }
  }
  if (charged > 0) {
    const note = captured ? 'drainage rates, and no pipe laid' : 'drainage rates';
    applyPressure(city.press, 'coin', Math.min(80, charged), 'law', IDX.drainageAct, note, city.tick);
  }
  if (!captured && connected > 0) {
    applyPressure(city.press, 'coin', -Math.min(40, connected * 2), 'law', IDX.drainageAct, 'pipe laid to the courts', city.tick);
  }
}

function vestryProtects(city: City, b: Building): boolean {
  for (let i = 0; i < b.householdIds.length; i++) {
    const h = city.households[b.householdIds[i]];
    if (!h) continue;
    for (let m = 0; m < h.memberIds.length; m++) {
      const id = h.memberIds[m];
      for (let v = 0; v < city.laws.vestry.length; v++) {
        if (city.laws.vestry[v] === id) return true;
      }
    }
  }
  return false;
}

function condemnWorst(city: City, captured: boolean): void {
  let worst = -1;
  let worstFabric = 1e9;
  for (const b of city.buildings) {
    if (b.kind !== 'courtdwelling' && b.kind !== 'tenement' && b.kind !== 'lodging') continue;
    if (captured && vestryProtects(city, b)) continue;
    if (b.fabric < worstFabric) { worstFabric = b.fabric; worst = b.id; }
  }
  if (worst < 0) return;
  city.laws.condemnedUntil[worst] = city.tick + MIN_PER_DAY * 7;
  const b = city.buildings[worst];
  b.facade = Math.min(b.facade, 220);
  for (let i = 0; i < b.occupants.length; i++) {
    const s = city.souls[b.occupants[i]];
    if (s) s.grievance = clamp(s.grievance + 80);
  }
  if (pressureOf(city.press, 'sanitation') > 600) {
    applyPressure(city.press, 'mood', -80, 'law', worst, 'an inspection nobody asked for', city.tick);
  }
}

function hurtScore(city: City, s: Soul, idx: number): number {
  const kind = ORDINANCE_KINDS[idx];
  const home = city.buildings[s.homeId];
  switch (kind) {
    case 'curfew':
    case 'licensingHours':
      if (s.trade === 'publican') return 90;
      if (s.scheduleId === 0) return 40;
      return 0;
    case 'cartBylaw':
      if (s.trade === 'docker' || s.trade === 'lighterman') return 70;
      return 0;
    case 'drainageAct':
      if (home && home.kind === 'courtdwelling') return 40;
      return 0;
    case 'dogTax':
      return city.laws.keepsDog[s.id] ? 55 : 0;
    case 'pewRents':
      if (s.piety > 500 && s.purse < 40) return 60;
      return 0;
    case 'breadAssize':
      if (s.trade === 'shopkeeper') return 80;
      return 0;
    case 'childLabour': {
      if (s.age < 16 && s.trade !== 'child' && s.trade !== 'none') return 30;
      const h = city.households[s.householdId];
      if (!h) return 0;
      for (let i = 0; i < h.memberIds.length; i++) {
        if (city.souls[h.memberIds[i]].age < 16) return 45;
      }
      return 0;
    }
    case 'inspectorPowers':
      if (home && (home.kind === 'courtdwelling' || home.kind === 'tenement')) return 50;
      return 0;
    case 'publicOrder':
      if (s.grievance > 600) return 40;
      return 0;
    default:
      return 0;
  }
}

function seedResentment(city: City, idx: number): void {
  const hall = townhallId(city);
  const subject = city.laws.vestry[0] ?? 0;
  const claim = seedClaim(city.claims, 'bylaw', subject, -1, hall, 1, city.tick);
  let planted = 0;
  for (const s of city.souls) {
    const hurt = hurtScore(city, s, idx);
    if (hurt <= 0) continue;
    s.grievance = clamp(s.grievance + hurt);
    if (s.depth !== 'principal' || planted >= 24) continue;
    implant(city.claims, s, claim, 280 + hurt, -1, city.tick);
    planted++;
  }
}

function queuePetition(city: City, kind: OrdinanceKind, want: 0 | 1, mover: SoulId): Petition {
  let slot = city.laws.petitions[0];
  for (let i = 0; i < city.laws.petitions.length; i++) {
    const p = city.laws.petitions[i];
    if (p.kind === kind && p.want === want && p.supporters > 0) {
      p.supporters++;
      return p;
    }
    if (p.supporters === 0) slot = p;
  }
  slot.kind = kind;
  slot.want = want;
  slot.mover = mover;
  slot.supporters = 1;
  slot.bornTick = city.tick;
  return slot;
}

/**
 * Where a soul is allowed to go, given the laws in force. Called from beginBlock
 * for the handful of souls due that minute. No allocations.
 */
export function gateOrdinanceTarget(city: City, s: Soul, target: BuildingId, activity: Activity): BuildingId {
  const laws = city.laws;
  if (laws.active === 0) return target;
  const mod = minuteOfDay(city.tick);
  const slots = laws.slots;

  const child = slots[IDX.childLabour];
  if (child.inForce && !child.captured && s.age < 16 && s.workId >= 0
    && target === s.workId && mod >= child.param) {
    if (willComply(city, s, IDX.childLabour)) {
      s.arriveActivity = 'visiting';
      child.enforced++;
      return s.homeId;
    }
    child.breached++;
  }

  const curfew = slots[IDX.curfew];
  if (curfew.inForce && !curfew.captured && mod >= curfew.param && target !== s.homeId) {
    if (willComply(city, s, IDX.curfew)) {
      s.arriveActivity = 'visiting';
      curfew.enforced++;
      return s.homeId;
    }
    curfew.breached++;
  }

  const lic = slots[IDX.licensingHours];
  if (lic.inForce && !lic.captured && activity === 'drinking' && mod >= lic.param) {
    const dest = city.buildings[target];
    if (dest && dest.kind === 'pub') {
      const keeper = laws.publicanOf[target];
      const lockIn = keeper >= 0 && !willComply(city, city.souls[keeper], IDX.licensingHours);
      if (!lockIn) {
        if (willComply(city, s, IDX.licensingHours) || laws.shebeenId < 0) {
          s.arriveActivity = 'visiting';
          lic.enforced++;
          return s.homeId;
        }
        s.arriveActivity = 'drinking';
        lic.breached++;
        return laws.shebeenId;
      }
    }
  }

  const pew = slots[IDX.pewRents];
  if (pew.inForce && activity === 'worshipping' && s.purse < pew.param && willComply(city, s, IDX.pewRents)) {
    s.arriveActivity = 'visiting';
    pew.enforced++;
    return s.homeId;
  }

  const order = slots[IDX.publicOrder];
  if (order.inForce && !order.captured && activity === 'gathering') {
    if (willComply(city, s, IDX.publicOrder)) {
      s.arriveActivity = 'visiting';
      order.enforced++;
      return s.homeId;
    }
    order.breached++;
  }

  return target;
}

/**
 * Pure preview for the only laws that can prevent an outdoor gathering. The UI
 * asks this every frame, so it must not increment enforcement or mutate a soul.
 * `gateOrdinanceTarget` remains the authoritative, recorded check at dispatch.
 */
export function wouldAllowGathering(city: City, s: Soul, target: BuildingId): boolean {
  const laws = city.laws;
  if (laws.active === 0) return true;
  const mod = minuteOfDay(city.tick);
  const curfew = laws.slots[IDX.curfew];
  if (curfew.inForce && !curfew.captured && mod >= curfew.param && target !== s.homeId
    && willComply(city, s, IDX.curfew)) return false;
  const order = laws.slots[IDX.publicOrder];
  if (order.inForce && !order.captured && willComply(city, s, IDX.publicOrder)) return false;
  return true;
}

export function allowErrand(city: City, s: Soul, kind: 'pub' | 'shop', target: BuildingId): boolean {
  const laws = city.laws;
  if (laws.active === 0) return true;
  const mod = minuteOfDay(city.tick);
  const curfew = laws.slots[IDX.curfew];
  if (curfew.inForce && !curfew.captured && mod >= curfew.param) {
    if (willComply(city, s, IDX.curfew)) return false;
    curfew.breached++;
  }
  const child = laws.slots[IDX.childLabour];
  if (child.inForce && !child.captured && s.age < 14) {
    if (willComply(city, s, IDX.childLabour)) return false;
    child.breached++;
  }
  const lic = laws.slots[IDX.licensingHours];
  if (kind === 'pub' && lic.inForce && !lic.captured && mod >= lic.param) {
    const keeper = laws.publicanOf[target];
    const lockIn = keeper >= 0 && !willComply(city, city.souls[keeper], IDX.licensingHours);
    if (!lockIn && willComply(city, s, IDX.licensingHours)) return false;
  }
  return true;
}

export function cartRetarget(city: City, s: Soul, target: BuildingId): BuildingId {
  const cart = city.laws.slots[IDX.cartBylaw];
  if (!cart.inForce || cart.captured || cart.param < 0) return target;
  if (s.trade !== 'docker' && s.trade !== 'lighterman') return target;
  const b = city.buildings[target];
  if (!b || b.streetId !== cart.param) return target;
  if (!willComply(city, s, IDX.cartBylaw)) {
    cart.breached++;
    return target;
  }
  cart.enforced++;
  const fav = city.favourite.shop;
  if (fav && fav[s.id] >= 0 && city.buildings[fav[s.id]].streetId !== cart.param) return fav[s.id];
  const shops = city.buildingsByKind.get('shop');
  if (shops) {
    for (let i = 0; i < shops.length; i++) {
      if (city.buildings[shops[i]].streetId !== cart.param) return shops[i];
    }
  }
  return target;
}

export function cartExtraMinutes(city: City, s: Soul, target: BuildingId): number {
  const cart = city.laws.slots[IDX.cartBylaw];
  if (!cart.inForce || cart.captured || cart.param < 0) return 0;
  if (s.trade !== 'docker' && s.trade !== 'lighterman') return 0;
  const b = city.buildings[target];
  if (!b) return 0;
  if (b.streetId === cart.param) return 0;
  const origFav = city.favourite.shop ? city.favourite.shop[s.id] : -1;
  if (origFav >= 0 && city.buildings[origFav].streetId === cart.param && target !== origFav) return 24;
  return 0;
}

export function onOrdinanceArrive(city: City, s: Soul): void {
  if (city.laws.active === 0) return;
  if (s.inId < 0) return;
  const b = city.buildings[s.inId];
  if (!b) return;

  const pew = city.laws.slots[IDX.pewRents];
  if (pew.inForce && b.kind === 'chapel' && s.activity === 'worshipping') {
    const fee = pew.param;
    if (s.purse >= fee) {
      s.purse -= fee;
      if (pew.captured && city.laws.curateId >= 0) {
        city.souls[city.laws.curateId].purse += fee;
      } else {
        b.fabric = clamp(b.fabric + 1);
      }
    } else if (willComply(city, s, IDX.pewRents)) {
      sendTo(city, s, s.homeId, 'commuting', 'visiting');
      pew.enforced++;
    } else {
      pew.breached++;
    }
  }

  const lic = city.laws.slots[IDX.licensingHours];
  if (lic.inForce && !lic.captured && b.kind === 'pub' && (s.activity === 'drinking' || s.arriveActivity === 'drinking')) {
    const mod = minuteOfDay(city.tick);
    if (mod >= lic.param) {
      const keeper = city.laws.publicanOf[b.id];
      const lockIn = keeper >= 0 && !willComply(city, city.souls[keeper], IDX.licensingHours);
      if (!lockIn) {
        if (willComply(city, s, IDX.licensingHours) || city.laws.shebeenId < 0) {
          sendTo(city, s, s.homeId, 'errand', 'visiting');
          lic.enforced++;
        } else {
          sendTo(city, s, city.laws.shebeenId, 'errand', 'drinking');
          lic.breached++;
        }
      }
    }
  }

  const bread = city.laws.slots[IDX.breadAssize];
  if (bread.inForce && b.kind === 'shop' && s.activity === 'shopping') {
    const keeper = city.laws.shopkeeperOf[b.id];
    const honest = !bread.captured && (keeper < 0 || willComply(city, city.souls[keeper], IDX.breadAssize));
    if (honest) {
      s.hunger = clamp(s.hunger - 80);
      if (s.purse > 0) s.purse -= 1;
    } else if (s.boldness > 520 && city.laws.breadStashId >= 0 && city.laws.breadStashId !== b.id) {
      sendTo(city, s, city.laws.breadStashId, 'errand', 'shopping');
      bread.breached++;
    }
  }
}

export function tickOrdinancesHourly(city: City): void {
  const laws = city.laws;
  // Smoothed toward the instantaneous reading rather than snapped to it.
  //
  // Measured hour by hour over a day, the raw number ran 0, 549, 0, 0, 270, 551,
  // 271, 552: it is computed from which constables happen to be mid-shift at the
  // moment the hourly pass runs, so it flickers between "a dead letter" and
  // "kept after a fashion" and back within an hour. That is noise to read and
  // noise to play against. How well a district is policed is a level, and a level
  // is what this now reports, while still being driven entirely by who is
  // actually on the beat.
  const want = reportEnforcement(city);
  const have = laws.enforcement;
  // Seed on the first pass rather than ramping from zero: a district is not
  // unpoliced merely because the clock has just started.
  laws.enforcement = laws.lastSat < 0 && have === 0 && want > 0
    ? want
    : have + Math.trunc((want - have) / 2);
  if (laws.active === 0) return;
  const mod = minuteOfDay(city.tick);
  const slots = laws.slots;

  const lic = slots[IDX.licensingHours];
  if (lic.inForce && !lic.captured && mod >= lic.param) kickPubs(city);

  const curfew = slots[IDX.curfew];
  if (curfew.inForce && !curfew.captured && mod >= curfew.param) enforceCurfew(city);

  const bread = slots[IDX.breadAssize];
  if (bread.inForce && !bread.captured) {
    for (const f of city.firms) {
      if (f.kind !== 'shop') continue;
      const keeper = laws.shopkeeperOf[f.buildingId];
      if (keeper >= 0 && !willComply(city, city.souls[keeper], IDX.breadAssize)) continue;
      f.orders = clamp(f.orders - 8);
      f.margin = clamp(f.margin - 4);
    }
  }

  const cart = slots[IDX.cartBylaw];
  if (cart.inForce && !cart.captured && cart.param >= 0) {
    for (const f of city.firms) {
      const b = city.buildings[f.buildingId];
      if (!b || b.streetId !== cart.param) continue;
      if (f.kind === 'shop' || f.kind === 'wharf') f.orders = clamp(f.orders - 6);
    }
  }

  if (lic.inForce && !lic.captured) {
    for (const f of city.firms) {
      const b = city.buildings[f.buildingId];
      if (b && b.kind === 'pub') f.orders = clamp(f.orders - 5);
    }
  }

  const order = slots[IDX.publicOrder];
  if (order.inForce) enforcePublicOrder(city);

  const child = slots[IDX.childLabour];
  if (child.inForce && !child.captured && mod >= child.param) {
    for (const s of city.souls) {
      if (s.age >= 16 || s.workId < 0 || s.inId !== s.workId) continue;
      if (willComply(city, s, IDX.childLabour)) {
        sendTo(city, s, s.homeId, 'commuting', 'visiting');
        s.overrideUntil = city.tick + 90;
        child.enforced++;
      } else {
        child.breached++;
      }
    }
  }

  if (slots[IDX.inspectorPowers].inForce) inspectHourly(city);

  const dog = slots[IDX.dogTax];
  if (dog.inForce && mod === 600) collectDogTax(city);

  informersHourly(city);
}

function kickPubs(city: City): void {
  const lic = city.laws.slots[IDX.licensingHours];
  const pubs = city.buildingsByKind.get('pub');
  if (!pubs) return;
  for (let i = 0; i < pubs.length; i++) {
    const b = city.buildings[pubs[i]];
    const keeper = city.laws.publicanOf[b.id];
    const lockIn = keeper >= 0 && !willComply(city, city.souls[keeper], IDX.licensingHours);
    if (lockIn) continue;
    for (let o = b.occupants.length - 1; o >= 0; o--) {
      const s = city.souls[b.occupants[o]];
      if (!s || s.trade === 'publican') continue;
      if (s.activity !== 'drinking' && s.activity !== 'eating') continue;
      if (willComply(city, s, IDX.licensingHours) || city.laws.shebeenId < 0) {
        sendTo(city, s, s.homeId, 'errand', 'visiting');
        s.overrideUntil = city.tick + 40;
        lic.enforced++;
      } else {
        sendTo(city, s, city.laws.shebeenId, 'errand', 'drinking');
        s.overrideUntil = city.tick + 40;
        lic.breached++;
      }
    }
  }
}

function enforceCurfew(city: City): void {
  const curfew = city.laws.slots[IDX.curfew];
  const enf = city.laws.enforcement;
  let arrests = 0;
  const pubs = city.buildingsByKind.get('pub');
  if (pubs) {
    for (let i = 0; i < pubs.length; i++) {
      const b = city.buildings[pubs[i]];
      for (let o = b.occupants.length - 1; o >= 0; o--) {
        const s = city.souls[b.occupants[o]];
        if (!s || s.trade === 'publican') continue;
        if (willComply(city, s, IDX.curfew)) {
          sendTo(city, s, s.homeId, 'commuting', 'visiting');
          s.overrideUntil = city.tick + 50;
          curfew.enforced++;
        } else {
          curfew.breached++;
        }
      }
    }
  }
  for (const s of city.souls) {
    if (s.inId >= 0) continue;
    if (s.trade === 'constable' || s.trade === 'lamplighter') continue;
    if (s.activity === 'held' || s.activity === 'dead') continue;
    if (willComply(city, s, IDX.curfew)) {
      sendTo(city, s, s.homeId, 'commuting', 'visiting');
      s.overrideUntil = city.tick + 50;
      curfew.enforced++;
    } else {
      curfew.breached++;
      if (enf > 520 && arrests < 2) {
        s.activity = 'held';
        s.overrideUntil = city.tick + 180;
        s.inId = city.favourite.constabulary ? city.favourite.constabulary[s.id] : s.homeId;
        s.destBuilding = -1;
        s.destNode = -1;
        arrests++;
        curfew.enforced++;
        s.grievance = clamp(s.grievance + 50);
      }
    }
  }
}

function enforcePublicOrder(city: City): void {
  const order = city.laws.slots[IDX.publicOrder];
  const cap = order.param;
  const captured = order.captured === 1;
  const enf = city.laws.enforcement;
  if (enf < 280 && !captured) return;

  for (const b of city.buildings) {
    if (b.occupants.length < cap) continue;
    if (captured && vestryProtects(city, b)) continue;
    if (b.kind !== 'pub' && b.kind !== 'townhall' && b.kind !== 'mill' && city.laws.shebeenId !== b.id) continue;
    let moved = 0;
    for (let o = b.occupants.length - 1; o >= 0 && moved < 6; o--) {
      const s = city.souls[b.occupants[o]];
      if (!s || s.trade === 'publican' || s.activity === 'working') continue;
      if (s.activity !== 'drinking' && s.activity !== 'gathering' && s.activity !== 'loitering') continue;
      if (willComply(city, s, IDX.publicOrder)) {
        sendTo(city, s, s.homeId, 'commuting', 'visiting');
        s.overrideUntil = city.tick + 40;
        moved++;
        order.enforced++;
      } else {
        order.breached++;
      }
    }
  }

  if (captured || enf > 400) {
    for (const f of city.firms) {
      if (f.strikeUntil <= city.tick) continue;
      f.strikeUntil = city.tick + 60;
      for (let i = 0; i < f.workerIds.length; i++) {
        city.souls[f.workerIds[i]].grievance = clamp(city.souls[f.workerIds[i]].grievance + 20);
      }
      order.enforced++;
      if (pressureOf(city.press, 'mood') < 480) {
        applyPressure(city.press, 'suspicion', 40, 'law', f.id, 'the picket was moved on', city.tick);
      }
    }
  }
}

function inspectHourly(city: City): void {
  const ins = city.laws.slots[IDX.inspectorPowers];
  const captured = ins.captured === 1;
  const hour = Math.floor(city.tick / 60);
  const start = mix(city.seed, Stream.Law, 55, hour) % city.buildings.length;
  for (let i = 0; i < 24; i++) {
    const b = city.buildings[(start + i * 11) % city.buildings.length];
    if (b.kind !== 'courtdwelling' && b.kind !== 'tenement') continue;
    if (captured && vestryProtects(city, b)) continue;
    if (city.laws.condemnedUntil[b.id] > city.tick) continue;
    if (b.fabric > 420) continue;
    city.laws.condemnedUntil[b.id] = city.tick + MIN_PER_DAY * 3;
    b.facade = Math.min(b.facade, 260);
    ins.enforced++;
    for (let o = 0; o < b.occupants.length; o++) {
      const s = city.souls[b.occupants[o]];
      if (s) s.grievance = clamp(s.grievance + 25);
    }
    if (inForce(city, 'drainageAct') && !city.laws.slots[IDX.drainageAct].captured && b.kind === 'courtdwelling' && b.doorNode >= 0) {
      connectBuilding(city.networks.drain, b.id, b.doorNode);
      b.drainSeg = city.networks.drain.buildingSeg[b.id];
    }
    return;
  }
}

function collectDogTax(city: City): void {
  const dog = city.laws.slots[IDX.dogTax];
  const fee = dog.param;
  const captured = dog.captured === 1;
  const station = city.buildingsByKind.get('constabulary')?.[0] ?? -1;
  let collected = 0;
  for (const s of city.souls) {
    if (!city.laws.keepsDog[s.id]) continue;
    if (s.activity === 'asleep' || s.activity === 'held' || s.activity === 'dead') continue;
    if (willComply(city, s, IDX.dogTax)) {
      const h = city.households[s.householdId];
      if (h && h.purse >= fee) {
        h.purse -= fee;
        collected++;
        if (captured && city.laws.vestry[0] >= 0) {
          city.souls[city.laws.vestry[0]].purse += fee;
        } else if (station >= 0) {
          sendTo(city, s, station, 'errand', 'errand');
          s.returnTo = s.inId >= 0 ? s.inId : s.homeId;
          s.returnAt = city.tick + 40;
          s.overrideUntil = s.returnAt + 5;
          dog.enforced++;
        }
      } else {
        city.laws.keepsDog[s.id] = 0;
        s.grievance = clamp(s.grievance + 70);
        dog.enforced++;
      }
    } else {
      dog.breached++;
    }
  }
  if (collected > 0 && !captured) {
    applyPressure(city.press, 'coin', Math.min(40, collected), 'law', IDX.dogTax, 'the dog tax', city.tick);
  }
}

function informersHourly(city: City): void {
  const curfew = city.laws.slots[IDX.curfew];
  const lic = city.laws.slots[IDX.licensingHours];
  if (!curfew.inForce && !lic.inForce) return;
  const mod = minuteOfDay(city.tick);
  const afterHours = (curfew.inForce && !curfew.captured && mod >= curfew.param)
    || (lic.inForce && !lic.captured && mod >= lic.param);
  if (!afterHours) return;
  const hour = Math.floor(city.tick / 60);
  let named = 0;
  for (const s of city.souls) {
    if (named >= 3) break;
    if (s.depth !== 'principal') continue;
    if (s.id % 12 !== hour % 12) continue;
    const violating = (s.inId < 0 && curfew.inForce && mod >= curfew.param && s.trade !== 'constable')
      || (s.activity === 'drinking' && lic.inForce && mod >= lic.param);
    if (!violating) continue;
    if (willComply(city, s, curfew.inForce ? IDX.curfew : IDX.licensingHours)) continue;
    const start = city.relations.start[s.id];
    const end = city.relations.start[s.id + 1];
    for (let e = start; e < end; e++) {
      const other = city.souls[city.relations.to[e]];
      if (!other || other.depth !== 'principal') continue;
      if (other.piety < 620 || other.boldness > 400) continue;
      const claim = seedClaim(city.claims, 'informer', s.id, other.id, s.inId >= 0 ? s.inId : s.homeId, 1, city.tick);
      implant(city.claims, other, claim, 540, -1, city.tick);
      named++;
      break;
    }
  }
}

export function tickOrdinancesDaily(city: City): void {
  sitPending(city);
  updateFactions(city);
  if (city.laws.active === 0) return;
  dripResentment(city);
  growPetitions(city);
  considerPetitions(city);
}

function updateFactions(city: City): void {
  const sum = [0, 0, 0, 0, 0];
  const n = [0, 0, 0, 0, 0];
  for (const s of city.souls) {
    const home = city.buildings[s.homeId];
    if (s.trade === 'alderman') { sum[0] += s.grievance; n[0]++; }
    if (s.trade === 'curate' || s.piety > 720) { sum[1] += s.grievance; n[1]++; }
    if (s.trade === 'publican') { sum[2] += s.grievance; n[2]++; }
    if (s.trade === 'millhand') { sum[3] += s.grievance; n[3]++; }
    if (home && home.kind === 'courtdwelling') { sum[4] += s.grievance; n[4]++; }
  }
  for (let i = 0; i < 5; i++) {
    city.laws.factionGrievance[i] = n[i] ? Math.round(sum[i] / n[i]) : 0;
  }
}

function dripResentment(city: City): void {
  for (let idx = 0; idx < city.laws.slots.length; idx++) {
    if (!city.laws.slots[idx].inForce) continue;
    for (const s of city.souls) {
      if (s.id % 4 !== (Math.floor(city.tick / MIN_PER_DAY) % 4)) continue;
      const hurt = hurtScore(city, s, idx);
      if (hurt > 0) s.grievance = clamp(s.grievance + Math.trunc(hurt / 8));
    }
  }
}

function growPetitions(city: City): void {
  const day = Math.floor(city.tick / MIN_PER_DAY);
  for (let idx = 0; idx < city.laws.slots.length; idx++) {
    const slot = city.laws.slots[idx];
    if (!slot.inForce) continue;
    let added = 0;
    for (const s of city.souls) {
      if (added >= 2) break;
      if (s.depth !== 'principal') continue;
      if (s.literacy < 400) continue;
      if (hurtScore(city, s, idx) < 40) continue;
      if ((s.id + day) % 3 !== 0) continue;
      queuePetition(city, slot.kind, 0, s.id);
      added++;
    }
  }
}

function considerPetitions(city: City): void {
  for (let i = 0; i < city.laws.petitions.length; i++) {
    const p = city.laws.petitions[i];
    if (p.supporters === 20) {
      pushLog(city, `A petition against ${ORDINANCES[IDX[p.kind]].label} has twenty names on it.`, 'info');
    }
  }
}
