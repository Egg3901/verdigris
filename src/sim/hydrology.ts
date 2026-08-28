// River level is a pure function of (seed, tick) so that replay and
// the save format stay untouched. The level is derived from a weighted sum of
// the last 28 watches of precipitation, which makes the river respond to recent
// weather without needing stored state. A slow dry-spell bias lowers the level
// during droughts, and the final level is clamped to 0..4.
import { weatherAt, forcedWeather, WEATHER_WATCH_MINUTES } from './weather';
import { mix, Stream } from './rng';

export const RIVER_LOOKBACK_WATCHES = 28;

const RIVER_SURFACE_DROP: readonly number[] = [10, 8, 6, 4, 2];

export function riverLevelAt(seed: number, tick: number): number {
  const currentWatch = Math.floor(Math.max(0, tick) / WEATHER_WATCH_MINUTES);
  let wet = 0;
  for (let age = 0; age < RIVER_LOOKBACK_WATCHES; age++) {
    const sampleTick = tick - age * WEATHER_WATCH_MINUTES;
    let precipitation = 0;
    if (sampleTick >= 0) {
      precipitation = weatherAt(seed, sampleTick).precipitation;
    }
    wet += (RIVER_LOOKBACK_WATCHES - age) * precipitation;
  }

  const pressureSystem = Math.floor(currentWatch / 8);
  const dry = mix(seed, Stream.Weather, pressureSystem, 7) % 100;
  if (dry < 12) {
    wet -= 120;
  }

  // The sandbox drought is faster than any natural dry spell: the bed empties
  // over hours, not days, draining harder the longer the pin holds.
  const pinned = forcedWeather();
  if (pinned.kind === 'drought' && tick >= pinned.since) {
    wet -= Math.floor((tick - pinned.since) * 2 / 3);
  }

  let level: number;
  if (wet <= 55) level = 0;
  else if (wet <= 95) level = 1;
  else if (wet <= 200) level = 2;
  else if (wet <= 260) level = 3;
  else level = 4;

  return Math.max(0, Math.min(4, level));
}

export function riverSurfaceDrop(level: number): number {
  return RIVER_SURFACE_DROP[Math.max(0, Math.min(4, level))];
}