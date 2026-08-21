import { describe, expect, it } from 'vitest';
import { newCity, warp, hashWorld } from '../city';
import { MIN_PER_DAY, minuteOfDay } from '../clock';
import { applyPressure, pressureOf } from '../pressures';
import { serviceAt } from '../networks';
import { DAILY_BUDGET } from '../interventions';
import {
  enact, repeal, canEnact, inForce, ordinanceOf, willComply, IDX, ORDINANCES, ORDINANCE_KINDS,
} from '../ordinances';
import type { OrdinanceKind } from '../types';

function pubOccupants(c: ReturnType<typeof newCity>): number {
  let n = 0;
  const pubs = c.buildingsByKind.get('pub') ?? [];
  for (let i = 0; i < pubs.length; i++) n += c.buildings[pubs[i]].occupants.length;
  return n;
}


function courtsOnMains(c: ReturnType<typeof newCity>): number {
  let n = 0;
  for (const b of c.buildings) {
    if (b.kind !== 'courtdwelling') continue;
    if (serviceAt(c.networks.drain, b.id)) n++;
  }
  return n;
}

function nextSitting(c: ReturnType<typeof newCity>): void {
  warp(c, MIN_PER_DAY);
}

describe('ordinances', () => {
  it('starts with the courts off the mains, so the drainage act has a real job', () => {
    const c = newCity('verdigris');
    expect(c.buildings.some((b) => b.kind === 'courtdwelling')).toBe(true);
    expect(courtsOnMains(c)).toBe(0);
  });

  it('does not spend the daily intervention budget', () => {
    const c = newCity('verdigris');
    warp(c, 400);
    expect(c.budgetLeft).toBe(DAILY_BUDGET);
    expect(enact(c, 'curfew', 1200)).toBe(true);
    expect(c.budgetLeft).toBe(DAILY_BUDGET);
  });

  it('a curfew keeps people out of the public houses after the hour', () => {
    const control = newCity('verdigris');
    const treated = newCity('verdigris');
    warp(control, 500);
    warp(treated, 500);
    expect(enact(treated, 'curfew', 1200)).toBe(true);
    warp(control, 760);
    warp(treated, 760);
    expect(minuteOfDay(treated.tick)).toBeGreaterThanOrEqual(1200);
    expect(pubOccupants(treated)).toBeLessThan(pubOccupants(control));
  });

  it('repeal restores the evening, and the vestry only sits once a day', () => {
    const c = newCity('verdigris');
    warp(c, 400);
    expect(enact(c, 'curfew', 1200)).toBe(true);
    expect(canEnact(c, 'licensingHours')).toBe('The vestry has already sat today.');
    expect(repeal(c, 'curfew')).toBe(false);
    nextSitting(c);
    expect(inForce(c, 'curfew')).toBe(true);
    expect(repeal(c, 'curfew')).toBe(true);
    expect(inForce(c, 'curfew')).toBe(false);
  });

  it('licensing hours empty the pubs and open a shebeen', () => {
    const control = newCity('verdigris');
    const treated = newCity('verdigris');
    warp(control, 500);
    warp(treated, 500);
    expect(enact(treated, 'licensingHours', 1260)).toBe(true);
    expect(treated.laws.shebeenId).toBeGreaterThanOrEqual(0);
    warp(control, 800);
    warp(treated, 800);
    expect(minuteOfDay(treated.tick)).toBeGreaterThanOrEqual(1260);
    expect(pubOccupants(treated)).toBeLessThan(pubOccupants(control));
  });

  it('the drainage act puts specific court dwellings on the mains', () => {
    const c = newCity('verdigris');
    warp(c, 400);
    const before = courtsOnMains(c);
    expect(before).toBe(0);
    expect(enact(c, 'drainageAct')).toBe(true);
    expect(courtsOnMains(c)).toBeGreaterThan(before);
    const causes = c.press.causes.filter((x) => x.causeKind === 'law');
    expect(causes.length).toBeGreaterThan(0);
  });

  it('high rot captures the drainage act: rates collected, no pipe laid', () => {
    const c = newCity('verdigris');
    warp(c, 400);
    applyPressure(c.press, 'rot', 400, 'seed', 0, 'test rot', c.tick);
    expect(pressureOf(c.press, 'rot')).toBeGreaterThan(580);
    let purseBefore = 0;
    for (const h of c.households) purseBefore += h.purse;
    expect(enact(c, 'drainageAct')).toBe(true);
    expect(ordinanceOf(c, 'drainageAct').captured).toBe(1);
    expect(courtsOnMains(c)).toBe(0);
    let purseAfter = 0;
    let arrearsAfter = 0;
    for (const h of c.households) {
      purseAfter += h.purse;
      arrearsAfter += h.arrearsDays;
    }
    expect(purseAfter < purseBefore || arrearsAfter > 0).toBe(true);
  });

  it('child labour cuts the hours the half-timers actually work', () => {
    // Counted as CHILD-HOURS across the regulated window, not as a headcount at
    // one moment. There are about twelve workers under sixteen in a district of
    // two hundred, and at any given minute only a handful are inside a workplace,
    // so a single-sample comparison swings between 0 and 1 either way and asserts
    // nothing. Measured over the window: 58 against 52 on one seed and 9 against
    // 8 on another, a consistent ten to eleven per cent.
    //
    // Modest is correct. Compliance is partial by design, and a law nobody
    // enforces is defied: the ordinance records the breaches rather than
    // pretending they did not happen.
    const atWork = (c: ReturnType<typeof newCity>): number => {
      let n = 0;
      for (const s of c.souls) if (s.age < 16 && s.workId >= 0 && s.inId === s.workId) n++;
      return n;
    };
    const control = newCity('verdigris');
    const treated = newCity('verdigris');
    warp(control, 400);
    warp(treated, 400);
    expect(treated.souls.filter((s) => s.age < 16 && s.workId >= 0).length).toBeGreaterThan(4);
    expect(enact(treated, 'childLabour', 780)).toBe(true);

    let controlHours = 0;
    let treatedHours = 0;
    for (let i = 0; i < 200; i++) {
      warp(control, 10);
      warp(treated, 10);
      const m = minuteOfDay(treated.tick);
      if (m >= 780 && m < 1140) {
        controlHours += atWork(control);
        treatedHours += atWork(treated);
      }
    }
    expect(controlHours).toBeGreaterThan(0);
    expect(treatedHours).toBeLessThan(controlHours);
  });

  it('souls hurt by a law take the grievance and carry a bylaw claim', () => {
    const c = newCity('verdigris');
    warp(c, 400);
    const publicans = c.souls.filter((s) => s.trade === 'publican');
    expect(publicans.length).toBeGreaterThan(0);
    const before = publicans.reduce((n, s) => n + s.grievance, 0);
    expect(enact(c, 'licensingHours', 1260)).toBe(true);
    const after = publicans.reduce((n, s) => n + c.souls[s.id].grievance, 0);
    expect(after).toBeGreaterThan(before);
    const bylaw = c.claims.claims.some((cl) => cl.kind === 'bylaw');
    expect(bylaw).toBe(true);
  });

  it('compliance varies with boldness, and with how well the law is enforced', () => {
    // Measured directly on willComply rather than by counting who happens to be
    // outdoors after the curfew hour. The outdoor proxy is diluted by everyone
    // moving for ordinary reasons (errands, deliveries, walking home), so it
    // reported a 0.9% difference in means, which is noise: the assertion passed
    // or failed on whichever way the population happened to fall. The property
    // that actually matters is the one the model claims.
    const c = newCity('verdigris');
    warp(c, 500);
    expect(enact(c, 'curfew', 1200)).toBe(true);
    warp(c, 760);

    const defy: number[] = [];
    const obey: number[] = [];
    for (const s of c.souls) {
      if (s.trade === 'constable') continue;
      (willComply(c, s, IDX.curfew) ? obey : defy).push(s.boldness);
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    expect(defy.length).toBeGreaterThan(10);
    expect(obey.length).toBeGreaterThan(10);
    // Boldness carries 3 of the 12 parts of the score, so expect a real but
    // modest gap. Measured at the time of writing: 540 against 514.
    expect(avg(defy)).toBeGreaterThan(avg(obey) + 8);
  });

  it('an unenforced curfew is a dead letter: captured, it is written for after bedtime', () => {
    const c = newCity('verdigris');
    warp(c, 400);
    applyPressure(c.press, 'rot', 400, 'seed', 0, 'test rot', c.tick);
    expect(enact(c, 'curfew', 1200)).toBe(true);
    expect(ordinanceOf(c, 'curfew').captured).toBe(1);
    expect(ordinanceOf(c, 'curfew').param).toBeGreaterThanOrEqual(1380);
  });

  it('replays identically from the same seed and act log', () => {
    const play = (): number => {
      const c = newCity('verdigris');
      warp(c, 400);
      enact(c, 'curfew', 1200);
      warp(c, MIN_PER_DAY);
      enact(c, 'licensingHours', 1260);
      warp(c, 800);
      return hashWorld(c);
    };
    expect(play()).toBe(play());
  });

  it('records every sitting in the save log', () => {
    const c = newCity('verdigris');
    warp(c, 400);
    enact(c, 'publicOrder', 5);
    expect(c.laws.acts.length).toBe(1);
    expect(c.laws.acts[0].kind).toBe('publicOrder');
    expect(c.laws.acts[0].enact).toBe(1);
  });

  it('every ordinance has a name, a mechanism, and a reason when it refuses', () => {
    const c = newCity('coppergate');
    warp(c, 400);
    expect(ORDINANCES.length).toBe(ORDINANCE_KINDS.length);
    for (const kind of ORDINANCE_KINDS) {
      const why = canEnact(c, kind);
      expect(why === null || typeof why === 'string').toBe(true);
    }
    expect(enact(c, 'inspectorPowers')).toBe(true);
    expect(c.laws.condemnedUntil.some((t) => t > c.tick)).toBe(true);
    expect(canEnact(c, 'inspectorPowers')).toBe('That is already in force.');
  });

  it('a hash of the world moves when a law is passed', () => {
    const a = newCity('verdigris');
    const b = newCity('verdigris');
    warp(a, 400);
    warp(b, 400);
    expect(hashWorld(a)).toBe(hashWorld(b));
    enact(a, 'dogTax', 4);
    expect(hashWorld(a)).not.toBe(hashWorld(b));
  });

  it('the bread assize either cheapens the honest shops or drives a black market', () => {
    const c = newCity('verdigris');
    warp(c, 400);
    let before = 0;
    let n = 0;
    for (const f of c.firms) {
      if (f.kind !== 'shop') continue;
      before += f.orders;
      n++;
    }
    expect(n).toBeGreaterThan(0);
    expect(enact(c, 'breadAssize')).toBe(true);
    expect(c.laws.breadStashId).toBeGreaterThanOrEqual(0);
    warp(c, 180);
    let after = 0;
    for (const f of c.firms) {
      if (f.kind !== 'shop') continue;
      after += f.orders;
    }
    expect(after).toBeLessThan(before);
    expect(inForce(c, 'breadAssize')).toBe(true);
  });

  it('does not throw for any ordinance on a fresh sitting', () => {
    const kinds: OrdinanceKind[] = [...ORDINANCE_KINDS];
    for (let i = 0; i < kinds.length; i++) {
      const c = newCity('jubilee');
      warp(c, 360 + i);
      expect(enact(c, kinds[i]), kinds[i]).toBe(true);
      expect(inForce(c, kinds[i])).toBe(true);
    }
  });
});
