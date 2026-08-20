// Stage 6: street identity and house numbers.
//
// Streets are found as maximal runs of paving rather than declared up front,
// because the arterials were carved as least-cost paths and nobody knows where
// they went until they got there. Numbering then walks each street's frontage,
// odds one side and evens the other, so addressOf yields "14 Foundry Row" and
// the prose layer never has to invent a place.
import { Tile } from '../types';
import type { District } from '../district';
import { cellKey, inBounds } from '../district';
import { Stream, mulberry32, mix, pick, shuffle } from '../rng';
import { STREET_HEAD, STREET_TAIL } from '../names';

export interface Street {
  id: number;
  name: string;
  cells: number[];
  horizontal: boolean;
}

const PAVED = new Uint8Array(16);
for (const t of [Tile.Street, Tile.Alley, Tile.Embankment, Tile.Wharf, Tile.Bridge]) PAVED[t] = 1;

export function nameStreets(d: District, seed: number): Street[] {
  const rng = mulberry32(mix(seed, Stream.GenNames, 0));
  const isPaved = (x: number, y: number) => inBounds(d, x, y) && PAVED[d.tile[cellKey(d, x, y)]] === 1;

  interface Run { cells: number[]; horizontal: boolean }
  const runs: Run[] = [];
  for (let y = 0; y < d.height; y++) {
    let run: number[] = [];
    for (let x = 0; x <= d.width; x++) {
      if (x < d.width && isPaved(x, y)) run.push(cellKey(d, x, y));
      else { if (run.length >= 4) runs.push({ cells: run, horizontal: true }); run = []; }
    }
  }
  for (let x = 0; x < d.width; x++) {
    let run: number[] = [];
    for (let y = 0; y <= d.height; y++) {
      if (y < d.height && isPaved(x, y)) run.push(cellKey(d, x, y));
      else { if (run.length >= 4) runs.push({ cells: run, horizontal: false }); run = []; }
    }
  }
  runs.sort((a, b) => b.cells.length - a.cells.length || a.cells[0] - b.cells[0]);

  // Name pool, deduped. Shuffled once so the same head does not always land on
  // the longest street.
  const pool: string[] = [];
  for (const h of STREET_HEAD) for (const t of STREET_TAIL) pool.push(`${h} ${t}`);
  shuffle(rng, pool);
  let poolAt = 0;

  const owner = new Int16Array(d.width * d.height).fill(-1);
  const streets: Street[] = [];
  for (const run of runs) {
    const free = run.cells.filter((k) => owner[k] === -1);
    if (free.length < Math.max(3, Math.ceil(run.cells.length * 0.5))) continue;
    const id = streets.length;
    const name = poolAt < pool.length ? pool[poolAt++] : `${pick(rng, STREET_HEAD)} ${pick(rng, STREET_TAIL)} ${id}`;
    for (const k of free) owner[k] = id;
    streets.push({ id, name, cells: free, horizontal: run.horizontal });
  }

  // Orphan paving joins the nearest named street, so no address is ever homeless.
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      const k = cellKey(d, x, y);
      if (!PAVED[d.tile[k]] || owner[k] !== -1) continue;
      let bestId = -1;
      let bestDist = Infinity;
      for (const s of streets) {
        for (const c of s.cells) {
          const cx = c % d.width;
          const cy = (c - cx) / d.width;
          const dist = Math.abs(cx - x) + Math.abs(cy - y);
          if (dist < bestDist) { bestDist = dist; bestId = s.id; }
          if (bestDist <= 1) break;
        }
        if (bestDist <= 1) break;
      }
      if (bestId >= 0) { owner[k] = bestId; streets[bestId].cells.push(k); }
    }
  }

  for (let i = 0; i < owner.length; i++) d.streetId[i] = owner[i];
  return streets;
}

/** The square gets its own name, and it is never a "Row". */
export function nameSquare(seed: number): string {
  const rng = mulberry32(mix(seed, Stream.GenNames, 99));
  return `${pick(rng, ['Jubilee', 'Exchange', 'Cathedral', 'Corporation', 'Verdigris', 'Coronation'])} Square`;
}
