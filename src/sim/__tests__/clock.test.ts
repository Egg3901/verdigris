import { describe, expect, it } from 'vitest';
import { dayOf, formatClock, isLampHour, MIN_PER_DAY, minuteOfDay, phaseLabel, phaseOf } from '../clock';

describe('clock', () => {
  it('reads the reference screenshot back exactly', () => {
    // The post this game came from shows "10:41AM - MORNING". That is tick 641,
    // and it is the anchor tick for the first screenshot golden.
    expect(formatClock(641)).toBe('10:41AM');
    expect(phaseLabel(phaseOf(641))).toBe('MORNING');
  });

  it('handles noon and midnight without a 0 o clock', () => {
    expect(formatClock(0)).toBe('12:00AM');
    expect(formatClock(720)).toBe('12:00PM');
    expect(formatClock(1439)).toBe('11:59PM');
  });

  it('wraps days', () => {
    expect(dayOf(0)).toBe(1);
    expect(dayOf(MIN_PER_DAY)).toBe(2);
    expect(minuteOfDay(MIN_PER_DAY + 5)).toBe(5);
    expect(formatClock(MIN_PER_DAY + 641)).toBe(formatClock(641));
  });

  it('covers every minute with exactly one phase', () => {
    for (let m = 0; m < MIN_PER_DAY; m++) {
      expect(typeof phaseOf(m)).toBe('string');
    }
  });

  it('lights the lamps from dusk to dawn and not otherwise', () => {
    expect(isLampHour(641)).toBe(false);
    expect(isLampHour(1260)).toBe(true);
    expect(isLampHour(60)).toBe(true);
    expect(isLampHour(500)).toBe(false);
  });
});
