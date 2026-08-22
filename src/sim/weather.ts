// Weather is derived from the clock rather than advanced through a hidden
// cursor. A six-hour watch is long enough to become part of the district's day,
// while a two-day pressure system keeps adjacent watches from feeling like dice.
import { MIN_PER_DAY, minuteOfDay } from './clock';
import { mix, Stream } from './rng';

export type WeatherKind = 'fair' | 'overcast' | 'rain' | 'storm' | 'fog';

export interface Weather {
  kind: WeatherKind;
  precipitation: 0 | 1 | 2;
  chill: 0 | 1 | 2;
  visibility: 0 | 1 | 2;
  /** Screen-space lean for rain, flags and smoke. */
  windX: -1 | 0 | 1;
  /** Absolute six-hour watch, and therefore the render revision. */
  watch: number;
  revision: number;
}

export const WEATHER_WATCH_MINUTES = MIN_PER_DAY / 4;

const WIND: readonly (-1 | 0 | 1)[] = [-1, -1, 0, 1, 1];

/** A pure snapshot. Same seed and tick always mean the same sky. */
export function weatherAt(seed: number, tick: number): Weather {
  const watch = Math.floor(Math.max(0, tick) / WEATHER_WATCH_MINUTES);
  const pressureSystem = Math.floor(watch / 8);
  const climate = mix(seed, Stream.Weather, pressureSystem, 0) % 100;
  const roll = mix(seed, Stream.Weather, watch, 1) % 100;
  const watchOfDay = Math.floor(minuteOfDay(tick) / WEATHER_WATCH_MINUTES);

  const wetSystem = climate < 38;
  const drySystem = climate >= 70;
  const stormAt = wetSystem ? 12 : drySystem ? 2 : 5;
  const rainAt = stormAt + (wetSystem ? 38 : drySystem ? 12 : 24);
  const fogAt = rainAt + (watchOfDay === 1 ? 18 : 5);
  const cloudAt = Math.min(94, fogAt + (drySystem ? 14 : 24));

  let kind: WeatherKind;
  if (roll < stormAt) kind = 'storm';
  else if (roll < rainAt) kind = 'rain';
  else if (roll < fogAt) kind = 'fog';
  else if (roll < cloudAt) kind = 'overcast';
  else kind = 'fair';

  const precipitation: Weather['precipitation'] = kind === 'storm' ? 2 : kind === 'rain' ? 1 : 0;
  const chill: Weather['chill'] = kind === 'storm' || kind === 'fog' ? 2
    : kind === 'rain' || kind === 'overcast' ? 1 : 0;
  const visibility: Weather['visibility'] = kind === 'fog' ? 2 : kind === 'storm' ? 1 : 0;
  const windX = WIND[mix(seed, Stream.Weather, watch, 2) % WIND.length];
  return { kind, precipitation, chill, visibility, windX, watch, revision: watch };
}

export function isWetWeather(weather: Weather): boolean {
  return weather.precipitation > 0;
}

/** Weather changes optional street trips, never a person's authored schedule. */
export function weatherErrandQuota(base: number, weather: Weather): number {
  if (weather.kind === 'storm') return Math.max(1, Math.round(base * 0.42));
  if (weather.kind === 'rain' || weather.kind === 'fog') return Math.max(1, Math.round(base * 0.68));
  return base;
}

/** Applied once per soul's ten-minute needs slice while they remain outdoors. */
export function weatherExposurePenalty(weather: Weather): number {
  return weather.precipitation + weather.chill;
}

/** Rain exposes a failed drain; sound buildings do not decay just because it rains. */
export function weatherFabricWear(weather: Weather, drainServed: boolean): number {
  if (drainServed || weather.precipitation === 0) return 0;
  return weather.precipitation;
}

export function weatherOutputPermille(weather: Weather, firmKind: string): number {
  if (firmKind !== 'wharf') return 1000;
  return weather.kind === 'storm' ? 700 : weather.kind === 'rain' ? 880 : weather.kind === 'fog' ? 920 : 1000;
}

export function weatherLabel(weather: Weather): string {
  switch (weather.kind) {
    case 'storm': return 'RAIN, HARD';
    case 'rain': return 'STEADY RAIN';
    case 'fog': return 'RIVER FOG';
    case 'overcast': return 'OVERCAST';
    default: return 'FAIR';
  }
}
