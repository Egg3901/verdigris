import { describe, expect, it } from 'vitest';
import { newCity, tickCity, warp, soulsOutdoors } from '../city';
import { MIN_PER_DAY, minuteOfDay } from '../clock';
import { PATTERNS, patternFor } from '../schedule';
import { isTravelling } from '../souls';

describe('schedules', () => {
  it('gives every soul exactly one place to be, every minute of the day', () => {
    const c = newCity('verdigris');
    for (let m = 0; m < MIN_PER_DAY; m++) {
      tickCity(c);
      for (const s of c.souls) {
        const indoors = s.inId >= 0;
        const outdoors = s.atNode >= 0 && s.inId < 0;
        expect(indoors !== outdoors, `soul ${s.id} at minute ${m} is in ${s.inId} and at node ${s.atNode}`).toBe(true);
      }
    }
  }, 10_000);

  it('never leaves a soul walking for more than an hour', () => {
    // A soul stuck in a travel activity is the symptom of an unreachable
    // destination, and it is much cheaper to catch here than to notice in play.
    // Measured per JOURNEY, keyed on the destination. A soul that finishes a
    // commute and leaves again on an errand has made two journeys, and timing
    // them as one would flag a healthy district.
    const c = newCity('coppergate');
    const since = new Map<number, { at: number; dest: number }>();
    for (let m = 0; m < MIN_PER_DAY * 2; m++) {
      tickCity(c);
      for (const s of c.souls) {
        if (!isTravelling(s)) { since.delete(s.id); continue; }
        const rec = since.get(s.id);
        if (!rec || rec.dest !== s.destBuilding) {
          since.set(s.id, { at: m, dest: s.destBuilding });
          continue;
        }
        expect(
          m - rec.at,
          `soul ${s.id} has been walking to ${s.destBuilding} since minute ${rec.at}`,
        ).toBeLessThan(60);
      }
    }
  });

  it('puts nearly everyone at their registered address in the dead hour', () => {
    const c = newCity('verdigris');
    warp(c, MIN_PER_DAY + 180);
    expect(minuteOfDay(c.tick)).toBe(180);
    const home = c.souls.filter((s) => s.inId === s.homeId).length;
    expect(home / c.souls.length).toBeGreaterThan(0.9);
  });

  it('keeps somebody on the street through the whole working day', () => {
    // The reference screenshot is a district at 10:41 in the morning with people
    // in it. Two rushes and eleven empty hours is not a living town.
    const c = newCity('verdigris');
    warp(c, 420);
    let quietest = Infinity;
    for (let m = 420; m < 1200; m += 20) {
      warp(c, 20);
      quietest = Math.min(quietest, soulsOutdoors(c));
    }
    expect(quietest).toBeGreaterThan(3);
  });

  it('reaches every pattern from some trade and age', () => {
    const reached = new Set<number>();
    for (const p of PATTERNS) {
      for (const t of p.trades) {
        for (const age of [10, 20, 40, 70]) reached.add(patternFor(t, age, 0));
      }
    }
    expect(reached.size).toBe(PATTERNS.length);
  });
});
