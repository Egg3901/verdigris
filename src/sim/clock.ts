// The district clock. One tick is one game-minute; city.tick is the canonical
// integer clock. The float simMin lives only in main.ts and never enters the sim.

export const MIN_PER_DAY = 1440;

export type DayPhase = 'night' | 'dawn' | 'morning' | 'afternoon' | 'evening' | 'dusk';

/** Speeds in game-minutes per real second. Index into this from the transport buttons. */
export const SPEEDS: readonly number[] = [0, 1, 4, 20];

/** Catch-up cap. Without it a backgrounded tab returns and spins forever. */
export const MAX_TICKS_PER_FRAME = 12;

/** The dead hour. Rent, wages, evictions and the intervention budget all land here. */
export const DAILY_MINUTE = 180;

export function dayOf(tick: number): number {
  return Math.floor(tick / MIN_PER_DAY) + 1;
}

export function minuteOfDay(tick: number): number {
  const m = tick % MIN_PER_DAY;
  return m < 0 ? m + MIN_PER_DAY : m;
}

export function phaseOf(tick: number): DayPhase {
  const m = minuteOfDay(tick);
  if (m < 300) return 'night';
  if (m < 420) return 'dawn';
  if (m < 720) return 'morning';
  if (m < 1020) return 'afternoon';
  if (m < 1200) return 'evening';
  if (m < 1320) return 'dusk';
  return 'night';
}

const PHASE_LABEL: Record<DayPhase, string> = {
  night: 'NIGHT',
  dawn: 'DAWN',
  morning: 'MORNING',
  afternoon: 'AFTERNOON',
  evening: 'EVENING',
  dusk: 'DUSK',
};

export function phaseLabel(p: DayPhase): string {
  return PHASE_LABEL[p];
}

/** "10:41AM". The reference screenshot's clock is formatClock(641). */
export function formatClock(tick: number): string {
  const m = minuteOfDay(tick);
  const h24 = Math.floor(m / 60);
  const min = m % 60;
  const ampm = h24 < 12 ? 'AM' : 'PM';
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${min < 10 ? '0' : ''}${min}${ampm}`;
}

/** Lamps are lit from dusk to dawn. Drives gas draw, arc lamps and the night atlas. */
export function isLampHour(tick: number): boolean {
  const m = minuteOfDay(tick);
  return m >= 1200 || m < 420;
}

/** 0..1000 across the dawn or dusk window, for the Bayer dither dissolve. */
export function lightBlend(tick: number): { from: DayPhase; to: DayPhase; t: number } {
  const m = minuteOfDay(tick);
  if (m >= 1200 && m < 1320) return { from: 'dusk', to: 'night', t: Math.round(((m - 1200) / 120) * 1000) };
  if (m >= 1020 && m < 1200) return { from: 'afternoon', to: 'dusk', t: Math.round(((m - 1020) / 180) * 1000) };
  if (m >= 300 && m < 420) return { from: 'night', to: 'dawn', t: Math.round(((m - 300) / 120) * 1000) };
  if (m >= 420 && m < 540) return { from: 'dawn', to: 'morning', t: Math.round(((m - 420) / 120) * 1000) };
  const p = phaseOf(tick);
  return { from: p, to: p, t: 0 };
}
