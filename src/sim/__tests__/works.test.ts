import { describe, expect, it } from 'vitest';
import { newCity, warp, hashWorld } from '../city';
import { apply, canApply } from '../interventions';
import { disconnectBuilding, serviceAt } from '../networks';
import { activeOrderFor, latestOrderFor, worksNeededAt } from '../works';
import { describeBuilding } from '../prose';

function fabricTarget(city: ReturnType<typeof newCity>) {
  const b = city.buildings.find((x) => x.drainSeg >= 0 && serviceAt(city.networks.drain, x.id)
    && (x.gasSeg < 0 || serviceAt(city.networks.gas, x.id))) as typeof city.buildings[number];
  b.fabric = 300;
  return b;
}

function runToResolution(city: ReturnType<typeof newCity>, buildingId: number): void {
  const order = latestOrderFor(city, buildingId);
  if (!order) throw new Error('order missing');
  warp(city, order.dueAt - city.tick + 60);
}

describe('the Works Register', () => {
  it('files a persistent case and refuses a duplicate at the same address', () => {
    const city = newCity('verdigris');
    warp(city, 600);
    const b = fabricTarget(city);

    expect(worksNeededAt(city, b.id)).toBe('fabric');
    expect(apply(city, 'fileWorks', { kind: 'building', id: b.id })).toBe(true);
    expect(activeOrderFor(city, b.id)?.status).toBe('filed');
    expect(canApply(city, 'fileWorks', { kind: 'building', id: b.id }))
      .toBe('That address is already in the register.');
    expect(city.nudges.at(-1)?.kind).toBe('fileWorks');
  });

  it('does not invent utility defects for buildings that do not need them', () => {
    const city = newCity('verdigris');
    const mast = city.buildings.find((b) => b.kind === 'mast');
    if (!mast) throw new Error('mast missing');
    mast.fabric = 900;
    expect(worksNeededAt(city, mast.id)).toBe(null);
  });

  it('turns an honest funded fabric order into actual structural work', () => {
    const city = newCity('verdigris');
    warp(city, 600);
    const b = fabricTarget(city);
    const beforeFacade = b.facade;
    city.press.pressures.rot.value = 280;
    city.press.pressures.coin.value = 820;

    apply(city, 'fileWorks', { kind: 'building', id: b.id });
    runToResolution(city, b.id);

    expect(latestOrderFor(city, b.id)?.status).toBe('completed');
    expect(b.fabric).toBeGreaterThan(400);
    expect(b.facade - beforeFacade).toBeLessThan(b.fabric - 300);
  });

  it('connects a real drain rather than poking sanitation directly', () => {
    const city = newCity('coppergate');
    warp(city, 600);
    const b = city.buildings.find((x) => x.doorNode >= 0) as typeof city.buildings[number];
    disconnectBuilding(city.networks.drain, b.id);
    b.drainSeg = -1;
    city.press.pressures.rot.value = 280;
    city.press.pressures.coin.value = 820;
    const sanitation = city.press.pressures.sanitation.value;

    apply(city, 'fileWorks', { kind: 'building', id: b.id });
    expect(latestOrderFor(city, b.id)?.kind).toBe('drain');
    runToResolution(city, b.id);

    expect(serviceAt(city.networks.drain, b.id)).toBe(true);
    expect(city.press.pressures.sanitation.value).not.toBe(sanitation);
  });

  it('papers over the same defect when rot has eaten the order', () => {
    const city = newCity('verdigris');
    warp(city, 600);
    const b = fabricTarget(city);
    b.facade = 500;
    const fabric = b.fabric;
    const facade = b.facade;
    city.press.pressures.rot.value = 900;
    city.press.pressures.rot.baseline = 900;
    city.press.pressures.coin.value = 820;

    apply(city, 'fileWorks', { kind: 'building', id: b.id });
    runToResolution(city, b.id);

    expect(latestOrderFor(city, b.id)?.status).toBe('skimmed');
    expect(b.fabric).toBeLessThanOrEqual(fabric);
    expect(b.facade).toBeGreaterThan(facade);
    expect(describeBuilding(city, b.id)).toContain('fresh paint and a new brass plaque');
  });

  it('replays work orders exactly from the same seed and actions', () => {
    const play = (): number => {
      const city = newCity('verdigris');
      warp(city, 600);
      const b = fabricTarget(city);
      city.press.pressures.rot.value = 280;
      city.press.pressures.coin.value = 820;
      apply(city, 'fileWorks', { kind: 'building', id: b.id });
      runToResolution(city, b.id);
      return hashWorld(city);
    };
    expect(play()).toBe(play());
  });
});
