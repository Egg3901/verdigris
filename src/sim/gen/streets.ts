// Stage 2: the civic square, the arterials, and the tram line.
//
// Arterials are carved as least-cost paths across a noise field rather than as
// straight lines. A Victorian district that grew has bent streets; a planned one
// has straight ones, and this district is meant to have grown.
import { Tile } from '../types';
import type { District } from '../district';
import { cellKey, inBounds, insideIsland, setTile, tileAt } from '../district';
import { Stream, mulberry32, mix, noise2, range, shuffle } from '../rng';
import type { RiverPlan } from './river';

export interface StreetPlan {
  squareX: number;
  squareY: number;
  squareW: number;
  /** Cells the tram runs along, in route order. */
  tramCells: { x: number; y: number }[];
  tramStops: { x: number; y: number }[];
  /** Every cell that is street, alley, square, embankment, wharf or bridge. */
  anchors: { x: number; y: number; label: string }[];
}

const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];

/** Least-cost path over non-water island cells. Fixed neighbour order, so deterministic. */
function pathBetween(
  d: District, seed: number, ax: number, ay: number, bx: number, by: number,
): { x: number; y: number }[] {
  const n = d.width * d.height;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const start = cellKey(d, ax, ay);
  dist[start] = 0;
  // Small grid, so a scanning selection loop beats the complexity of a heap here.
  const done = new Uint8Array(n);
  const open: number[] = [start];
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (dist[open[i]] < dist[open[bi]]) bi = i;
    const k = open[bi];
    open[bi] = open[open.length - 1];
    open.pop();
    if (done[k]) continue;
    done[k] = 1;
    if (k === cellKey(d, bx, by)) break;
    const cx = k % d.width;
    const cy = (k - cx) / d.width;
    for (let i = 0; i < 4; i++) {
      const nx = cx + DX[i];
      const ny = cy + DY[i];
      if (!inBounds(d, nx, ny) || !insideIsland(d, nx, ny)) continue;
      const t = tileAt(d, nx, ny);
      if (t === Tile.Water) continue;
      const nk = cellKey(d, nx, ny);
      if (done[nk]) continue;
      // Reuse existing paving cheaply so arterials braid instead of running parallel.
      const paved = t === Tile.Street || t === Tile.Bridge || t === Tile.Square;
      const wobble = noise2(seed, Stream.GenStreets, nx * 0.31, ny * 0.31);
      const cost = paved ? 0.35 : 1 + wobble * 1.7;
      const nd = dist[k] + cost;
      if (nd < dist[nk]) {
        dist[nk] = nd;
        prev[nk] = k;
        open.push(nk);
      }
    }
  }
  const out: { x: number; y: number }[] = [];
  let k = cellKey(d, bx, by);
  if (dist[k] === Infinity) return out;
  while (k !== -1) {
    const x = k % d.width;
    out.push({ x, y: (k - x) / d.width });
    k = prev[k];
  }
  out.reverse();
  return out;
}

function carve(d: District, cells: { x: number; y: number }[], width: number): void {
  for (const c of cells) {
    for (let dx = 0; dx < width; dx++) {
      for (let dy = 0; dy < width; dy++) {
        const x = c.x + dx;
        const y = c.y + dy;
        if (!inBounds(d, x, y) || !insideIsland(d, x, y)) continue;
        const t = tileAt(d, x, y);
        if (t === Tile.Water || t === Tile.Bridge || t === Tile.Square) continue;
        setTile(d, x, y, Tile.Street);
      }
    }
  }
}

/** The largest clear square on the polite bank, biased toward the map centre. */
function placeSquare(d: District, river: RiverPlan, seed: number): { x: number; y: number; w: number } {
  const rng = mulberry32(mix(seed, Stream.GenStreets, 7));
  const w = range(rng, 6, d.width >= 60 ? 9 : 8);
  let best = { x: -1, y: -1, w, score: -Infinity };
  const cx = (d.width - 1) / 2;
  const cy = (d.height - 1) / 2;
  // Civic life need not occupy the geometric centre. The offset is bounded so
  // the square remains a hub, but large enough to produce distinct wards.
  const targetX = cx + range(rng, -Math.round(d.width * 0.12), Math.round(d.width * 0.12));
  const targetY = cy + range(rng, -Math.round(d.height * 0.06), Math.round(d.height * 0.06));
  const wantedRiverGap = range(rng, 5, d.width >= 60 ? 11 : 9);
  for (let y = 1; y < d.height - w; y++) {
    for (let x = 1; x < d.width - w; x++) {
      let ok = true;
      for (let j = 0; j < w && ok; j++) {
        for (let i = 0; i < w; i++) {
          if (!insideIsland(d, x + i, y + j) || tileAt(d, x + i, y + j) !== Tile.Void) { ok = false; break; }
          if (d.polite[cellKey(d, x + i, y + j)] !== 1) { ok = false; break; }
        }
      }
      if (!ok) continue;
      const dc = Math.abs(x + w / 2 - targetX) + Math.abs(y + w / 2 - targetY);
      const toRiver = Math.abs(y + w - river.centre[Math.min(d.width - 1, Math.round(x + w / 2))]);
      const score = -dc - Math.abs(toRiver - wantedRiverGap) * 0.8;
      if (score > best.score) best = { x, y, w, score };
    }
  }
  if (best.x < 0) {
    // Degenerate seed: fall back to the centre of the polite bank. Never leaves
    // the district without a square, because everything downstream needs one.
    const fx = Math.round(d.width / 2 - w / 2);
    const fy = Math.max(1, river.centre[Math.round(d.width / 2)] - w - 4);
    return { x: fx, y: fy, w };
  }
  return { x: best.x, y: best.y, w: best.w };
}

export function layStreets(d: District, seed: number, river: RiverPlan): StreetPlan {
  const rng = mulberry32(mix(seed, Stream.GenStreets, 1));
  const sq = placeSquare(d, river, seed);
  for (let j = 0; j < sq.w; j++) {
    for (let i = 0; i < sq.w; i++) setTile(d, sq.x + i, sq.y + j, Tile.Square);
  }
  const sqcx = sq.x + (sq.w >> 1);
  const sqcy = sq.y + (sq.w >> 1);

  const anchors: StreetPlan['anchors'] = [{ x: sqcx, y: sqcy, label: 'square' }];

  // Bridgeheads, both ends of both crossings.
  for (let i = 0; i < river.bridges.length; i++) {
    const b = river.bridges[i];
    anchors.push({ x: b.x, y: b.y0, label: `bridgehead${i}n` });
    anchors.push({ x: b.x, y: b.y1, label: `bridgehead${i}s` });
  }

  // Edge gates: points on the island rim, spread around the compass.
  const gates: { x: number; y: number }[] = [];
  const rimSteps = d.width >= 60 ? 12 : 8;
  for (let i = 0; i < rimSteps; i++) {
    const t = i / rimSteps;
    // Walk the diamond rim by parameter, then pull inward to the first land cell.
    const ang = t * 4;
    let px: number, py: number;
    const cx = (d.width - 1) / 2;
    const cy = (d.height - 1) / 2;
    const r = (d.width - 1) / 2;
    if (ang < 1) { px = cx + r * (1 - ang); py = cy - r * ang; }
    else if (ang < 2) { px = cx - r * (ang - 1); py = cy - r * (2 - ang); }
    else if (ang < 3) { px = cx - r * (3 - ang); py = cy + r * (ang - 2); }
    else { px = cx + r * (ang - 3); py = cy + r * (4 - ang); }
    let gx = Math.round(px);
    let gy = Math.round(py);
    for (let step = 0; step < 8; step++) {
      if (insideIsland(d, gx, gy) && tileAt(d, gx, gy) !== Tile.Water) break;
      gx += Math.sign(cx - gx);
      gy += Math.sign(cy - gy);
    }
    if (insideIsland(d, gx, gy) && tileAt(d, gx, gy) !== Tile.Water) gates.push({ x: gx, y: gy });
  }
  shuffle(rng, gates);
  const gateCount = range(rng, d.width >= 60 ? 5 : 4, d.width >= 60 ? 8 : 6);
  const chosen = gates.slice(0, Math.min(gateCount, gates.length));

  // Arterials: square to each gate, ONE cell wide.
  //
  // The 2-wide carve stamps a 2x2 block at every path cell, so on a diagonal run
  // it lays a three-cell swath. Doing that for six gate arterials spent a quarter
  // of the island on tarmac and starved the district of buildings. Six metres is
  // a real Victorian street; only the civic spine below gets twelve.
  for (const g of chosen) {
    const p = pathBetween(d, seed, sqcx, sqcy, g.x, g.y);
    if (p.length) carve(d, p, 1);
    anchors.push({ x: g.x, y: g.y, label: 'gate' });
  }
  // And square to every bridgehead, so both banks are properly stitched.
  for (const b of river.bridges) {
    const north = pathBetween(d, seed, sqcx, sqcy, b.x, b.y0);
    if (north.length) carve(d, north, 2);
    const far = { x: b.x, y: Math.min(d.height - 1, b.y1 + 3) };
    if (insideIsland(d, far.x, far.y)) {
      const south = pathBetween(d, seed, b.x, b.y1, far.x, far.y);
      if (south.length) carve(d, south, 2);
    }
  }

  return { squareX: sq.x, squareY: sq.y, squareW: sq.w, tramCells: [], tramStops: [], anchors };
}
