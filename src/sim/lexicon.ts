// Authored fragments and their predicates. Data, not logic.
//
// Every fragment carries a `when` that reads real integers out of the sim. A
// fragment whose predicate fails is never selected, which is the guarantee that
// makes this whole layer trustworthy: the prose can never assert something the
// simulation does not contain. That property is worth more than any amount of
// generated fluency, and it is exactly what an LLM in this slot would destroy.
import { isLampHour, minuteOfDay } from './clock';
import { DEFS } from './buildings';
import type { Building } from './buildings';
import { serviceAt } from './networks';
import { pressureOf } from './pressures';
import { inForce, ordinanceOf } from './ordinances';
import type { Activity, Trade } from './types';
import type { City } from './city';

export interface Fragment {
  token: string;
  when: (city: City, b: Building) => boolean;
  salience: number;
}

const kindIs = (...kinds: string[]) => (_c: City, b: Building) => kinds.includes(b.kind);

export const SENSES: readonly Fragment[] = [
  // Trade smells. Highest salience, because they say what a place IS.
  { token: 'ink', when: kindIs('newspaper'), salience: 90 },
  { token: 'hot iron', when: kindIs('foundry'), salience: 92 },
  { token: 'raw cotton', when: kindIs('mill'), salience: 92 },
  { token: 'coal gas', when: kindIs('gasworks'), salience: 94 },
  { token: 'wet rope', when: kindIs('wharfshed', 'warehouse'), salience: 88 },
  { token: 'spilled beer', when: kindIs('pub'), salience: 86 },
  { token: 'brass polish', when: kindIs('bank', 'exchange', 'postexchange'), salience: 84 },
  { token: 'carbolic', when: kindIs('dispensary', 'bathhouse'), salience: 86 },
  { token: 'chalk dust', when: kindIs('school'), salience: 84 },
  { token: 'cold stone', when: kindIs('chapel'), salience: 80 },
  { token: 'machine oil', when: kindIs('workshop', 'tramdepot', 'pumphouse'), salience: 82 },
  { token: 'warm glass', when: kindIs('glasshouse'), salience: 84 },
  { token: 'sealing wax', when: kindIs('townhall', 'constabulary'), salience: 78 },
  { token: 'goods nobody is buying', when: kindIs('shop'), salience: 80 },
  { token: 'a coal fire kept small', when: kindIs('terrace'), salience: 76 },
  { token: 'boiled washing', when: kindIs('tenement', 'lodging'), salience: 78 },
  { token: 'four families and one stair', when: kindIs('tenement'), salience: 82 },
  { token: 'a room let by the week', when: kindIs('lodging'), salience: 76 },
  { token: 'beeswax and cut flowers', when: kindIs('villa'), salience: 80 },
  { token: 'standing water', when: kindIs('courtdwelling'), salience: 84 },
  { token: 'a stair worn through in the middle', when: kindIs('courtdwelling', 'tenement'), salience: 72 },
  { token: 'the yard through the wall', when: kindIs('warehouse'), salience: 70 },

  // Condition. These are the ones that change while you watch.
  { token: 'dust', when: (_c, b) => b.fabric < 420, salience: 70 },
  { token: 'damp', when: (c, b) => b.fabric < 520 && !serviceAt(c.networks.drain, b.id), salience: 74 },
  { token: 'new gilding', when: (_c, b) => b.facade > 840, salience: 72 },
  { token: 'fresh paint over old rot', when: (_c, b) => b.facade > 760 && b.fabric < 420, salience: 96 },
  { token: 'a cold grate', when: (c, b) => DEFS[b.kind].needsGas && isLampHour(c.tick) && !serviceAt(c.networks.gas, b.id), salience: 88 },
  { token: 'soot on the sills', when: (c, b) => c.district.grime[b.cells[0]] > 150, salience: 58 },
  { token: 'a draught nobody will name', when: (_c, b) => b.fabric < 300, salience: 66 },
  { token: 'the smell of the drains', when: (c) => pressureOf(c.press, 'sanitation') < 340, salience: 76 },
  { token: 'a notice about the new hours', when: (c, b) => b.kind === 'pub' && inForce(c, 'licensingHours'), salience: 82 },
  { token: 'the door locked from inside', when: (c, b) => b.kind === 'pub' && inForce(c, 'licensingHours') && b.occupants.some((id) => c.souls[id].activity === 'drinking') && minuteOfDay(c.tick) >= ordinanceOf(c, 'licensingHours').param, salience: 94 },
  { token: 'a queue for the four-pound loaf', when: (c, b) => b.kind === 'shop' && inForce(c, 'breadAssize') && b.occupants.length > 2, salience: 88 },
  { token: 'an empty pew', when: (c, b) => b.kind === 'chapel' && inForce(c, 'pewRents') && b.occupants.length < 3, salience: 80 },
  { token: 'a condemned bill on the door', when: (c, b) => c.laws.condemnedUntil[b.id] > c.tick, salience: 92 },
  { token: 'carts sent round', when: (c, b) => inForce(c, 'cartBylaw') && ordinanceOf(c, 'cartBylaw').param === b.streetId && (b.kind === 'shop' || b.kind === 'warehouse'), salience: 84 },
  { token: 'the courts still off the mains', when: (c, b) => b.kind === 'courtdwelling' && !serviceAt(c.networks.drain, b.id), salience: 90 },
  { token: 'a shebeen after hours', when: (c, b) => c.laws.shebeenId === b.id && inForce(c, 'licensingHours'), salience: 95 },

  // Occupancy. Absence is information, so an empty room says so.
  { token: 'an argument', when: (c, b) => b.occupants.some((id) => c.souls[id].activity === 'arguing'), salience: 90 },
  { token: 'nobody at all', when: (_c, b) => b.occupants.length === 0, salience: 40 },
  { token: 'more people than the room was built for', when: (_c, b) => b.occupants.length > DEFS[b.kind].capacity, salience: 86 },
  { token: 'somebody asleep who should not be', when: (c, b) => b.occupants.some((id) => c.souls[id].activity === 'asleep' && !isLampHour(c.tick)), salience: 68 },
];

/** What a soul is doing, by activity and trade. Every modifier below is gated on
 *  a real integer, so the sentence is always a report and never a flourish. */
const ACTIVITY_PHRASE: Partial<Record<Activity, string>> = {
  asleep: 'asleep',
  waking: 'not yet properly awake',
  eating: 'eating',
  working: 'at work',
  commuting: 'on the way somewhere',
  errand: 'out on an errand',
  shopping: 'buying something small',
  drinking: 'drinking',
  worshipping: 'at prayer',
  loitering: 'standing about',
  visiting: 'sitting with the family',
  ailing: 'ailing',
  arguing: 'in the middle of an argument',
  mourning: 'in mourning',
  striking: 'out on strike',
  gathering: 'part of a crowd',
  hiding: 'keeping out of sight',
  held: 'in custody',
  dead: 'dead',
};

// Pronoun-free by construction.
//
// These lines are attached to a named soul whose sex the sim knows, but writing
// "minding a machine that does not stop for him" and then attaching it to Harriet
// is worse than any amount of cleverness saves. Phrases that describe the WORK
// rather than the worker never have to agree with anything.
const WORK_PHRASE: Partial<Record<Trade, string[]>> = {
  clerk: [
    'copying correspondence into the letter book',
    'balancing a column in the rate ledger',
    'entering a resolution in the minutes',
  ],
  millhand: [
    'minding a machine that does not stop for anyone',
    'watching a belt that has been slipping since Tuesday',
    'feeding the frame and counting the hours',
    'listening for the sound the machine makes before it jams',
  ],
  lighterman: ['working a barge off the quay', 'making fast in a wind that is getting up'],
  engineer: ['inside a machine up to the elbows', 'tracing the fault in a stopped engine'],
  lamplighter: ['checking a mantle that has been failing for a week', 'trimming the lamps for the evening round'],
  conductor: ['counting the fares twice, to be sure', 'arguing with somebody about a ticket'],
  constable: ['entering a charge in the occurrence book', 'standing the appointed beat'],
  printer: ['setting type back to front, correctly', 'washing ink out of the press and out of both hands'],
  publican: ['pulling for a room that is not paying yet', 'watering something that was already watered'],
  shopkeeper: ['setting out the window before the noon trade', 'weighing an order against the shop scales'],
  seamstress: ['finishing a seam by the last of the light', 'turning a collar for the second time'],
  laundress: ['up to the elbows in somebody else\'s linen', 'boiling a copper that has boiled since five'],
  docker: ['shifting weight that was badly loaded', 'waiting to be picked, and not being picked'],
  nurse: ['dressing what can be dressed', 'entering a case in the dispensary book'],
  curate: ['preparing a sermon about patience', 'visiting a house that would rather not be visited'],
  alderman: ['signing the day\'s minutes', 'hearing a motion from the works committee'],
  child: ['reciting something learned by heart', 'copying the answer off the next desk'],
};

/**
 * @param salt a stable per-soul number, so six mill hands in one room do not all
 *   say the same sentence. Repetition inside a single INSIDE list is the fastest
 *   way to make a generated district feel generated.
 */
export function activityPhrase(
  activity: Activity, trade: Trade, fatigue: number, grievance: number, hunger: number, salt = 0,
): string {
  if (activity === 'working') {
    if (fatigue > 820) return 'asleep over the work';
    if (grievance > 720) return 'working, and saying exactly what the new rota is worth';
    const options = WORK_PHRASE[trade];
    if (!options || !options.length) return 'at work';
    return options[Math.abs(salt) % options.length];
  }
  if (activity === 'asleep' && hunger > 880) return 'asleep, and hungry with it';
  if (activity === 'drinking' && grievance > 700) return 'drinking, and getting louder about it';
  if (activity === 'eating' && hunger > 800) return 'eating too fast';
  return ACTIVITY_PHRASE[activity] ?? 'here';
}

/** Joined as an English list, which is how the reference reads: "Ink, dust, and". */
export function joinList(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}
