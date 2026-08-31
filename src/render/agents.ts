// Souls on the street: position, facing, and the per-frame depth list.
//
// Only souls who are outdoors exist here. At three in the morning that is almost
// nobody, and at the shift change it is around a hundred and forty, which sorts
// in about fifteen microseconds.
import type { City } from '../sim/city';
import { soulPos } from '../sim/souls';
import type { Soul } from '../sim/souls';
import { isDeputationActive } from '../sim/deputations';
import { isOccasionActive } from '../sim/occasions';
import { activePublicVisit } from '../sim/civic-visits';
import { isDisasterActive } from '../sim/disasters';
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
  /** 0 man, 1 woman, 2 child. Drives the silhouette, not the palette. */
  figure: 0 | 1 | 2;
  /** 0 bare, 1 flat cap, 2 bowler, 3 top hat, 4 helmet, 5 bonnet. */
  head: 0 | 1 | 2 | 3 | 4 | 5;
  /** 0 nothing, 1 basket, 2 tool, 3 lamplighter's pole. */
  carry: 0 | 1 | 2 | 3;
  step: number;
  vendor: boolean;
}

// Two colourways per silhouette, chosen by id. Enough that a crowd does not read
// as one person repeated, cheap enough to cost nothing.
const COATS = [PAL.soot1, PAL.wood1, PAL.buntBlue, PAL.brick0, PAL.verd1, PAL.ochre0];
const HATS = [PAL.soot0, PAL.brass0, PAL.stone1, PAL.buntRed, PAL.slate0, PAL.wood0];

// One, then two, then three, then two. These are offsets in tile space around
// the square node: side displaces along the screen x axis and outward advances
// toward the screen y axis, so the group reads as a small stopped deputation.
const DEPUTATION_WEDGE: readonly [side: number, outward: number][] = [
  [0, 0.28],
  [-0.18, 0.44], [0.18, 0.44],
  [-0.36, 0.62], [0, 0.62], [0.36, 0.62],
  [-0.18, 0.8], [0.18, 0.8],
];
const MARKET_FAN: readonly [side: number, outward: number][] = [
  [-0.62, 0.22], [0.62, 0.22], [0, 0.76],
  [-0.28, 0.42], [0.28, 0.42], [-0.52, 0.68], [0.52, 0.68], [0, 0.5],
];
const RIOT_RING: readonly [side: number, outward: number][] = [
  [-0.72, 0.18], [-0.48, 0.12], [-0.24, 0.2], [0, 0.12], [0.24, 0.2], [0.48, 0.12], [0.72, 0.18],
  [-0.62, 0.48], [-0.35, 0.55], [-0.1, 0.42], [0.15, 0.58], [0.4, 0.44], [0.66, 0.56],
  [-0.42, 0.82], [-0.08, 0.76], [0.3, 0.84],
];

/**
 * What a person is, in three pixels of silhouette.
 *
 * A crowd of identical blocks reads as one person repeated however many
 * colourways it has. Height and hat do more work than colour ever can at this
 * size: a child is short, a woman's skirt is wider than her shoulders, and the
 * hat says trade and class from across the district.
 */
function figureOf(s: Soul): 0 | 1 | 2 {
  if (s.trade === 'child' || s.age < 14) return 2;
  return s.sex === 1 ? 1 : 0;
}

function headOf(s: Soul): 0 | 1 | 2 | 3 | 4 | 5 {
  if (s.trade === 'constable') return 4;
  // The gentry and the counting house go about in a topper; the vestry is the
  // one place in the district where you can tell rank by headroom.
  if (s.trade === 'alderman') return 3;
  if (s.trade === 'clerk' || s.trade === 'curate' || s.trade === 'engineer') return 2;
  if (figureOf(s) === 1) return 5;
  if (figureOf(s) === 2) return (s.id & 1) === 0 ? 1 : 0;
  // Working men in flat caps, tradesmen in bowlers, hashed but stable.
  const working = s.trade === 'millhand' || s.trade === 'docker'
    || s.trade === 'lighterman' || s.trade === 'lamplighter';
  if (working) return 1;
  return (s.id % 3) === 0 ? 1 : 2;
}

function carryOf(s: Soul): 0 | 1 | 2 | 3 {
  if (s.trade === 'lamplighter') return 3;
  if (s.trade === 'engineer' || s.trade === 'printer') return 2;
  if (s.trade === 'laundress' || s.trade === 'shopkeeper' || s.trade === 'seamstress') return 1;
  return 0;
}

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

function fillAgent(
  out: AgentDraw[], n: number, s: Soul, cx: number, cy: number, step: number, vendor = false,
): void {
  const slot = out[n] ?? (out[n] = {
    soulId: -1, wx: 0, wy: 0, tx: 0, ty: 0, depth: 0, coat: '', hat: '', step: 0, vendor: false,
    figure: 0, head: 0, carry: 0,
  });
  slot.soulId = s.id;
  slot.tx = cx;
  slot.ty = cy;
  slot.wx = isoX(cx, cy);
  slot.wy = isoY(cx, cy);
  slot.depth = depthKey(cx, cy, LAYER_AGENT);
  slot.coat = coatOf(s);
  slot.hat = hatOf(s);
  slot.figure = figureOf(s);
  slot.head = headOf(s);
  slot.carry = carryOf(s);
  slot.step = step;
  slot.vendor = vendor;
}

/** Fill `out` in place. Called every frame, so it must not allocate. */
export function collectAgents(city: City, fracMin: number, out: AgentDraw[]): number {
  let n = 0;
  const deputation = isDeputationActive(city) ? city.deputations.current : null;
  const civic = !deputation ? activePublicVisit(city) : null;
  const occasion = !deputation && !civic && isOccasionActive(city) ? city.occasions.current : null;
  const riot = !deputation && !civic && !occasion
    ? city.disasters.events.find((event) => event.kind === 'riot' && isDisasterActive(city, event)) : null;
  const squareNode = deputation?.squareNode ?? civic?.nodeId ?? occasion?.squareNode
    ?? (riot ? riot.nodeId : -1);
  const attendeeIds = deputation?.attendeeIds ?? civic?.actorIds ?? occasion?.attendeeIds ?? riot?.involvedIds ?? [];

  for (const s of city.souls) {
    if (s.inId >= 0 || s.atNode < 0) continue;
    // Deputation members are redrawn at their stationary public arrangement
    // below. Skipping their ordinary node position avoids a second body hidden
    // underneath the wedge.
    if (s.activity === 'gathering' && s.atNode === squareNode && s.toNode < 0
      && attendeeIds.includes(s.id)) continue;
    const pos = soulPos(city.graph, s, fracMin);
    fillAgent(out, n, s, pos.cx, pos.cy,
    // Frame-step from distance walked, so the gait matches the speed rather than
    // running off a wall clock.
      Math.floor((s.progressMilli / 1200) % 4));
    n++;
  }

  if ((deputation || civic || occasion || riot) && squareNode >= 0) {
    const baseX = city.graph.cx[squareNode];
    const baseY = city.graph.cy[squareNode];
    const formation = riot ? RIOT_RING : deputation || civic?.kind === 'petition' ? DEPUTATION_WEDGE : MARKET_FAN;
    for (let i = 0; i < attendeeIds.length && i < formation.length; i++) {
      const s = city.souls[attendeeIds[i]];
      if (!s || s.inId >= 0 || s.activity !== 'gathering' || s.atNode !== squareNode || s.toNode >= 0) continue;
      const [side, outward] = formation[i];
      // screen-x movement is x + side, y - side; shared outward movement makes
      // each later row sit one small step further down the square.
      fillAgent(out, n, s, baseX + side + outward, baseY - side + outward, i & 1 ? 0 : 2,
        Boolean(occasion?.vendorIds.includes(s.id)));
      n++;
    }
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
