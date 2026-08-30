import { describe, expect, it } from 'vitest';
import { freightStrideAt, riverBoatCountAt } from '../fx';

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
});
