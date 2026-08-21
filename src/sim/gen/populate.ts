// Stage 7: souls, households, firms, and the prehistory.
//
// The prehistory is the highest-leverage twenty lines in the whole design. The
// generator writes history that predates tick 0: grudges with negative sinceTick,
// ties that are already established, buildings whose fabric and facade have
// already diverged. That is what makes day-one prose read "an argument about
// drainage that has run for eleven years" instead of "just now", and it costs
// nothing at runtime.
import { MIN_PER_DAY } from '../clock';
import type { Building } from '../buildings';
import { DEFS } from '../buildings';
import type { Firm, FirmKind } from '../firms';
import { FIRM_WAGE } from '../firms';
import type { Household } from '../households';
import type { Soul, Depth } from '../souls';
import { patternFor } from '../schedule';
import type { BuildingKind, Trade } from '../types';
import { CAPS } from '../types';
import { Stream, mulberry32, mix, pick, range, int, shuffle, chance } from '../rng';
import { GIVEN_M, GIVEN_F, FAMILY, FIRM_HEAD, FIRM_TAIL, GRUDGE_TOPIC } from '../names';

export interface Population {
  souls: Soul[];
  households: Household[];
  firms: Firm[];
}

const DWELLINGS: readonly BuildingKind[] = ['terrace', 'tenement', 'courtdwelling', 'villa', 'lodging'];

/** Jobs a building offers: trade and how many slots. */
const JOBS: Partial<Record<BuildingKind, [Trade, number][]>> = {
  mill: [['millhand', 22], ['engineer', 2], ['clerk', 2]],
  foundry: [['millhand', 12], ['engineer', 3]],
  workshop: [['engineer', 3], ['seamstress', 4]],
  wharfshed: [['docker', 5], ['lighterman', 2]],
  warehouse: [['docker', 3], ['clerk', 1]],
  shop: [['shopkeeper', 2], ['seamstress', 1]],
  pub: [['publican', 2], ['laundress', 1]],
  bank: [['clerk', 5]],
  exchange: [['clerk', 6]],
  townhall: [['alderman', 3], ['clerk', 5]],
  newspaper: [['printer', 5], ['clerk', 2]],
  constabulary: [['constable', 6]],
  gasworks: [['engineer', 4], ['lamplighter', 3]],
  pumphouse: [['engineer', 2]],
  tramdepot: [['conductor', 6], ['engineer', 2]],
  postexchange: [['clerk', 4]],
  dispensary: [['nurse', 4]],
  chapel: [['curate', 2]],
  school: [['clerk', 3]],
  bathhouse: [['laundress', 3]],
  glasshouse: [['none', 1]],
  mast: [['engineer', 2]],
  lodging: [['laundress', 1]],
};

interface Slot { buildingId: number; trade: Trade; firmId: number }

const FIRM_KIND: Partial<Record<BuildingKind, FirmKind>> = {
  mill: 'mill', foundry: 'foundry', workshop: 'workshop',
  wharfshed: 'wharf', warehouse: 'wharf',
  shop: 'shop', pub: 'shop', bank: 'shop', exchange: 'shop',
  newspaper: 'paper',
  gasworks: 'utility', pumphouse: 'utility', tramdepot: 'utility', postexchange: 'utility',
  townhall: 'civic', constabulary: 'civic', school: 'civic', dispensary: 'civic',
  chapel: 'civic', bathhouse: 'civic', mast: 'civic', glasshouse: 'civic', lodging: 'shop',
};

export function populate(seed: number, buildings: Building[], targetSouls: number): Population {
  const rng = mulberry32(mix(seed, Stream.GenSouls, 0));

  // Firms first, because a job slot needs an employer.
  const firms: Firm[] = [];
  for (const b of buildings) {
    const kind = FIRM_KIND[b.kind];
    if (!kind) continue;
    const r = mulberry32(mix(seed, Stream.GenSouls, 11, b.id));
    const name = b.kind === 'mill' || b.kind === 'foundry' || b.kind === 'workshop'
      ? `${pick(r, FIRM_HEAD)} ${pick(r, FIRM_TAIL)}`
      : b.name;
    firms.push({
      id: firms.length, buildingId: b.id, name, kind,
      workerIds: [], orders: range(r, 520, 820), margin: range(r, 80, 260),
      wageBase: FIRM_WAGE[kind], wageOffset: 0,
      strikeUntil: -1, closedUntil: -1, output: 0,
    });
    b.firmId = firms.length - 1;
  }

  const slots: Slot[] = [];
  for (const b of buildings) {
    const jobs = JOBS[b.kind];
    if (!jobs) continue;
    for (const [trade, n] of jobs) {
      for (let i = 0; i < n; i++) slots.push({ buildingId: b.id, trade, firmId: b.firmId });
    }
  }
  shuffle(rng, slots);

  const homes = buildings.filter((b) => DWELLINGS.includes(b.kind));
  if (!homes.length) return { souls: [], households: [], firms };

  const souls: Soul[] = [];
  const households: Household[] = [];
  let slotAt = 0;

  // Fill dwellings in a fixed order, largest capacity first, until the target
  // population is met. Court dwellings get overfilled on purpose.
  const order = homes.slice().sort((a, b) => {
    const ca = DEFS[a.kind].capacity;
    const cb = DEFS[b.kind].capacity;
    return cb - ca || a.id - b.id;
  });

  for (const home of order) {
    if (souls.length >= targetSouls) break;
    const r = mulberry32(mix(seed, Stream.GenSouls, 3, home.id));
    const cap = DEFS[home.kind].capacity;
    const wanted = home.kind === 'tenement' || home.kind === 'lodging'
      ? range(r, 2, 4)
      : 1;
    for (let hh = 0; hh < wanted && souls.length < targetSouls; hh++) {
      const size = home.kind === 'courtdwelling' ? range(r, 3, 6)
        : home.kind === 'villa' ? range(r, 2, 5)
          : range(r, 1, Math.max(2, Math.min(6, cap >> 1)));
      const family = pick(r, FAMILY);
      const hid = households.length;
      const members: number[] = [];
      for (let m = 0; m < size && souls.length < targetSouls; m++) {
        const id = souls.length;
        const isAdult = m < 2 || !chance(r, 380);
        const age = isAdult ? range(r, 19, 74) : range(r, 2, 17);
        const sex: 0 | 1 = m === 0 ? 0 : m === 1 ? 1 : (int(r, 2) as 0 | 1);
        let trade: Trade = 'none';
        let workId = -1;
        let firmId = -1;
        // Children on the working bank go to the mill, not to school.
        //
        // Every soul under fourteen was given trade 'child' and sent to the board
        // school, without exception, which meant a child labour ordinance had
        // literally nothing to bite on: measured, zero young souls at the mill in
        // both the control and the regulated run. In an 1890s district on the
        // wrong side of the river a half-timer of eleven or twelve was ordinary,
        // and it is the fact that makes the law worth passing.
        const poorHome = home.kind === 'courtdwelling' || home.kind === 'tenement'
          || home.kind === 'lodging';
        const halfTimer = age >= 11 && age < 14 && poorHome && chance(r, 520);
        if (age < 14 && !halfTimer) trade = 'child';
        else if (age < 68 && slotAt < slots.length) {
          const s = slots[slotAt++];
          trade = s.trade;
          workId = s.buildingId;
          firmId = s.firmId;
          if (firmId >= 0) firms[firmId].workerIds.push(id);
        }
        const depth: Depth = souls.length < 40 ? 'principal' : 'extra';
        souls.push({
          id, given: pick(r, sex === 0 ? GIVEN_M : GIVEN_F), family, age, sex,
          trade, depth,
          householdId: hid, homeId: home.id, workId, firmId,
          hunger: range(r, 150, 450), fatigue: range(r, 150, 450),
          warmth: range(r, 500, 900), health: range(r, 620, 980), drink: range(r, 0, 250),
          purse: range(r, 20, 260),
          mood: range(r, 380, 720), grievance: range(r, 80, 420),
          suspicion: range(r, 60, 340), piety: range(r, 100, 900),
          credulity: range(r, 200, 850), boldness: range(r, 150, 850),
          literacy: home.kind === 'villa' ? range(r, 600, 990) : range(r, 120, 760),
          beliefs: [],
          scheduleId: patternFor(trade, age, id),
          blockIdx: 0, overrideUntil: -1,
          activity: 'asleep', inId: home.id, activitySince: 0, arriveActivity: 'asleep',
          atNode: -1, toNode: -1, progressMilli: 0,
          destNode: -1, destBuilding: -1, route: [], routeIdx: 0,
          lastSpokeTick: -1, targetSoul: -1,
          returnAt: -1, returnTo: -1,
        });
        members.push(id);
      }
      if (!members.length) continue;
      const rent = home.kind === 'villa' ? range(r, 40, 70)
        : home.kind === 'courtdwelling' ? range(r, 6, 12)
          : range(r, 14, 30);
      households.push({
        id: hid, buildingId: home.id, name: family, memberIds: members,
        purse: range(r, 40, 700), rentPerDay: rent, arrearsDays: 0,
        standing: home.kind === 'villa' ? range(r, 600, 950) : range(r, 200, 700),
        evictedTick: -1,
      });
      home.householdIds.push(hid);
    }
  }

  // Prehistory. Grudges predate tick 0, so the district already has a past.
  for (const b of buildings) {
    const r = mulberry32(mix(seed, Stream.GenHistory, b.id));
    const n = b.kind === 'townhall' || b.kind === 'chapel' || b.kind === 'newspaper'
      ? range(r, 2, 3)
      : chance(r, 480) ? 1 : 0;
    for (let i = 0; i < n; i++) {
      const years = range(r, 2, 19);
      const withSoul = souls.length ? souls[int(r, souls.length)].id : -1;
      b.grudges.push({
        topic: pick(r, GRUDGE_TOPIC),
        sinceTick: -years * 365 * MIN_PER_DAY,
        withSoul,
        heat: range(r, 200, 800),
      });
    }
    // Fabric and facade have already diverged before the player arrives. On the
    // polite bank the show is kept up and the structure is not.
    const def = DEFS[b.kind];
    const drift = range(r, 0, 240);
    b.facade = Math.max(0, Math.min(1000, def.baseFacade + range(r, -60, 90)));
    b.fabric = Math.max(0, Math.min(1000, def.baseFabric - drift));
  }

  if (souls.length > CAPS.souls) souls.length = CAPS.souls;
  return { souls, households, firms };
}
