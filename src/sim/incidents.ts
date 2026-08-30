// Named things that go wrong on their own.
//
// Incidents fire from pressure thresholds with HYSTERESIS and a cooldown. Without
// the hysteresis band a pressure sitting on a threshold chatters an incident
// every hour, and the ticker becomes noise the player learns to ignore, which is
// worse than having no ticker.
//
// Every incident carries the cause chain that produced it, so "why did the mill
// walk out" is answerable from the ring rather than from the player's memory.
import { applyPressure, explain, pressureOf } from './pressures';
import type { Cause } from './pressures';
import { emit, witnessesOf } from './events';
import { seedClaim, implant } from './claims';
import type { City } from './city';
import { pushLog } from './city';
import type { BuildingId, PressureKey, SoulId } from './types';

export interface IncidentDef {
  id: string;
  label: string;
  key: PressureKey;
  /** Fires when the pressure crosses this, clears only when it recovers past
   *  clearAt. The gap between them is the hysteresis band. */
  fireBelow?: number;
  fireAbove?: number;
  clearAt: number;
  cooldownHours: number;
  /** Words for the ticker. State, not drama. */
  say: (city: City) => string;
}

// Thresholds are set from the band the system ACTUALLY produces, measured over
// thirty unattended game-days: rot 360 to 760, sanitation 540 to 680, mood 495 to
// 572, wages 420 to 510, coin 394 to 532, suspicion 188 to 306. Thresholds picked
// on intuition instead sat outside that band entirely, and in thirty days exactly
// one incident type could ever fire.
export const INCIDENTS: readonly IncidentDef[] = [
  {
    id: 'lampFailure', label: 'the lamps did not light', key: 'gas',
    fireBelow: 700, clearAt: 840, cooldownHours: 12,
    say: () => 'Half the district lamps failed at lighting-up time.',
  },
  {
    id: 'outbreak', label: 'sickness', key: 'sanitation',
    fireBelow: 470, clearAt: 560, cooldownHours: 24,
    say: () => 'The dispensary reports more patients than it has chairs.',
  },
  {
    id: 'walkout', label: 'a walkout', key: 'wages',
    fireBelow: 380, clearAt: 470, cooldownHours: 36,
    say: () => 'The mill wages were not paid, and the frames are standing.',
  },
  {
    id: 'riot', label: 'a disturbance', key: 'mood',
    fireBelow: 430, clearAt: 520, cooldownHours: 48,
    say: () => 'A disorderly crowd formed in the square after closing time.',
  },
  {
    id: 'inquiry', label: 'an inquiry', key: 'suspicion',
    fireAbove: 430, clearAt: 330, cooldownHours: 36,
    say: (c) => (pressureOf(c.press, 'rot') > 520
      ? 'The council has appointed an inquiry, though the office is expected to return no finding.'
      : 'The council has appointed an inquiry with authority to examine the account.'),
  },
];

export interface Incident {
  id: number;
  defId: string;
  tick: number;
  placeId: BuildingId;
  soulIds: SoulId[];
  severity: number;
  /** The cause ring, snapshotted at the moment it fired. This is the answer to
   *  "why", and it has to be captured now: the ring is 512 entries and by the
   *  time the player asks, the reason may have rolled off it. */
  because: Cause[];
}

export interface IncidentState {
  live: Incident[];
  /** defId to the tick it last fired, for the cooldown. */
  lastFired: Map<string, number>;
  /** defId to whether it is currently latched, for the hysteresis. */
  latched: Set<string>;
  next: number;
}

export function newIncidents(): IncidentState {
  return { live: [], lastFired: new Map(), latched: new Set(), next: 0 };
}

export function checkIncidents(city: City, tick: number): void {
  const st = city.incidents;
  for (const def of INCIDENTS) {
    const value = pressureOf(city.press, def.key);
    const tripped = def.fireBelow !== undefined ? value < def.fireBelow : value > (def.fireAbove ?? 1e9);
    const cleared = def.fireBelow !== undefined ? value > def.clearAt : value < def.clearAt;

    if (st.latched.has(def.id)) {
      if (cleared) st.latched.delete(def.id);
      continue;
    }
    if (!tripped) continue;

    const last = st.lastFired.get(def.id) ?? -1e9;
    if (tick - last < def.cooldownHours * 60) continue;

    st.latched.add(def.id);
    st.lastFired.set(def.id, tick);
    fire(city, def, tick);
  }
  // Incidents older than a day stop being live, but they stay in the log.
  st.live = st.live.filter((i) => tick - i.tick < 1440);
}

function fire(city: City, def: IncidentDef, tick: number): void {
  const place = pickPlace(city, def);
  const seen = place >= 0 ? witnessesOf(city, place) : [];
  let subjects = seen;
  if (def.id === 'outbreak') {
    const household = city.households
      .filter((item) => item.memberIds.length >= 2)
      .map((item) => ({
        item,
        health: Math.round(item.memberIds.reduce((sum, id) => sum + city.souls[id].health, 0) / item.memberIds.length),
      }))
      .sort((a, b) => a.health - b.health || a.item.id - b.item.id)[0]?.item;
    if (household) {
      subjects = household.memberIds.slice(0, 6);
      for (const id of subjects) {
        const soul = city.souls[id];
        soul.health = Math.max(0, soul.health - 160);
        if (soul.health < 500) soul.activity = 'ailing';
      }
    }
  }
  const incident: Incident = {
    id: city.incidents.next++,
    defId: def.id,
    tick,
    placeId: place,
    soulIds: subjects.slice(0, 12),
    severity: Math.abs(500 - pressureOf(city.press, def.key)),
    because: explain(city.press, def.key, 5),
  };
  city.incidents.live.push(incident);
  if (place >= 0) city.buildings[place].lastIncidentTick = tick;

  emit(city.events, def.id, place, incident.soulIds, incident.severity, tick);

  // An incident is observable, so it becomes something people believe. This is
  // the join between the mechanical layer and the social one.
  const claimKind = def.id === 'outbreak' ? 'sickness'
    : def.id === 'collapse' ? 'collapse'
      : def.id === 'inquiry' ? 'graft'
        : def.id === 'walkout' ? 'closure' : 'sabotage';
  if (incident.soulIds.length) {
    const claim = seedClaim(city.claims, claimKind, incident.soulIds[0], -1, place, 1, tick);
    for (const id of incident.soulIds) implant(city.claims, city.souls[id], claim, 640, -1, tick);
  }

  switch (def.id) {
    case 'outbreak':
      applyPressure(city.press, 'mood', -70, 'incident', incident.id, def.label, tick);
      break;
    case 'walkout':
      for (const f of city.firms) if (f.kind === 'mill' || f.kind === 'foundry') f.strikeUntil = tick + 1440;
      break;
    case 'riot':
      applyPressure(city.press, 'suspicion', 90, 'incident', incident.id, def.label, tick);
      break;
    case 'inquiry':
      applyPressure(city.press, 'coin', -60, 'incident', incident.id, def.label, tick);
      if (pressureOf(city.press, 'rot') > 520) {
        applyPressure(city.press, 'suspicion', 60, 'incident', incident.id, 'a whitewash', tick);
      } else {
        applyPressure(city.press, 'rot', -80, 'incident', incident.id, 'an inquiry that looked', tick);
      }
      break;
    default:
      break;
  }

  pushLog(city, def.say(city), 'loss');
}

function pickPlace(city: City, def: IncidentDef): BuildingId {
  const want = def.id === 'outbreak' ? 'dispensary'
    : def.id === 'walkout' ? 'mill'
      : def.id === 'riot' ? 'townhall'
        : def.id === 'inquiry' ? 'townhall'
          : def.id === 'lampFailure' ? 'gasworks' : 'chapel';
  const list = city.buildingsByKind.get(want as never);
  return list && list.length ? list[0] : -1;
}

/** The ripple, one line per hop. This is what makes the consequences legible. */
export function explainIncident(city: City, incident: Incident): string[] {
  const def = INCIDENTS.find((d) => d.id === incident.defId);
  const out = [def ? def.label : incident.defId];
  for (const c of incident.because) {
    out.push(`${c.delta > 0 ? 'up' : 'down'} ${Math.abs(c.delta)} on ${c.key}: ${c.note}`);
  }
  void city;
  return out;
}
