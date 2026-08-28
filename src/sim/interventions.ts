// The nudges, and the rule that keeps them honest.
//
// HARD RULE: an intervention must never be a direct pressure poke. If cutGas were
// applyPressure('gas', -300) the game would be a slider board. It breaks a
// specific segment of a specific tree, a specific set of buildings downstream of
// it loses service, and the pressure moves as a CONSEQUENCE of that, reported by
// the hourly network read. The gas, drain and post trees exist for no other
// reason.
//
// BACKFIRES ARE STATE CONDITIONS, NOT DICE. Every one of the eight has a
// documented world state under which it does the opposite of what you wanted. A
// player who learns the state can predict the backfire, which is the difference
// between a system and a slot machine.
import type { City } from './city';
import { pushLog } from './city';
import { applyPressure, pressureOf } from './pressures';
import { breakSegment, serviceAt } from './networks';
import { seedClaim, implant, lineageOf } from './claims';
import { emit, witnessesOf } from './events';
import { adjustTie } from './relations';
import { fullName } from './souls';
import { addressOf } from './worldgen';
import { mix } from './rng';
import type { InterventionKind, Target } from './types';
import { canFileWorks, fileWorks } from './works';
import { canCallDeputation, callDeputation } from './deputations';
import { canOpenShelter, openShelter } from './shelters';
import { canStartDisaster, startDisaster } from './disasters';
import { weatherAt } from './weather';
import { noteMatterResponse } from './matters';
import { DEFS } from './buildings';
import { isRunning } from './firms';

export const DAILY_BUDGET = 3;

export interface Nudge {
  tick: number;
  kind: InterventionKind;
  target: Target;
  exposure: InterventionForecast['exposure'];
  traced: boolean;
}

export interface InterventionDef {
  kind: InterventionKind;
  label: string;
  blurb: string;
  /** Suspicion added when it lands. The price of being the sort of person who does this. */
  heat: number;
  targets: Target['kind'][];
  /** null means allowed; a string is the reason it is not, shown in the UI. */
  can: (city: City, t: Target) => string | null;
  apply: (city: City, t: Target) => string;
}

export interface InterventionForecast {
  posture: 'settled' | 'contested' | 'unclear';
  exposure: 'public' | 'deniable';
  text: string;
}

const PUBLIC_INTERVENTIONS = new Set<InterventionKind>([
  'fundBunting', 'fileWorks', 'callDeputation', 'openShelter', 'quarantine',
  // A fire, a flood or a collapse is about as public as an act can be.
  'setFire', 'floodOut', 'condemn',
]);

export function exposureOf(kind: InterventionKind): InterventionForecast['exposure'] {
  return PUBLIC_INTERVENTIONS.has(kind) ? 'public' : 'deniable';
}

function building(city: City, t: Target) {
  return city.buildings[t.id];
}

export const INTERVENTIONS: Record<InterventionKind, InterventionDef> = {
  rumour: {
    kind: 'rumour',
    label: 'Start a rumour',
    blurb: 'Put a story about somebody into somebody else\'s ear, and let the ties carry it.',
    heat: 40,
    targets: ['soul'],
    can: (city, t) => {
      const s = city.souls[t.id];
      if (!s) return 'Nobody there.';
      if (s.depth !== 'principal') return 'Nobody would repeat a thing said about them.';
      return null;
    },
    apply: (city, t) => {
      const s = city.souls[t.id];
      const rng = mix(city.seed, 90, city.tick, s.id);
      const kinds = ['affair', 'theft', 'graft', 'informer'] as const;
      const kind = kinds[rng % kinds.length];
      const claim = seedClaim(city.claims, kind, s.id, -1, s.homeId, 0, city.tick, 1);

      // Backfire: a listener who knows the subject well and is hard to fool reads
      // it as slander, and puts about a counter-story naming an outsider.
      const neighbours = city.relations
        ? neighbourList(city, s.id)
        : [];
      const sceptic = neighbours.find((id) => city.souls[id].credulity < 340);
      if (sceptic !== undefined) {
        applyPressure(city.press, 'suspicion', 40, 'intervention', claim, 'a story that did not hold', city.tick);
        const counter = seedClaim(city.claims, 'informer', sceptic, s.id, s.homeId, 0, city.tick, 1);
        implant(city.claims, city.souls[sceptic], counter, 620, -1, city.tick);
        return `The story about ${fullName(s)} was not believed. Something else is going round instead.`;
      }

      let planted = 0;
      for (const id of neighbours.slice(0, 4)) {
        implant(city.claims, city.souls[id], claim, 200, -1, city.tick);
        planted++;
      }
      emit(city.events, 'rumour', s.homeId, [s.id], 300, city.tick);
      return `A story about ${fullName(s)} is in ${planted} ears by nightfall.`;
    },
  },

  cutGas: {
    kind: 'cutGas',
    label: 'Cut off the gas',
    blurb: 'Break one segment. Whatever is downstream of it goes dark at dusk.',
    heat: 70,
    targets: ['building'],
    can: (city, t) => {
      const b = building(city, t);
      if (!b) return 'Nothing there.';
      if (b.gasSeg < 0) return 'That building is not on the gas.';
      if (!serviceAt(city.networks.gas, b.id)) return 'That main is already broken.';
      return null;
    },
    apply: (city, t) => {
      const b = building(city, t);
      const lost = breakSegment(city.networks.gas, b.gasSeg, city.tick);
      emit(city.events, 'gasCut', b.id, [], 500, city.tick);

      // Backfire: if the district is already suspicious, the works send an
      // inspector, and the inspection repairs three OTHER rotten mains. Sabotage
      // causes maintenance.
      if (pressureOf(city.press, 'suspicion') > 620) {
        const broken = [];
        for (let i = 0; i < city.networks.gas.segBroken.length && broken.length < 3; i++) {
          if (city.networks.gas.segBroken[i] && i !== b.gasSeg) broken.push(i);
        }
        for (const seg of broken) city.networks.gas.segBroken[seg] = 0;
        applyPressure(city.press, 'mood', 60, 'intervention', b.id, 'an inspection nobody asked for', city.tick);
        return `The works sent an inspector. He found three other mains, and fixed them.`;
      }
      return `${lost.length} buildings lose their gas. They will find out at dusk.`;
    },
  },

  delayTram: {
    kind: 'delayTram',
    label: 'Delay the tram',
    blurb: 'One shift late. Everyone walks through the square instead.',
    heat: 30,
    targets: ['line', 'square', 'building'],
    can: (city) => (city.tramDelayedUntil > city.tick ? 'The tram is already late.' : null),
    apply: (city) => {
      city.tramDelayedUntil = city.tick + 720;
      applyPressure(city.press, 'tram', -300, 'intervention', 0, 'the tram is not running', city.tick);

      // Backfire: where grievance is already high, lateness is the last straw and
      // the mill walks out. That reads as a holiday, and worker mood goes UP.
      const angry = city.souls.filter((s) => s.grievance > 700).length;
      if (angry > city.souls.length * 0.18) {
        const mill = city.firms.find((f) => f.kind === 'mill');
        if (mill) {
          mill.strikeUntil = city.tick + 1440;
          applyPressure(city.press, 'mood', 90, 'intervention', mill.id, 'an unscheduled holiday', city.tick);
          return 'The lateness was the last straw. The mill has walked out, and is enjoying it.';
        }
      }
      return 'The tram will not run properly until tomorrow. The pavements will be busy.';
    },
  },

  tipOff: {
    kind: 'tipOff',
    label: 'Set the police on them',
    blurb: 'Give them a name. They will act on it within the hour.',
    heat: 60,
    targets: ['soul', 'building'],
    can: (city, t) => {
      if (t.kind === 'soul' && !city.souls[t.id]) return 'Nobody there.';
      if (t.kind === 'building' && !building(city, t)) return 'Nothing there.';
      if (!city.buildingsByKind.get('constabulary')?.length) return 'There is nobody to tell.';
      return null;
    },
    apply: (city, t) => {
      const s = t.kind === 'soul' ? city.souls[t.id] : null;
      const place = s ? s.inId >= 0 ? s.inId : s.homeId : t.id;
      emit(city.events, 'arrest', place, s ? [s.id] : [], 700, city.tick);
      const seen = witnessesOf(city, place);

      // Backfire: a false tip in a rotten district takes the wrong person, the
      // street notices, and the martyr story spreads grievance faster than the
      // arrest suppressed it.
      if (pressureOf(city.press, 'rot') > 560) {
        const wrong = seen.find((id) => id !== s?.id);
        applyPressure(city.press, 'suspicion', 80, 'intervention', place, 'they took the wrong man', city.tick);
        if (wrong !== undefined) {
          const martyr = seedClaim(city.claims, 'informer', wrong, s?.id ?? -1, place, 1, city.tick, 1);
          for (const id of seen) implant(city.claims, city.souls[id], martyr, 700, -1, city.tick);
          for (const id of seen) city.souls[id].grievance = Math.min(1000, city.souls[id].grievance + 90);
          return `They took ${fullName(city.souls[wrong])}, who had done nothing. The street watched.`;
        }
      }

      if (s) {
        s.activity = 'held';
        s.overrideUntil = city.tick + 600;
        const claim = seedClaim(city.claims, 'theft', s.id, -1, place, 0, city.tick, 1);
        for (const id of seen) implant(city.claims, city.souls[id], claim, 520, -1, city.tick);
        // The household loses the wage. Arrears do the rest.
        const h = city.households[s.householdId];
        if (h) h.arrearsDays++;
        return `${fullName(s)} was taken this morning, in front of ${seen.length} people.`;
      }
      applyPressure(city.press, 'suspicion', 30, 'intervention', place, 'a search', city.tick);
      return 'The constabulary searched the place and found nothing worth writing down.';
    },
  },

  fundStrike: {
    kind: 'fundStrike',
    label: 'Back a strike',
    blurb: 'Pay the workers to stop. The picket closes the gate.',
    heat: 50,
    targets: ['building', 'firm'],
    can: (city, t) => {
      const b = building(city, t);
      if (!b || b.firmId < 0) return 'Nobody works there.';
      const f = city.firms[b.firmId];
      if (f.strikeUntil > city.tick) return 'They are already out.';
      if (f.workerIds.length < 4) return 'Too few hands to make a picket.';
      return null;
    },
    apply: (city, t) => {
      const b = building(city, t);
      const f = city.firms[b.firmId];
      f.strikeUntil = city.tick + 1440 * 3;

      // Backfire: with the treasury empty the town hall sides with the owner, the
      // constables clear the picket, and the workforce comes apart instead of
      // together.
      if (pressureOf(city.press, 'coin') < 320) {
        applyPressure(city.press, 'mood', -120, 'intervention', f.id, 'the picket was cleared', city.tick);
        for (let i = 0; i < f.workerIds.length - 1; i++) {
          adjustTie(city.relations, f.workerIds[i], f.workerIds[i + 1], -40);
        }
        f.strikeUntil = city.tick + 240;
        return `The hall sided with the owner. The picket lasted four hours and cost them each other.`;
      }

      // Solidarity is a permanent change to the graph, not a temporary buff.
      for (let i = 0; i < f.workerIds.length - 1; i++) {
        adjustTie(city.relations, f.workerIds[i], f.workerIds[i + 1], 60);
        city.souls[f.workerIds[i]].grievance = Math.max(0, city.souls[f.workerIds[i]].grievance - 60);
      }
      emit(city.events, 'strike', b.id, f.workerIds.slice(0, 8), 600, city.tick);
      return `${f.name} is out. ${f.workerIds.length} hands, and the gate is shut.`;
    },
  },

  plantStory: {
    kind: 'plantStory',
    label: 'Plant a newspaper story',
    blurb: 'Put an existing rumour in the paper. Everyone who reads will believe it.',
    heat: 45,
    targets: ['claim', 'soul'],
    can: (city, t) => {
      if (!city.buildingsByKind.get('newspaper')?.length) return 'There is no paper to plant it in.';
      if (city.paperCredibility < 250) return 'Nobody believes the paper any more.';
      if (t.kind === 'claim' && !city.claims.claims[t.id]) return 'No such story.';
      if (t.kind === 'soul') {
        const s = city.souls[t.id];
        if (!s || !s.beliefs.length) return 'They have nothing to tell.';
      }
      return null;
    },
    apply: (city, t) => {
      const claimId = t.kind === 'claim' ? t.id : city.souls[t.id].beliefs[0].claimId;
      const claim = city.claims.claims[claimId];
      let readers = 0;
      for (const s of city.souls) {
        if (s.literacy < 520) continue;
        implant(city.claims, s, claimId, 700, -1, city.tick);
        readers++;
      }
      claim.salience = 1000;

      // Backfire: a false story that can be checked gets a retraction, and the
      // paper's credibility drops PERMANENTLY, weakening every future plant.
      if (claim.truth === 0 && claim.generation === 0) {
        city.paperCredibility = Math.max(0, city.paperCredibility - 220);
        applyPressure(city.press, 'suspicion', 50, 'intervention', claimId, 'a retraction', city.tick);
        return `It ran, and then it was retracted. The paper is worth less than it was.`;
      }

      applyPressure(city.press, 'coin', -40, 'intervention', claimId, 'an inquiry nobody wanted', city.tick);
      if (pressureOf(city.press, 'rot') > 500) {
        applyPressure(city.press, 'suspicion', 70, 'intervention', claimId, 'the inquiry found nothing', city.tick);
        return `It ran. The hall opened an inquiry, and the inquiry found nothing. Nobody is surprised.`;
      }
      return `It ran. ${readers} people who can read now believe it, and ${lineageOf(city.claims, claimId).length} versions are in the air.`;
    },
  },

  quarantine: {
    kind: 'quarantine',
    label: 'Quarantine a street',
    blurb: 'Close it at both ends. Whoever is inside stays inside.',
    heat: 80,
    targets: ['street', 'building'],
    can: (city, t) => {
      const b = building(city, t);
      if (!b || b.streetId < 0) return 'No street to close.';
      if (city.quarantined.has(b.streetId)) return 'That street is already shut.';
      return null;
    },
    apply: (city, t) => {
      const b = building(city, t);
      const street = city.streets[b.streetId];
      city.quarantined.add(b.streetId);
      const confined = city.souls.filter((s) => {
        const home = city.buildings[s.homeId];
        return home && home.streetId === b.streetId;
      });
      for (const s of confined) {
        s.grievance = Math.min(1000, s.grievance + 70);
        s.overrideUntil = city.tick + 1440;
      }

      const sick = confined.filter((s) => s.health < 400).length;

      // Backfire, two ways. No sickness at all and it reads as arbitrary. Sickness
      // present and you have concentrated the infected instead of separating them.
      if (sick === 0) {
        applyPressure(city.press, 'mood', -200, 'intervention', b.streetId, 'a cordon with no reason', city.tick);
        return `${street?.name ?? 'The street'} is shut, and there was nothing wrong with it. The district noticed.`;
      }
      if (sick > confined.length * 0.25) {
        applyPressure(city.press, 'sanitation', -80, 'intervention', b.streetId, 'the sick shut in together', city.tick);
        return `${street?.name ?? 'The street'} is shut with ${sick} sick already inside it.`;
      }
      applyPressure(city.press, 'sanitation', 150, 'intervention', b.streetId, 'a cordon', city.tick);
      return `${street?.name ?? 'The street'} is shut. ${confined.length} people are on the wrong side of it.`;
    },
  },

  fundBunting: {
    kind: 'fundBunting',
    label: 'Put on a celebration',
    blurb: 'Three days of flags over the square. The money comes from somewhere.',
    heat: 5,
    targets: ['square', 'building'],
    can: (city) => (city.buntingUntil > city.tick ? 'The flags are already up.' : null),
    apply: (city) => {
      city.buntingUntil = city.tick + 1440 * 3;
      applyPressure(city.press, 'mood', 200, 'intervention', 0, 'flags over the square', city.tick);
      applyPressure(city.press, 'coin', -90, 'intervention', 0, 'flags over the square', city.tick);
      // This is the thesis as a button. The money came out of the repairs line,
      // so the city looks better this week and is structurally worse.
      applyPressure(city.press, 'rot', 60, 'intervention', 0, 'the repairs line, spent on flags', city.tick);
      for (const b of city.buildings) b.facade = Math.min(1000, b.facade + 12);
      return 'The flags are up. The square has not looked better in years.';
    },
  },

  fileWorks: {
    kind: 'fileWorks',
    label: 'Order repairs',
    blurb: 'Put one real defect into the register. The hall may send a crew, or only a plaque.',
    heat: 10,
    targets: ['building'],
    can: (city, t) => canFileWorks(city, t.id),
    apply: (city, t) => {
      const order = fileWorks(city, t.id);
      const b = city.buildings[t.id];
      const route = order.pneumatic ? 'went by pneumatic post' : 'was carried to the hall by hand';
      return `Works case ${order.id + 1} for ${b.name} ${route}. A number is not a repair.`;
    },
  },

  callDeputation: {
    kind: 'callDeputation',
    label: 'Send a delegation',
    blurb: 'Ask the street to carry its filed works case to Civic Hall in person.',
    heat: 25,
    targets: ['building'],
    can: (city, t) => canCallDeputation(city, t.id),
    apply: (city, t) => {
      const attending = callDeputation(city, t.id);
      const b = city.buildings[t.id];
      return `${attending} neighbours have left ${b.name} for Civic Hall. Whether the hall hears them depends on who arrives.`;
    },
  },

  openShelter: {
    kind: 'openShelter',
    label: 'Open a shelter',
    blurb: 'Open a public door in the rain. The vulnerable still have to reach it.',
    heat: 5,
    targets: ['building'],
    can: (city, t) => canOpenShelter(city, t.id),
    apply: (city, t) => {
      const admitted = openShelter(city, t.id);
      const b = city.buildings[t.id];
      return `${b?.name ?? 'The building'} has opened its doors. ${admitted} people are making for shelter.`;
    },
  },

  // The ward boss's cruel powers: loose a disaster on a workplace. Each is very
  // public and lands a heavy blow on order and mood, which the meters report. A
  // fire will spread on its own; a flood needs water near enough to let in.
  setFire: {
    kind: 'setFire',
    label: 'Set it alight',
    blurb: 'Start a fire in this workplace. It will spread to whatever it can reach.',
    heat: 260,
    targets: ['building'],
    can: (city, t) => canStartDisaster(city, 'fire', t.id),
    apply: (city, t) => {
      startDisaster(city, 'fire', t.id);
      return `You have Verdigris put to the torch at ${city.buildings[t.id]?.name ?? 'the site'}.`;
    },
  },
  floodOut: {
    kind: 'floodOut',
    label: 'Flood it out',
    blurb: 'Let the river in. The water will rise through the low streets while the rain holds.',
    heat: 210,
    targets: ['building'],
    can: (city, t) => canStartDisaster(city, 'flood', t.id),
    apply: (city, t) => {
      startDisaster(city, 'flood', t.id);
      return `You have the wall breached at ${city.buildings[t.id]?.name ?? 'the site'} and the water let in.`;
    },
  },
  condemn: {
    kind: 'condemn',
    label: 'Condemn it',
    blurb: 'Bring this building down. What stood there is a cleared, ruined site.',
    heat: 230,
    targets: ['building'],
    can: (city, t) => canStartDisaster(city, 'collapse', t.id),
    apply: (city, t) => {
      startDisaster(city, 'collapse', t.id);
      return `You have ${city.buildings[t.id]?.name ?? 'the building'} pulled down.`;
    },
  },
};

function neighbourList(city: City, id: number): number[] {
  const r = city.relations;
  const out: number[] = [];
  for (let i = r.start[id]; i < r.start[id + 1]; i++) out.push(r.to[i]);
  return out;
}

export function canApply(city: City, kind: InterventionKind, target: Target): string | null {
  // No daily allowance gates a ward boss's powers. The only cost of an act is
  // what it does to happiness, order and the purse, which the meters report.
  const def = INTERVENTIONS[kind];
  if (!def.targets.includes(target.kind)) return 'Not that sort of thing.';
  return def.can(city, target);
}

/**
 * A clerk's risk note, derived from the same thresholds as the intervention.
 * It names the known political shape without promising the exact outcome.
 */
export function forecastIntervention(city: City, kind: InterventionKind, target: Target): InterventionForecast {
  const exposure = exposureOf(kind);
  const note = (posture: InterventionForecast['posture'], text: string): InterventionForecast => ({ posture, exposure, text });

  if (kind === 'rumour') {
    const soul = city.souls[target.id];
    const sceptic = soul && neighbourList(city, soul.id).some((id) => city.souls[id].credulity < 340);
    return note(sceptic ? 'contested' : 'unclear', sceptic
      ? 'A close sceptic is likely to answer the story.'
      : 'The first listeners are hard to read.');
  }
  if (kind === 'cutGas') {
    return note(pressureOf(city.press, 'suspicion') > 620 ? 'contested' : 'settled',
      pressureOf(city.press, 'suspicion') > 620 ? 'The works are already watching this ward.' : 'No inspection is expected just now.');
  }
  if (kind === 'delayTram') {
    const angry = city.souls.filter((s) => s.grievance > 700).length;
    const tense = angry > city.souls.length * 0.18;
    return note(tense ? 'contested' : 'settled', tense
      ? 'The mill hands are near their limit.'
      : 'The walk through the square should be orderly.');
  }
  if (kind === 'tipOff') {
    const rotten = pressureOf(city.press, 'rot') > 560;
    return note(rotten ? 'contested' : 'settled', rotten
      ? 'A rotten constabulary may take the wrong person.'
      : 'The constabulary is likely to follow the name given.');
  }
  if (kind === 'fundStrike') {
    const poor = pressureOf(city.press, 'coin') < 320;
    return note(poor ? 'contested' : 'settled', poor
      ? 'An empty treasury makes a clearing attempt likely.'
      : 'The hall can afford to let the gate stand.');
  }
  if (kind === 'plantStory') {
    const claimId = target.kind === 'claim' ? target.id : city.souls[target.id]?.beliefs[0]?.claimId;
    const claim = claimId === undefined ? undefined : city.claims.claims[claimId];
    const exposed = claim?.truth === 0 && claim.generation === 0;
    const hollow = pressureOf(city.press, 'rot') > 500;
    return note(exposed || hollow ? 'contested' : 'unclear', exposed
      ? 'This claim can be checked and may force a retraction.'
      : hollow ? 'Any inquiry is likely to look hollow.' : 'The paper can carry it, but readers decide what follows.');
  }
  if (kind === 'quarantine') {
    const b = building(city, target);
    const confined = b ? city.souls.filter((s) => city.buildings[s.homeId]?.streetId === b.streetId) : [];
    const sick = confined.filter((s) => s.health < 400).length;
    const wrong = sick === 0 || sick > confined.length * 0.25;
    return note(wrong ? 'contested' : 'settled', sick === 0
      ? 'The clerk can find no sickness on this street.'
      : sick > confined.length * 0.25 ? 'Too many sick people would be shut in together.' : 'The cordon has a narrow sanitary case.');
  }
  if (kind === 'fundBunting') {
    return note('contested', 'The square gains cheer; repairs lose money.');
  }
  if (kind === 'fileWorks') {
    const funded = pressureOf(city.press, 'coin') >= 360;
    const honest = pressureOf(city.press, 'rot') < 520;
    const workshop = city.firms.find((firm) => firm.kind === 'workshop');
    const crew = Boolean(workshop && isRunning(workshop, city.tick));
    return note(funded && honest && crew ? 'settled' : 'contested', funded && honest && crew
      ? 'Money, clerks and a working crew are in place.'
      : 'Money, clerks or the works crew may fail this case.');
  }
  if (kind === 'callDeputation') {
    return note('unclear', 'The street must arrive together, and the hall must hear it.');
  }
  if (kind === 'setFire') {
    const dry = weatherAt(city.seed, city.tick).precipitation === 0;
    return note(dry ? 'contested' : 'settled', dry
      ? 'Dry weather: the fire will jump to whatever stands near it.'
      : 'The rain will hold the flames to this one building.');
  }
  if (kind === 'floodOut') {
    const hard = weatherAt(city.seed, city.tick).precipitation === 2;
    return note('contested', hard
      ? 'Hard rain: the water will climb the street quickly.'
      : 'The water will spread only while the rain holds.');
  }
  if (kind === 'condemn') {
    return note('settled', 'The building comes down at once, and stays down until it is rebuilt.');
  }
  const b = building(city, target);
  const served = Boolean(b
    && (!DEFS[b.kind].needsGas || serviceAt(city.networks.gas, b.id))
    && (!DEFS[b.kind].needsDrain || serviceAt(city.networks.drain, b.id)));
  return note(served ? 'settled' : 'contested', served
    ? 'The room has the services a refuge needs.'
    : 'Heat or drains may fail the public room.');
}

export function apply(city: City, kind: InterventionKind, target: Target): boolean {
  if (canApply(city, kind, target)) return false;
  const def = INTERVENTIONS[kind];
  const traced = def.heat > 55;
  city.nudges.push({ tick: city.tick, kind, target, exposure: exposureOf(kind), traced });
  const text = def.apply(city, target);
  noteMatterResponse(city, kind, target);
  applyPressure(city.press, 'suspicion', def.heat, 'intervention', target.id, def.label.toLowerCase(), city.tick);
  city.traced += traced ? 1 : 0;
  pushLog(city, text, kind === 'fundBunting' || kind === 'fileWorks' || kind === 'callDeputation' || kind === 'openShelter' ? 'gain' : 'loss');
  return true;
}

/** Where a nudge landed, in words, for the inspector. */
export function describeTarget(city: City, target: Target): string {
  switch (target.kind) {
    case 'soul': return city.souls[target.id] ? fullName(city.souls[target.id]) : 'nobody';
    case 'building': {
      const b = city.buildings[target.id];
      return b ? `${b.name}, ${addressOf(city, b)}` : 'nowhere';
    }
    default: return 'the district';
  }
}
