import { describe, expect, it } from 'vitest';
import { newCity } from '../../sim/city';
import { collectVehicles, freightStrideAt, riverBoatCountAt } from '../fx';

describe('rendered city pulse', () => {
  it('thins road freight outside the working day', () => {
    expect(freightStrideAt(720)).toBe(1);
    expect(freightStrideAt(1200)).toBe(2);
    expect(freightStrideAt(60)).toBe(5);
  });

  it('keeps river traffic proportional to both water and shift', () => {
    expect(riverBoatCountAt(3, 720)).toBe(3);
    expect(riverBoatCountAt(3, 1260)).toBe(2);
    expect(riverBoatCountAt(3, 60)).toBe(1);
    expect(riverBoatCountAt(1, 60)).toBe(0);
    expect(riverBoatCountAt(0, 720)).toBe(0);
  });

  it('culls an off-screen barge without writing a missing vehicle slot', () => {
    const city = newCity('verdigris');
    city.tick = 720;
    const out: Parameters<typeof collectVehicles>[5] = [];
    expect(collectVehicles(
      city, [], 0,
      { wx: 1_000_000, wy: 1_000_000 },
      { wx: 1_000_010, wy: 1_000_010 },
      out,
    )).toBe(0);
    expect(out).toHaveLength(0);
  });
});
