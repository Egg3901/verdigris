import { describe, expect, it } from 'vitest';
import { generateWorld, validateWorld, dumpDistrict } from '../worldgen';
import { CAPS } from '../types';
import { isConnected } from '../graph';

const SEEDS = ['verdigris', 'coppergate', 'jubilee'];

describe('worldgen', () => {
  for (const seed of SEEDS) {
    it(`produces a valid district for seed "${seed}"`, () => {
      const w = generateWorld(seed);
      const errs = validateWorld(w);
      expect(errs, `${errs.join('\n')}\n\n${dumpDistrict(w.district)}`).toEqual([]);
    });
  }

  it('is deterministic across two generations of the same seed', () => {
    const a = generateWorld('verdigris');
    const b = generateWorld('verdigris');
    expect(dumpDistrict(b.district)).toEqual(dumpDistrict(a.district));
    expect(b.buildings.map((x) => `${x.kind}@${x.ox},${x.oy}`)).toEqual(
      a.buildings.map((x) => `${x.kind}@${x.ox},${x.oy}`),
    );
    expect(b.souls.map((s) => `${s.given} ${s.family}/${s.trade}`)).toEqual(
      a.souls.map((s) => `${s.given} ${s.family}/${s.trade}`),
    );
  });

  it('produces materially different districts for different seeds', () => {
    const a = generateWorld('verdigris');
    const b = generateWorld('coppergate');
    expect(dumpDistrict(b.district)).not.toEqual(dumpDistrict(a.district));
  });

  it('keeps the street graph inside its caps and in one piece', () => {
    for (const seed of SEEDS) {
      const w = generateWorld(seed);
      expect(w.graph.n, seed).toBeLessThanOrEqual(CAPS.nodes);
      expect(isConnected(w.graph), seed).toBe(true);
    }
  });

  it('gives every soul an address and every working soul somewhere to be', () => {
    const w = generateWorld('verdigris');
    expect(w.souls.length).toBeGreaterThan(150);
    for (const s of w.souls) {
      expect(s.homeId).toBeGreaterThanOrEqual(0);
      if (s.trade !== 'none' && s.trade !== 'child') expect(s.workId).toBeGreaterThanOrEqual(0);
    }
  });

  it('generates courts with no through route: the rot geography must exist', () => {
    for (const seed of SEEDS) {
      const courts = generateWorld(seed).plots.filter((p) => p.court);
      expect(courts.length, seed).toBeGreaterThan(0);
    }
  });
});
