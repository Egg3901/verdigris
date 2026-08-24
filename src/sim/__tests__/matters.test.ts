import { describe, expect, it } from 'vitest';
import { newCity, tickCity, warp } from '../city';
import { apply } from '../interventions';
import {
  activeMatters, canPressMatter, declineMatter, holdRatepayerMeeting, matterInsight,
  MEETING_PERIOD, pressMatter, regardFor, tickMatters,
} from '../matters';
import { latestOrderFor } from '../works';
import { applyPressure, pressureOf } from '../pressures';

function setCoin(city: ReturnType<typeof newCity>, value: number): void {
  applyPressure(city.press, 'coin', value - pressureOf(city.press, 'coin'), 'seed', 0, 'test treasury', city.tick);
}

describe("the alderman's matters", () => {
  it('opens a small agenda from live conditions at the dead hour', () => {
    const city = newCity('verdigris');
    warp(city, 180);
    const matters = activeMatters(city.matters);
    expect(matters.length).toBeGreaterThanOrEqual(2);
    expect(matters.length).toBeLessThanOrEqual(3);
    expect(matters.some((matter) => matter.kind === 'repair')).toBe(true);
    expect(matters.some((matter) => matter.kind === 'labour')).toBe(true);
    for (const matter of matters) {
      expect(matter.partyIds.length).toBeGreaterThan(0);
      expect(matter.cause.length).toBeGreaterThan(20);
      expect(matter.dueAt).toBeGreaterThan(city.tick);
    }
  });

  it('judges a repair by the works outcome, not by filing the form', () => {
    const city = newCity('verdigris');
    warp(city, 180);
    const matter = activeMatters(city.matters).find((item) => item.kind === 'repair');
    expect(matter).toBeTruthy();
    expect(apply(city, 'fileWorks', matter!.target)).toBe(true);
    expect(matter!.status).toBe('pending');
    expect(city.matters.standing).toBe(500);

    const order = latestOrderFor(city, matter!.target.id);
    expect(order).toBeTruthy();
    expect(matter!.subjectId).toBe(order!.id);
    order!.status = 'completed';
    order!.resolvedAt = city.tick;
    tickMatters(city);
    expect(matter!.status).toBe('kept');
    expect(city.matters.standing).toBe(525);
    expect(matter!.outcome).toContain('actually made');
  });

  it('credits a works case filed before the petition reaches the desk', () => {
    const city = newCity('verdigris');
    const candidate = city.buildings
      .filter((building) => building.householdIds.length > 0 && building.fabric < 760)
      .sort((a, b) => a.fabric - b.fabric || a.id - b.id)[0];
    expect(candidate).toBeTruthy();
    expect(apply(city, 'fileWorks', { kind: 'building', id: candidate.id })).toBe(true);
    const order = latestOrderFor(city, candidate.id)!;
    warp(city, 180);
    const matter = activeMatters(city.matters).find((item) => item.kind === 'repair' && item.target.id === candidate.id);
    expect(matter).toBeTruthy();
    expect(matter!.status).toBe('pending');
    expect(matter!.subjectId).toBe(order.id);
  });

  it('lets the alderman decline without spending influence', () => {
    const city = newCity('verdigris');
    warp(city, 180);
    const matter = activeMatters(city.matters)[0];
    const budget = city.budgetLeft;
    expect(declineMatter(city, matter.id)).toBe(true);
    expect(matter.status).toBe('declined');
    expect(city.budgetLeft).toBe(budget);
    expect(city.matters.standing).toBe(494);
  });

  it('fails an unanswered deadline and records the standing loss', () => {
    const city = newCity('verdigris');
    warp(city, 180);
    const matter = activeMatters(city.matters)[0];
    matter.dueAt = city.tick + 1;
    tickCity(city);
    expect(matter.status).toBe('failed');
    expect(matter.outcome).toContain('deadline passed');
    expect(city.matters.standing).toBe(482);
  });

  it('does not put a declined address straight back on the desk', () => {
    const city = newCity('verdigris');
    warp(city, 180);
    const repair = activeMatters(city.matters).find((item) => item.kind === 'repair');
    expect(repair).toBeTruthy();
    declineMatter(city, repair!.id);
    warp(city, 1440);
    const nextRepairs = activeMatters(city.matters).filter((item) => item.kind === 'repair');
    expect(nextRepairs.every((item) => item.target.id !== repair!.target.id)).toBe(true);
  });

  it('closes a matter without penalty when events overtake it', () => {
    const city = newCity('verdigris');
    warp(city, 180);
    const labour = activeMatters(city.matters).find((item) => item.kind === 'labour');
    expect(labour).toBeTruthy();
    const firm = city.firms[labour!.subjectId];
    for (const id of firm.workerIds) city.souls[id].grievance = 0;
    tickMatters(city);
    expect(labour!.status).toBe('overtaken');
    expect(city.matters.standing).toBe(500);
  });

  it('records whether a funded stoppage survives the first clearing attempt', () => {
    const city = newCity('verdigris');
    warp(city, 180);
    const matter = activeMatters(city.matters).find((item) => item.kind === 'labour');
    expect(matter).toBeTruthy();
    expect(apply(city, 'fundStrike', matter!.target)).toBe(true);
    expect(matter!.status).toBe('pending');
    warp(city, 239);
    expect(matter!.status).toBe('pending');
    tickCity(city);
    expect(matter!.status).toBe('kept');
    expect(matter!.outcome).toContain('stoppage held');
    expect(matter!.standingDelta).toBe(25);
    expect(matter!.partyIds.every((id) => regardFor(city, id) > 0)).toBe(true);
    expect(matterInsight(city, matter!)).toContain('first four hours');
  });

  it('lets the hall clear an unfunded stoppage after four truthful hours', () => {
    const city = newCity('verdigris');
    warp(city, 180);
    const matter = activeMatters(city.matters).find((item) => item.kind === 'labour')!;
    setCoin(city, 300);
    expect(apply(city, 'fundStrike', matter.target)).toBe(true);
    warp(city, 239);
    expect(matter.status).toBe('pending');
    tickCity(city);
    expect(matter.status).toBe('failed');
    expect(matter.outcome).toContain('picket was cleared');
    expect(matter.partyIds.every((id) => regardFor(city, id) < 0)).toBe(true);
  });

  it('can press one pending promise with one further influence', () => {
    const city = newCity('verdigris');
    warp(city, 180);
    const matter = activeMatters(city.matters).find((item) => item.kind === 'labour')!;
    setCoin(city, 300);
    expect(apply(city, 'fundStrike', matter.target)).toBe(true);
    const before = city.budgetLeft;
    expect(canPressMatter(city, matter.id)).toBeNull();
    expect(pressMatter(city, matter.id)).toBe(true);
    expect(city.budgetLeft).toBe(before - 1);
    expect(canPressMatter(city, matter.id)).toContain('already');
    warp(city, 240);
    expect(matter.status).toBe('kept');
  });

  it('lets named patrons carry confidence at the weekly meeting', () => {
    const city = newCity('verdigris');
    warp(city, 180);
    const matter = activeMatters(city.matters).find((item) => item.kind === 'repair')!;
    expect(apply(city, 'fileWorks', matter.target)).toBe(true);
    const order = latestOrderFor(city, matter.target.id)!;
    order.status = 'completed';
    order.resolvedAt = city.tick;
    tickMatters(city);
    city.tick = city.matters.nextMeetingAt;
    expect(holdRatepayerMeeting(city)).toBe(true);
    expect(city.matters.meetings[0]).toMatchObject({ outcome: 'carried', influenceCap: 4 });
    expect(city.matters.meetings[0].supporterId).toBe(matter.partyIds[0]);
    expect(city.matters.meetings[0].text).toContain('spoke for the chair');
  });

  it('lets named opponents narrow the chair without ending play', () => {
    const city = newCity('verdigris');
    warp(city, 180);
    const matter = activeMatters(city.matters)[0];
    matter.dueAt = city.tick + 1;
    tickCity(city);
    city.tick = city.matters.nextMeetingAt;
    expect(holdRatepayerMeeting(city)).toBe(true);
    expect(city.matters.meetings[0]).toMatchObject({ outcome: 'lost', influenceCap: 2 });
    expect(city.matters.meetings[0].opponentId).toBe(matter.partyIds[0]);
    expect(city.matters.nextMeetingAt).toBe(city.tick + MEETING_PERIOD);
  });

  it('counts only traced deniable acts against the ratepayers vote', () => {
    const city = newCity('verdigris');
    warp(city, 180);
    expect(apply(city, 'tipOff', { kind: 'soul', id: 0 })).toBe(true);
    expect(apply(city, 'tipOff', { kind: 'soul', id: 1 })).toBe(true);
    city.tick = city.matters.nextMeetingAt;
    expect(holdRatepayerMeeting(city)).toBe(true);
    expect(city.matters.meetings[0]).toMatchObject({ outcome: 'lost', exposedActs: 2 });
  });

  it('can reverse a lost meeting at the next sitting', () => {
    const city = newCity('verdigris');
    city.matters.standing = 400;
    city.tick = city.matters.nextMeetingAt;
    holdRatepayerMeeting(city);
    expect(city.matters.influenceCap).toBe(2);
    city.matters.standing = 600;
    city.tick = city.matters.nextMeetingAt;
    holdRatepayerMeeting(city);
    expect(city.matters.meetings.at(-1)?.outcome).toBe('carried');
    expect(city.matters.influenceCap).toBe(4);
  });

  it('does not let old support freeze later weekly votes', () => {
    const city = newCity('verdigris');
    warp(city, 180);
    const matter = activeMatters(city.matters).find((item) => item.kind === 'repair')!;
    expect(apply(city, 'fileWorks', matter.target)).toBe(true);
    const order = latestOrderFor(city, matter.target.id)!;
    order.status = 'completed';
    tickMatters(city);
    city.tick = city.matters.nextMeetingAt;
    holdRatepayerMeeting(city);
    expect(city.matters.meetings.at(-1)?.outcome).toBe('carried');
    city.matters.standing = 500;
    city.tick = city.matters.nextMeetingAt;
    holdRatepayerMeeting(city);
    expect(city.matters.meetings.at(-1)?.outcome).toBe('divided');
    expect(regardFor(city, matter.partyIds[0])).toBe(1);
  });

  it('generates and resolves identically from the same seed and choices', () => {
    const play = () => {
      const city = newCity('coppergate');
      warp(city, 180);
      const matter = activeMatters(city.matters)[0];
      declineMatter(city, matter.id);
      warp(city, 1440);
      return city.matters;
    };
    expect(play()).toEqual(play());
  });
});
