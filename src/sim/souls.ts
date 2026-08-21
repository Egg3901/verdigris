// Souls: the shape of a person, and the hot loop that moves them.
//
// Souls travel along graph EDGES, not cells: position is (atNode, toNode,
// progressMilli). A movement update is two integer adds and a compare, which is
// what makes 200 of them free. Render interpolates with soulPos().
import { WALK_MILLICELL_PER_MIN, TRAVEL_ACTIVITIES } from './types';
import type { Activity, BuildingId, FirmId, HouseholdId, NodeId, SoulId, Trade } from './types';
import type { StreetGraph } from './graph';
import { edgeCostBetween, stepToward } from './graph';

/** Principals carry the full relationship graph, grudges and beliefs. Extras carry
 *  household, workplace and schedule only. 200 named souls is more names than any
 *  player will read, and halving the gossip cost buys the rest of the sim. */
export type Depth = 'principal' | 'extra';

export interface Belief {
  claimId: number;
  conviction: number;
  heardFrom: SoulId;
  heardTick: number;
}

export interface Soul {
  id: SoulId;
  given: string;
  family: string;
  age: number;
  /** 0 male, 1 female. Used for pronouns in prose and for the agent sprite. */
  sex: 0 | 1;
  trade: Trade;
  depth: Depth;

  householdId: HouseholdId;
  homeId: BuildingId;
  workId: BuildingId;
  firmId: FirmId;

  // Needs, 0..1000. Integers, because floats in stored state break determinism.
  hunger: number;
  fatigue: number;
  warmth: number;
  health: number;
  drink: number;
  purse: number;

  // Character, 0..1000. Set at worldgen and moved only by events.
  mood: number;
  grievance: number;
  suspicion: number;
  piety: number;
  credulity: number;
  boldness: number;
  literacy: number;

  beliefs: Belief[];

  scheduleId: number;
  blockIdx: number;
  /** Tick at which an interrupt expires and the normal schedule resumes. */
  overrideUntil: number;

  activity: Activity;
  inId: BuildingId;
  activitySince: number;
  /** What the soul intends to do once it gets where it is going. Held here rather
   *  than recomputed on arrival, so a schedule change mid-journey cannot silently
   *  rewrite what the walk was for. */
  arriveActivity: Activity;

  atNode: NodeId;
  toNode: NodeId;
  progressMilli: number;
  destNode: NodeId;
  destBuilding: BuildingId;
  /** Detour route, used only when a closure blocks the next hop. Empty otherwise. */
  route: number[];
  routeIdx: number;

  lastSpokeTick: number;
  targetSoul: SoulId;

  /** Errand return leg. An errand is two journeys, not one, and without the
   *  second leg the district empties out: souls trickle to a shop and stay there.
   *  -1 when the soul is not on an errand. */
  returnAt: number;
  returnTo: BuildingId;
}

const TRAVEL = new Set<Activity>(TRAVEL_ACTIVITIES);

export function isTravelling(s: Soul): boolean {
  return TRAVEL.has(s.activity) && s.toNode >= 0;
}

export function fullName(s: Soul): string {
  return `${s.given} ${s.family}`;
}

export function isChild(s: Soul): boolean {
  return s.age < 14;
}

export function isWorkingAge(s: Soul): boolean {
  return s.age >= 14 && s.age < 68;
}

/**
 * World position in cells, interpolated across the current edge.
 * fracMin is the fraction of the current game-minute already elapsed, so the
 * renderer gets smooth motion out of a one-minute tick.
 */
export function soulPos(g: StreetGraph, s: Soul, fracMin: number): { cx: number; cy: number } {
  if (s.atNode < 0) return { cx: 0, cy: 0 };
  if (s.toNode < 0) return { cx: g.cx[s.atNode], cy: g.cy[s.atNode] };

  // Walk the fraction of a minute FORWARD along the route, crossing nodes as
  // needed, rather than clamping at the end of the current edge.
  //
  // Clamping was the visible half of the jumping bug: a soul that covers two and
  // a half cells a minute crosses several one-cell edges within a single tick,
  // and stopping the interpolation at the first junction pins it there until the
  // sim catches up. This is a pure lookahead: it reads state and never writes it,
  // so the sim stays a function of (seed, tick, nudges) and the renderer stays
  // free to ask for any moment in between.
  let from = s.atNode;
  let to = s.toNode;
  let prog = s.progressMilli + fracMin * WALK_MILLICELL_PER_MIN;
  let guard = 0;
  for (;;) {
    const span = Math.max(1, edgeCostBetween(g, from, to)) * 1000;
    if (prog < span || guard++ > 8) {
      const t = Math.min(1, Math.max(0, prog / span));
      return {
        cx: g.cx[from] + (g.cx[to] - g.cx[from]) * t,
        cy: g.cy[from] + (g.cy[to] - g.cy[from]) * t,
      };
    }
    prog -= span;
    from = to;
    if (from === s.destNode) return { cx: g.cx[from], cy: g.cy[from] };
    // Follows the next-hop matrix rather than a stored detour route. Detours are
    // rare and last a few minutes; being a cell out during one is invisible.
    const next = stepToward(g, from, s.destNode);
    if (next < 0 || next === from) return { cx: g.cx[from], cy: g.cy[from] };
    to = next;
  }
}

/** Which of the 4 iso facings the sprite should use. */
export function soulFacing(g: StreetGraph, s: Soul): number {
  if (s.toNode < 0 || s.atNode < 0) return 0;
  const dx = g.cx[s.toNode] - g.cx[s.atNode];
  const dy = g.cy[s.toNode] - g.cy[s.atNode];
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 0 : 1;
  return dy >= 0 ? 2 : 3;
}

/**
 * One game-minute of walking. Returns true when the soul reached its destination.
 * The caller decides what arriving means, because souls arrive for many reasons.
 */
export function advanceSoul(g: StreetGraph, s: Soul): boolean {
  if (s.atNode < 0) return true;
  if (s.destNode < 0 || s.atNode === s.destNode) { s.toNode = -1; return true; }

  if (s.toNode < 0) {
    const next = nextHopFor(g, s);
    if (next < 0) { s.destNode = s.atNode; return true; }
    s.toNode = next;
    s.progressMilli = 0;
  }

  // Consume the WHOLE minute, crossing as many nodes as the speed allows.
  //
  // This used to cross at most one node per tick and then return, leaving the
  // remainder in progressMilli. A soul walks 2500 millicells a minute and a
  // one-cell edge spans 1000, so after a single tick progressMilli was routinely
  // larger than the edge it sat on. soulPos then clamped to the end of the edge,
  // the soul was drawn standing at the next node for the entire minute, and at
  // the next tick it jumped. That is the whole of "people jump around instead of
  // moving smoothly", and it has been there since the first commit.
  s.progressMilli += WALK_MILLICELL_PER_MIN;
  let guard = 0;
  for (;;) {
    const span = Math.max(1, edgeCostBetween(g, s.atNode, s.toNode)) * 1000;
    if (s.progressMilli < span || guard++ > 8) return false;
    s.progressMilli -= span;
    s.atNode = s.toNode;
    if (s.routeIdx > 0 && s.routeIdx < s.route.length && s.route[s.routeIdx] === s.atNode) s.routeIdx++;
    if (s.atNode === s.destNode) {
      s.toNode = -1;
      s.progressMilli = 0;
      s.route.length = 0;
      s.routeIdx = 0;
      return true;
    }
    const next = nextHopFor(g, s);
    if (next < 0) { s.toNode = -1; s.destNode = s.atNode; return true; }
    s.toNode = next;
  }
}

function nextHopFor(g: StreetGraph, s: Soul): NodeId {
  if (s.route.length && s.routeIdx < s.route.length) {
    const cand = s.route[s.routeIdx];
    if (cand !== s.atNode) return cand;
    s.routeIdx++;
    if (s.routeIdx < s.route.length) return s.route[s.routeIdx];
  }
  return stepToward(g, s.atNode, s.destNode);
}
