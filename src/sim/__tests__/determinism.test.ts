import { describe, expect, it } from 'vitest';
import { newCity, tickCity, warp, hashWorld, soulsOutdoors } from '../city';
import { MIN_PER_DAY } from '../clock';

describe('determinism', () => {
  it('two cities from the same seed stay identical for a full day', () => {
    const a = newCity('verdigris');
    const b = newCity('verdigris');
    warp(a, MIN_PER_DAY);
    warp(b, MIN_PER_DAY);
    expect(hashWorld(b)).toBe(hashWorld(a));
  });

  it('splitting a run does not change it', () => {
    const a = newCity('coppergate');
    const b = newCity('coppergate');
    warp(a, 5000);
    warp(b, 2000);
    warp(b, 3000);
    expect(hashWorld(b)).toBe(hashWorld(a));
  });

  it('different seeds diverge', () => {
    const a = newCity('verdigris');
    const b = newCity('jubilee');
    warp(a, 600);
    warp(b, 600);
    expect(hashWorld(b)).not.toBe(hashWorld(a));
  });

  it('the world actually moves: the hash changes minute to minute', () => {
    const c = newCity('verdigris');
    warp(c, 420);
    const seen = new Set<number>();
    for (let i = 0; i < 30; i++) {
      tickCity(c);
      seen.add(hashWorld(c));
    }
    expect(seen.size).toBeGreaterThan(20);
  });

  it('puts souls on the street during the day and takes them in at night', () => {
    const c = newCity('verdigris');
    warp(c, 180);
    const deadOfNight = soulsOutdoors(c);
    warp(c, 400 - 180);
    const morningRush = soulsOutdoors(c);
    expect(deadOfNight).toBeLessThan(12);
    expect(morningRush).toBeGreaterThan(deadOfNight);
  });
});
