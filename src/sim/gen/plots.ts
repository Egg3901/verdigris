// Stage 4: plots, and the courts.
//
// Plots are sliced off street frontage at the block's grain. Whatever is left in
// the middle of a block with no frontage becomes a COURT: one alley in, crammed
// dwellings, no through route. The courts are the rot made spatial. They sit
// twenty metres behind the gold-leaf frontages, they are the last to get gas and
// the first to lose drainage, and no arterial passes them.
import { Tile } from '../types';
import type { District } from '../district';
import { cellKey, inBounds, insideIsland, setTile, tileAt } from '../district';
import { Stream, mulberry32, mix, range } from '../rng';
import type { Block } from './blocks';

export interface Plot {
  id: number;
  blockId: number;
  ox: number; oy: number; w: number; d: number;
  cells: number[];
  /** Direction index toward the street the plot fronts: 0 E, 1 W, 2 S, 3 N. */
  dir: number;
  /** The walkable cell the door opens onto. */
  frontX: number; frontY: number;
  /** The plot cell the door is in. */
  doorX: number; doorY: number;
  frontage: number;
  polite: boolean;
  court: boolean;
}

const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];

const STREETY = new Uint8Array(16);
for (const t of [Tile.Street, Tile.Alley, Tile.Square, Tile.Embankment, Tile.Wharf, Tile.Bridge]) {
  STREETY[t] = 1;
}

function isStreety(d: District, x: number, y: number): boolean {
  if (!inBounds(d, x, y)) return false;
  return STREETY[d.tile[cellKey(d, x, y)]] === 1;
}

export function subdividePlots(d: District, seed: number, blocks: Block[]): Plot[] {
  const rng = mulberry32(mix(seed, Stream.GenPlots, 0));
  const plots: Plot[] = [];
  const taken = new Uint8Array(d.width * d.height);

  for (const block of blocks) {
    const inBlock = new Set(block.cells);

    const fits = (ox: number, oy: number, w: number, h: number): boolean => {
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const k = cellKey(d, ox + i, oy + j);
          if (!inBlock.has(k) || taken[k]) return false;
        }
      }
      return true;
    };

    for (const k of block.cells) {
      if (taken[k]) continue;
      const cx = k % d.width;
      const cy = (k - cx) / d.width;
      let dir = -1;
      for (let i = 0; i < 4; i++) {
        if (isStreety(d, cx + DX[i], cy + DY[i])) { dir = i; break; }
      }
      if (dir < 0) continue;

      // Frontage runs perpendicular to the street direction, depth runs away from it.
      const horizontalFront = dir === 2 || dir === 3;

      // Do not always take the widest frontage that fits. A real street is mostly
      // narrow houses with the occasional wide one, and always grabbing the
      // block's grain produces both a monotonous street and a third fewer
      // buildings than the district needs.
      const roll = mix(seed, Stream.GenPlots, k, 3) % 100;
      const wantFront = roll < 55 ? 1 : roll < 82 ? 2 : Math.max(1, block.grain);
      const wantDepth = roll < 40 ? 2 : roll < 88 ? Math.min(3, block.depth) : block.depth;
      const maxFront = Math.max(1, Math.min(block.grain, wantFront));
      const maxDepth = Math.max(1, Math.min(block.depth, wantDepth));

      let best: { w: number; h: number } | null = null;
      for (let f = maxFront; f >= 1 && !best; f--) {
        for (let dd = maxDepth; dd >= 1; dd--) {
          const w = horizontalFront ? f : dd;
          const h = horizontalFront ? dd : f;
          const ox = dir === 1 ? cx : cx;
          const oy = dir === 3 ? cy : cy;
          // Grow away from the street: for dir E the plot extends west from cx,
          // for dir S it extends north from cy, and so on.
          const px = dir === 0 ? cx - (w - 1) : ox;
          const py = dir === 2 ? cy - (h - 1) : oy;
          if (fits(px, py, w, h)) { best = { w, h }; break; }
        }
      }
      if (!best) continue;

      const w = best.w;
      const h = best.h;
      const px = dir === 0 ? cx - (w - 1) : cx;
      const py = dir === 2 ? cy - (h - 1) : cy;
      const cells: number[] = [];
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const kk = cellKey(d, px + i, py + j);
          taken[kk] = 1;
          cells.push(kk);
        }
      }
      plots.push({
        id: plots.length, blockId: block.id,
        ox: px, oy: py, w, d: h, cells, dir,
        frontX: cx + DX[dir], frontY: cy + DY[dir],
        doorX: cx, doorY: cy,
        frontage: horizontalFront ? w : h,
        polite: block.polite, court: false,
      });
    }

    // Whatever the frontage pass could not reach is interior. That is a court.
    const leftover = block.cells.filter((k) => !taken[k]);
    if (!leftover.length) continue;
    const seen = new Set<number>();
    for (const start of leftover) {
      if (seen.has(start)) continue;
      const comp: number[] = [];
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const c = stack.pop() as number;
        comp.push(c);
        const cx = c % d.width;
        const cy = (c - cx) / d.width;
        for (let i = 0; i < 4; i++) {
          const nx = cx + DX[i];
          const ny = cy + DY[i];
          if (!inBounds(d, nx, ny)) continue;
          const nk = cellKey(d, nx, ny);
          if (seen.has(nk) || taken[nk] || !inBlock.has(nk)) continue;
          seen.add(nk);
          stack.push(nk);
        }
      }
      comp.sort((a, b) => a - b);

      if (comp.length < 2) {
        for (const c of comp) {
          const x = c % d.width;
          setTile(d, x, (c - x) / d.width, Tile.Yard);
          taken[c] = 1;
        }
        continue;
      }

      // Cut one alley in, from the component cell nearest to existing paving.
      let mouth = comp[0];
      let mouthDir = -1;
      let bestDist = Infinity;
      for (const c of comp) {
        const cx = c % d.width;
        const cy = (c - cx) / d.width;
        for (let i = 0; i < 4; i++) {
          for (let step = 1; step <= 3; step++) {
            const nx = cx + DX[i] * step;
            const ny = cy + DY[i] * step;
            if (!inBounds(d, nx, ny)) break;
            if (isStreety(d, nx, ny)) {
              if (step < bestDist) { bestDist = step; mouth = c; mouthDir = i; }
              break;
            }
          }
        }
      }

      const mx = mouth % d.width;
      const my = (mouth - mx) / d.width;
      if (mouthDir >= 0) {
        for (let step = 0; step < bestDist; step++) {
          const x = mx + DX[mouthDir] * step;
          const y = my + DY[mouthDir] * step;
          if (!insideIsland(d, x, y)) continue;
          if (tileAt(d, x, y) === Tile.Void) setTile(d, x, y, Tile.Alley);
          taken[cellKey(d, x, y)] = 1;
        }
      }
      setTile(d, mx, my, Tile.Court);
      taken[mouth] = 1;

      // The rest of the component is court dwellings, one cell each.
      for (const c of comp) {
        if (taken[c]) continue;
        const x = c % d.width;
        const y = (c - x) / d.width;
        taken[c] = 1;
        plots.push({
          id: plots.length, blockId: block.id,
          ox: x, oy: y, w: 1, d: 1, cells: [c], dir: mouthDir < 0 ? 3 : mouthDir,
          frontX: mx, frontY: my, doorX: x, doorY: y,
          frontage: 1, polite: false, court: true,
        });
      }
    }
  }

  // Mark the plot grid and paint grime. Grime rises toward the working bank and
  // the east, where the mill quarter lands. A district that visibly gets sootier
  // as you walk east IS the theme, rendered.
  for (const p of plots) {
    for (const k of p.cells) {
      d.plotId[k] = p.id;
      if (tileAt(d, k % d.width, (k - (k % d.width)) / d.width) === Tile.Void) {
        setTile(d, k % d.width, (k - (k % d.width)) / d.width, p.court ? Tile.Court : Tile.Plot);
      }
    }
  }
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      const k = cellKey(d, x, y);
      const east = x / (d.width - 1);
      const working = d.polite[k] ? 0 : 0.35;
      const jitter = (mix(seed, Stream.GenPlots, x, y) % 40) / 255;
      d.grime[k] = Math.min(255, Math.round((east * 0.55 + working + jitter) * 210));
    }
  }
  // Court cells carry an extra load of soot regardless of where they sit.
  for (const p of plots) {
    if (!p.court) continue;
    for (const k of p.cells) d.grime[k] = Math.min(255, d.grime[k] + 55);
  }
  void rng;
  return plots;
}

/**
 * Paving that nothing can reach is not paving.
 *
 * The plot pass leaves stubs behind: an alley that dead-ended into a court that
 * was later swallowed, a scrap of wharf cut off by a shed. Left alone each one
 * becomes a marooned graph node, and a marooned node fails the connectivity
 * invariant that everything downstream (next-hop, schedules, the tram) assumes.
 * Cheaper to delete them here than to special-case them forever.
 */
export function pruneUnreachablePaving(d: District, fromX: number, fromY: number): number {
  const n = d.width * d.height;
  const seen = new Uint8Array(n);
  const start = cellKey(d, fromX, fromY);
  if (!isStreety(d, fromX, fromY) && tileAt(d, fromX, fromY) !== Tile.Square) return 0;
  const q = [start];
  seen[start] = 1;
  for (let head = 0; head < q.length; head++) {
    const k = q[head];
    const x = k % d.width;
    const y = (k - x) / d.width;
    for (let i = 0; i < 4; i++) {
      const nx = x + DX[i];
      const ny = y + DY[i];
      if (!inBounds(d, nx, ny)) continue;
      const nk = cellKey(d, nx, ny);
      if (seen[nk]) continue;
      const t = tileAt(d, nx, ny);
      if (!isStreety(d, nx, ny) && t !== Tile.Square && t !== Tile.Court) continue;
      seen[nk] = 1;
      q.push(nk);
    }
  }
  let pruned = 0;
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      const k = cellKey(d, x, y);
      const t = tileAt(d, x, y);
      const walkish = isStreety(d, x, y) || t === Tile.Square || t === Tile.Court;
      if (!walkish || seen[k]) continue;
      setTile(d, x, y, Tile.Yard);
      pruned++;
    }
  }
  return pruned;
}

/** Plots whose front cell was pruned can no longer be built on. Court dwellings
 *  front onto the court mouth, which is walkable but is not a street, so Court
 *  belongs in this test even though it is deliberately absent from isStreety. */
export function plotIsReachable(d: District, p: Plot): boolean {
  const t = tileAt(d, p.frontX, p.frontY);
  return isStreety(d, p.frontX, p.frontY) || t === Tile.Square || t === Tile.Court;
}

export function plotFrontageAxis(p: Plot): 'ns' | 'ew' {
  return p.dir === 2 || p.dir === 3 ? 'ew' : 'ns';
}

export function randomGrainJitter(seed: number, plotId: number): number {
  return range(mulberry32(mix(seed, Stream.GenPlots, plotId)), 0, 100);
}
