// Deterministic seeded RNG. All sim randomness flows through this, never Math.random.
//
// DETERMINISM CONTRACT: no PRNG cursor is ever stored in sim state. Every random
// decision derives its generator from (seed, stream, tick, entity), so a replay
// from (seedStr, tickCount, nudges) is exact with no hidden state to restore.
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Integer mixer. Order matters: every argument shifts the whole downstream stream. */
export function mix(a: number, b: number, c = 0, d = 0): number {
  let h = 2166136261 >>> 0;
  h = Math.imul(h ^ (a >>> 0), 16777619);
  h = Math.imul(h ^ (b >>> 0), 16777619);
  h = Math.imul(h ^ (c >>> 0), 16777619);
  h = Math.imul(h ^ (d >>> 0), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 16777619);
  return (h ^ (h >>> 15)) >>> 0;
}

// One stream per worldgen stage and per runtime system. Separate streams matter:
// inserting a stage later must not reshuffle the draws of the stages before it.
export const Stream = {
  Gen: 1,
  GenRiver: 2,
  GenStreets: 3,
  GenBlocks: 4,
  GenPlots: 5,
  GenAssign: 6,
  GenNames: 7,
  GenSouls: 8,
  GenNetworks: 9,
  GenTram: 10,
  GenHistory: 11,
  GenWards: 12,
  Schedule: 20,
  Gossip: 21,
  Incident: 22,
  Prose: 23,
  Tram: 24,
  Crowd: 25,
  Law: 28,
  /** Natural physical failures. Kept apart from incidents so adding a disaster
   *  kind never changes the district's social incident sequence. */
  Disaster: 29,
} as const;
export type StreamId = (typeof Stream)[keyof typeof Stream];

/** A generator uniquely determined by where you are, not by how you got there. */
export function streamAt(seed: number, stream: StreamId, tick: number, entity = 0): Rng {
  return mulberry32(mix(seed, stream, tick, entity));
}

/** Integer in [0, n). */
export function int(rng: Rng, n: number): number {
  return Math.min(n - 1, Math.floor(rng() * n));
}

/** Integer in [lo, hi], inclusive both ends. */
export function range(rng: Rng, lo: number, hi: number): number {
  return lo + int(rng, hi - lo + 1);
}

export function pick<T>(rng: Rng, xs: readonly T[]): T {
  return xs[int(rng, xs.length)];
}

export function weightedPick<T>(rng: Rng, xs: readonly T[], w: readonly number[]): T {
  let total = 0;
  for (let i = 0; i < xs.length; i++) total += w[i];
  if (total <= 0) return xs[int(rng, xs.length)];
  let r = rng() * total;
  for (let i = 0; i < xs.length; i++) {
    r -= w[i];
    if (r <= 0) return xs[i];
  }
  return xs[xs.length - 1];
}

/** Integer odds out of 1000, so callers never carry a float threshold in state. */
export function chance(rng: Rng, permille: number): boolean {
  return rng() * 1000 < permille;
}

/** In-place Fisher-Yates. Deterministic given the rng. */
export function shuffle<T>(rng: Rng, xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = int(rng, i + 1);
    const t = xs[i];
    xs[i] = xs[j];
    xs[j] = t;
  }
  return xs;
}

/**
 * Value noise on an integer lattice, smoothstep interpolated.
 *
 * Deliberately NOT trigonometric: Math.sin and friends are not bit-identical
 * across JS engines, and anything feeding stored worldgen state has to be.
 * Returns 0..1.
 */
export function noise2(seed: number, stream: StreamId, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const c = (px: number, py: number) => mix(seed, stream, px | 0, py | 0) / 4294967296;
  const a00 = c(xi, yi);
  const a10 = c(xi + 1, yi);
  const a01 = c(xi, yi + 1);
  const a11 = c(xi + 1, yi + 1);
  const top = a00 + (a10 - a00) * u;
  const bot = a01 + (a11 - a01) * u;
  return top + (bot - top) * v;
}

/** Fractal value noise. Same determinism guarantee as noise2. */
export function fbm2(seed: number, stream: StreamId, x: number, y: number, octaves = 3): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise2(seed + o * 7919, stream, x * f, y * f);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}
