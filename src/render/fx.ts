// Per-frame effects: the tram, and the smoke.
//
// Everything here is deterministic from (seed, tick) and allocates nothing, so it
// costs the same whether the sim is paused or running at forty times speed.
import type { City } from '../sim/city';
import { tramPos } from '../sim/city';
import { serviceAt } from '../sim/networks';
import { isRunning } from '../sim/firms';
import { PAL, gradeHex, shadeHex, variantFor } from './palette';
import type { Variant } from './palette';
import { minuteOfDay } from '../sim/clock';
import { TILE_W, TILE_H, isoX, isoY } from './iso';
import { fillPolyHard } from './raster';
import { mix } from '../sim/rng';
import { stepToward } from '../sim/graph';
import { Tile } from '../sim/types';
import { cellKey } from '../sim/district';

/**
 * The tram car.
 *
 * Drawn as a box on the rails with a verdigris roof and lit windows after dark.
 * It is not depth sorted against the buildings: at this scale the line runs down
 * the middle of the street and a car is never behind a facade for long enough to
 * matter, and sorting it would mean threading it through the merge walk for one
 * sprite.
 */
export function drawTrams(ctx: CanvasRenderingContext2D, city: City, variant: Variant): number {
  let calls = 0;
  for (const car of city.trams) {
    const p = tramPos(city, car);
    const wx = isoX(p.cx, p.cy);
    const wy = isoY(p.cx, p.cy);
    const x = Math.round(wx);
    const y = Math.round(wy);
    const body = gradeHex(PAL.buntRed, variant);
    const roof = gradeHex(PAL.verd2, variant);

    // Body: a short iso box, oriented along the direction of travel.
    const along = Math.abs(p.dx) >= Math.abs(p.dy);
    const hw = along ? 9 : 7;
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
    // Windows: lit after dark, which is what makes a tram read as a tram.
    ctx.fillStyle = variant === 'day' ? gradeHex(PAL.darkWindow, variant) : PAL.litWindow;
    for (let i = 0; i < 3; i++) ctx.fillRect(x - hw + 3 + i * 5, y - 9, 3, 3);
    // A trolley pole up to the wire.
    ctx.fillStyle = gradeHex(PAL.soot2, variant);
    ctx.fillRect(x, y - 19, 1, 5);
    calls += 5;
  }
  return calls;
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
  let calls = 0;

  // Smoke has to be LIGHTER than what is behind it, and what is behind it flips
  // between day and night. Grading the day palette into night gave dark blue
  // puffs over dark blue roofs: present, invisible, and only found by counting
  // pixels. Smoke reads against a sky, not in a colour scheme.
  const shades = variant === 'day'
    ? [PAL.smoke2, PAL.smoke1, PAL.smoke0]
    // At night smoke is barely lit: only a little lighter than the roofs it
    // passes over, or it shouts louder than the lit windows do.
    : ['#4e5566', '#414757', '#363b48'];

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
      const px = Math.round(wx + drift * age * 4);
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
  void variantFor;
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

export function buildCartRoutes(city: City, count = 9): CartRoute[] {
  const out: CartRoute[] = [];
  const g = city.graph;
  if (g.n < 4) return out;
  for (let i = 0; i < count; i++) {
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

export function drawCarts(
  ctx: CanvasRenderingContext2D, city: City, routes: readonly CartRoute[],
  fracMin: number, variant: Variant,
  tl: { wx: number; wy: number }, br: { wx: number; wy: number },
): number {
  const t = city.tick + fracMin;
  let calls = 0;
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

    const wx = isoX(cx, cy);
    const wy = isoY(cx, cy);
    if (wx < tl.wx || wx > br.wx || wy < tl.wy || wy > br.wy) continue;

    const x = Math.round(wx);
    const y = Math.round(wy);
    const body = gradeHex(CART_BODY[r.kind], variant);
    const dark = gradeHex(shadeHex(CART_BODY[r.kind], -0.2), variant);

    // A shadow, so it sits on the cobbles like everything else.
    ctx.fillStyle = 'rgba(10,12,16,0.45)';
    ctx.fillRect(x - 5, y, 10, 1);

    if (r.kind === 2) {
      // A hand barrow: no horse, one man's width.
      fillPolyHard(ctx, [
        { x: x - 3, y: y - 3 }, { x: x + 3, y: y - 3 },
        { x: x + 3, y: y - 6 }, { x: x - 3, y: y - 6 },
      ], body);
      calls += 2;
      continue;
    }

    // The horse, ahead of the cart and a shade darker.
    ctx.fillStyle = gradeHex(PAL.wood0, variant);
    ctx.fillRect(x + 4, y - 7, 5, 4);
    ctx.fillRect(x + 8, y - 9, 2, 3);
    // The bed and its load.
    fillPolyHard(ctx, [
      { x: x - 6, y: y - 2 }, { x: x + 3, y: y - 2 },
      { x: x + 3, y: y - 7 }, { x: x - 6, y: y - 7 },
    ], body);
    fillPolyHard(ctx, [
      { x: x - 6, y: y - 7 }, { x: x + 3, y: y - 7 },
      { x: x + 2, y: y - 10 }, { x: x - 5, y: y - 10 },
    ], gradeHex(r.kind === 0 ? PAL.thatch1 : PAL.soot3, variant));
    // Wheels.
    ctx.fillStyle = dark;
    ctx.fillRect(x - 5, y - 2, 2, 2);
    ctx.fillRect(x + 1, y - 2, 2, 2);
    calls += 5;
  }
  return calls;
}
