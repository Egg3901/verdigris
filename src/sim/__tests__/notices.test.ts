import { describe, expect, it } from 'vitest';
import { hashWorld, newCity } from '../city';
import { apply } from '../interventions';
import { activeMatters, noteNoticeResponse, openDailyMatters, tickMatters } from '../matters';
import {
  canServeNotice, canSummonNotice, serveNotice, summonOnNotice, tickNoticesHourly,
} from '../notices';
import { makeWardCall } from '../ward-rounds';
import { worksNeededAt } from '../works';

function inspectedHome(city: ReturnType<typeof newCity>) {
  const building = city.buildings.find((item) => item.householdIds.length > 0);
  if (!building) throw new Error('occupied home missing');
  building.fabric = 400;
  expect(worksNeededAt(city, building.id)).toBe('fabric');
  expect(makeWardCall(city, 'inspect', building.id)).toContain('inspector of nuisances');
  return building;
}

describe('nuisance notices', () => {
  it('requires a view of the premises before service', () => {
    const city = newCity('notice-evidence');
    const building = city.buildings.find((item) => item.householdIds.length > 0)!;
    building.fabric = 400;
    expect(canServeNotice(city, building.id)).toBe('View the premises before serving a notice.');
  });

  it('charges real private means and physically abates the defect', () => {
    const city = newCity('notice-compliance');
    const building = inspectedHome(city);
    const notice = serveNotice(city, building.id)!;
    const household = city.households[notice.householdId];
    household.arrearsDays = 0;
    household.purse = 500;
    const beforePurse = household.purse;
    const beforeFabric = building.fabric;

    city.tick = notice.dueAt;
    const updates = tickNoticesHourly(city);

    expect(notice.status).toBe('complied');
    expect(household.purse).toBe(beforePurse - notice.cost);
    expect(building.fabric).toBeGreaterThan(beforeFabric);
    expect(worksNeededAt(city, building.id)).toBeNull();
    expect(updates[0].text).toContain('nuisance notice is satisfied');
  });

  it('turns a poor occupier\'s default into a real summons and paper order', () => {
    const city = newCity('notice-default');
    const building = inspectedHome(city);
    const notice = serveNotice(city, building.id)!;
    const household = city.households[notice.householdId];
    household.purse = 0;
    household.arrearsDays = 2;
    const beforeFabric = building.fabric;
    city.tick = notice.dueAt;
    tickNoticesHourly(city);
    expect(notice.status).toBe('defaulted');
    expect(canSummonNotice(city, building.id)).toBeNull();
    const beforeBudget = city.budgetLeft;
    summonOnNotice(city, building.id);
    expect(city.budgetLeft).toBe(beforeBudget - 1);

    city.tick = notice.dueAt;
    tickNoticesHourly(city);
    expect(notice.status).toBe('orderMade');
    expect(building.fabric).toBe(beforeFabric);
  });

  it('keeps a repair promise when the occupier complies', () => {
    const city = newCity('verdigris');
    city.tick = 180;
    openDailyMatters(city);
    const matter = activeMatters(city.matters).find((item) => item.kind === 'repair')!;
    const building = city.buildings[matter.target.id];
    expect(makeWardCall(city, 'inspect', building.id)).toBeTruthy();
    const notice = serveNotice(city, building.id)!;
    const household = city.households[notice.householdId];
    household.purse = 500;
    household.arrearsDays = 0;
    noteNoticeResponse(city, notice.id);
    expect(matter.response).toBe('serveNotice');

    city.tick = notice.dueAt;
    tickNoticesHourly(city);
    tickMatters(city);
    expect(matter.status).toBe('kept');
    expect(matter.outcome).toContain('complied with the nuisance notice');
  });

  it('lets public works abate a notice after private default', () => {
    const city = newCity('verdigris');
    city.tick = 180;
    openDailyMatters(city);
    const matter = activeMatters(city.matters).find((item) => item.kind === 'repair')!;
    const building = city.buildings[matter.target.id];
    makeWardCall(city, 'inspect', building.id);
    const notice = serveNotice(city, building.id)!;
    const household = city.households[notice.householdId];
    household.purse = 0;
    household.arrearsDays = 1;
    noteNoticeResponse(city, notice.id);
    city.tick = notice.dueAt;
    tickNoticesHourly(city);
    expect(notice.status).toBe('defaulted');

    expect(apply(city, 'fileWorks', matter.target)).toBe(true);
    expect(matter.response).toBe('fileWorks');
    const order = city.works.orders[matter.subjectId];
    order.status = 'completed';
    order.resolvedAt = city.tick;
    tickMatters(city);
    expect(matter.status).toBe('kept');
  });

  it('replays notice outcomes exactly', () => {
    const play = (): number => {
      const city = newCity('notice-replay');
      const building = inspectedHome(city);
      const notice = serveNotice(city, building.id)!;
      const household = city.households[notice.householdId];
      household.purse = 500;
      household.arrearsDays = 0;
      city.tick = notice.dueAt;
      tickNoticesHourly(city);
      return hashWorld(city);
    };
    expect(play()).toBe(play());
  });
});
