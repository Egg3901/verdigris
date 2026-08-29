// River level is a pure function of (seed, tick) so that replay and
// the save format stay untouched. The level is derived from a weighted sum of
// the last 28 watches of precipitation, which makes the river respond to recent
// weather without needing stored state. A slow dry-spell bias lowers the level
// during droughts, and the final level is clamped to 0..4.
import { weatherAt, naturalWeatherAt, forcedWeather, WEATHER_WATCH_MINUTES } from './weather';
import { mix, Stream } from './rng';

export const RIVER_LOOKBACK_WATCHES = 28;

/** A river has base flow: springs and the upstream catchment keep it alive
 *  through ordinary dry weather. Droughts need a sustained deficit. */
const BASE_FLOW = 40;

const RIVER_SURFACE_DROP: readonly number[] = [10, 8, 6, 4, 2];

function wetAt(seed: number, tick: number): number {
  const currentWatch = Math.floor(Math.max(0, tick) / WEATHER_WATCH_MINUTES);
  let wet = 0;
  for (let age = 0; age < RIVER_LOOKBACK_WATCHES; age++) {
    const sampleTick = tick - age * WEATHER_WATCH_MINUTES;
    // Prehistory: before tick 0, borrow the seed's own weather a lookback
    // ahead, so the district opens with a real river rather than an empty
    // rain ledger reading as a drought.
    // Borrowed prehistory reads the natural clock: a pin applies forward, and
    // reading history through it would let one click drain a week of rain.
    const p = sampleTick >= 0
      ? weatherAt(seed, sampleTick).precipitation
      : naturalWeatherAt(seed, sampleTick + RIVER_LOOKBACK_WATCHES * WEATHER_WATCH_MINUTES).precipitation;
    wet += (RIVER_LOOKBACK_WATCHES - age) * p;
  }
  wet += BASE_FLOW;

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
  return wet;
}

export function riverLevelAt(seed: number, tick: number): number {
  const wet = wetAt(seed, tick);
  let level: number;
  if (wet <= 95) level = 0;
  else if (wet <= 135) level = 1;
  else if (wet <= 240) level = 2;
  else if (wet <= 300) level = 3;
  else level = 4;

  return Math.max(0, Math.min(4, level));
}

/**
 * The surface height in pixels below the bank lip, at pixel resolution rather
 * than in five steps, so the river rises and falls a pixel at a time as the
 * rain ledger moves instead of jumping a band per rebake.
 */
export function riverDropAt(seed: number, tick: number): number {
  const wet = wetAt(seed, tick);
  if (wet <= 95) return 10;
  if (wet >= 300) return 2;
  return Math.round(10 - (8 * (wet - 95)) / 205);
}

export function riverSurfaceDrop(level: number): number {
  return RIVER_SURFACE_DROP[Math.max(0, Math.min(4, level))];
}