// Stage 1: the river, its banks, and two or three crossings.
//
// One bank is flagged polite (embankment, balustrade, arc lamps), the other
// working (wharf, cranes, sheds). That single flag does most of the class
// geography for free: everything downstream of it, from plot grain to grime to
// which souls live where, keys off which side of the water a cell sits on.
import { Tile } from '../types';
import type { District } from '../district';
import { cellKey, inBounds, insideIsland, setTile } from '../district';
import { Stream, fbm2, mulberry32, mix, range, int } from '../rng';
import type { Archetype } from './archetype';

export interface RiverPlan {
  /** centre[x] = y of the channel centreline at column x, or -1 outside the island. */
  centre: Int16Array;
  halfWidth: Int16Array;
  /** x columns carrying a crossing, and what kind. */
  bridges: { x: number; stone: boolean; y0: number; y1: number }[];
  outfallX: number;
  outfallY: number;
}

export function carveRiver(d: District, seed: number, arch: Archetype): RiverPlan {
  const rng = mulberry32(mix(seed, Stream.GenRiver, 0));
  const centre = new Int16Array(d.width).fill(-1);
  const halfWidth = new Int16Array(d.width).fill(0);

  // Where the river runs is the archetype's biggest lever. A mill town keeps it
  // against the north edge so the works bank takes the island; a garden borough
  // pushes it south so the polite bank does. The crossing town keeps the exact
  // legacy draw sequence, so every seed that rolls it is bit-identical to the
  // pre-archetype generator.
  let baseY: number;
  let amp: number;
  if (arch.kind === 'crossing') {
    baseY = d.height / 2 + range(rng, -2, 2);
    amp = 3.2 + rng() * 2.4;
  } else {
    const fracPct = range(rng, arch.riverFracPct[0], arch.riverFracPct[1]);
    baseY = Math.round((d.height * fracPct) / 100) + range(rng, -1, 1);
    amp = arch.riverAmp[0] + rng() * (arch.riverAmp[1] - arch.riverAmp[0]);
  }
  const phase = int(rng, 512);

  for (let x = 0; x < d.width; x++) {
    // Value noise only. Math.sin is not bit-identical across engines and this
    // number lands in stored state.
    const n = fbm2(seed + phase, Stream.GenRiver, x * 0.09, 4.5, 3);
    const y = Math.round(baseY + (n - 0.5) * 2 * amp);
    const wob = fbm2(seed + 991, Stream.GenRiver, x * 0.16, 11.25, 2);
    const hw = Math.round(1 + wob * 1.8);
    centre[x] = y;
    // One to two cells of channel by default, not three. A river that takes a
    // third of the island leaves a district too sparse to read as a town: the
    // reference is a packed field of roofs with water at the edge of it, not a
    // waterway with some houses either side. A port earns extra width, but only
    // ramping toward the east mouth.
    let cap = Math.max(1, Math.min(arch.halfWidthMax, hw));
    if (arch.mouthExtra > 0) {
      // Start the ramp mid-island: the far east tip is mostly sea already, so a
      // later start hides the whole mouth off the coast.
      const mouthStart = d.width * 0.45;
      if (x > mouthStart) {
        const t = (x - mouthStart) / (d.width - mouthStart);
        cap = Math.min(arch.halfWidthMax + arch.mouthExtra, cap + Math.round(t * (arch.mouthExtra + 1)));
      }
    }
    halfWidth[x] = Math.max(1, cap);
  }

  for (let x = 0; x < d.width; x++) {
    const cy = centre[x];
    const hw = halfWidth[x];
    for (let y = cy - hw; y <= cy + hw; y++) {
      if (inBounds(d, x, y) && insideIsland(d, x, y)) setTile(d, x, y, Tile.Water);
    }
  }

  // Bank sides. Polite is north of the channel by convention, and everything
  // else in the generator reads this flag rather than recomputing the geometry.
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      d.polite[cellKey(d, x, y)] = y < centre[x] ? 1 : 0;
    }
  }

  // Bridge count is an archetype range. A garden borough can drop to a single
  // crossing; count and position are seed-derived either way, so a new seed
  // changes daily routes as well as scenery.
  const span = arch.bridgeMax - arch.bridgeMin + 1;
  const wantedBridges = arch.bridgeMin + (mix(seed, Stream.GenRiver, 91) % span);
  const cols: number[] = [];
  for (let x = 4; x < d.width - 4; x++) if (insideIsland(d, x, centre[x])) cols.push(x);
  cols.sort((a, b) => halfWidth[a] - halfWidth[b] || a - b);
  const bridges: RiverPlan['bridges'] = [];
  for (const x of cols) {
    if (bridges.length >= wantedBridges) break;
    const separation = wantedBridges > 2 ? 10 : 12;
    if (bridges.some((b) => Math.abs(b.x - x) < separation)) continue;
    const hw = halfWidth[x];
    bridges.push({ x, stone: bridges.length === 0, y0: centre[x] - hw - 1, y1: centre[x] + hw + 1 });
  }
  bridges.sort((a, b) => a.x - b.x);

  for (const b of bridges) {
    const width = b.stone ? 2 : 1;
    for (let dx = 0; dx < width; dx++) {
      for (let y = b.y0; y <= b.y1; y++) setTile(d, b.x + dx, y, Tile.Bridge);
    }
  }

  // The drain outfall. Every drain segment walks to here, so cutting sanitation
  // has a shape on the map rather than being a slider.
  const ox = Math.round(d.width * 0.72);
  const outfallX = insideIsland(d, ox, centre[ox]) ? ox : Math.round(d.width / 2);
  return { centre, halfWidth, bridges, outfallX, outfallY: centre[outfallX] };
}

/**
 * Stage 1b: the walkable strip along each bank. Polite gets an embankment,
 * working gets wharf.
 *
 * The quay is ONE cell wide, which is six metres and reads as a promenade rather
 * than a car park, and buys the district about ninety buildable cells. The catch
 * is that a one-cell strip following a meandering channel breaks 4-connectivity
 * wherever the centreline steps by more than one row, and a broken quay is an
 * unreachable quay: the prune pass eats it and every wharf shed loses its
 * frontage. So each column is stitched to the previous one.
 */
export function layBanks(d: District, plan: RiverPlan): void {
  for (const polite of [true, false]) {
    let prevY = -1;
    for (let x = 0; x < d.width; x++) {
      const cy = plan.centre[x];
      const hw = plan.halfWidth[x];
      const y = polite ? cy - hw - 1 : cy + hw + 1;
      const from = prevY < 0 ? y : Math.min(prevY, y);
      const to = prevY < 0 ? y : Math.max(prevY, y);
      for (let yy = from; yy <= to; yy++) {
        if (!inBounds(d, x, yy) || !insideIsland(d, x, yy)) continue;
        const t = d.tile[cellKey(d, x, yy)];
        if (t === Tile.Water || t === Tile.Bridge) continue;
        setTile(d, x, yy, polite ? Tile.Embankment : Tile.Wharf);
      }
      if (inBounds(d, x, y) && insideIsland(d, x, y)) prevY = y;
    }
  }
}
