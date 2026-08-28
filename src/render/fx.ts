// Per-frame effects: the tram, and the smoke.
//
// Everything here is deterministic from (seed, tick) and allocates nothing, so it
// costs the same whether the sim is paused or running at forty times speed.
import type { City } from '../sim/city';
import { tramPos } from '../sim/city';
import { serviceAt } from '../sim/networks';
import { isRunning } from '../sim/firms';
import { PAL, gradeHex, shadeHex } from './palette';
import type { Variant } from './palette';
import { minuteOfDay } from '../sim/clock';
import { TILE_W, TILE_H, isoX, isoY, depthKey, LAYER_AGENT, LAYER_OVERHEAD } from './iso';
import { fillPolyHard, lineHard, ditherPolyHard } from './raster';
import { mix, Stream } from '../sim/rng';
import { stepToward } from '../sim/graph';
import { Tile } from '../sim/types';
import { cellKey, insideIsland } from '../sim/district';
import { isDisasterActive } from '../sim/disasters';
import { weatherAt } from '../sim/weather';

export interface VehicleDraw {
  /** 0 tram, 1 cart. */
  kind: 0 | 1;
  /** Cart body family. Ignored by trams. */
  cartKind: 0 | 1 | 2;
  wx: number;
  wy: number;
  depth: number;
  /** Tram body axis. Carts do not need an orientation at this resolution. */
  along: boolean;
}

/** A fire sits on its source roof but remains part of the world depth order. */
export interface HazardDraw {
  wx: number;
  wy: number;
  depth: number;
  phase: number;
  wide: boolean;
}

/** Collect active roof fires without particle state or per-frame allocation. */
export function collectHazards(
  city: City, fracMin: number,
  tl: { wx: number; wy: number }, br: { wx: number; wy: number }, out: HazardDraw[],
): number {
  let n = 0;
  const frame = Math.floor((city.tick + fracMin) * 0.28);
  for (const event of city.disasters.events) {
    if (event.kind !== 'fire' || !isDisasterActive(city, event)) continue;
    // Every address the fire has reached burns, not only the one it started at.
    for (let bi = 0; bi < event.affectedBuildingIds.length; bi++) {
      const b = city.buildings[event.affectedBuildingIds[bi]];
      if (!b) continue;
      const anchors = b.w * b.d > 2 ? 2 : 1;
      const sx = b.ox + b.w - 1;
      const sy = b.oy + b.d - 1;
      const roofY = isoY(sx, sy) - b.storeys * 8 - 11;
      for (let i = 0; i < anchors; i++) {
        const wx = isoX(sx, sy) + (anchors === 1 ? 0 : i === 0 ? -7 : 7);
        if (wx < tl.wx - 14 || wx > br.wx + 14 || roofY < tl.wy - 56 || roofY > br.wy + 8) continue;
        const slot = out[n] ?? (out[n] = { wx: 0, wy: 0, depth: 0, phase: 0, wide: false });
        slot.wx = wx;
        slot.wy = roofY;
        slot.depth = depthKey(sx, sy, LAYER_OVERHEAD);
        slot.phase = frame + (mix(city.seed, 184, event.id, bi * 3 + i) % 4);
        slot.wide = anchors === 2;
        n++;
      }
    }
  }
  for (let i = 0; i < n - 1; i++) {
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

/**
 * A big, layered, flickering blaze. The old version was a 10px lozenge that read
 * as an orange smudge; a building fire has to look like it is destroying the
 * building. Four nested tongues from a dark-red envelope to a white-hot core,
 * two of them leaning independently so the flame writhes, a hot base flare that
 * licks up the near roof, and embers spat up into the smoke above.
 */
export function drawHazard(ctx: CanvasRenderingContext2D, hazard: HazardDraw, variant: Variant): number {
  const x = Math.round(hazard.wx);
  const y = Math.round(hazard.wy);
  const p = hazard.phase;
  // Two flicker terms, so the outer sheet and the core do not move as one block.
  const leanA = ((p % 3) - 1) * 2;
  const leanB = (((p >> 1) % 3) - 1);
  const flick = p % 4;
  const H = (hazard.wide ? 26 : 20) + flick * 2;
  const halfW = hazard.wide ? 9 : 7;

  // A hot pool of light on the roof under the flame, so the fire sits IN the
  // building rather than floating above it. Ordered dither keeps it on-palette.
  ditherPolyHard(ctx, [
    { x: x - halfW - 2, y: y + 2 }, { x: x + halfW + 2, y: y + 2 },
    { x: x + halfW, y: y - 4 }, { x: x - halfW, y: y - 4 },
  ], gradeHex(PAL.brass2, variant, true), 6);

  // Outer envelope: dark, wide, ragged, the sooty edge of the fire.
  fillPolyHard(ctx, [
    { x: x - halfW, y }, { x: x - halfW + 1, y: y - H * 0.4 },
    { x: x - 3 + leanA, y: y - H * 0.72 }, { x: x - 1 + leanA, y: y - H },
    { x: x + 3 + leanA, y: y - H * 0.66 }, { x: x + halfW - 1, y: y - H * 0.36 },
    { x: x + halfW, y },
  ], gradeHex(PAL.buntRed, variant));
  // Mid body.
  fillPolyHard(ctx, [
    { x: x - halfW + 2, y }, { x: x - 2 + leanB, y: y - H * 0.5 },
    { x: x - 1 + leanA, y: y - H * 0.82 }, { x: x + 1 + leanA, y: y - H * 0.62 },
    { x: x + 3 + leanB, y: y - H * 0.42 }, { x: x + halfW - 2, y },
  ], gradeHex(PAL.buntRedHi, variant));
  // Inner flame, bright.
  fillPolyHard(ctx, [
    { x: x - 3, y }, { x: x - 2 + leanB, y: y - H * 0.4 },
    { x: x + leanB, y: y - H * 0.66 }, { x: x + 2 + leanB, y: y - H * 0.38 },
    { x: x + 3, y },
  ], gradeHex(PAL.brass2, variant, true));
  // White-hot core, low in the flame where it is hottest.
  fillPolyHard(ctx, [
    { x: x - 1, y }, { x: x - 1 + leanB, y: y - H * 0.34 },
    { x: x + 1 + leanB, y: y - H * 0.5 }, { x: x + 2, y: y - H * 0.28 },
    { x: x + 1, y },
  ], gradeHex(PAL.gas2, variant, true));

  // Embers: a few sparks flung up into the smoke, positions hashed off the phase.
  ctx.fillStyle = gradeHex(PAL.brass3, variant, true);
  for (let i = 0; i < 3; i++) {
    const e = (p * 7 + i * 5) % 13;
    const ex = x + ((e % 5) - 2) + leanA;
    const ey = y - H - 2 - (e % 6);
    ctx.fillRect(ex, ey, 1, 1);
  }
  return 9;
}

/**
 * Fill a reusable, depth-sorted list of moving vehicles.
 *
 * Vehicles use the actor layer, after structures on their own ground row and
 * before structures on a nearer row. This lets a tram disappear behind a roof
 * without treating it as an atmospheric overlay.
 */
export function collectVehicles(
  city: City, routes: readonly CartRoute[], fracMin: number,
  tl: { wx: number; wy: number }, br: { wx: number; wy: number },
  out: VehicleDraw[],
): number {
  let n = 0;
  const add = (kind: VehicleDraw['kind'], cartKind: VehicleDraw['cartKind'], cx: number, cy: number, along: boolean) => {
    const wx = isoX(cx, cy);
    const wy = isoY(cx, cy);
    // Include the tram pole and cart body above their ground point in the cull.
    if (wx < tl.wx - 12 || wx > br.wx + 12 || wy < tl.wy - 24 || wy > br.wy + 4) return;
    const slot = out[n] ?? (out[n] = { kind: 0, cartKind: 0, wx: 0, wy: 0, depth: 0, along: false });
    slot.kind = kind;
    slot.cartKind = cartKind;
    slot.wx = wx;
    slot.wy = wy;
    slot.depth = depthKey(cx, cy, LAYER_AGENT);
    slot.along = along;
    n++;
  };

  for (const car of city.trams) {
    const p = tramPos(city, car);
    add(0, 0, p.cx, p.cy, Math.abs(p.dx) >= Math.abs(p.dy));
  }

  const t = city.tick + fracMin;
  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    if (r.nodes.length < 2) continue;
    // Triangle wave: out along the route and back, forever, with a per-cart phase.
    const phase = ((t + i * 37) % (r.span * 2)) / r.span;
    const along = phase <= 1 ? phase : 2 - phase;
    const pos = along * (r.nodes.length - 1);
    const idx = Math.min(r.nodes.length - 2, Math.floor(pos));
    const f = pos - idx;
    const na = r.nodes[idx];
    const nb = r.nodes[idx + 1];
    const cx = city.graph.cx[na] + (city.graph.cx[nb] - city.graph.cx[na]) * f;
    const cy = city.graph.cy[na] + (city.graph.cy[nb] - city.graph.cy[na]) * f;

    // Never draw a cart standing in the river: the route is a node polyline and
    // the corridor between two nodes bends, exactly as the tram rails do.
    const tx = Math.round(cx);
    const ty = Math.round(cy);
    if (tx < 0 || ty < 0 || tx >= city.district.width || ty >= city.district.height) continue;
    if (city.district.tile[cellKey(city.district, tx, ty)] === Tile.Water) continue;
    add(1, r.kind, cx, cy, false);
  }

  // Vehicles move only a fraction of a cell per frame, so insertion sort keeps
  // the nearly sorted list ordered without allocating.
  for (let i = 0; i < n - 1; i++) {
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

/** Draw one vehicle from the merged depth list. */
export function drawVehicle(ctx: CanvasRenderingContext2D, vehicle: VehicleDraw, variant: Variant): number {
  const x = Math.round(vehicle.wx);
  const y = Math.round(vehicle.wy);
  if (vehicle.kind === 0) {
    const body = gradeHex(PAL.buntRed, variant);
    const roof = gradeHex(PAL.verd2, variant);
    const hw = vehicle.along ? 9 : 7;
    fillPolyHard(ctx, [
      { x: x - hw, y: y - 4 }, { x, y: y - 8 },
      { x: x + hw, y: y - 4 }, { x, y },
    ], gradeHex(shadeHex(PAL.buntRed, -0.2), variant));
    fillPolyHard(ctx, [
      { x: x - hw, y: y - 11 }, { x, y: y - 15 },
      { x: x + hw, y: y - 11 }, { x, y: y - 7 },
    ], roof);
    ctx.fillStyle = body;
    ctx.fillRect(x - hw + 1, y - 11, hw * 2 - 1, 7);
    ctx.fillStyle = variant === 'day' ? gradeHex(PAL.darkWindow, variant) : gradeHex(PAL.litWindow, variant, true);
    for (let i = 0; i < 3; i++) ctx.fillRect(x - hw + 3 + i * 5, y - 9, 3, 3);
    ctx.fillStyle = gradeHex(PAL.soot2, variant);
    ctx.fillRect(x, y - 19, 1, 5);
    return 5;
  }

  const cartKind = vehicle.cartKind;
  const body = gradeHex(CART_BODY[cartKind], variant);
  const dark = gradeHex(shadeHex(CART_BODY[cartKind], -0.2), variant);
  ctx.fillStyle = gradeHex(PAL.soot0, variant);
  ctx.fillRect(x - 5, y, 10, 1);

  if (cartKind === 2) {
    fillPolyHard(ctx, [
      { x: x - 3, y: y - 3 }, { x: x + 3, y: y - 3 },
      { x: x + 3, y: y - 6 }, { x: x - 3, y: y - 6 },
    ], body);
    return 2;
  }

  ctx.fillStyle = gradeHex(PAL.wood0, variant);
  ctx.fillRect(x + 4, y - 7, 5, 4);
  ctx.fillRect(x + 8, y - 9, 2, 3);
  fillPolyHard(ctx, [
    { x: x - 6, y: y - 2 }, { x: x + 3, y: y - 2 },
    { x: x + 3, y: y - 7 }, { x: x - 6, y: y - 7 },
  ], body);
  fillPolyHard(ctx, [
    { x: x - 6, y: y - 7 }, { x: x + 3, y: y - 7 },
    { x: x + 2, y: y - 10 }, { x: x - 5, y: y - 10 },
  ], gradeHex(cartKind === 0 ? PAL.thatch1 : PAL.soot3, variant));
  ctx.fillStyle = dark;
  ctx.fillRect(x - 5, y - 2, 2, 2);
  ctx.fillRect(x + 1, y - 2, 2, 2);
  return 5;
}

/**
 * Chimney smoke.
 *
 * PAL.smoke0/1/2 have been in the palette since the first commit and had no
 * callers at all. A gaslight-era district with a mill quarter and no smoke in it
 * is missing the one effect the setting is famous for.
 *
 * Puffs fade by stepping DOWN through sizes rather than by alpha ramp, which is
 * how pixel art dissipates smoke, and the drift is an integer hash of the puff
 * index so nothing is stored between frames.
 */
export function drawSmoke(
  ctx: CanvasRenderingContext2D, city: City, fracMin: number, variant: Variant,
  tl: { wx: number; wy: number }, br: { wx: number; wy: number },
): number {
  const t = city.tick + fracMin;
  const weather = weatherAt(city.seed, city.tick);
  let calls = 0;

  // Smoke has to be LIGHTER than what is behind it, and what is behind it flips
  // between day and night. Grading the day palette into night gave dark blue
  // puffs over dark blue roofs: present, invisible, and only found by counting
  // pixels. Smoke reads against a sky, not in a colour scheme.
  const shades = [
    gradeHex(PAL.smoke2, variant),
    gradeHex(PAL.smoke1, variant),
    gradeHex(PAL.smoke0, variant),
  ];

  for (const b of city.buildings) {
    const industrial = b.kind === 'mill' || b.kind === 'foundry' || b.kind === 'gasworks';
    if (!industrial) {
      // Domestic chimneys smoke in the cold hours, and only if there is fuel: a
      // household with the main cut has a cold grate, and the prose says so.
      const m = minuteOfDay(city.tick);
      if (m > 540 && m < 1020) continue;
      if (b.id % 6 !== 0) continue;
      if (!serviceAt(city.networks.gas, b.id)) continue;
    } else if (b.firmId >= 0 && !isRunning(city.firms[b.firmId], city.tick)) {
      // A struck or shut mill does not smoke. This is the clearest visual signal
      // in the game that an intervention landed.
      continue;
    }

    // Rise from a CHIMNEY, not from the middle of the roof.
    //
    // Puffs used to be five-pixel iso ground-diamonds emitted at the building's
    // south corner, so on a phone they read as a scatter of grey lozenges lying
    // on the roofs rather than as smoke leaving a flue. Chimneys sit at the ridge
    // ends, so the plume starts above the ridge and drifts off the near end.
    const sx = b.ox + b.w - 1;
    const sy = b.oy + b.d - 1;
    const roofTop = b.storeys * 8 + 2 + (industrial ? 24 : 11);
    const wx = isoX(sx, sy) - (industrial ? 0 : TILE_W * 0.22);
    const wy = isoY(sx, sy) - roofTop - (TILE_H * 0.5);
    if (wx < tl.wx - 40 || wx > br.wx + 40 || wy < tl.wy - 80 || wy > br.wy + 40) continue;

    const puffs = industrial ? 6 : 2;
    const rise = industrial ? 42 : 20;
    for (let i = 0; i < puffs; i++) {
      const age = (t * (industrial ? 0.05 : 0.03) + i / puffs) % 1;
      const drift = (((mix(city.seed, 81, b.id, i) >>> 0) % 7) - 3) * 0.6;
      const px = Math.round(wx + drift * age * 4 + weather.windX * age * (industrial ? 14 : 8));
      const py = Math.round(wy - age * rise);
      // Small, and shrinking to nothing rather than fading. Two pixels across at
      // the top of a domestic flue is the whole of it.
      const r = industrial
        ? Math.max(1, Math.round((1 - age) * 2) + 1)
        : 1;
      ctx.fillStyle = shades[Math.min(2, Math.floor(age * 3))];
      ctx.fillRect(px - r, py - r, r * 2, Math.max(1, r * 2 - 1));
      calls++;
    }
  }

  // Disaster smoke is larger and denser than a flue, but uses the same hard,
  // deterministic puff language. It remains an atmospheric pass above roofs.
  for (const event of city.disasters.events) {
    if (event.kind !== 'fire' || !isDisasterActive(city, event)) continue;
    for (let bi = 0; bi < event.affectedBuildingIds.length; bi++) {
      const b = city.buildings[event.affectedBuildingIds[bi]];
      if (!b) continue;
      const sx = b.ox + b.w - 1;
      const sy = b.oy + b.d - 1;
      const wx = isoX(sx, sy);
      const wy = isoY(sx, sy) - b.storeys * 8 - 19;
      if (wx < tl.wx - 48 || wx > br.wx + 48 || wy < tl.wy - 96 || wy > br.wy + 40) continue;
      const puffs = b.w * b.d > 2 ? 10 : 7;
      for (let i = 0; i < puffs; i++) {
        const age = (t * 0.07 + i / puffs) % 1;
        const drift = (((mix(city.seed, 185, event.id, bi * 11 + i) >>> 0) % 9) - 4) * 0.7;
        const px = Math.round(wx + drift * age * 5 + weather.windX * age * 18);
        const py = Math.round(wy - age * 62);
        const r = Math.max(1, Math.round((1 - age) * 3));
        ctx.fillStyle = shades[Math.min(2, Math.floor(age * 3))];
        ctx.fillRect(px - r, py - r, r * 2, Math.max(1, r * 2 - 1));
        calls++;
      }
    }
  }
  return calls;
}

/** Viewport rain, generated from the current watch and animation frame. */
export function drawWeatherFx(
  ctx: CanvasRenderingContext2D, city: City, fracMin: number, variant: Variant,
  tl: { wx: number; wy: number }, br: { wx: number; wy: number },
): number {
  const weather = weatherAt(city.seed, city.tick);
  if (weather.precipitation === 0) return 0;
  const count = weather.precipitation === 2 ? 78 : 48;
  const spanX = Math.max(1, Math.floor(br.wx - tl.wx));
  const spanY = Math.max(1, Math.floor(br.wy - tl.wy));
  const frame = Math.floor((city.tick + fracMin) * (weather.precipitation === 2 ? 2 : 1.4));
  const dark = gradeHex(PAL.riv2, variant);
  const glint = gradeHex(PAL.rivGlint, variant);
  let calls = 0;
  for (let i = 0; i < count * 5 && calls < count; i++) {
    // The lane is fixed for the whole watch. Only y advances, so rain falls
    // instead of every streak teleporting to a new x each animation frame.
    const h = mix(city.seed, Stream.Weather, weather.watch, i);
    const x = Math.floor(tl.wx + (h % spanX));
    const fall = frame * (weather.precipitation === 2 ? 5 : 3);
    const y = Math.floor(tl.wy + (((h >>> 12) + fall) % spanY));
    const tx = Math.round(x / TILE_W + y / TILE_H);
    const ty = Math.round(y / TILE_H - x / TILE_W);
    if (!insideIsland(city.district, tx, ty)) continue;
    const len = weather.precipitation === 2 ? 6 + (h & 1) : 4 + (h & 1);
    const lean = weather.windX * (weather.precipitation === 2 ? 3 : 2);
    const bright = weather.precipitation === 2 ? (h % 5) < 2 : (h & 3) === 0;
    const colour = bright ? glint : dark;
    lineHard(ctx, { x, y }, { x: x + lean, y: y + len }, colour);
    calls++;
  }
  return calls;
}


/**
 * Carts, drays and hand barrows.
 *
 * The only vehicles in the district were two trams, so the streets read as empty
 * even with sixty people on them: a working 1890s district moves goods all day,
 * and the absence of any of it is most of why the place looked posed.
 *
 * Render side and stateless. A cart's position is a pure function of (tick,
 * cart index) along a route precomputed once from the seed, so it costs nothing
 * per frame, cannot drift, and cannot break the determinism contract.
 */
export interface CartRoute {
  nodes: number[];
  /** Ticks to traverse the whole route one way. */
  span: number;
  kind: 0 | 1 | 2;
}

export function buildCartRoutes(city: City, count = 0): CartRoute[] {
  const out: CartRoute[] = [];
  const g = city.graph;
  if (g.n < 4) return out;
  const wanted = count > 0 ? count : Math.max(9, Math.min(18, Math.round(city.buildings.length / 20)));
  for (let i = 0; i < wanted; i++) {
    // Endpoints drawn from the seed, far enough apart to be a journey.
    let a = (mix(city.seed, 91, i) >>> 0) % g.n;
    let b = (mix(city.seed, 92, i) >>> 0) % g.n;
    let guard = 0;
    while (guard++ < 20
      && Math.abs(g.cx[a] - g.cx[b]) + Math.abs(g.cy[a] - g.cy[b]) < 14) {
      b = (mix(city.seed, 92, i, guard) >>> 0) % g.n;
    }
    const nodes: number[] = [a];
    let cur = a;
    let steps = 0;
    while (cur !== b && steps++ < 60) {
      const next = stepToward(g, cur, b);
      if (next < 0) break;
      nodes.push(next);
      cur = next;
    }
    if (nodes.length < 3) continue;
    out.push({
      nodes,
      // Slower than a soul walks, which is what a loaded dray is.
      span: nodes.length * 9 + ((mix(city.seed, 93, i) >>> 0) % 20),
      kind: ((mix(city.seed, 94, i) >>> 0) % 3) as 0 | 1 | 2,
    });
  }
  return out;
}

const CART_BODY = [PAL.wood1, PAL.brick1, PAL.soot2];
