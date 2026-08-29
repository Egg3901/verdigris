// Weather is derived from the clock rather than advanced through a hidden
// cursor. A six-hour watch is long enough to become part of the district's day,
// while a two-day pressure system keeps adjacent watches from feeling like dice.
import { MIN_PER_DAY, minuteOfDay } from './clock';
import { mix, Stream } from './rng';

export type WeatherKind = 'fair' | 'overcast' | 'rain' | 'storm' | 'fog' | 'snow';

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

/**
 * The district's year, in days.
 *
 * Short enough that a player who stays with a district sees a winter, long
 * enough that the cold is an occasion rather than a mood that comes round every
 * week. Day 0 sits in the mild part of the year, so a new district never opens
 * in the snow.
 */
export const YEAR_DAYS = 48;

/** The coldest day of the year. Winter reaches back and forward from here. */
const MIDWINTER_DAY = 36;

/** Days either side of midwinter that can freeze at all. */
const WINTER_REACH = 8;

export function dayOfYear(tick: number): number {
  return Math.floor(Math.max(0, tick) / MIN_PER_DAY) % YEAR_DAYS;
}

/**
 * How cold the season is, 0 to 100.
 *
 * Zero for two thirds of the year, rising to 100 at midwinter. This is a
 * seasonal temperature, not a chance: it is what the freezing roll is measured
 * against, so the deep of winter turns every shower to snow while the shoulders
 * of the season only freeze the occasional watch.
 */
export function seasonColdness(tick: number): number {
  const day = dayOfYear(tick);
  let dist = Math.abs(day - MIDWINTER_DAY);
  if (dist > YEAR_DAYS / 2) dist = YEAR_DAYS - dist;
  if (dist >= WINTER_REACH) return 0;
  return 100 - Math.round((dist * 100) / WINTER_REACH);
}

// A sandbox override. Normally weather is a pure function of (seed, tick); when
// the player pins it from the settings panel, that pin wins everywhere until it
// is cleared. Bumping a generation counter on every change moves the render
// revision, which is what makes the compositor rebake the baked fog and puddles
// for the new sky rather than only the per-frame rain.
/** 'drought' is a sandbox condition, not a WeatherKind: the sky shows fair
 *  while the river is drained on its own clock in hydrology.ts. */
export type ForcedWeather = WeatherKind | 'drought';

let forcedKind: ForcedWeather | null = null;
let forcedSince = 0;
let forcedGen = 0;

/**
 * The pin applies from the moment it is set, never retroactively. History
 * before sinceTick keeps the natural weather, so anything integrated over
 * trailing watches, the river level above all, moves gradually after a pin
 * instead of teleporting: pinning rain fills the river over days, pinning
 * fair drains it over days.
 */
export function forceWeather(kind: ForcedWeather | null, sinceTick = 0): void {
  forcedKind = kind;
  forcedSince = sinceTick;
  forcedGen++;
}

export function forcedWeather(): { kind: ForcedWeather | null; since: number } {
  return { kind: forcedKind, since: forcedSince };
}

// The last (seed, tick) anybody asked the sky about.
//
// RENDER ONLY, and nothing in src/sim ever reads it, so it cannot enter the
// world hash or the save. It exists because a building sprite is baked from a
// HouseSpec that carries no clock, and roof snow has to know whether it is
// snowing. scene.ts samples the weather for the building it is about to bake
// immediately before it bakes it, so the latch is the current sky at that
// moment. Once scene.ts passes snowCover on the spec this can go.
let latchSeed = -1;
let latchTick = -1;

/** A pure snapshot, unless the player has pinned the weather from the sandbox. */
export function weatherAt(seed: number, tick: number): Weather {
  latchSeed = seed;
  latchTick = tick;
  return sample(seed, tick, true);
}

/**
 * The weather the clock alone would give, ignoring any sandbox pin.
 *
 * The river integrates a week of rain, and for the opening week it borrows
 * that history from ticks a lookback ahead. A pin applies forward, so reading
 * borrowed history through the pin let a single click on Fair rewrite seven
 * days of rain at once and empty the channel between two frames. History is
 * never pinned; only the present is.
 */
export function naturalWeatherAt(seed: number, tick: number): Weather {
  return sample(seed, tick, false);
}

function sample(seed: number, tick: number, allowPin: boolean): Weather {
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

  // Snow is not a sixth sky drawn from the same hat: it is what the district's
  // rain becomes when it is cold enough. The pressure system still decides
  // whether there is weather at all, so a dry winter system stays dry, and the
  // freezing roll only asks whether what is already falling arrives frozen.
  // The small hours and the dawn watch are the cold ones, so a shower that
  // would fall as rain at noon can come down as snow before daylight.
  if (kind === 'rain' || kind === 'storm') {
    const nightBite = watchOfDay === 0 ? 24 : watchOfDay === 1 ? 10 : watchOfDay === 3 ? 14 : 0;
    const bite = seasonColdness(tick) + (seasonColdness(tick) > 0 ? nightBite : 0);
    if (bite > 0 && mix(seed, Stream.Weather, watch, 3) % 100 < bite) kind = 'snow';
  }

  if (allowPin && forcedKind !== null && tick >= forcedSince) {
    kind = forcedKind === 'drought' ? 'fair' : forcedKind;
  }

  // Snow IS precipitation: people shelter from it, the quays lose work in it,
  // and a failed gutter still gets wet under it. It is one step rather than two
  // because a blizzard is a storm and this is snowfall.
  const precipitation: Weather['precipitation'] = kind === 'storm' ? 2
    : kind === 'rain' || kind === 'snow' ? 1 : 0;
  const chill: Weather['chill'] = kind === 'storm' || kind === 'fog' || kind === 'snow' ? 2
    : kind === 'rain' || kind === 'overcast' ? 1 : 0;
  const visibility: Weather['visibility'] = kind === 'fog' ? 2
    : kind === 'storm' || kind === 'snow' ? 1 : 0;
  const windX = WIND[mix(seed, Stream.Weather, watch, 2) % WIND.length];
  const revision = allowPin && forcedKind !== null
    ? 1_000_000 + forcedGen * 4096 + watch : watch;
  return { kind, precipitation, chill, visibility, windX, watch, revision };
}

export function isWetWeather(weather: Weather): boolean {
  return weather.precipitation > 0;
}

/**
 * How much of a watch's precipitation runs off into the river, in quarters of
 * one step of rain. Rain is 4 and a storm is 8, which is exactly the weight
 * hydrology.ts used before snow existed, so a district that never freezes has
 * the river it always had.
 *
 * SNOW IS 1, a quarter of rain. Snow that falls stays on the roofs and the
 * setts; it reaches the channel when it thaws, days later, and the thaw is not
 * modelled. Letting a snow watch swell the river like a rain watch would have
 * the level climbing while the district is visibly frozen, and floods keyed off
 * precipitation would fire in a blizzard. A small trickle is honest: some of it
 * melts on contact with warm stone and the drains take it.
 */
export function precipitationRunoffQuarters(weather: Weather): number {
  if (weather.kind === 'snow') return 1;
  return weather.precipitation * 4;
}

/** How long the ground remembers snow: a full cover takes about a day to go. */
const SNOW_LOOKBACK_WATCHES = 10;

/** Full cover. A permille so the cover deepens by pixels, not by steps. */
const SNOW_FULL = 1000;

/**
 * Lying snow, 0 to 1000, as a pure function of (seed, tick).
 *
 * The same shape as the river's rain ledger: walk the recent watches forward,
 * adding while it snows and taking away while it does not. Nothing is stored,
 * so a replay lands on the same cover, and pinning snow from the sandbox builds
 * the cover up over the following watches instead of dressing the district
 * instantly.
 *
 * A thaw under a cold sky is slow; a thaw in mild weather clears the streets in
 * a watch or two, which is what makes the day after the snow read as the day
 * after rather than as a second winter.
 */
export function snowCoverAt(seed: number, tick: number): number {
  let cover = 0;
  for (let age = SNOW_LOOKBACK_WATCHES; age >= 0; age--) {
    const watchTick = tick - age * WEATHER_WATCH_MINUTES;
    if (watchTick < 0) continue;
    // The current watch counts only for the part of it that has actually
    // happened, so the cover grows through the watch rather than at its edge.
    const part = age === 0
      ? (tick % WEATHER_WATCH_MINUTES) / WEATHER_WATCH_MINUTES
      : 1;
    const w = sample(seed, watchTick, true);
    if (w.kind === 'snow') {
      cover += Math.round(360 * part);
    } else {
      const freezing = seasonColdness(watchTick) >= 55 && w.chill >= 2;
      cover -= Math.round((freezing ? 130 : 420) * part);
    }
    cover = Math.max(0, Math.min(SNOW_FULL, cover));
  }
  return cover;
}

/**
 * Lying snow for the (seed, tick) the renderer last asked the sky about.
 * See the latch above: this is the bake-time reader, and only the renderer
 * calls it.
 */
export function latchedSnowCover(): number {
  if (latchSeed < 0) return 0;
  return snowCoverAt(latchSeed, latchTick);
}

/** Whether the sky the renderer last sampled was snowing. */
export function latchedSnowfall(): boolean {
  if (latchSeed < 0) return false;
  return sample(latchSeed, latchTick, true).kind === 'snow';
}

/** Weather changes optional street trips, never a person's authored schedule. */
export function weatherErrandQuota(base: number, weather: Weather): number {
  if (weather.kind === 'storm') return Math.max(1, Math.round(base * 0.42));
  // Snow keeps more people in than rain does and fewer than a storm: the errand
  // is not dangerous, it is just cold, dark and slow underfoot.
  if (weather.kind === 'snow') return Math.max(1, Math.round(base * 0.55));
  if (weather.kind === 'rain' || weather.kind === 'fog') return Math.max(1, Math.round(base * 0.68));
  return base;
}

/** Applied once per soul's ten-minute needs slice while they remain outdoors. */
export function weatherExposurePenalty(weather: Weather): number {
  return weather.precipitation + weather.chill;
}

/** Rain exposes a failed drain; sound buildings do not decay just because it
 *  rains. Snow counts the same as rain here: it lies in the broken gutter and
 *  goes into the wall as it melts. */
export function weatherFabricWear(weather: Weather, drainServed: boolean): number {
  if (drainServed || weather.precipitation === 0) return 0;
  return weather.precipitation;
}

export function weatherOutputPermille(weather: Weather, firmKind: string): number {
  if (firmKind !== 'wharf') return 1000;
  // Frozen ropes, iced decks and a shorthanded gang: worse than rain, better
  // than a storm that stops the river working at all.
  return weather.kind === 'storm' ? 700 : weather.kind === 'snow' ? 800
    : weather.kind === 'rain' ? 880 : weather.kind === 'fog' ? 920 : 1000;
}

export function weatherLabel(weather: Weather): string {
  switch (weather.kind) {
    case 'storm': return 'RAIN, HARD';
    case 'rain': return 'STEADY RAIN';
    case 'snow': return 'SNOW';
    case 'fog': return 'RIVER FOG';
    case 'overcast': return 'OVERCAST';
    default: return 'FAIR';
  }
}
