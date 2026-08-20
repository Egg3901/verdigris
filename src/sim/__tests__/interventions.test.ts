import { describe, expect, it } from 'vitest';
import { newCity, warp, hashWorld } from '../city';
import { INTERVENTIONS, canApply, apply, DAILY_BUDGET } from '../interventions';
import { pressureOf } from '../pressures';
import { serviceAt } from '../networks';
import type { InterventionKind } from '../types';

function firstOfKind(c: ReturnType<typeof newCity>, kind: string): number {
  return (c.buildingsByKind.get(kind as never) ?? [])[0] ?? -1;
}

describe('interventions', () => {
  it('spends the daily budget and refuses when it is gone', () => {
    const c = newCity('verdigris');
    warp(c, 600);
    expect(c.budgetLeft).toBe(DAILY_BUDGET);
    for (let i = 0; i < DAILY_BUDGET; i++) {
      expect(apply(c, 'fundBunting', { kind: 'square', id: 0 })
        || apply(c, 'delayTram', { kind: 'line', id: 0 })
        || apply(c, 'rumour', { kind: 'soul', id: 0 })).toBe(true);
    }
    expect(c.budgetLeft).toBe(0);
    expect(canApply(c, 'fundBunting', { kind: 'square', id: 0 })).toBe('Nothing left today.');
  });

  it('cutting a gas main removes service from real buildings downstream', () => {
    // Not a pressure poke: a specific segment breaks and a specific set of
    // buildings loses service. If this ever passes without the count changing,
    // the intervention has quietly become a slider.
    const c = newCity('verdigris');
    warp(c, 400);
    const target = c.buildings.find((b) => b.gasSeg >= 0 && serviceAt(c.networks.gas, b.id));
    expect(target).toBeTruthy();
    const before = c.buildings.filter((b) => b.gasSeg >= 0 && serviceAt(c.networks.gas, b.id)).length;
    expect(apply(c, 'cutGas', { kind: 'building', id: (target as { id: number }).id })).toBe(true);
    const after = c.buildings.filter((b) => b.gasSeg >= 0 && serviceAt(c.networks.gas, b.id)).length;
    expect(after).toBeLessThan(before);
  });

  it('every nudge logs a cause, so no pressure ever moves unexplained', () => {
    const c = newCity('verdigris');
    warp(c, 600);
    const before = c.press.causeHead;
    apply(c, 'fundBunting', { kind: 'square', id: 0 });
    expect(c.press.causeHead).not.toBe(before);
    const causes = c.press.causes.filter((x) => x.causeKind === 'intervention');
    expect(causes.length).toBeGreaterThan(0);
  });

  it('funding the bunting raises mood and rot together: the thesis as a button', () => {
    const c = newCity('verdigris');
    warp(c, 600);
    const mood = pressureOf(c.press, 'mood');
    const rot = pressureOf(c.press, 'rot');
    apply(c, 'fundBunting', { kind: 'square', id: 0 });
    expect(pressureOf(c.press, 'mood')).toBeGreaterThan(mood);
    expect(pressureOf(c.press, 'rot')).toBeGreaterThan(rot);
  });

  it('every intervention has a reason when it refuses, and never throws', () => {
    const c = newCity('coppergate');
    warp(c, 700);
    for (const kind of Object.keys(INTERVENTIONS) as InterventionKind[]) {
      const def = INTERVENTIONS[kind];
      for (const tk of def.targets) {
        const id = tk === 'soul' ? 0 : tk === 'building' ? firstOfKind(c, 'mill') : 0;
        const why = canApply(c, kind, { kind: tk, id });
        if (why !== null) expect(typeof why).toBe('string');
      }
    }
  });

  it('a nudge actually changes the world, and the change persists', () => {
    // Proves the intervention does something, which a determinism hash of the sim
    // alone cannot. Note what this deliberately does NOT assert: the same nudge a
    // minute apart is allowed to converge, because a one-minute offset on a
    // twelve-hour tram delay genuinely produces the same district. Asserting
    // otherwise would be testing a coincidence.
    const nudged = newCity('verdigris');
    const left = newCity('verdigris');
    warp(nudged, 500);
    warp(left, 500);
    expect(hashWorld(left)).toBe(hashWorld(nudged));

    apply(nudged, 'cutGas', {
      kind: 'building',
      id: (nudged.buildings.find((b) => b.gasSeg >= 0) as { id: number }).id,
    });
    warp(nudged, 400);
    warp(left, 400);
    expect(hashWorld(nudged)).not.toBe(hashWorld(left));
  });

  it('replays identically from the same seed and nudge log', () => {
    // This is the save format: (seedStr, tick, nudges). If a replay diverged, a
    // saved district would not be the district you left.
    const play = (): number => {
      const c = newCity('verdigris');
      warp(c, 500);
      apply(c, 'fundBunting', { kind: 'square', id: 0 });
      warp(c, 200);
      apply(c, 'delayTram', { kind: 'line', id: 0 });
      warp(c, 740);
      return hashWorld(c);
    };
    expect(play()).toBe(play());
  });

  it('records every nudge in the save log', () => {
    const c = newCity('verdigris');
    warp(c, 600);
    apply(c, 'fundBunting', { kind: 'square', id: 0 });
    expect(c.nudges.length).toBe(1);
    expect(c.nudges[0].kind).toBe('fundBunting');
    expect(c.nudges[0].tick).toBe(c.tick);
  });
});
