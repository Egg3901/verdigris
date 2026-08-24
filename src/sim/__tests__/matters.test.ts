import { describe, expect, it } from 'vitest';
import { newCity, tickCity, warp } from '../city';
import { apply } from '../interventions';
import { activeMatters, declineMatter, tickMatters } from '../matters';
import { latestOrderFor } from '../works';

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
    tickCity(city);
    expect(matter!.status).toBe('kept');
    expect(matter!.outcome).toContain('stoppage held');
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
