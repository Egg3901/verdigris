// Souls on the street: position, facing, and the per-frame depth list.
//
// Only souls who are outdoors exist here. At three in the morning that is almost
// nobody, and at the shift change it is around a hundred and forty, which sorts
// in about fifteen microseconds.
import type { City } from '../sim/city';
import { soulPos } from '../sim/souls';
import type { Soul } from '../sim/souls';
import { PAL } from './palette';
import { isoX, isoY, depthKey, LAYER_AGENT } from './iso';

export interface AgentDraw {
  soulId: number;
  wx: number;
  wy: number;
  tx: number;
  ty: number;
  depth: number;
  coat: string;
  hat: string;
  step: number;
}

// Two colourways per silhouette, chosen by id. Enough that a crowd does not read
// as one person repeated, cheap enough to cost nothing.
const COATS = [PAL.soot1, PAL.wood1, PAL.buntBlue, PAL.brick0, PAL.verd1, PAL.ochre0];
const HATS = [PAL.soot0, PAL.brass0, PAL.stone1, PAL.buntRed, PAL.slate0, PAL.wood0];

function coatOf(s: Soul): string {
  if (s.trade === 'constable') return PAL.buntBlue;
  if (s.trade === 'child') return PAL.buntCream;
  return COATS[(s.id * 7 + s.family.length) % COATS.length];
}

function hatOf(s: Soul): string {
  if (s.trade === 'constable') return PAL.soot0;
  if (s.trade === 'alderman' || s.trade === 'clerk') return PAL.soot0;
  return HATS[(s.id * 5 + s.given.length) % HATS.length];
}

/** Fill `out` in place. Called every frame, so it must not allocate. */
export function collectAgents(city: City, fracMin: number, out: AgentDraw[]): number {
  let n = 0;
  for (const s of city.souls) {
    if (s.inId >= 0 || s.atNode < 0) continue;
    const pos = soulPos(city.graph, s, fracMin);
    const slot = out[n] ?? (out[n] = {
      soulId: -1, wx: 0, wy: 0, tx: 0, ty: 0, depth: 0, coat: '', hat: '', step: 0,
    });
    slot.soulId = s.id;
    slot.tx = pos.cx;
    slot.ty = pos.cy;
    slot.wx = isoX(pos.cx, pos.cy);
    slot.wy = isoY(pos.cx, pos.cy);
    slot.depth = depthKey(pos.cx, pos.cy, LAYER_AGENT);
    slot.coat = coatOf(s);
    slot.hat = hatOf(s);
    // Frame-step from distance walked, so the gait matches the speed rather than
    // running off a wall clock.
    slot.step = Math.floor((s.progressMilli / 1200) % 4);
    n++;
  }
  for (let i = 0; i < n - 1; i++) {
    // Insertion sort: the list is nearly sorted frame to frame, so this beats
    // Array.sort and allocates nothing.
    const cur = out[i + 1];
    let j = i;
    while (j >= 0 && out[j].depth > cur.depth) {
      out[j + 1] = out[j];
      j--;
    }
    out[j + 1] = cur;
  }
  return n;
}
