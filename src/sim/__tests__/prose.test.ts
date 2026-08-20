import { describe, expect, it } from 'vitest';
import { newCity, warp } from '../city';
import { describeBuilding, describeSoul, insideList } from '../prose';
import { SENSES } from '../lexicon';
import { serviceAt } from '../networks';
import { DEFS } from '../buildings';

describe('prose', () => {
  it('says something about every building, with no unfilled placeholders', () => {
    const c = newCity('verdigris');
    warp(c, 641);
    for (const b of c.buildings) {
      const line = describeBuilding(c, b.id);
      expect(line.length, `${b.kind} ${b.id}`).toBeGreaterThan(8);
      expect(line, `${b.kind} ${b.id}`).not.toMatch(/\$\{|undefined|NaN|\[object/);
    }
  });

  it('can never assert something the simulation does not contain', () => {
    // This is the property that makes the whole narrative layer trustworthy, and
    // it is exactly the property an LLM in this slot would destroy.
    const c = newCity('coppergate');
    warp(c, 1260);
    const dust = SENSES.find((f) => f.token === 'dust');
    const grate = SENSES.find((f) => f.token === 'a cold grate');
    expect(dust && grate).toBeTruthy();
    for (const b of c.buildings) {
      if (dust && b.fabric >= 420) expect(dust.when(c, b), `${b.name} fabric ${b.fabric}`).toBe(false);
      if (grate && DEFS[b.kind].needsGas && serviceAt(c.networks.gas, b.id)) {
        expect(grate.when(c, b), `${b.name} has gas`).toBe(false);
      }
    }
  });

  it('lists only souls who are actually inside', () => {
    const c = newCity('verdigris');
    warp(c, 700);
    for (const b of c.buildings) {
      const { lines, more } = insideList(c, b.id);
      expect(lines.length + more).toBe(b.occupants.length);
      for (const line of lines) {
        expect(c.souls[line.soulId].inId, line.line).toBe(b.id);
      }
    }
  });

  it('is stable within a game-hour and breathes across hours', () => {
    const c = newCity('verdigris');
    warp(c, 600);
    const b = c.buildings[0].id;
    const first = describeBuilding(c, b);
    warp(c, 5);
    expect(describeBuilding(c, b)).toBe(first);
  });

  it('describes every soul', () => {
    const c = newCity('verdigris');
    warp(c, 641);
    for (const s of c.souls) {
      const line = describeSoul(c, s.id);
      expect(line).not.toMatch(/\$\{|undefined|NaN/);
      expect(line.length).toBeGreaterThan(10);
    }
  });
});
