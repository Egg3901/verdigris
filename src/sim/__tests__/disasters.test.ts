import { describe, expect, it } from 'vitest';
import { hashWorld, newCity, sendTo, tickCity, warp } from '../city';
import { DEFS } from '../buildings';
import { disasterAt, isBuildingClosed, startDisaster } from '../disasters';
import { apply } from '../interventions';
import { servedCount, serviceAt } from '../networks';
import { latestOrderFor } from '../works';
import { weatherAt } from '../weather';
import { cellKey } from '../district';

type City = ReturnType<typeof newCity>;

function atWorkday(): City {
  const city = newCity('verdigris');
  warp(city, 600);
  return city;
}

function firmTarget(city: City, predicate: (id: number) => boolean): number {
  const target = city.buildings.find((b) => b.firmId >= 0
    && b.householdIds.length === 0
    && !DEFS[b.kind].landmark
    && predicate(b.id));
  if (!target) throw new Error('disaster target missing');
  return target.id;
}

function fireTarget(city: City, occupied = false): number {
  return firmTarget(city, (id) => {
    const b = city.buildings[id];
    return b.gasSeg >= 0 && serviceAt(city.networks.gas, id)
      && (!occupied || b.occupants.length > 0);
  });
}

function floodTarget(city: City): number {
  return firmTarget(city, (id) => {
    const b = city.buildings[id];
    const riverY = city.river.centre[b.doorX];
    return b.drainSeg >= 0
      && serviceAt(city.networks.drain, id)
      && riverY >= 0
      && Math.abs(b.doorY - riverY) <= city.river.halfWidth[b.doorX] + 3;
  });
}

function collapseTarget(city: City): number {
  const wharf = city.buildings.find((b) => b.kind === 'wharfshed'
    && b.firmId >= 0 && b.householdIds.length === 0);
  if (!wharf) throw new Error('wharf shed missing');
  return wharf.id;
}

function makeOrdinaryFirmsSound(city: City): void {
  for (const b of city.buildings) {
    if (b.firmId >= 0 && b.householdIds.length === 0 && !DEFS[b.kind].landmark) b.fabric = 700;
  }
}

function advanceUntilNextHour(city: City, when: (kind: ReturnType<typeof weatherAt>) => boolean): void {
  for (let hour = 0; hour < 96; hour++) {
    if (when(weatherAt(city.seed, city.tick + 60))) return;
    warp(city, 60);
  }
  throw new Error('weather condition missing');
}

describe('physical disasters', () => {
  it('forces a fire through a live gas main, evacuating occupants and closing the firm', () => {
    const city = atWorkday();
    const id = fireTarget(city, true);
    const building = city.buildings[id];
    const occupants = building.occupants.slice();
    const beforeServed = servedCount(city.networks.gas);

    const fire = startDisaster(city, 'fire', id);
    if (!fire) throw new Error('fire did not start');

    expect(fire.brokenSegment).toBe(building.gasSeg);
    expect(city.networks.gas.segBroken[fire.brokenSegment]).toBe(1);
    expect(serviceAt(city.networks.gas, id)).toBe(false);
    expect(servedCount(city.networks.gas)).toBeLessThan(beforeServed);
    expect(fire.evacuatedIds).toEqual(occupants);
    for (const soulId of fire.evacuatedIds) {
      const soul = city.souls[soulId];
      expect(soul.inId).toBe(-1);
      expect(soul.destBuilding).toBe(soul.homeId);
    }
    expect(city.firms[building.firmId].closedUntil).toBe(fire.containedAt);
  });

  it('turns away a soul whose destination catches fire while they are walking', () => {
    const city = atWorkday();
    const id = fireTarget(city);
    const soul = city.souls.find((candidate) => candidate.inId >= 0
      && candidate.inId !== id && candidate.homeId !== id);
    if (!soul) throw new Error('traveller missing');
    sendTo(city, soul, id, 'commuting', 'working');
    expect(soul.destBuilding).toBe(id);
    expect(startDisaster(city, 'fire', id)).not.toBeNull();

    let redirected = false;
    for (let minute = 0; minute < 359; minute++) {
      tickCity(city);
      expect(soul.inId).not.toBe(id);
      if (soul.destBuilding !== id) redirected = true;
    }
    expect(redirected).toBe(true);
  });

  it('forces a riverside flood through the actual drain tree', () => {
    const city = atWorkday();
    const id = floodTarget(city);
    const building = city.buildings[id];
    const beforeServed = servedCount(city.networks.drain);

    const flood = startDisaster(city, 'flood', id);
    if (!flood) throw new Error('flood did not start');

    expect(flood.brokenSegment).toBe(building.drainSeg);
    expect(city.networks.drain.segBroken[flood.brokenSegment]).toBe(1);
    expect(serviceAt(city.networks.drain, id)).toBe(false);
    expect(servedCount(city.networks.drain)).toBeLessThan(beforeServed);
    expect(flood.affectedBuildingIds).toContain(id);
  });

  it('evacuates every occupied flooded address to somewhere outside the water', () => {
    const city = newCity('verdigris');
    warp(city, 180);
    const id = firmTarget(city, (buildingId) => {
      const target = city.buildings[buildingId];
      const riverY = city.river.centre[target.doorX];
      if (target.drainSeg < 0 || !serviceAt(city.networks.drain, target.id)
        || riverY < 0 || Math.abs(target.doorY - riverY) > city.river.halfWidth[target.doorX] + 3) return false;
      return city.buildings
        .filter((b) => Math.abs(b.doorX - target.doorX) + Math.abs(b.doorY - target.doorY) <= 5)
        .sort((a, b) => (Math.abs(a.doorX - target.doorX) + Math.abs(a.doorY - target.doorY))
          - (Math.abs(b.doorX - target.doorX) + Math.abs(b.doorY - target.doorY)) || a.id - b.id)
        .slice(0, 8)
        .some((b) => b.occupants.length > 0);
    });
    const flood = startDisaster(city, 'flood', id);
    if (!flood) throw new Error('flood did not start');

    expect(flood.evacuatedIds.length).toBeGreaterThan(0);
    for (const soulId of flood.evacuatedIds) {
      const soul = city.souls[soulId];
      expect(flood.affectedBuildingIds).not.toContain(soul.destBuilding);
    }
  });

  it('turns a collapse into fabric-zero damage that completed Works can reopen', () => {
    const city = atWorkday();
    const id = collapseTarget(city);
    const collapse = startDisaster(city, 'collapse', id);
    if (!collapse) throw new Error('collapse did not start');
    expect(city.buildings[id].fabric).toBe(0);
    expect(isBuildingClosed(city, id)).toBe(true);

    city.press.pressures.rot.value = 260;
    city.press.pressures.rot.baseline = 260;
    city.press.pressures.coin.value = 820;
    expect(apply(city, 'fileWorks', { kind: 'building', id })).toBe(true);
    const order = latestOrderFor(city, id);
    if (!order) throw new Error('repair order missing');
    expect(order.kind).toBe('fabric');

    warp(city, collapse.containedAt - city.tick);
    expect(order.status).toBe('completed');
    expect(city.buildings[id].fabric).toBeGreaterThan(0);
    expect(isBuildingClosed(city, id)).toBe(false);
  });

  it('revises at containment and removal while the physical damage remains', () => {
    const city = atWorkday();
    const id = fireTarget(city);
    const beforeFabric = city.buildings[id].fabric;
    const fire = startDisaster(city, 'fire', id);
    if (!fire) throw new Error('fire did not start');
    const startedRevision = city.disasters.revision;

    warp(city, fire.containedAt - city.tick);
    expect(fire.status).toBe('contained');
    expect(city.disasters.revision).toBeGreaterThan(startedRevision);
    const containedRevision = city.disasters.revision;

    warp(city, fire.clearsAt - city.tick);
    expect(disasterAt(city, id)).toBeNull();
    expect(city.disasters.revision).toBeGreaterThan(containedRevision);
    expect(city.buildings[id].fabric).toBeLessThan(beforeFabric);
  });

  it('keeps disaster state in the hash and remains exact across a split warp', () => {
    const ordinary = atWorkday();
    const a = atWorkday();
    const b = atWorkday();
    const id = fireTarget(a);
    expect(hashWorld(a)).toBe(hashWorld(ordinary));
    expect(startDisaster(a, 'fire', id)).not.toBeNull();
    expect(hashWorld(a)).not.toBe(hashWorld(ordinary));

    const bId = fireTarget(b);
    expect(startDisaster(b, 'fire', bId)).not.toBeNull();
    warp(a, 720);
    warp(b, 360);
    warp(b, 360);
    expect(hashWorld(b)).toBe(hashWorld(a));
  });

  it('refuses a second disaster of the same kind while the first remains recorded', () => {
    const city = atWorkday();
    const id = fireTarget(city);
    expect(startDisaster(city, 'fire', id)).not.toBeNull();
    expect(startDisaster(city, 'fire', id)).toBeNull();
    expect(city.disasters.events.filter((event) => event.kind === 'fire')).toHaveLength(1);
  });

  it('lets all three kinds arise naturally from their physical conditions', () => {
    const collapseCity = atWorkday();
    makeOrdinaryFirmsSound(collapseCity);
    const collapseId = collapseTarget(collapseCity);
    collapseCity.buildings[collapseId].fabric = 100;
    collapseCity.press.pressures.rot.value = 800;
    collapseCity.press.pressures.rot.baseline = 800;
    warp(collapseCity, 60);
    expect(collapseCity.disasters.events.at(-1)?.kind).toBe('collapse');
    expect(collapseCity.disasters.events.at(-1)?.buildingId).toBe(collapseId);

    const fireCity = atWorkday();
    makeOrdinaryFirmsSound(fireCity);
    advanceUntilNextHour(fireCity, (weather) => weather.precipitation === 0);
    const fireId = fireTarget(fireCity);
    fireCity.buildings[fireId].fabric = 300;
    fireCity.press.pressures.rot.value = 650;
    fireCity.press.pressures.rot.baseline = 650;
    warp(fireCity, 60);
    expect(fireCity.disasters.events.at(-1)?.kind).toBe('fire');
    expect(fireCity.disasters.events.at(-1)?.buildingId).toBe(fireId);

    const floodCity = atWorkday();
    makeOrdinaryFirmsSound(floodCity);
    advanceUntilNextHour(floodCity, (weather) => weather.precipitation > 0);
    const floodId = floodTarget(floodCity);
    floodCity.buildings[floodId].fabric = 400;
    floodCity.press.pressures.rot.value = 300;
    floodCity.press.pressures.rot.baseline = 300;
    floodCity.press.pressures.sanitation.value = 300;
    floodCity.press.pressures.sanitation.baseline = 300;
    warp(floodCity, 60);
    expect(floodCity.disasters.events.at(-1)?.kind).toBe('flood');
    expect(floodCity.disasters.events.at(-1)?.buildingId).toBe(floodId);
  });

  it('carries fire to a touching building and brands every shell it reaches', () => {
    const city = atWorkday();
    // Advance to a dry watch boundary, so the whole active window shares fair
    // weather and the fire is free to jump.
    for (let i = 0; i < 200
      && !(city.tick % 360 === 0 && weatherAt(city.seed, city.tick).precipitation === 0); i++) {
      warp(city, 60);
    }
    // A dry, rotten quarter: low fabric everywhere and rot pinned high.
    for (const b of city.buildings) if (b.firmId >= 0) b.fabric = 300;
    city.press.pressures.rot.value = 950;
    city.press.pressures.rot.baseline = 950;

    // A fire origin whose cells physically touch another non-landmark building.
    const d = city.district;
    let origin = -1;
    for (const b of city.buildings) {
      if (!(b.firmId >= 0 && b.householdIds.length === 0 && !DEFS[b.kind].landmark
        && b.gasSeg >= 0 && serviceAt(city.networks.gas, b.id))) continue;
      let touches = false;
      for (const k of b.cells) {
        const x = k % d.width;
        const y = (k - x) / d.width;
        for (let dy = -1; dy <= 1 && !touches; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= d.width || ny >= d.height) continue;
            const nb = d.buildingId[cellKey(d, nx, ny)];
            if (nb >= 0 && nb !== b.id && !DEFS[city.buildings[nb].kind].landmark) { touches = true; break; }
          }
        }
      }
      if (touches) { origin = b.id; break; }
    }
    if (origin < 0) throw new Error('no touching building pair in this district');

    const fire = startDisaster(city, 'fire', origin);
    if (!fire) throw new Error('fire did not start');
    warp(city, fire.containedAt - city.tick);

    expect(fire.affectedBuildingIds.length).toBeGreaterThan(1);
    for (const id of fire.affectedBuildingIds) {
      expect(city.buildings[id].burntAt).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps a burnt-out shell charred until its fabric is made good', () => {
    const city = atWorkday();
    const id = fireTarget(city);
    // A poor building, so the damage leaves it well below the recovery threshold.
    city.buildings[id].fabric = 300;
    const fire = startDisaster(city, 'fire', id);
    if (!fire) throw new Error('fire did not start');
    expect(city.buildings[id].burntAt).toBeGreaterThanOrEqual(0);

    // The event ends but the scar does not: the shell is still charred.
    warp(city, fire.clearsAt - city.tick);
    expect(disasterAt(city, id)).toBeNull();
    expect(city.buildings[id].burntAt).toBeGreaterThanOrEqual(0);

    // Rebuild the fabric, and within the hour the scar clears and the compositor
    // is told to re-flatten the address.
    city.buildings[id].fabric = 900;
    const rev = city.disasters.revision;
    warp(city, 60);
    expect(city.buildings[id].burntAt).toBe(-1);
    expect(city.disasters.revision).toBeGreaterThan(rev);
  });

  it('requires rain for a natural flood and dry weather for a natural fire', () => {
    const dryFlood = atWorkday();
    makeOrdinaryFirmsSound(dryFlood);
    advanceUntilNextHour(dryFlood, (weather) => weather.precipitation === 0);
    const floodId = floodTarget(dryFlood);
    dryFlood.buildings[floodId].fabric = 400;
    dryFlood.press.pressures.rot.value = 300;
    dryFlood.press.pressures.rot.baseline = 300;
    dryFlood.press.pressures.sanitation.value = 300;
    dryFlood.press.pressures.sanitation.baseline = 300;
    warp(dryFlood, 60);
    expect(dryFlood.disasters.events.some((event) => event.kind === 'flood')).toBe(false);

    const wetFire = atWorkday();
    makeOrdinaryFirmsSound(wetFire);
    advanceUntilNextHour(wetFire, (weather) => weather.precipitation > 0);
    const fireId = fireTarget(wetFire);
    wetFire.buildings[fireId].fabric = 300;
    wetFire.press.pressures.rot.value = 650;
    wetFire.press.pressures.rot.baseline = 650;
    warp(wetFire, 60);
    expect(wetFire.disasters.events.some((event) => event.kind === 'fire')).toBe(false);
  });
});
