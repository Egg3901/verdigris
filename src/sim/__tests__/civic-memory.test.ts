import { describe, expect, it } from 'vitest';
import { hashWorld, newCity, warp } from '../city';
import { startDisaster } from '../disasters';
import { apply } from '../interventions';
import { civicHouseholdBurden, civicRecordAt } from '../civic-memory';
import { latestOrderFor } from '../works';
import { serviceAt } from '../networks';
import { DEFS } from '../buildings';

type City = ReturnType<typeof newCity>;

function atWorkday(seed = 'verdigris'): City {
  const city = newCity(seed);
  warp(city, 600);
  return city;
}

function fireTarget(city: City): number {
  const building = city.buildings.find((b) => b.firmId >= 0 && b.householdIds.length === 0
    && !DEFS[b.kind].landmark && b.gasSeg >= 0 && serviceAt(city.networks.gas, b.id));
  if (!building) throw new Error('fire target missing');
  return building.id;
}

function homeTarget(city: City): number {
  const building = city.buildings.find((b) => b.householdIds.length > 0 && b.fabric < 760);
  if (!building) throw new Error('home target missing');
  return building.id;
}

describe('civic memory', () => {
  it('keeps a bounded household record after a physical disaster clears', () => {
    const city = atWorkday();
    const id = fireTarget(city);
    const before = hashWorld(city);
    const fire = startDisaster(city, 'fire', id);
    if (!fire) throw new Error('fire missing');
    const record = civicRecordAt(city, id);
    if (!record) throw new Error('record missing');

    expect(hashWorld(city)).not.toBe(before);
    expect(record.cause).toBe('fire');
    expect(record.verdict).toBe('open');
    expect(record.householdIds.length).toBeGreaterThan(0);
    expect(record.householdIds.length).toBeLessThanOrEqual(12);
    expect(record.householdIds.some((householdId) => civicHouseholdBurden(city, householdId) > 0)).toBe(true);

    warp(city, fire.clearsAt - city.tick);
    expect(civicRecordAt(city, id)?.cause).toBe('fire');
    expect(civicRecordAt(city, id)?.verdict).toBe('open');
  });

  it('turns a completed repair into lasting household recovery', () => {
    const city = atWorkday('coppergate');
    const id = homeTarget(city);
    const building = city.buildings[id];
    building.fabric = 300;
    city.press.pressures.rot.value = 280;
    city.press.pressures.rot.baseline = 280;
    city.press.pressures.coin.value = 820;
    city.press.pressures.coin.baseline = 820;

    expect(apply(city, 'fileWorks', { kind: 'building', id })).toBe(true);
    const order = latestOrderFor(city, id);
    if (!order) throw new Error('works order missing');
    const record = civicRecordAt(city, id);
    if (!record) throw new Error('record missing');
    expect(record.cause).toBe('fabric');
    expect(record.worksOrderId).toBe(order.id);

    const householdId = record.householdIds[0];
    city.civic.householdBurden[householdId] = 260;
    warp(city, order.dueAt - city.tick);
    expect(order.status).toBe('completed');
    expect(record.verdict).toBe('madeGood');
    const afterRepair = civicHouseholdBurden(city, householdId);
    expect(afterRepair).toBeLessThan(260);

    const nextDaily = Math.ceil((city.tick + 1) / 1440) * 1440 + 180;
    warp(city, nextDaily - city.tick);
    expect(civicHouseholdBurden(city, householdId)).toBeLessThan(afterRepair);
  });

  it('is exact across split time once a civic case exists', () => {
    const a = atWorkday('jubilee');
    const b = atWorkday('jubilee');
    const id = fireTarget(a);
    expect(startDisaster(a, 'fire', id)).not.toBeNull();
    expect(startDisaster(b, 'fire', id)).not.toBeNull();

    warp(a, 360);
    warp(b, 120);
    warp(b, 240);
    expect(hashWorld(b)).toBe(hashWorld(a));
  });
});
