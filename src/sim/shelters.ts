// Storm refuges are a physical service, not a morale button. A provider opens
// its doors for a few hours, selected people walk there, and relief happens only
// once their body is actually inside.
import type { City } from './city';
import { pushLog, resumeCurrentBlock, sendTo } from './city';
import { DEFS } from './buildings';
import { isBuildingClosed } from './disasters';
import { serviceAt } from './networks';
import { mix, Stream } from './rng';
import type { BuildingId, SoulId } from './types';
import { isWetWeather, weatherAt } from './weather';
import { recordCivicRelief } from './civic-memory';

export interface Shelter {
  id: number;
  providerId: BuildingId;
  openedAt: number;
  endsAt: number;
  capacity: number;
  guestIds: SoulId[];
  arrivedIds: SoulId[];
  relievedIds: SoulId[];
}

export interface ShelterState {
  current: Shelter | null;
  /** Changes when the refuge banner, awning, or inspector needs refreshing. */
  revision: number;
  nextId: number;
}

const PROVIDERS = new Set(['chapel', 'bathhouse', 'dispensary', 'townhall']);
const DURATION = 360;
const MAX_GUESTS = 12;

export function newShelters(): ShelterState {
  return { current: null, revision: 0, nextId: 0 };
}

export function isShelterActive(city: City): boolean {
  const current = city.shelters.current;
  return Boolean(current && city.tick < current.endsAt && !isBuildingClosed(city, current.providerId));
}

export function shelterSummary(city: City, buildingId: BuildingId): string {
  const shelter = city.shelters.current;
  if (!shelter || shelter.providerId !== buildingId || !isShelterActive(city)) return '';
  const provider = city.buildings[buildingId];
  const failedDrain = provider && DEFS[provider.kind].needsDrain
    && !serviceAt(city.networks.drain, provider.id);
  return `STORM REFUGE OPEN · ${shelter.arrivedIds.length}/${shelter.guestIds.length} ARRIVED${failedDrain ? ' · DRAINS FAILED' : ''}`;
}

function disasterDisplaced(city: City): Set<SoulId> {
  const out = new Set<SoulId>();
  for (const disaster of city.disasters.events) {
    for (const id of disaster.evacuatedIds) out.add(id);
  }
  return out;
}

/** Only people actually exposed outdoors are called in. */
function eligibleGuests(city: City, providerId: BuildingId): SoulId[] {
  const displaced = disasterDisplaced(city);
  const out: SoulId[] = [];
  for (const s of city.souls) {
    if (s.inId >= 0 || s.destBuilding === providerId) continue;
    if (s.activity === 'asleep' || s.activity === 'held' || s.activity === 'dead') continue;
    const vulnerable = s.age < 14 || s.activity === 'ailing' || s.health < 560 || s.warmth < 460 || displaced.has(s.id);
    if (vulnerable) out.push(s.id);
  }
  out.sort((a, b) => {
    const sa = city.souls[a];
    const sb = city.souls[b];
    const da = displaced.has(a) ? 1 : 0;
    const db = displaced.has(b) ? 1 : 0;
    if (da !== db) return db - da;
    const va = (sa.age < 14 ? 300 : 0) + (sa.activity === 'ailing' ? 220 : 0)
      + Math.max(0, 560 - sa.health) + Math.max(0, 460 - sa.warmth);
    const vb = (sb.age < 14 ? 300 : 0) + (sb.activity === 'ailing' ? 220 : 0)
      + Math.max(0, 560 - sb.health) + Math.max(0, 460 - sb.warmth);
    if (va !== vb) return vb - va;
    return mix(city.seed, Stream.Crowd, city.tick, a + providerId * 257)
      - mix(city.seed, Stream.Crowd, city.tick, b + providerId * 257) || a - b;
  });
  return out;
}

function capacityAt(city: City, providerId: BuildingId): number {
  const provider = city.buildings[providerId];
  if (!provider) return 0;
  return Math.max(0, Math.min(MAX_GUESTS, DEFS[provider.kind].capacity - provider.occupants.length));
}

/** Reason suitable for a disabled intervention row, or null when a door can open. */
export function canOpenShelter(city: City, providerId: BuildingId): string | null {
  if (city.shelters.current) return 'Another refuge is already open.';
  const provider = city.buildings[providerId];
  if (!provider || !PROVIDERS.has(provider.kind)) return 'That building cannot take in storm refugees.';
  if (!isWetWeather(weatherAt(city.seed, city.tick))) return 'There is no rain to shelter from.';
  if (isBuildingClosed(city, providerId)) return 'That building is closed.';
  if (capacityAt(city, providerId) <= 0) return 'There is no room inside.';
  if (!eligibleGuests(city, providerId).length) return 'Nobody vulnerable is out in the rain.';
  return null;
}

/** Call a small, ranked group to a real doorway. No one is helped until arrival. */
export function openShelter(city: City, providerId: BuildingId): number {
  if (canOpenShelter(city, providerId)) return 0;
  const capacity = capacityAt(city, providerId);
  const guestIds = eligibleGuests(city, providerId).slice(0, capacity);
  if (!guestIds.length) return 0;
  const shelter: Shelter = {
    id: city.shelters.nextId++, providerId, openedAt: city.tick, endsAt: city.tick + DURATION,
    capacity, guestIds, arrivedIds: [], relievedIds: [],
  };
  city.shelters.current = shelter;
  city.shelters.revision++;
  for (const id of guestIds) {
    const s = city.souls[id];
    s.overrideUntil = shelter.endsAt + 1;
    sendTo(city, s, providerId, 'commuting', 'visiting');
  }
  return guestIds.length;
}

function ownsGuest(city: City, shelter: Shelter, soulId: SoulId): boolean {
  const s = city.souls[soulId];
  if (!s) return false;
  return s.destBuilding === shelter.providerId || (s.inId === shelter.providerId && s.activity === 'visiting');
}

function closeShelter(city: City, shelter: Shelter, reason: string): void {
  for (const id of shelter.guestIds) {
    if (!ownsGuest(city, shelter, id)) continue;
    const s = city.souls[id];
    s.overrideUntil = city.tick;
    resumeCurrentBlock(city, s);
  }
  city.shelters.current = null;
  city.shelters.revision++;
  pushLog(city, reason, 'info');
}

/** Record physical arrivals and end the refuge when its time or safety ends. */
export function tickShelters(city: City): void {
  const shelter = city.shelters.current;
  if (!shelter) return;
  if (isBuildingClosed(city, shelter.providerId)) {
    closeShelter(city, shelter, 'The storm refuge has had to close.');
    return;
  }
  for (const id of shelter.guestIds) {
    const s = city.souls[id];
    if (!s || s.inId !== shelter.providerId || s.activity !== 'visiting') continue;
    if (!shelter.arrivedIds.includes(id)) {
      shelter.arrivedIds.push(id);
      city.shelters.revision++;
    }
    if (shelter.relievedIds.includes(id)) continue;
    const provider = city.buildings[shelter.providerId];
    const heated = provider && (!DEFS[provider.kind].needsGas || serviceAt(city.networks.gas, provider.id));
    const sanitary = provider && (!DEFS[provider.kind].needsDrain || serviceAt(city.networks.drain, provider.id));
    if (!sanitary) {
      // Predictable backfire: crowding vulnerable people behind a failed drain
      // makes the room warm and the people in it sicker.
      s.warmth = Math.min(1000, s.warmth + (heated ? 90 : 40));
      s.health = Math.max(0, s.health - 24);
      s.grievance = Math.min(1000, s.grievance + 35);
      recordCivicRelief(city, id, false);
    } else {
      s.warmth = Math.min(1000, s.warmth + (heated ? 160 : 70));
      s.health = Math.min(1000, s.health + (heated ? 28 : 14));
      s.grievance = Math.max(0, s.grievance - (heated ? 42 : 20));
      recordCivicRelief(city, id, true);
    }
    shelter.relievedIds.push(id);
    city.shelters.revision++;
  }
  if (city.tick >= shelter.endsAt) closeShelter(city, shelter, 'The storm refuge has closed for the night.');
}
