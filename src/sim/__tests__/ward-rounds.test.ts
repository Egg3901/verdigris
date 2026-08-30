import { describe, expect, it } from 'vitest';
import { newCity } from '../city';
import { applyPressure, pressureOf } from '../pressures';
import { scheduleRatepayerSitting } from '../matters';
import { fileWorks, tickWorksHourly, worksNeededAt } from '../works';
import {
  CALLS_PER_DAY, canMakeWardCall, makeWardCall, resetWardRounds,
} from '../ward-rounds';

function occupiedHome(city: ReturnType<typeof newCity>): number {
  return city.buildings.find((building) => building.householdIds.length > 0
    && building.occupants.some((id) => city.souls[id].age >= 21 && city.souls[id].homeId === building.id))?.id ?? -1;
}

describe('ward rounds', () => {
  it('hears a named person and enters a civic relationship', () => {
    const city = newCity('ward-hearing');
    const buildingId = occupiedHome(city);
    expect(buildingId).toBeGreaterThanOrEqual(0);
    expect(canMakeWardCall(city, 'hear', buildingId)).toBeNull();

    const text = makeWardCall(city, 'hear', buildingId);
    const call = city.wardRounds.calls[0];
    expect(text).toContain('ward book');
    expect(call.kind).toBe('hear');
    expect(city.matters.relations.find((item) => item.soulId === call.soulId)?.regard).toBe(1);
    expect(city.wardRounds.callsLeft).toBe(CALLS_PER_DAY - 1);

    expect(canMakeWardCall(city, 'canvass', buildingId)).toContain('already called');
    expect(makeWardCall(city, 'canvass', buildingId)).toBeNull();
    expect(city.wardRounds.callsLeft).toBe(CALLS_PER_DAY - 1);
  });

  it('turns a premises view into evidence against a skimmed works case', () => {
    const city = newCity('ward-inspection');
    const building = city.buildings.find((item) => worksNeededAt(city, item.id));
    expect(building).toBeTruthy();
    const buildingId = building!.id;

    expect(makeWardCall(city, 'inspect', buildingId)).toContain('inspector of nuisances');
    const order = fileWorks(city, buildingId);
    expect(order.inspected).toBe(true);

    order.status = 'working';
    order.dueAt = city.tick;
    const workshop = city.firms[order.workshopFirmId];
    expect(workshop).toBeTruthy();
    workshop.output = Math.max(1, workshop.output);
    workshop.strikeUntil = -1;
    applyPressure(city.press, 'rot', 700 - pressureOf(city.press, 'rot'), 'seed', 0, 'test rot', city.tick);
    applyPressure(city.press, 'coin', 700 - pressureOf(city.press, 'coin'), 'seed', 0, 'test funds', city.tick);

    tickWorksHourly(city);
    expect(order.status).toBe('completed');
  });

  it('carries a canvassed ratepayer into the next sitting', () => {
    const city = newCity('ward-canvass');
    const buildingId = occupiedHome(city);
    expect(buildingId).toBeGreaterThanOrEqual(0);
    city.matters.standing = 1000;

    expect(makeWardCall(city, 'canvass', buildingId)).toContain('gives a pledge');
    const call = city.wardRounds.calls[0];
    const relation = city.matters.relations.find((item) => item.soulId === call.soulId);
    expect(relation).toMatchObject({ regard: 1, lastCanvassedAt: city.tick });

    city.matters.nextMeetingAt = city.tick + 60;
    expect(scheduleRatepayerSitting(city)).toBe(true);
    const visit = city.civicVisits.visits.find((item) => item.kind === 'meeting');
    expect(visit?.actorIds).toContain(call.soulId);
  });

  it('restores three calls when a new day is entered', () => {
    const city = newCity('ward-reset');
    const buildingId = occupiedHome(city);
    makeWardCall(city, 'hear', buildingId);
    expect(city.wardRounds.callsLeft).toBe(CALLS_PER_DAY - 1);
    city.tick = 1440;
    resetWardRounds(city);
    expect(city.wardRounds.callsLeft).toBe(CALLS_PER_DAY);
  });
});
