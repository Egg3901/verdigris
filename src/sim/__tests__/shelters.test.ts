import { describe, expect, it } from 'vitest';
import { hashWorld, newCity, tickCity, warp } from '../city';
import { canOpenShelter, openShelter } from '../shelters';
import { isWetWeather, weatherAt } from '../weather';
import { breakSegment } from '../networks';

type City = ReturnType<typeof newCity>;

function atWetDay(seed = 'verdigris'): City {
  const city = newCity(seed);
  for (let tick = 420; tick < 1440 * 40; tick += 60) {
    const weather = weatherAt(city.seed, tick);
    const minute = tick % 1440;
    if (minute >= 420 && minute <= 1200 && isWetWeather(weather)) {
      warp(city, tick);
      return city;
    }
  }
  throw new Error('wet daytime watch missing');
}

function atFairDay(seed = 'verdigris'): City {
  const city = newCity(seed);
  for (let tick = 420; tick < 1440 * 40; tick += 60) {
    const weather = weatherAt(city.seed, tick);
    const minute = tick % 1440;
    if (minute >= 420 && minute <= 1200 && !isWetWeather(weather)) {
      warp(city, tick);
      return city;
    }
  }
  throw new Error('fair daytime watch missing');
}

function providerId(city: City): number {
  const provider = city.buildings.find((b) => b.kind === 'chapel' || b.kind === 'bathhouse'
    || b.kind === 'dispensary' || b.kind === 'townhall');
  if (!provider) throw new Error('shelter provider missing');
  return provider.id;
}

function vulnerableOutdoor(city: City): number {
  const soul = city.souls.find((s) => s.inId < 0 && s.activity !== 'held' && s.activity !== 'dead');
  if (!soul) throw new Error('outdoor soul missing');
  soul.age = 6;
  soul.health = 0;
  soul.warmth = 0;
  return soul.id;
}

describe('storm refuges', () => {
  it('only opens a suitable public door during rain', () => {
    const fair = atFairDay();
    const fairProvider = providerId(fair);
    expect(canOpenShelter(fair, fairProvider)).toBe('There is no rain to shelter from.');

    const wet = atWetDay();
    const unsuitable = wet.buildings.find((b) => b.kind === 'shop');
    if (!unsuitable) throw new Error('shop missing');
    expect(canOpenShelter(wet, unsuitable.id)).toBe('That building cannot take in storm refugees.');
  });

  it('calls a deterministic capacity-limited group and only relieves them after arrival', () => {
    const city = atWetDay();
    const provider = providerId(city);
    const soulId = vulnerableOutdoor(city);
    const soul = city.souls[soulId];
    const before = { health: soul.health, warmth: soul.warmth, grievance: soul.grievance };

    const called = openShelter(city, provider);
    const shelter = city.shelters.current;
    if (!shelter) throw new Error('shelter did not open');
    expect(called).toBeGreaterThan(0);
    expect(shelter.guestIds).toContain(soulId);
    expect(shelter.guestIds.length).toBeLessThanOrEqual(shelter.capacity);
    expect(shelter.relievedIds).toEqual([]);
    expect(soul.destBuilding).toBe(provider);
    expect(soul.health).toBe(before.health);
    expect(soul.warmth).toBe(before.warmth);
    expect(soul.grievance).toBe(before.grievance);

    for (let minute = 0; minute < 120 && !shelter.relievedIds.includes(soulId); minute++) tickCity(city);
    expect(shelter.arrivedIds).toContain(soulId);
    expect(shelter.relievedIds).toContain(soulId);
    expect(soul.inId).toBe(provider);
    expect(soul.health).toBeGreaterThan(before.health);
    expect(soul.warmth).toBeGreaterThan(before.warmth);
    expect(soul.grievance).toBeLessThan(before.grievance);
  });

  it('includes refuge state in the hash and stays exact across split time', () => {
    const a = atWetDay('coppergate');
    const b = atWetDay('coppergate');
    const providerA = providerId(a);
    const providerB = providerId(b);
    vulnerableOutdoor(a);
    vulnerableOutdoor(b);
    const ordinary = hashWorld(a);
    expect(openShelter(a, providerA)).toBeGreaterThan(0);
    expect(openShelter(b, providerB)).toBeGreaterThan(0);
    expect(hashWorld(a)).not.toBe(ordinary);
    warp(a, 120);
    warp(b, 60);
    warp(b, 60);
    expect(hashWorld(b)).toBe(hashWorld(a));
  });

  it('releases the guests when the refuge expires', () => {
    const city = atWetDay('jubilee');
    const provider = providerId(city);
    vulnerableOutdoor(city);
    expect(openShelter(city, provider)).toBeGreaterThan(0);
    const endsAt = city.shelters.current?.endsAt ?? -1;
    warp(city, endsAt - city.tick);
    expect(city.shelters.current).toBeNull();
  });

  it('backfires when vulnerable people are crowded behind a failed drain', () => {
    const city = atWetDay('mercy');
    const provider = providerId(city);
    const building = city.buildings[provider];
    if (building.drainSeg < 0) throw new Error('provider drain missing');
    breakSegment(city.networks.drain, building.drainSeg, city.tick);
    const soulId = vulnerableOutdoor(city);
    const soul = city.souls[soulId];
    soul.health = 1000;
    expect(openShelter(city, provider)).toBeGreaterThan(0);
    const shelter = city.shelters.current;
    if (!shelter) throw new Error('shelter did not open');
    for (let minute = 0; minute < 120 && !shelter.relievedIds.includes(soulId); minute++) tickCity(city);
    expect(shelter.relievedIds).toContain(soulId);
    expect(soul.health).toBeLessThan(1000);
  });

  it('closes and redirects its guests if the provider becomes a disaster site', () => {
    const city = atWetDay('blackwater');
    const provider = providerId(city);
    vulnerableOutdoor(city);
    expect(openShelter(city, provider)).toBeGreaterThan(0);
    const guests = city.shelters.current?.guestIds.slice() ?? [];
    city.disasters.events.push({
      id: 999, kind: 'flood', buildingId: provider, affectedBuildingIds: [provider], evacuatedIds: [],
      startedAt: city.tick, containedAt: city.tick + 60, clearsAt: city.tick + 1440,
      severity: 800, status: 'active', brokenSegment: -1,
    });

    tickCity(city);
    expect(city.shelters.current).toBeNull();
    for (const id of guests) expect(city.souls[id].inId).not.toBe(provider);
  });
});
