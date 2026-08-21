import { describe, expect, it } from 'vitest';
import { newCity, warp, hashWorld } from '../city';
import { MIN_PER_DAY, minuteOfDay } from '../clock';
import { applyPressure, pressureOf } from '../pressures';
import { serviceAt } from '../networks';
import { DAILY_BUDGET } from '../interventions';
import {
  enact, repeal, canEnact, inForce, ordinanceOf, willComply, ORDINANCES, ORDINANCE_KINDS,
} from '../ordinances';
import type { OrdinanceKind } from '../types';

function pubOccupants(c: ReturnType<typeof newCity>): number {
  let n = 0;
  const pubs = c.buildingsByKind.get('pub') ?? [];
  for (let i = 0; i < pubs.length; i++) n += c.buildings[pubs[i]].occupants.length;
  return n;
}

function youngAtMill(c: ReturnType<typeof newCity>): number {
  let n = 0;
  for (const s of c.souls) {
    if (s.age < 14 || s.age >= 16) continue;
    if (s.trade === 'child' || s.trade === 'none') continue;
    if (s.workId >= 0 && s.inId === s.workId) n++;
  }
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

  it('child labour sends the half-timers home after the hour', () => {
    const control = newCity('verdigris');
    const treated = newCity('verdigris');
    warp(control, 400);
    warp(treated, 400);
    const young = treated.souls.filter((s) => s.age >= 14 && s.age < 16 && s.trade !== 'child' && s.trade !== 'none');
    expect(young.length).toBeGreaterThan(0);
    expect(enact(treated, 'childLabour', 780)).toBe(true);
    warp(control, 500);
    warp(treated, 500);
    expect(minuteOfDay(treated.tick)).toBeGreaterThanOrEqual(840);
    expect(youngAtMill(treated)).toBeLessThan(youngAtMill(control));
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

  it('compliance varies with boldness: the people still out after curfew are the bolder ones', () => {
    const c = newCity('verdigris');
    warp(c, 500);
    expect(enact(c, 'curfew', 1200)).toBe(true);
    warp(c, 760);
    const out: number[] = [];
    const homeDrinkers: number[] = [];
    for (const s of c.souls) {
      if (s.scheduleId !== 0) continue;
      if (s.trade === 'constable' || s.trade === 'lamplighter') continue;
      if (s.inId < 0) out.push(s.boldness);
      else if (s.inId === s.homeId) homeDrinkers.push(s.boldness);
    }
    if (out.length >= 2 && homeDrinkers.length >= 2) {
      const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      expect(avg(out)).toBeGreaterThan(avg(homeDrinkers));
    } else {
      let yes = 0;
      let no = 0;
      for (const s of c.souls) {
        if (s.scheduleId !== 0) continue;
        if (willComply(c, s, 0)) yes++; else no++;
      }
      expect(yes).toBeGreaterThan(0);
      expect(no).toBeGreaterThan(0);
    }
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
