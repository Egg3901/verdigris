// The three things a ward boss is actually balancing.
//
// The simulation runs on eight fine-grained pressures plus the enforcement
// level, which is the right vocabulary for the machinery but the wrong one for
// the goal. A player is not trying to hold `suspicion` at 180; they are trying
// to keep the district happy, orderly and solvent, and to decide which of the
// three they are willing to spend to buy the others.
//
// These are DERIVED, never stored: they are a reading of the live pressures, so
// nothing can set "happiness" directly and every point of it is the honest
// consequence of the sim underneath. That is the same discipline the
// interventions follow, applied to the scoreboard.
import type { City } from './city';
import { pressureOf } from './pressures';

export interface WardMetrics {
  /** How the district feels: mood, carried in part by wages. */
  happiness: number;
  /** Public order: calm and trust set against fear, plus the weight of the law. */
  order: number;
  /** The public purse. */
  money: number;
}

const clamp = (v: number): number => Math.max(0, Math.min(1000, Math.round(v)));

export function wardMetrics(city: City): WardMetrics {
  const mood = pressureOf(city.press, 'mood');
  const wages = pressureOf(city.press, 'wages');
  const suspicion = pressureOf(city.press, 'suspicion');
  const coin = pressureOf(city.press, 'coin');
  const enforcement = city.laws.enforcement;
  return {
    happiness: clamp(mood * 0.7 + wages * 0.3),
    // Order rises with public calm (the inverse of suspicion) and with the
    // enforcement the vestry is willing to fund. A frightened, over-policed
    // district and a trusting, unpoliced one can read the same number by
    // different routes, which is the tension the axis is meant to hold.
    order: clamp((1000 - suspicion) * 0.6 + enforcement * 0.4),
    money: clamp(coin),
  };
}

/** A plain word for a 0..1000 reading, so the meters can caption themselves. */
export function metricWord(value: number): string {
  if (value >= 820) return 'thriving';
  if (value >= 640) return 'steady';
  if (value >= 440) return 'strained';
  if (value >= 240) return 'failing';
  return 'critical';
}
