// Stage 5: which building goes on which plot.
//
// Quotas run first as forced placements on their best-scoring eligible plot, then
// the residue fills. Scoring is the only place the district's social geography is
// decided, so it is worth reading closely: the mill wants the working bank and
// distance from the square, the bank wants the opposite, and the two of them
// pulling against each other is what produces a city with quarters.
import { Tile } from '../types';
import type { BuildingKind } from '../types';
import { DEFS, QUOTAS, RESIDUE } from '../buildings';
import type { District } from '../district';
import { cellKey, inBounds, tileAt } from '../district';
import { Stream, mulberry32, mix, range, weightedPick } from '../rng';
import type { Plot } from './plots';
import { plotIsReachable } from './plots';
import type { StreetPlan } from './streets';
import type { RiverPlan } from './river';

export interface Placement {
  plot: Plot;
  kind: BuildingKind;
  w: number;
  d: number;
  ox: number;
  oy: number;
}

interface Ctx {
  d: District;
  plots: Plot[];
  streets: StreetPlan;
  river: RiverPlan;
  distSquare: Float32Array;
  distRiver: Float32Array;
  nearWharf: Uint8Array;
  nearSquare: Uint8Array;
}

/** Footprint the plot can actually carry for this kind, respecting the 2x2 cap
 *  on non-landmarks and the frontage axis. */
export function footprintFor(plot: Plot, kind: BuildingKind, relaxed = false): { w: number; d: number } | null {
  const def = DEFS[kind];
  if (plot.frontage < (relaxed ? Math.min(2, def.minFrontage) : def.minFrontage)) return null;
  const horizontalFront = plot.dir === 2 || plot.dir === 3;
  const capFront = def.maxFoot[0];
  const capDeep = def.maxFoot[1];
  const w = horizontalFront ? Math.min(plot.w, capFront) : Math.min(plot.w, capDeep);
  const d = horizontalFront ? Math.min(plot.d, capDeep) : Math.min(plot.d, capFront);
  if (w < 1 || d < 1) return null;
  if (def.landmark && !relaxed) {
    // Landmarks need most of what they asked for, or they read as a shed.
    const wantW = horizontalFront ? capFront : capDeep;
    const wantD = horizontalFront ? capDeep : capFront;
    if (w < Math.min(2, wantW) || d < Math.min(2, wantD)) return null;
    if (w * d < Math.max(4, Math.floor(wantW * wantD * 0.45))) return null;
  }
  return { w, d };
}

function scoreOf(ctx: Ctx, plot: Plot, kind: BuildingKind): number {
  const k = cellKey(ctx.d, plot.ox, plot.oy);
  const ds = ctx.distSquare[k];
  const dr = ctx.distRiver[k];
  const polite = plot.polite ? 1 : 0;
  const area = plot.w * plot.d;
  const front = plot.frontage;
  const wharf = ctx.nearWharf[k];
  const onSquare = ctx.nearSquare[k];

  switch (kind) {
    case 'townhall': return onSquare * 120 + polite * 40 - ds * 3 + front * 8 + area * 4;
    case 'exchange': return onSquare * 90 + polite * 30 - ds * 2.5 + front * 7 + area * 3;
    case 'bank': return onSquare * 80 + polite * 35 - ds * 2.2 + front * 6;
    case 'glasshouse': return polite * 45 - Math.abs(ds - 8) * 3 + area * 4;
    case 'postexchange': return onSquare * 60 + polite * 25 - ds * 2 + front * 5;
    case 'newspaper': return -Math.abs(ds - 5) * 3 + front * 5 + polite * 10;
    case 'constabulary': return -Math.abs(ds - 6) * 3 + polite * 5 + front * 4;
    case 'chapel': return polite * 20 - Math.abs(ds - 9) * 2 + area * 3;
    case 'dispensary': return (1 - polite) * 30 - Math.abs(ds - 10) * 2;
    case 'school': return -Math.abs(ds - 11) * 2 + area * 4;
    case 'bathhouse': return (1 - polite) * 35 - Math.abs(ds - 9) * 2;
    case 'mast': return polite * 30 - Math.abs(ds - 7) * 2.5 + area * 3;
    case 'gasworks': return (1 - polite) * 70 + ds * 2.5 - dr * 1.5 + area * 3;
    case 'pumphouse': return -dr * 4 + (1 - polite) * 20;
    case 'tramdepot': return (1 - polite) * 40 + ds * 1.6 + area * 3;
    case 'mill': return (1 - polite) * 90 + ds * 3 - dr * 2 + area * 5 + plot.ox * 1.2;
    case 'foundry': return (1 - polite) * 80 + ds * 2.5 + area * 4 + plot.ox * 1.0;
    case 'workshop': return (1 - polite) * 40 + ds * 1.2 + area * 2;
    case 'wharfshed': return wharf * 140 - dr * 3;
    case 'warehouse': return wharf * 60 + (1 - polite) * 25 - dr * 1.5;
    case 'pub': return -Math.abs(ds - 8) * 1.2 + front * 3 + (1 - polite) * 12;
    case 'shop': return -ds * 1.4 + front * 4 + polite * 8;
    case 'villa': return polite * 60 + ds * 1.1 - wharf * 40 + area * 3;
    case 'tenement': return (1 - polite) * 45 + area * 4 - onSquare * 30;
    case 'terrace': return front <= 2 ? 20 + (1 - polite) * 10 : 0;
    case 'lodging': return (1 - polite) * 25 + ds * 0.8;
    case 'courtdwelling': return plot.court ? 200 : -1000;
    default: return 0;
  }
}

function bfsDist(d: District, sources: number[]): Float32Array {
  const dist = new Float32Array(d.width * d.height).fill(Infinity);
  const q: number[] = [];
  for (const s of sources) { dist[s] = 0; q.push(s); }
  const DXX = [1, -1, 0, 0];
  const DYY = [0, 0, 1, -1];
  for (let head = 0; head < q.length; head++) {
    const k = q[head];
    const x = k % d.width;
    const y = (k - x) / d.width;
    for (let i = 0; i < 4; i++) {
      const nx = x + DXX[i];
      const ny = y + DYY[i];
      if (!inBounds(d, nx, ny)) continue;
      const nk = cellKey(d, nx, ny);
      if (dist[nk] !== Infinity) continue;
      dist[nk] = dist[k] + 1;
      q.push(nk);
    }
  }
  for (let i = 0; i < dist.length; i++) if (dist[i] === Infinity) dist[i] = 60;
  return dist;
}

export function assignBuildings(
  d: District, seed: number, plots: Plot[], streets: StreetPlan, river: RiverPlan,
): Placement[] {
  const rng = mulberry32(mix(seed, Stream.GenAssign, 0));

  const squareCells: number[] = [];
  const riverCells: number[] = [];
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      const t = tileAt(d, x, y);
      if (t === Tile.Square) squareCells.push(cellKey(d, x, y));
      if (t === Tile.Water) riverCells.push(cellKey(d, x, y));
    }
  }
  const ctx: Ctx = {
    d, plots, streets, river,
    distSquare: bfsDist(d, squareCells.length ? squareCells : [cellKey(d, streets.squareX, streets.squareY)]),
    distRiver: bfsDist(d, riverCells),
    nearWharf: new Uint8Array(d.width * d.height),
    nearSquare: new Uint8Array(d.width * d.height),
  };
  for (const p of plots) {
    const k = cellKey(d, p.ox, p.oy);
    ctx.nearWharf[k] = tileAt(d, p.frontX, p.frontY) === Tile.Wharf ? 1 : 0;
    ctx.nearSquare[k] = tileAt(d, p.frontX, p.frontY) === Tile.Square ? 1 : 0;
  }

  const used = new Uint8Array(plots.length);
  const buildable = new Uint8Array(plots.length);
  for (const p of plots) buildable[p.id] = plotIsReachable(d, p) ? 1 : 0;
  const out: Placement[] = [];

  const place = (kind: BuildingKind, relaxed = false): boolean => {
    let best = -1;
    let bestScore = -Infinity;
    for (const p of plots) {
      if (used[p.id] || !buildable[p.id]) continue;
      if (p.court !== (kind === 'courtdwelling')) continue;
      const fp = footprintFor(p, kind, relaxed);
      if (!fp) continue;
      const s = scoreOf(ctx, p, kind) + (mix(seed, Stream.GenAssign, p.id, kind.length) % 100) / 25;
      if (s > bestScore) { bestScore = s; best = p.id; }
    }
    if (best < 0) return false;
    const p = plots[best];
    const fp = footprintFor(p, kind, relaxed);
    if (!fp) return false;
    used[p.id] = 1;
    // Anchor to the street end of the plot, so the facade meets the pavement.
    const ox = p.dir === 1 ? p.ox + (p.w - fp.w) : p.ox;
    const oy = p.dir === 3 ? p.oy + (p.d - fp.d) : p.oy;
    out.push({ plot: p, kind, w: fp.w, d: fp.d, ox, oy });
    return true;
  };

  // Forced placements first, in quota order. Anything that misses its minimum on
  // the strict pass gets a relaxed retry, because a district with no town hall is
  // not a district. Better a small civic hall than an absent one.
  for (const q of QUOTAS) {
    const want = range(rng, q.min, q.max);
    let got = 0;
    for (let i = 0; i < want; i++) { if (!place(q.kind)) break; got++; }
    while (got < q.min && place(q.kind, true)) got++;
  }

  // Courts are dwellings by definition. Fill them before the general residue so a
  // court never ends up as a villa.
  for (const p of plots) {
    if (used[p.id] || !buildable[p.id] || !p.court) continue;
    place('courtdwelling');
  }

  // Residue, up to a target. Weighted by score so the geography still decides,
  // but with enough noise that terraces and tenements interleave the way real
  // streets do.
  //
  // The target is a hard stop rather than "build on everything", because plot
  // supply swings by 15% across seeds and the title plate promises a roof count.
  // Plots left over are not failures: they become the back gardens, drying yards
  // and waste ground that stop a district reading as wall-to-wall frontage.
  const target = range(rng, 168, 196);
  for (const p of plots) {
    if (out.length >= target) break;
    if (used[p.id] || !buildable[p.id]) continue;
    const kinds: BuildingKind[] = [];
    const weights: number[] = [];
    for (const kind of RESIDUE) {
      if (kind === 'courtdwelling') continue;
      if (!footprintFor(p, kind)) continue;
      const s = scoreOf(ctx, p, kind);
      if (s <= 0) continue;
      kinds.push(kind);
      weights.push(s);
    }
    if (!kinds.length) continue;
    const r = mulberry32(mix(seed, Stream.GenAssign, 77, p.id));
    const kind = weightedPick(r, kinds, weights);
    const fp = footprintFor(p, kind);
    if (!fp) continue;
    used[p.id] = 1;
    const ox = p.dir === 1 ? p.ox + (p.w - fp.w) : p.ox;
    const oy = p.dir === 3 ? p.oy + (p.d - fp.d) : p.oy;
    out.push({ plot: p, kind, w: fp.w, d: fp.d, ox, oy });
  }

  return out;
}
