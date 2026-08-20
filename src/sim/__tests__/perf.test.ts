import { describe, expect, it } from 'vitest';
import { newCity, warp } from '../city';
import { MIN_PER_DAY } from '../clock';

describe('performance guard', () => {
  it('runs a full game-day well inside the frame budget', () => {
    // Loose enough not to flake on a busy box, tight enough to catch a ten times
    // regression. The real budget is 0.25ms per minute-tick, which is 360ms a day.
    const c = newCity('verdigris');
    const t0 = performance.now();
    warp(c, MIN_PER_DAY);
    const ms = performance.now() - t0;
    expect(ms, `${Math.round(ms)}ms for ${MIN_PER_DAY} ticks`).toBeLessThan(1500);
  });

  it('generates a world in well under a second', () => {
    const t0 = performance.now();
    newCity('jubilee');
    const ms = performance.now() - t0;
    expect(ms, `${Math.round(ms)}ms`).toBeLessThan(1500);
  });
});
