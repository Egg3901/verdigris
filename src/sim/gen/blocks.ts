// Stage 3: blocks. Flood-fill the land the arterials left behind, then split any
// block that is too deep with a one-cell alley, until nothing runs further across
// than the archetype's block span. Those cuts are the back alleys and passages
// between the rows. The split position is jittered, which is what stops the
// result reading as a lattice.
import { Tile } from '../types';
import type { District } from '../district';
import { cellKey, inBounds, insideIsland, setTile, tileAt } from '../district';
import { Stream, mulberry32, mix, range } from '../rng';
import type { Archetype } from './archetype';

export interface Block {
  id: number;
  wardId: number;
  cells: number[];
  x0: number; y0: number; x1: number; y1: number;
  polite: boolean;
  /** Frontage width plots are sliced at: 1 terrace, 2 to 3 merchant, 4+ civic. */
  grain: number;
  /** How far back from the street plots run. Civic blocks run deep, courts do not. */
  depth: number;
}

const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];
// A block must be shallow enough that plots sliced off opposite frontages MEET in
// the middle. Plots run 2 to 4 cells deep, so a span over 7 leaves a core no
// frontage pass can reach, and that core turns into a court. Courts are supposed
// to be the exception that carries the theme, not a third of the district: at a
// span of 11 they were 38% of all plots, which is a generator bug wearing a
// thematic hat. The span is now an archetype dial (arch.blockSpan), held between
// 6 and 8, so the grain differs by kind of town without reopening that hole.
const MIN_SPAN = 3;

function floodBlocks(d: District): number[][] {
  const seen = new Uint8Array(d.width * d.height);
  const out: number[][] = [];
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      const k = cellKey(d, x, y);
      if (seen[k] || !insideIsland(d, x, y) || tileAt(d, x, y) !== Tile.Void) continue;
      const cells: number[] = [];
      const stack = [k];
      seen[k] = 1;
      while (stack.length) {
        const c = stack.pop() as number;
        cells.push(c);
        const cx = c % d.width;
        const cy = (c - cx) / d.width;
        for (let i = 0; i < 4; i++) {
          const nx = cx + DX[i];
          const ny = cy + DY[i];
          if (!inBounds(d, nx, ny) || !insideIsland(d, nx, ny)) continue;
          const nk = cellKey(d, nx, ny);
          if (seen[nk] || tileAt(d, nx, ny) !== Tile.Void) continue;
          seen[nk] = 1;
          stack.push(nk);
        }
      }
      cells.sort((a, b) => a - b);
      out.push(cells);
    }
  }
  return out;
}

/** A block is civic if any of its cells looks straight out onto the square. */
function touchesSquare(d: District, cells: number[]): boolean {
  for (const k of cells) {
    const x = k % d.width;
    const y = (k - x) / d.width;
    for (let i = 0; i < 4; i++) {
      const nx = x + DX[i];
      const ny = y + DY[i];
      if (inBounds(d, nx, ny) && d.tile[cellKey(d, nx, ny)] === Tile.Square) return true;
    }
  }
  return false;
}

function bbox(d: District, cells: number[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of cells) {
    const x = k % d.width;
    const y = (k - x) / d.width;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

export function subdivideBlocks(d: District, seed: number, arch: Archetype): Block[] {
  const rng = mulberry32(mix(seed, Stream.GenBlocks, 0));
  const maxSpan = arch.blockSpan;

  // Cut passes: re-flood after every pass so a cut that isolates a lobe is seen.
  for (let pass = 0; pass < 6; pass++) {
    let cuts = 0;
    for (const cells of floodBlocks(d)) {
      const b = bbox(d, cells);
      const w = b.x1 - b.x0 + 1;
      const h = b.y1 - b.y0 + 1;
      if (Math.max(w, h) <= maxSpan) continue;
      const vertical = w >= h;
      const span = vertical ? w : h;
      if (span < MIN_SPAN * 2 + 1) continue;
      const lo = (vertical ? b.x0 : b.y0) + MIN_SPAN;
      const hi = (vertical ? b.x1 : b.y1) - MIN_SPAN;
      if (hi < lo) continue;
      const at = range(rng, lo, hi);
      for (const k of cells) {
        const x = k % d.width;
        const y = (k - x) / d.width;
        if ((vertical ? x : y) === at) setTile(d, x, y, Tile.Alley);
      }
      cuts++;
    }
    if (!cuts) break;
  }

  // Final flood is the block set. Anything of one or two cells is paving, not a block.
  const blocks: Block[] = [];
  for (const cells of floodBlocks(d)) {
    if (cells.length < 3) {
      for (const k of cells) {
        const x = k % d.width;
        setTile(d, x, (k - x) / d.width, Tile.Alley);
      }
      continue;
    }
    const b = bbox(d, cells);
    let politeVotes = 0;
    for (const k of cells) politeVotes += d.polite[k];
    const polite = politeVotes * 2 >= cells.length;
    const id = blocks.length;
    for (const k of cells) d.blockId[k] = id;
    // Grain is context, not taste. Only the handful of blocks fronting the square
    // subdivide coarse enough to carry a civic building; the polite bank gets
    // merchant frontages, and the working bank gets terraces. Making every polite
    // block civic-grained is what starves the district of buildings: the count
    // falls by a third and the streets stop reading as streets.
    // The archetype's grain bonus widens the ordinary frontage by a cell: a
    // garden borough's houses stand in their own width, a mill town's do not.
    const civic = touchesSquare(d, cells);
    const bonus = arch.grainBonus;
    const grain = civic
      ? range(rng, 4, 5)
      : polite ? range(rng, 2 + bonus, 3 + bonus) : range(rng, 1 + bonus, 2 + bonus);
    const depth = civic ? 4 : polite ? 3 + arch.depthBonus : range(rng, 2, 3 + arch.depthBonus);
    blocks.push({ id, wardId: -1, cells, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, polite, grain, depth });
  }
  return blocks;
}
