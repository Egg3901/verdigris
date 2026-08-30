// River level is a pure function of (seed, tick) so that replay and
// the save format stay untouched. The level is derived from a weighted sum of
// the last 28 watches of precipitation, which makes the river respond to recent
// weather without needing stored state. A slow dry-spell bias lowers the level
// during droughts, and the final level is clamped to 0..4.
import {
  weatherAt, naturalWeatherAt, forcedWeather, precipitationRunoffQuarters, WEATHER_WATCH_MINUTES,
} from './weather';
import { mix, Stream } from './rng';

export const RIVER_LOOKBACK_WATCHES = 28;

/** A river has base flow: springs and the upstream catchment keep it alive
 *  through ordinary dry weather. Droughts need a sustained deficit. */
const BASE_FLOW = 40;

const RIVER_SURFACE_DROP: readonly number[] = [10, 8, 6, 4, 2];

/** The runoff ledger at one instant, before the channel's inertia is applied. */
function runoffTargetAt(seed: number, tick: number, naturalOnly = false): number {
  const currentWatch = Math.floor(Math.max(0, tick) / WEATHER_WATCH_MINUTES);
  let wet = 0;
  // Runoff is carried in quarters of one step of rain so that snow can count
  // for a quarter of what rain counts for without moving the levels a rainy
  // district has always had. See precipitationRunoffQuarters: snow lies where
  // it falls, and the thaw that would eventually feed the channel is days away
  // and not modelled.
  let quarters = 0;
  for (let age = 0; age < RIVER_LOOKBACK_WATCHES; age++) {
    const sampleTick = tick - age * WEATHER_WATCH_MINUTES;
    // Prehistory: before tick 0, borrow the seed's own weather a lookback
    // ahead, so the district opens with a real river rather than an empty
    // rain ledger reading as a drought.
    // Borrowed prehistory reads the natural clock: a pin applies forward, and
    // reading history through it would let one click drain a week of rain.
    const w = sampleTick >= 0
      ? naturalOnly ? naturalWeatherAt(seed, sampleTick) : weatherAt(seed, sampleTick)
      : naturalWeatherAt(seed, sampleTick + RIVER_LOOKBACK_WATCHES * WEATHER_WATCH_MINUTES);
    quarters += (RIVER_LOOKBACK_WATCHES - age) * precipitationRunoffQuarters(w);
  }
  wet += Math.floor(quarters / 4);
  wet += BASE_FLOW;

  const pressureSystem = Math.floor(currentWatch / 8);
  const dry = mix(seed, Stream.Weather, pressureSystem, 7) % 100;
  if (dry < 12) {
    wet -= 120;
  }

  return wet;
}

/** Interpolate between adjacent natural watch ledgers with no boundary seam. */
function naturalWetAt(seed: number, tick: number): number {
  const watchStart = Math.floor(tick / WEATHER_WATCH_MINUTES) * WEATHER_WATCH_MINUTES;
  const previousTick = Math.max(0, watchStart - WEATHER_WATCH_MINUTES);
  const previous = runoffTargetAt(seed, previousTick, true);
  const target = runoffTargetAt(seed, watchStart, true);
  const elapsed = tick - watchStart;
  return previous + Math.round((target - previous) * elapsed / WEATHER_WATCH_MINUTES);
}

/**
 * Water has inertia.
 *
 * A six-hour weather watch changes at one tick, but the channel must not gain a
 * whole watch of runoff on that same minute. Interpolating from the previous
 * watch's ledger to the present one makes rain arrive through gutters, drains
 * and upstream ground over the following six hours. At the next boundary the
 * old target is exactly the value the last interpolation reached, so there is no
 * seam.
 */
function wetAt(seed: number, tick: number): number {
  const t = Math.max(0, tick);
  const pinned = forcedWeather();
  let wet: number;
  if (pinned.kind !== null && t >= pinned.since) {
    // Pins get their own watch cadence starting at the click. The first cycle
    // begins at the natural channel value already on screen; later cycles begin
    // at the exact target reached by the one before them.
    const age = t - pinned.since;
    const cycle = Math.floor(age / WEATHER_WATCH_MINUTES);
    const cycleStart = pinned.since + cycle * WEATHER_WATCH_MINUTES;
    const previous = cycle === 0
      ? naturalWetAt(seed, pinned.since)
      : runoffTargetAt(seed, cycleStart - WEATHER_WATCH_MINUTES);
    const target = runoffTargetAt(seed, cycleStart);
    wet = previous + Math.round(
      (target - previous) * (t - cycleStart) / WEATHER_WATCH_MINUTES,
    );
  } else {
    wet = naturalWetAt(seed, t);
  }
  // Drought is a sandbox fast-forward through a sustained deficit. It still
  // drains minute by minute, and now starts from the inertial channel above.
  if (pinned.kind === 'drought' && t >= pinned.since) {
    return wet - Math.floor((t - pinned.since) * 2 / 3);
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

/** Continuous channel fullness for effects whose density can change more finely
 * than the five simulation-facing level bands. */
export function riverFillAt(seed: number, tick: number): number {
  const wet = wetAt(seed, tick);
  if (wet <= 95) return 0;
  if (wet >= 300) return 1000;
  return Math.round(((wet - 95) * 1000) / 205);
}

export function riverSurfaceDrop(level: number): number {
  return RIVER_SURFACE_DROP[Math.max(0, Math.min(4, level))];
}
