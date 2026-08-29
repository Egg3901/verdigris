import { describe, expect, it } from 'vitest';
import { hashWorld, newCity, warp } from '../city';
import { apply } from '../interventions';
import { enact } from '../ordinances';
import { serviceAt } from '../networks';
import { canCallDeputation, callDeputation } from '../deputations';
import { latestOrderFor } from '../works';

type City = ReturnType<typeof newCity>;

function availableFromStreet(city: City, buildingId: number): number {
  const target = city.buildings[buildingId];
  return city.souls.filter((s) => {
    const home = city.buildings[s.homeId];
    return home?.streetId === target.streetId
      && s.inId >= 0
      && s.returnAt < 0
      && s.overrideUntil <= city.tick
      && s.age >= 14
      && s.activity !== 'asleep'
      && s.activity !== 'held'
      && s.activity !== 'dead';
  }).length;
}

/** A street with enough residents to be heard, and a non-pneumatic case to move. */
function deputationTarget(city: City): number {
  let picked = -1;
  let best = -1;
  for (const b of city.buildings) {
    if (b.streetId < 0 || (b.postSeg >= 0 && serviceAt(city.networks.post, b.id))) continue;
    const available = availableFromStreet(city, b.id);
    if (available <= best) continue;
    picked = b.id;
    best = available;
  }
  if (picked < 0 || best < 5) throw new Error('no street can form a deputation in this fixture');
  city.buildings[picked].fabric = 300;
  return picked;
}

function filedDeputation(city: City): number {
  warp(city, 600);
  const id = deputationTarget(city);
  expect(apply(city, 'fileWorks', { kind: 'building', id })).toBe(true);
  return id;
}

describe('public deputations', () => {
  it('refuses to call a street that has not filed its Works case', () => {
    const city = newCity('verdigris');
    warp(city, 600);
    const id = deputationTarget(city);

    expect(canCallDeputation(city, id)).toBe('File this address in the works register first.');
    expect(callDeputation(city, id)).toBe(0);
    expect(city.deputations.current).toBeNull();
  });

  it('routes real street residents outdoors to the civic square and keeps arrivals gathering', () => {
    const city = newCity('verdigris');
    const id = filedDeputation(city);

    expect(callDeputation(city, id)).toBeGreaterThanOrEqual(5);
    const current = city.deputations.current;
    if (!current) throw new Error('deputation missing');
    expect(current.attendeeIds.length).toBeGreaterThanOrEqual(5);
    for (const soulId of current.attendeeIds) {
      const soul = city.souls[soulId];
      expect(city.buildings[soul.homeId].streetId).toBe(city.buildings[id].streetId);
      expect(soul.inId).toBe(-1);
      expect(soul.destNode).toBe(current.squareNode);
      expect(soul.activity).toBe('gathering');
    }

    warp(city, 60);
    expect(current.arrivedIds.length).toBeGreaterThanOrEqual(5);
    for (const soulId of current.arrivedIds) {
      const soul = city.souls[soulId];
      expect(soul.inId).toBe(-1);
      expect(soul.atNode).toBe(current.squareNode);
      expect(soul.activity).toBe('gathering');
    }
  });

  it('hears a sufficient crowd by moving its filed case sooner without repairing it directly', () => {
    const city = newCity('verdigris');
    const id = filedDeputation(city);
    const building = city.buildings[id];
    const order = latestOrderFor(city, id);
    if (!order) throw new Error('works order missing');
    const startsAt = order.startsAt;
    const duration = order.dueAt - order.startsAt;
    const fabric = building.fabric;

    expect(callDeputation(city, id)).toBeGreaterThanOrEqual(5);
    warp(city, 60);

    expect(city.deputations.current?.status).toBe('heard');
    expect(order.status).toBe('filed');
    expect(order.startsAt).toBeLessThan(startsAt);
    expect(order.dueAt - order.startsAt).toBe(duration);
    expect(building.fabric).toBe(fabric);
  });

  it('leaves a thin deputation unaccelerated, then restores its attendees to scheduled life', () => {
    const city = newCity('verdigris');
    const id = filedDeputation(city);
    const order = latestOrderFor(city, id);
    if (!order) throw new Error('works order missing');
    const startsAt = order.startsAt;
    const dueAt = order.dueAt;

    expect(callDeputation(city, id, 1)).toBe(1);
    const current = city.deputations.current;
    if (!current) throw new Error('deputation missing');
    warp(city, 60);
    expect(['thin', 'dispersed']).toContain(current.status);
    expect(order.startsAt).toBe(startsAt);
    expect(order.dueAt).toBe(dueAt);

    warp(city, current.endsAt - city.tick);
    expect(city.deputations.current?.status).not.toBe('gathering');
    for (const soulId of current.attendeeIds) {
      expect(city.souls[soulId].overrideUntil).toBeLessThanOrEqual(city.tick);
      expect(city.souls[soulId].activity).not.toBe('gathering');
    }
    const endedAt = current.endedAt;
    const revision = city.deputations.revision;
    warp(city, 5);
    expect(current.endedAt).toBe(endedAt);
    expect(city.deputations.revision).toBe(revision);
  });

  it('lets public order reduce accepted turnout before anyone takes the route', () => {
    const free = newCity('verdigris');
    const ordered = newCity('verdigris');
    const freeId = filedDeputation(free);
    const orderedId = filedDeputation(ordered);
    expect(enact(ordered, 'publicOrder', 5)).toBe(true);

    const freeTurnout = callDeputation(free, freeId);
    const orderedTurnout = callDeputation(ordered, orderedId);
    expect(freeTurnout).toBeGreaterThanOrEqual(5);
    expect(orderedTurnout).toBeLessThan(freeTurnout);
    expect(ordered.deputations.current?.rejectedCount).toBeGreaterThan(0);
    const current = ordered.deputations.current;
    if (!current) throw new Error('ordered deputation missing');
    warp(ordered, current.heardAt - ordered.tick);
    if (current.status === 'dispersed') {
      expect(current.endedAt).toBe(ordered.tick);
      for (const id of current.attendeeIds) expect(ordered.souls[id].activity).not.toBe('gathering');
    }
  });

  it('does not create a banner or empty crowd when every selected resident complies with public order', () => {
    // Needs a district where every resident the deputation would draw on
    // complies, and which seeds those are moves whenever worldgen does. Search
    // a fixed list in order rather than pinning one: the property under test is
    // that full compliance produces no banner and no crowd, not any particular
    // district. Fails loudly if no seed in the corpus can show it.
    let shown = false;
    for (let i = 0; i < 16 && !shown; i++) {
      const city = newCity(`dep-zero-${i}`);
      warp(city, 600);
      // The fixture helpers throw on a district that cannot stage this at all,
      // which is a legitimate outcome per seed and not a failure: skip it and
      // try the next. Only running out of seeds is a failure.
      let id = -1;
      try {
        id = deputationTarget(city);
      } catch {
        continue;
      }
      if (!apply(city, 'fileWorks', { kind: 'building', id })) continue;
      if (!enact(city, 'publicOrder', 5)) continue;
      if (callDeputation(city, id, 1) !== 0) continue;
      expect(city.deputations.current).toBeNull();
      expect(city.deputations.revision).toBe(0);
      shown = true;
    }
    expect(shown).toBe(true);
  });

  it('replays the same nudge sequence and split warp to the same world hash', () => {
    const play = (split: boolean): number => {
      const city = newCity('verdigris');
      const id = filedDeputation(city);
      expect(apply(city, 'callDeputation', { kind: 'building', id })).toBe(true);
      if (split) {
        warp(city, 70);
        warp(city, 110);
      } else {
        warp(city, 180);
      }
      return hashWorld(city);
    };

    expect(play(false)).toBe(play(false));
    expect(play(true)).toBe(play(false));
  });
});
