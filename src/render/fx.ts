// Per-frame effects: the tram, and the smoke.
//
// Everything here is deterministic from (seed, tick) and allocates nothing, so it
// costs the same whether the sim is paused or running at forty times speed.
import type { City } from '../sim/city';
import { tramPos } from '../sim/city';
import { serviceAt } from '../sim/networks';
import { isRunning } from '../sim/firms';
import { PAL, gradeHex, shadeHex, isDarkVariant } from './palette';
import type { Variant } from './palette';
import { minuteOfDay } from '../sim/clock';
import { TILE_W, TILE_H, isoX, isoY, depthKey, worldBounds, LAYER_AGENT, LAYER_OVERHEAD } from './iso';
import { fillPolyHard, lineHard, ditherPolyHard, applyDitherVeil } from './raster';
import { mix, Stream } from '../sim/rng';
import { stepToward } from '../sim/graph';
import { Tile } from '../sim/types';
import { cellKey, insideIsland } from '../sim/district';
import { isDisasterActive } from '../sim/disasters';
import { weatherAt, snowCoverAt } from '../sim/weather';
import type { Weather } from '../sim/weather';
import { riverLevelAt, riverDropAt } from '../sim/hydrology';

export interface VehicleDraw {
  /** 0 tram, 1 cart, 2 barge. */
  kind: 0 | 1 | 2;
  /** Cart body family. Ignored by trams. */
  cartKind: 0 | 1 | 2;
  wx: number;
  wy: number;
  depth: number;
  /** Tram body axis. Carts do not need an orientation at this resolution. */
  along: boolean;
  /** Dither veil 0..16: barges slip gradually into a bridge's shadow. */
  veil: number;
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
  const H = (hazard.wide ? 36 : 28) + flick * 3;
  const halfW = hazard.wide ? 11 : 8;
  const red = gradeHex(PAL.buntRed, variant);
  const redHi = gradeHex(PAL.buntRedHi, variant);
  const hot = gradeHex(PAL.brass2, variant, true);
  const core = gradeHex(PAL.gas2, variant, true);
  const white = gradeHex(PAL.litWindow2, variant, true);

  // A broad hot pool of light on the roof under the fire, denser at the centre,
  // so the flame sits IN the building and throws light onto what it stands on.
  ditherPolyHard(ctx, [
    { x: x - halfW - 4, y: y + 3 }, { x: x + halfW + 4, y: y + 3 },
    { x: x + halfW + 1, y: y - 5 }, { x: x - halfW - 1, y: y - 5 },
  ], hot, 5);
  ditherPolyHard(ctx, [
    { x: x - halfW, y: y + 1 }, { x: x + halfW, y: y + 1 },
    { x: x + halfW - 2, y: y - 4 }, { x: x - halfW + 2, y: y - 4 },
  ], core, 7);

  // Two flanking tongues, so the fire is a mass of flame rather than one spike.
  for (const s of [-1, 1]) {
    const fx = x + s * (halfW - 2);
    const fh = H * (0.5 + (((p >> 2) + (s > 0 ? 1 : 0)) % 2) * 0.14);
    fillPolyHard(ctx, [
      { x: fx - 3, y }, { x: fx - 1 + leanA * s, y: y - fh * 0.6 },
      { x: fx + leanA * s, y: y - fh }, { x: fx + 2 + leanA * s, y: y - fh * 0.55 },
      { x: fx + 3, y },
    ], red);
    fillPolyHard(ctx, [
      { x: fx - 1, y }, { x: fx + leanB, y: y - fh * 0.55 },
      { x: fx + 1 + leanB, y: y - fh * 0.35 }, { x: fx + 2, y },
    ], redHi);
  }

  // Outer envelope: dark, wide, ragged, the sooty edge of the fire.
  fillPolyHard(ctx, [
    { x: x - halfW, y }, { x: x - halfW + 1, y: y - H * 0.4 },
    { x: x - 3 + leanA, y: y - H * 0.72 }, { x: x - 1 + leanA, y: y - H },
    { x: x + 3 + leanA, y: y - H * 0.66 }, { x: x + halfW - 1, y: y - H * 0.36 },
    { x: x + halfW, y },
  ], red);
  // Mid body.
  fillPolyHard(ctx, [
    { x: x - halfW + 2, y }, { x: x - 2 + leanB, y: y - H * 0.5 },
    { x: x - 1 + leanA, y: y - H * 0.86 }, { x: x + 1 + leanA, y: y - H * 0.64 },
    { x: x + 3 + leanB, y: y - H * 0.42 }, { x: x + halfW - 2, y },
  ], redHi);
  // Inner flame, bright.
  fillPolyHard(ctx, [
    { x: x - 4, y }, { x: x - 2 + leanB, y: y - H * 0.44 },
    { x: x + leanB, y: y - H * 0.7 }, { x: x + 2 + leanB, y: y - H * 0.4 },
    { x: x + 4, y },
  ], hot);
  // White-hot core, tall and narrow up the heart of the flame.
  fillPolyHard(ctx, [
    { x: x - 2, y }, { x: x - 1 + leanB, y: y - H * 0.4 },
    { x: x + leanB, y: y - H * 0.58 }, { x: x + 2 + leanB, y: y - H * 0.36 },
    { x: x + 2, y },
  ], core);
  ctx.fillStyle = white;
  ctx.fillRect(x, y - Math.round(H * 0.22), 1, Math.round(H * 0.22));

  // Embers: sparks flung up into the smoke, positions hashed off the phase.
  ctx.fillStyle = gradeHex(PAL.brass3, variant, true);
  for (let i = 0; i < 6; i++) {
    const e = (p * 7 + i * 5) % 17;
    const ex = x + ((e % 7) - 3) + leanA;
    const ey = y - H - 2 - (e % 9);
    ctx.fillRect(ex, ey, 1, 1);
  }
  return 12;
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
  const add = (kind: VehicleDraw['kind'], cartKind: VehicleDraw['cartKind'], cx: number, cy: number, along: boolean, dy = 0) => {
    const wx = isoX(cx, cy);
    const wy = isoY(cx, cy) + dy;
    // Include the tram pole and cart body above their ground point in the cull.
    if (wx < tl.wx - 12 || wx > br.wx + 12 || wy < tl.wy - 24 || wy > br.wy + 4) return;
    const slot = out[n] ?? (out[n] = { kind: 0, cartKind: 0, wx: 0, wy: 0, depth: 0, along: false, veil: 16 });
    slot.veil = 16;
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

  // Barges work the channel, deterministic in (seed, tick) like everything
  // else that moves. Fewer as the river falls, none on a dry bed, and a boat
  // under a bridge is skipped: the deck and parapet are what hide it.
  const level = riverLevelAt(city.seed, city.tick);
  if (level > 0) {
    const surfaceY = riverDropAt(city.seed, city.tick) + (level === 1 ? 2 : 0);
    const riv = city.river;
    let x0 = -1;
    let x1 = -1;
    for (let x = 0; x < city.district.width; x++) {
      if (riv.centre[x] >= 0 && insideIsland(city.district, x, riv.centre[x])) {
        if (x0 < 0) x0 = x;
        x1 = x;
      }
    }
    const span = x1 - x0 - 4;
    if (span > 8) {
      const boats = level >= 3 ? 3 : level === 2 ? 2 : 1;
      for (let i = 0; i < boats; i++) {
        // Triangle wave along the reach: down with the current, then poled back.
        const ph = ((t * 0.22 + (i * span * 2) / boats) % (span * 2) + span * 2) % (span * 2);
        const along = ph <= span ? ph : span * 2 - ph;
        const bx = x0 + 2 + along;
        const bi = Math.min(x1 - 1, Math.floor(bx));
        const f = bx - bi;
        const by = riv.centre[bi] + (riv.centre[bi + 1] - riv.centre[bi]) * f;
        // Slipping under a bridge is gradual: the boat dissolves into the
        // deck's shadow over its last tile of approach instead of popping.
        let veil = 16;
        for (const bridge of riv.bridges) {
          const clearing = bridge.stone ? 1.4 : 1.1;
          const dist = Math.abs(bx - bridge.x);
          if (dist < clearing) { veil = 0; break; }
          if (dist < clearing + 1.2) veil = Math.min(veil, Math.round((16 * (dist - clearing)) / 1.2));
        }
        if (veil <= 0) continue;
        add(2, (i % 3) as VehicleDraw['cartKind'], bx, by, ph <= span, surfaceY);
        out[n - 1].veil = veil;
      }
    }
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

let BARGE_SCRATCH: HTMLCanvasElement | null = null;
function bargeScratch(): HTMLCanvasElement {
  if (!BARGE_SCRATCH) {
    BARGE_SCRATCH = document.createElement('canvas');
    BARGE_SCRATCH.width = 32;
    BARGE_SCRATCH.height = 24;
  }
  return BARGE_SCRATCH;
}

/** Draw one vehicle from the merged depth list. */
export function drawVehicle(ctx: CanvasRenderingContext2D, vehicle: VehicleDraw, variant: Variant): number {
  const x = Math.round(vehicle.wx);
  const y = Math.round(vehicle.wy);
  if (vehicle.kind === 2 && vehicle.veil < 16) {
    // Near a bridge the barge is drawn to a scratch canvas, veiled by ordered
    // dither, and blitted, so it slides into the shadow of the arch.
    const scratch = bargeScratch();
    const sctx = scratch.getContext('2d') as CanvasRenderingContext2D;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, scratch.width, scratch.height);
    sctx.setTransform(1, 0, 0, 1, 16 - x, 12 - y);
    drawVehicle(sctx, { ...vehicle, veil: 16 }, variant);
    applyDitherVeil(sctx, scratch.width, scratch.height, vehicle.veil);
    ctx.drawImage(scratch, x - 16, y - 12);
    return 9;
  }
  if (vehicle.kind === 2) {
    // A working river barge: low freeboard, so it clears every arch on the
    // river. The cargo tells the boats apart; the tiller man stands aft.
    const hull = gradeHex(PAL.wood0, variant);
    const deck = gradeHex(PAL.wood2, variant);
    const east = vehicle.along;
    fillPolyHard(ctx, [
      { x: x - 8, y: y - 2 }, { x: x + 8, y: y - 2 },
      { x: x + 6, y: y + 2 }, { x: x - 6, y: y + 2 },
    ], hull);
    fillPolyHard(ctx, [
      { x: x - 7, y: y - 3 }, { x: x + 7, y: y - 3 }, { x: x + 7, y: y - 2 }, { x: x - 7, y: y - 2 },
    ], deck);
    // The bow leads whichever way the boat is working.
    ctx.fillStyle = hull;
    ctx.fillRect(east ? x + 8 : x - 9, y - 2, 1, 3);
    if (vehicle.cartKind === 0) {
      ctx.fillStyle = gradeHex(PAL.wood1, variant);
      ctx.fillRect(x - 4, y - 6, 3, 3);
      ctx.fillRect(x, y - 5, 3, 2);
    } else if (vehicle.cartKind === 1) {
      fillPolyHard(ctx, [
        { x: x - 5, y: y - 3 }, { x: x - 3, y: y - 6 }, { x: x + 4, y: y - 6 }, { x: x + 6, y: y - 3 },
      ], gradeHex(PAL.buntBlue, variant));
    } else {
      fillPolyHard(ctx, [
        { x: x - 5, y: y - 3 }, { x: x - 1, y: y - 6 }, { x: x + 3, y: y - 4 }, { x: x + 5, y: y - 3 },
      ], gradeHex(PAL.soot1, variant));
    }
    ctx.fillStyle = gradeHex(PAL.soot0, variant);
    ctx.fillRect(east ? x - 6 : x + 5, y - 5, 1, 3);
    // The wake trails astern and glints.
    ctx.fillStyle = gradeHex(PAL.rivGlint, variant);
    ctx.fillRect(east ? x - 10 : x + 9, y, 1, 1);
    ctx.fillRect(east ? x - 12 : x + 11, y + 1, 1, 1);
    return 8;
  }
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
    ctx.fillStyle = !isDarkVariant(variant) ? gradeHex(PAL.darkWindow, variant) : gradeHex(PAL.litWindow, variant, true);
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

    // Ember drift from a working stack after dark: single hot pixels climbing
    // through the plume and going out partway up. Only visible against the dusk
    // and night sky, which is when a foundry gate glows anyway. The building is
    // already known to be RUNNING, so a struck mill goes cold in both channels.
    if (industrial && isDarkVariant(variant)) {
      ctx.fillStyle = gradeHex(PAL.brass3, variant, true);
      for (let i = 0; i < 3; i++) {
        const age = (t * 0.09 + i / 3 + ((mix(city.seed, 86, b.id, i) % 7) / 7)) % 1;
        if (age >= 0.65) continue;
        const sway = ((mix(city.seed, 87, b.id, i) % 5) - 2) * 0.8;
        const ex = Math.round(wx + sway * age * 5 + weather.windX * age * 16);
        const ey = Math.round(wy - age * (rise + 10));
        ctx.fillRect(ex, ey, 1, 1);
        calls++;
      }
    }
  }

  // Disaster smoke is larger and denser than a flue, but uses the same hard,
  // deterministic puff language. It remains an atmospheric pass above roofs.
  // A fire throws a thick, dark column, black with soot at the base and paling to
  // grey as it climbs and thins. It leans hard downwind and towers over the roofs,
  // so a blaze is legible across the whole district, not just at the flame.
  const fireShades = [
    gradeHex(PAL.soot0, variant), gradeHex(PAL.soot1, variant),
    gradeHex(PAL.smoke1, variant), gradeHex(PAL.smoke2, variant),
  ];
  for (const event of city.disasters.events) {
    if (event.kind !== 'fire' || !isDisasterActive(city, event)) continue;
    for (let bi = 0; bi < event.affectedBuildingIds.length; bi++) {
      const b = city.buildings[event.affectedBuildingIds[bi]];
      if (!b) continue;
      const sx = b.ox + b.w - 1;
      const sy = b.oy + b.d - 1;
      const wx = isoX(sx, sy);
      const wy = isoY(sx, sy) - b.storeys * 8 - 19;
      if (wx < tl.wx - 64 || wx > br.wx + 64 || wy < tl.wy - 140 || wy > br.wy + 40) continue;
      const big = b.w * b.d > 2;
      const puffs = big ? 20 : 14;
      const rise = big ? 108 : 90;
      for (let i = 0; i < puffs; i++) {
        const age = (t * 0.055 + i / puffs) % 1;
        const drift = (((mix(city.seed, 185, event.id, bi * 11 + i) >>> 0) % 11) - 5) * 0.6;
        // The plume widens as it leaves the fire, then frays out at the top.
        const px = Math.round(wx + drift * (0.4 + age) * 4 + weather.windX * age * 30);
        const py = Math.round(wy - age * rise);
        const r = Math.max(1, Math.round(1 + (age < 0.15 ? age * 6 : (1 - age) * 3.4)));
        ctx.fillStyle = fireShades[Math.min(3, Math.floor(age * 4))];
        ctx.fillRect(px - r, py - r, r * 2, r * 2);
        calls++;
      }
    }
  }
  return calls;
}

/**
 * Falling snow.
 *
 * Rain is a viewport effect and gets away with it because a streak crosses the
 * frame in a few tenths of a second. Snow hangs in the air long enough for the
 * eye to hold one flake, so anchoring it to the viewport would drag the whole
 * fall sideways every time the camera panned, which is the bug that used to put
 * fog on the viewport corners. The field is therefore laid out in WORLD space,
 * as a repeating cell of flakes; the camera only decides which cells are worth
 * visiting, so density per acre of city is the same at every zoom and the cost
 * is proportional to what is on screen rather than to the district.
 *
 * Flakes drift instead of streaking: each one slides across its cell on the
 * wind, sways on its own phase, and falls at a speed set by its size, so the
 * big near flakes come down through the small far ones.
 */
function drawSnowfall(
  ctx: CanvasRenderingContext2D, city: City, fracMin: number, variant: Variant, weather: Weather,
  tl: { wx: number; wy: number }, br: { wx: number; wy: number },
): number {
  const t = city.tick + fracMin;
  // Snow comes in waves the way rain gusts, but slower and shallower: a squall
  // of flakes, then a lull, never a downpour.
  const gust = 0.62 + 0.3 * (0.5 + 0.5 * Math.sin(t * 0.012))
    + 0.2 * (0.5 + 0.5 * Math.sin(t * 0.031 + 2.2));
  const perCell = Math.max(2, Math.round(6 * gust));
  const near = gradeHex(PAL.stone4, variant);
  const far = gradeHex(PAL.plaster2, variant);
  const d = city.district;
  const cx0 = Math.floor((tl.wx - SNOW_CELL_W) / SNOW_CELL_W);
  const cx1 = Math.ceil(br.wx / SNOW_CELL_W);
  const cy0 = Math.floor((tl.wy - SNOW_CELL_H) / SNOW_CELL_H);
  const cy1 = Math.ceil(br.wy / SNOW_CELL_H);
  let calls = 0;
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let i = 0; i < perCell; i++) {
        const h = mix(city.seed, Stream.Weather, cx * 131 + cy * 17, weather.watch * 8 + i) >>> 0;
        // Three flake sizes. A bigger flake is nearer, so it falls faster and
        // leans further on the wind: the parallax is what gives the fall depth.
        const size = (h % 9) === 0 ? 2 : 1;
        const fall = (0.55 + size * 0.35) * t;
        const sway = Math.sin(t * 0.045 + (h >>> 4) % 63) * (size === 2 ? 2.4 : 1.4);
        const lean = weather.windX * t * 0.28 * size;
        const x = cx * SNOW_CELL_W
          + (((h % SNOW_CELL_W) + lean + sway) % SNOW_CELL_W + SNOW_CELL_W) % SNOW_CELL_W;
        const y = cy * SNOW_CELL_H
          + (((h >>> 9) % SNOW_CELL_H + fall) % SNOW_CELL_H + SNOW_CELL_H) % SNOW_CELL_H;
        if (x < tl.wx || x > br.wx || y < tl.wy || y > br.wy) continue;
        // Snow over the void looks like dust on the screen. It falls on the
        // district, the same rule the rain and the fog banks keep.
        const tx = Math.round(x / TILE_W + y / TILE_H);
        const ty = Math.round(y / TILE_H - x / TILE_W);
        if (!insideIsland(d, tx, ty)) continue;
        ctx.fillStyle = size === 2 ? near : far;
        ctx.fillRect(Math.round(x), Math.round(y), size, size);
        calls++;
      }
    }
  }
  return calls;
}

const SNOW_CELL_W = 96;
const SNOW_CELL_H = 72;

/** Viewport rain, generated from the current watch and animation frame. */
export function drawWeatherFx(
  ctx: CanvasRenderingContext2D, city: City, fracMin: number, variant: Variant,
  tl: { wx: number; wy: number }, br: { wx: number; wy: number },
): number {
  const weather = weatherAt(city.seed, city.tick);
  if (weather.kind === 'snow') return drawSnowfall(ctx, city, fracMin, variant, weather, tl, br);
  if (weather.precipitation === 0) return 0;
  const storm = weather.precipitation === 2;
  const t = city.tick + fracMin;
  // Shifting intensity: the rain gusts and eases rather than falling at one flat
  // rate. Two slow sines beat against each other, so it swells and slackens
  // without ever settling into an obvious loop. Deterministic from the tick.
  const gust = 0.5 + 0.55 * (0.5 + 0.5 * Math.sin(t * 0.019))
    + 0.35 * (0.5 + 0.5 * Math.sin(t * 0.051 + 1.7));
  const base = storm ? 120 : 64;
  const count = Math.round(base * gust);
  const spanX = Math.max(1, Math.floor(br.wx - tl.wx));
  const spanY = Math.max(1, Math.floor(br.wy - tl.wy));
  const frame = Math.floor(t * (storm ? 2 : 1.4));
  const dark = gradeHex(PAL.riv2, variant);
  const glint = gradeHex(PAL.rivGlint, variant);
  const d = city.district;
  let calls = 0;
  for (let i = 0; i < count * 5 && calls < count; i++) {
    // The lane is fixed for the whole watch. Only y advances, so rain falls
    // instead of every streak teleporting to a new x each animation frame.
    const h = mix(city.seed, Stream.Weather, weather.watch, i);
    const x = Math.floor(tl.wx + (h % spanX));
    const fall = frame * (storm ? 5 : 3);
    const y = Math.floor(tl.wy + (((h >>> 12) + fall) % spanY));
    const tx = Math.round(x / TILE_W + y / TILE_H);
    const ty = Math.round(y / TILE_H - x / TILE_W);
    if (!insideIsland(d, tx, ty)) continue;
    const len = storm ? 6 + (h & 1) : 4 + (h & 1);
    const lean = weather.windX * (storm ? 3 : 2);
    const bright = storm ? (h % 5) < 2 : (h & 3) === 0;
    lineHard(ctx, { x, y }, { x: x + lean, y: y + len }, bright ? glint : dark);
    calls++;
  }

  // Where the rain lands, the surface answers. Marks are rehashed each frame with
  // the frame number so they blink rather than drift, and the mark depends on
  // what was struck: the river dimples in little rings, wet paving throws a short
  // glint, and rain on a roof or in a yard is left to the streaks alone.
  const surfaceMarks = Math.round((storm ? 46 : 26) * gust);
  for (let i = 0; i < surfaceMarks * 5 && calls < count + surfaceMarks; i++) {
    const h = mix(city.seed, Stream.Weather, weather.watch + 9, i * 3 + (frame & 7));
    const x = Math.floor(tl.wx + (h % spanX));
    const y = Math.floor(tl.wy + ((h >>> 12) % spanY));
    const tx = Math.round(x / TILE_W + y / TILE_H);
    const ty = Math.round(y / TILE_H - x / TILE_W);
    if (!insideIsland(d, tx, ty)) continue;
    const tile = d.tile[cellKey(d, tx, ty)];
    if (tile === Tile.Water) {
      // A dimple ring on the water, down on the surface the river actually has.
      const wy = y + riverDropAt(city.seed, city.tick);
      ctx.fillStyle = glint;
      ctx.fillRect(x - 1, wy, 1, 1);
      ctx.fillRect(x + 1, wy, 1, 1);
      ctx.fillRect(x, wy - 1, 1, 1);
      if ((h & 3) === 0) ctx.fillRect(x, wy + 1, 1, 1);
      calls++;
    } else if (tile === Tile.Street || tile === Tile.Alley || tile === Tile.Square
      || tile === Tile.Embankment || tile === Tile.Wharf || tile === Tile.Bridge) {
      // A glint on wet stone.
      ctx.fillStyle = (h & 3) === 0 ? glint : dark;
      ctx.fillRect(x - 1, y, 3, 1);
      if (storm && (h & 7) === 0) ctx.fillRect(x, y - 1, 1, 1);
      calls++;
    }
  }
  return calls;
}

/**
 * Snow lying on the open ground.
 *
 * A dithered pale cover over every open cell that is not water and not built
 * on, deepening while it snows and thinning as it thaws. It is baked into one
 * world-sized canvas and blitted, for the same reason the ground itself is: a
 * quarter of a million ordered-dither pixels is a bake, not a frame.
 *
 * The cover is keyed on four things only, so it is rebuilt when the depth
 * crosses a step or the light changes and never per frame. Cobbled streets take
 * less than gardens do: boots, wheels and hooves clear a thoroughfare, and the
 * difference between a white yard and a grey street is what stops the district
 * reading as a bedsheet thrown over it.
 */
let SNOW_LAYER: HTMLCanvasElement | null = null;
let SNOW_LAYER_KEY = '';

function snowLevel(cover: number): number {
  if (cover < 120) return 0;
  if (cover < 380) return 1;
  if (cover < 700) return 2;
  return 3;
}

export function drawSnowCover(
  ctx: CanvasRenderingContext2D, city: City, variant: Variant,
  tl: { wx: number; wy: number }, br: { wx: number; wy: number },
): number {
  const level = snowLevel(snowCoverAt(city.seed, city.tick));
  if (level === 0) return 0;
  if (!SNOW_LAYER) SNOW_LAYER = document.createElement('canvas');
  const layer = SNOW_LAYER;
  const wb = worldBounds();
  const key = `${city.seed}|${level}|${variant}|${Math.round(wb.w)}x${Math.round(wb.h)}`;
  if (SNOW_LAYER_KEY !== key) {
    layer.width = Math.max(1, Math.round(wb.w));
    layer.height = Math.max(1, Math.round(wb.h));
    const sctx = layer.getContext('2d') as CanvasRenderingContext2D;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, layer.width, layer.height);
    sctx.setTransform(1, 0, 0, 1, -wb.minX, -wb.minY);
    paintSnowCover(sctx, city, variant, level);
    SNOW_LAYER_KEY = key;
  }
  // Cull the blit itself: off screen, the layer costs nothing.
  if (wb.minX > br.wx || wb.minY > br.wy || wb.maxX < tl.wx || wb.maxY < tl.wy) return 0;
  ctx.drawImage(layer, wb.minX, wb.minY);
  return 1;
}

function paintSnowCover(
  ctx: CanvasRenderingContext2D, city: City, variant: Variant, level: number,
): void {
  const d = city.district;
  const pale = gradeHex(PAL.stone4, variant);
  const blue = gradeHex(shadeHex(PAL.slate2, 0.5), variant);
  // Trodden ground takes about two thirds of what open ground takes.
  const open = level === 3 ? 13 : level === 2 ? 8 : 4;
  const trodden = level === 3 ? 9 : level === 2 ? 5 : 2;
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      if (!insideIsland(d, x, y)) continue;
      const k = cellKey(d, x, y);
      if (d.buildingId[k] >= 0) continue;
      const tile = d.tile[k];
      if (tile === Tile.Water) continue;
      const paved = tile === Tile.Street || tile === Tile.Alley || tile === Tile.Square
        || tile === Tile.Bridge || tile === Tile.Wharf || tile === Tile.Embankment;
      const amount = paved ? trodden : open;
      if (amount <= 0) continue;
      const cx = isoX(x, y);
      const cy = isoY(x, y);
      const diamond = [
        { x: cx, y: cy - TILE_H / 2 }, { x: cx + TILE_W / 2, y: cy },
        { x: cx, y: cy + TILE_H / 2 }, { x: cx - TILE_W / 2, y: cy },
      ];
      // A drift on the lee side of the cell rather than an even wash: the
      // second, bluer pass is offset up the diamond so the cover has a shaded
      // edge where it banks against whatever stands north of it.
      ditherPolyHard(ctx, diamond, pale, amount);
      if (level >= 2) {
        ditherPolyHard(ctx, [
          diamond[0], diamond[1],
          { x: cx + TILE_W / 4, y: cy - TILE_H / 4 }, { x: cx - TILE_W / 4, y: cy - TILE_H / 4 },
        ], blue, level === 3 ? 5 : 3);
      }
    }
  }
}

/**
 * How lit the district's gaslight is at a given minute, 0 to 1.
 *
 * Evening: the lamplighter works from 7pm and finishes by 9pm, so the level
 * ramps across those two hours. It holds full through the night and fades back
 * over the two hours after 5:30am as the lamps are put out. Each lamp then
 * lights when the level crosses ITS own threshold, so they come on one by one
 * rather than all together.
 */
function lampLevel(m: number): number {
  if (m >= 1140) return Math.min(1, (m - 1140) / 120);
  if (m < 330) return 1;
  if (m < 450) return 1 - (m - 330) / 120;
  return 0;
}

/**
 * Gaslight, lit one lamp at a time as evening falls, and flickering.
 *
 * Drawn per frame right after the ground and before the buildings, so a pool
 * still occludes correctly under a wall, but can now catch as the light fades
 * instead of the whole street flipping to lit at a variant boundary. Each lamp
 * has its own threshold and its own flicker, both hashed off the building id.
 */
export function drawLamps(
  ctx: CanvasRenderingContext2D, city: City, fracMin: number, variant: Variant,
  tl: { wx: number; wy: number }, br: { wx: number; wy: number },
): number {
  const level = lampLevel((minuteOfDay(city.tick) + fracMin) % 1440);
  if (level <= 0) return 0;
  const t = city.tick + fracMin;
  const flickFrame = Math.floor(t * 3);
  const gas0 = gradeHex(PAL.gas0, variant, true);
  const gas1 = gradeHex(PAL.gas1, variant, true);
  const gas2 = gradeHex(PAL.gas2, variant, true);
  let calls = 0;
  for (const b of city.buildings) {
    if (b.gasSeg < 0 || !serviceAt(city.networks.gas, b.id)) continue;
    // Not every door carries a street lamp: they stand at intervals, and some are
    // out of service, so the light is uneven rather than a bulb at every house.
    if ((mix(city.seed, 63, b.id) % 100) >= 58) continue;
    const threshold = (mix(city.seed, 61, b.id) % 1000) / 1000;
    if (level <= threshold) continue;
    const lx = isoX(b.doorX, b.doorY);
    const ly = isoY(b.doorX, b.doorY);
    if (lx < tl.wx - 24 || lx > br.wx + 24 || ly < tl.wy - 24 || ly > br.wy + 24) continue;
    // Just-caught lamps and the frequent gaslight flicker burn dim; a settled
    // lamp burns full. Dim drops the bright inner rings, so the pool gutters.
    const ramp = (level - threshold) / 0.1;
    const dim = ramp < 0.55 || (mix(city.seed, 62, b.id, flickFrame) % 7) === 0;
    const rings: Array<[number, number, string]> = dim
      ? [[1.8, 3, gas1], [1.0, 5, gas1]]
      : [[2.6, 2, gas0], [1.9, 3, gas1], [1.2, 5, gas1], [0.7, 8, gas2]];
    for (const [scale, density, colour] of rings) {
      ditherPolyHard(ctx, [
        { x: lx, y: ly - (TILE_H / 2) * scale }, { x: lx + (TILE_W / 2) * scale, y: ly },
        { x: lx, y: ly + (TILE_H / 2) * scale }, { x: lx - (TILE_W / 2) * scale, y: ly },
      ], colour, density);
    }
    calls++;
  }
  return calls;
}

/**
 * Birds over the roofs.
 *
 * A few small flocks wheel across the district in fair daylight: two-pixel
 * chevrons that beat and glide, drifting on the same wind as the smoke. They
 * ground themselves in rain, fog and darkness, so their absence is also a
 * weather read. Purely atmospheric, above the depth-sorted pass, never pickable.
 */
export function drawBirds(
  ctx: CanvasRenderingContext2D, city: City, fracMin: number, variant: Variant,
  tl: { wx: number; wy: number }, br: { wx: number; wy: number },
): number {
  if (isDarkVariant(variant)) return 0;
  const weather = weatherAt(city.seed, city.tick);
  if (weather.precipitation > 0 || weather.kind === 'fog') return 0;
  const t = city.tick + fracMin;
  const spanX = Math.max(1, br.wx - tl.wx);
  const spanY = Math.max(1, br.wy - tl.wy);
  const ink = gradeHex(PAL.soot1, variant);
  ctx.fillStyle = ink;
  let calls = 0;
  for (let fl = 0; fl < 3; fl++) {
    const h = mix(city.seed, 88, fl);
    // Each flock crosses at its own height and pace, leaning with the wind, and
    // wraps around the viewport so there is usually one somewhere in frame.
    const dir = weather.windX !== 0 ? weather.windX : (h & 1) ? 1 : -1;
    const speed = 2.2 + (h % 3) * 0.7;
    const cx = tl.wx - 40
      + ((((h % 997) + t * speed * dir) % (spanX + 80)) + spanX + 80) % (spanX + 80);
    const cy = tl.wy + spanY * (0.1 + ((h >>> 4) % 28) / 100) + Math.sin(t * 0.05 + fl * 2) * 5;
    const birds = 4 + ((h >>> 6) % 3);
    for (let i = 0; i < birds; i++) {
      const bh = mix(h, 89, i);
      const bx = Math.round(cx + ((bh % 25) - 12) * 1.6);
      const by = Math.round(cy + (((bh >>> 5) % 13) - 6));
      // The wing beat: the chevron closes to a bar and opens again, phased per
      // bird so the flock ripples rather than flapping in unison.
      const beat = (Math.floor(t * 6) + i) % 4 < 2;
      ctx.fillRect(bx, by, 1, 1);
      ctx.fillRect(bx - 1, by - (beat ? 0 : 1), 1, 1);
      ctx.fillRect(bx + 1, by - (beat ? 0 : 1), 1, 1);
      calls++;
    }
  }
  return calls;
}

/**
 * Warm light spilling from open doorways after dark.
 *
 * A street lamp is civic light; this is domestic trade light. Pubs and shops
 * with gas throw an amber fan across the pavement outside their door, smaller
 * and warmer than a lamp pool. Shops shut by nine and their fronts go dark;
 * pubs pour light into the small hours, which is when the district's night
 * geography becomes legible: the lit doors are where the trouble and the
 * comfort both are. Drawn with the lamps, between ground and buildings, so a
 * wall still occludes it.
 */
export function drawDoorGlow(
  ctx: CanvasRenderingContext2D, city: City, fracMin: number, variant: Variant,
  tl: { wx: number; wy: number }, br: { wx: number; wy: number },
): number {
  if (!isDarkVariant(variant)) return 0;
  const m = (minuteOfDay(city.tick) + fracMin) % 1440;
  const t = city.tick + fracMin;
  const flickFrame = Math.floor(t * 3);
  const warm = gradeHex(PAL.litWindow, variant, true);
  const amber = gradeHex(PAL.gas1, variant, true);
  let calls = 0;
  for (const b of city.buildings) {
    const isPub = b.kind === 'pub';
    if (!isPub && b.kind !== 'shop') continue;
    if (!serviceAt(city.networks.gas, b.id)) continue;
    // Opening hours: shops go dark at nine, pubs at half past one.
    const open = isPub ? (m >= 1050 || m < 90) : (m >= 1050 && m < 1260);
    if (!open) continue;
    const lx = isoX(b.doorX, b.doorY);
    const ly = isoY(b.doorX, b.doorY);
    if (lx < tl.wx - 16 || lx > br.wx + 16 || ly < tl.wy - 12 || ly > br.wy + 12) continue;
    // The fan gutters when the door swings, hashed per building and frame.
    const gutter = (mix(city.seed, 66, b.id, flickFrame) % 9) === 0;
    const w = isPub ? 7 : 5;
    const fan = [
      { x: lx, y: ly - 3 }, { x: lx + w, y: ly },
      { x: lx, y: ly + 3 }, { x: lx - w, y: ly },
    ];
    ditherPolyHard(ctx, fan, amber, gutter ? 3 : 6);
    if (!gutter) {
      ditherPolyHard(ctx, [
        { x: lx, y: ly - 2 }, { x: lx + w - 3, y: ly },
        { x: lx, y: ly + 2 }, { x: lx - w + 3, y: ly },
      ], warm, 8);
    }
    calls++;
  }
  return calls;
}

/**
 * Drifting street-level fog and haze.
 *
 * Not the baked river bank, which sits still on the water plane, but a moving
 * layer of low cloud that rolls through with the wind. Dense and low on a fog
 * watch, a thin veil on an overcast or stormy one. Ordered dither keeps it on
 * palette and keeps buildings legible through it: the pixels are scattered, so
 * it reads as translucent without ever using alpha.
 */
export function drawFog(
  ctx: CanvasRenderingContext2D, city: City, fracMin: number, variant: Variant,
  tl: { wx: number; wy: number }, br: { wx: number; wy: number },
): number {
  const weather = weatherAt(city.seed, city.tick);
  const heavy = weather.kind === 'fog';
  if (!heavy && weather.kind !== 'overcast' && weather.kind !== 'storm') return 0;
  const t = city.tick + fracMin;
  const pale = gradeHex(PAL.smoke2, variant);
  const dim = gradeHex(PAL.smoke1, variant);
  const dir = weather.windX || 1;
  // Banks live in WORLD space and wrap across the district's own extent, so
  // panning the camera moves past the fog instead of dragging it along. The
  // viewport only culls. The count scales with the district so the streets
  // hold the same density the old per-viewport spread had.
  const wb = worldBounds();
  const spanX = wb.w + 120;
  const banks = Math.max(heavy ? 16 : 6, Math.round(spanX / (heavy ? 40 : 107)));
  let calls = 0;
  for (let i = 0; i < banks; i++) {
    // Each bank drifts across and wraps, at its own height and speed. Lower banks
    // (nearer the foreground) are denser, which is what makes it read as fog
    // lying in the streets rather than a flat grey wash over the sky.
    const speed = 4 + (i % 3) * 2;
    const cx = wb.minX - 60 + (((i * 211 + t * speed * dir) % spanX) + spanX) % spanX;
    const low = 0.42 + ((i * 37) % 100) / 170;
    const cy = wb.minY + wb.h * low + Math.sin((t * 0.03 + i) * 1) * 4;
    if (cx < tl.wx - 60 || cx > br.wx + 60 || cy < tl.wy - 20 || cy > br.wy + 20) continue;
    // Fog lies in the streets. A bank whose centre has drifted off the island
    // would hang in the void as a grey smear, so it is skipped until it wraps.
    const fogTx = Math.round(cx / TILE_W + cy / TILE_H);
    const fogTy = Math.round(cy / TILE_H - cx / TILE_W);
    if (!insideIsland(city.district, fogTx, fogTy)) continue;
    const w = heavy ? 34 + (i % 4) * 8 : 26;
    const h = heavy ? 9 : 6;
    const bank = [
      { x: cx - w, y: cy }, { x: cx - w * 0.5, y: cy - h },
      { x: cx + w * 0.6, y: cy - h + 1 }, { x: cx + w, y: cy + 1 },
      { x: cx + w * 0.4, y: cy + h * 0.7 }, { x: cx - w * 0.6, y: cy + h * 0.8 },
    ];
    const near = low > 0.62;
    ditherPolyHard(ctx, bank, pale, heavy ? (near ? 8 : 5) : 3);
    ditherPolyHard(ctx, bank, dim, heavy ? (near ? 4 : 2) : 1);
    calls += 2;
  }
  return calls;
}

/**
 * Flood water on the ground: a slow shimmer of glints that drift across the
 * flooded footprints, so standing water reads as water rather than a blue stain.
 * Runs while the event is active, which is when the water is actually moving.
 */
/**
 * The river, moving.
 *
 * The channel was a static slab with a few baked speckles: water that never
 * goes anywhere reads as painted glass. This drifts glints and streaks
 * downstream at a rate the wind sets, and after dark hangs broken reflections
 * of the quay lamps off the bank. Everything is a pure function of
 * (seed, tick, frame fraction), and everything sits on the sunken surface the
 * river actually has rather than the old zero plane.
 */
export function drawRiverFx(
  ctx: CanvasRenderingContext2D, city: City, fracMin: number, variant: Variant,
  tl: { wx: number; wy: number }, br: { wx: number; wy: number },
): number {
  const d = city.district;
  const riv = city.river;
  const level = riverLevelAt(city.seed, city.tick);
  if (level === 0) return 0;
  const drop = riverDropAt(city.seed, city.tick);
  const weather = weatherAt(city.seed, city.tick);
  const t = city.tick + fracMin;
  // A storm hurries the surface along and breaks it up; a fair dawn barely
  // moves it. The current always runs the same way, toward the outfall.
  const rough = weather.kind === 'storm' ? 2 : weather.precipitation > 0 ? 1 : 0;
  const speed = 0.05 + rough * 0.06;
  const perColumn = 2 + rough;
  const glint = gradeHex(PAL.rivGlint, variant);
  const streak = gradeHex(PAL.riv2, variant);
  const dark = gradeHex(shadeHex(PAL.riv1, -0.2), variant);
  let calls = 0;
  for (let x = 0; x < d.width; x++) {
    const cy = riv.centre[x];
    if (cy < 0) continue;
    const hw = riv.halfWidth[x];
    // Cheap column cull before any per-glint work.
    if (isoX(x, cy) < tl.wx - TILE_W * 2 || isoX(x, cy) > br.wx + TILE_W * 2) continue;
    for (let i = 0; i < perColumn; i++) {
      const h = mix(city.seed, Stream.Weather, x, i);
      // Each glint slides one cell downstream and hands off to the next
      // column, so the surface reads as continuous flow rather than a row of
      // blinking dots.
      const drift = ((t * speed + ((h % 128) / 128)) % 1 + 1) % 1;
      const fx = x + drift;
      const off = ((h >>> 9) % (hw * 2 + 1)) - hw;
      const fy = cy + off;
      if (!insideIsland(d, Math.round(fx), fy)) continue;
      if (d.tile[cellKey(d, Math.round(fx), fy)] !== Tile.Water) continue;
      const wx = Math.round(isoX(fx, fy));
      const wy = Math.round(isoY(fx, fy)) + drop;
      if (wx < tl.wx || wx > br.wx || wy < tl.wy || wy > br.wy) continue;
      // A short streak with a bright head: the shape a ripple makes when the
      // light is low and behind it.
      ctx.fillStyle = (h >>> 3) % 5 === 0 ? glint : streak;
      ctx.fillRect(wx, wy, 2, 1);
      if (rough > 0 && (h >>> 5) % 3 === 0) {
        ctx.fillStyle = dark;
        ctx.fillRect(wx - 2, wy + 1, 2, 1);
      }
      calls++;
    }
  }
  // Reflections. Hung off the lamps that are actually burning rather than
  // sprinkled along the bank, so a light on the water always has a light above
  // it, and only where open channel lies in front of the lamp.
  if (isDarkVariant(variant) && lampLevel((minuteOfDay(city.tick) + fracMin) % 1440) > 0) {
    const lampGlow = gradeHex(PAL.gas1, variant, true);
    const deep = gradeHex(PAL.brass2, variant, true);
    for (const b of city.buildings) {
      if (b.gasSeg < 0 || !serviceAt(city.networks.gas, b.id)) continue;
      if ((mix(city.seed, 63, b.id) % 100) >= 58) continue;
      // Find open water out from the door, on whichever side the channel lies:
      // the polite bank looks south at it and the working bank looks north.
      let wy0 = -1;
      for (let step = 1; step <= 3 && wy0 < 0; step++) {
        for (const dir of [1, -1]) {
          const ny = b.doorY + step * dir;
          if (ny < 0 || ny >= d.height) continue;
          if (d.tile[cellKey(d, b.doorX, ny)] === Tile.Water) { wy0 = ny; break; }
        }
      }
      if (wy0 < 0) continue;
      const wx = Math.round(isoX(b.doorX, wy0));
      const wy = Math.round(isoY(b.doorX, wy0)) + drop;
      if (wx < tl.wx || wx > br.wx || wy < tl.wy - 8 || wy > br.wy) continue;
      const h = mix(city.seed, 64, b.id);
      const wob = Math.round(Math.sin(t * 0.4 + b.id) * 1.4);
      const len = 4 + (h % 3);
      for (let k = 0; k < len; k++) {
        // A reflection on moving water is never a solid line.
        if ((mix(h, k, Math.floor(t * 2)) & 3) === 0) continue;
        ctx.fillStyle = k < 2 ? lampGlow : deep;
        ctx.fillRect(wx + (k > 1 ? wob : 0), wy + k * 2, 1, 1);
      }
      calls++;
    }
  }
  return calls;
}

export function drawFloodFx(
  ctx: CanvasRenderingContext2D, city: City, fracMin: number, variant: Variant,
  tl: { wx: number; wy: number }, br: { wx: number; wy: number },
): number {
  let calls = 0;
  const t = city.tick + fracMin;
  const glint = gradeHex(PAL.rivGlint, variant);
  const dark = gradeHex(PAL.riv2, variant);
  for (const event of city.disasters.events) {
    if (event.kind !== 'flood' || !isDisasterActive(city, event)) continue;
    for (const id of event.affectedBuildingIds) {
      const b = city.buildings[id];
      if (!b) continue;
      const cx = isoX(b.doorX, b.doorY);
      const cy = isoY(b.doorX, b.doorY) + 2;
      if (cx < tl.wx - 20 || cx > br.wx + 20 || cy < tl.wy - 20 || cy > br.wy + 20) continue;
      for (let i = 0; i < 3; i++) {
        const ph = (t * 0.06 + i * 0.37 + (id % 7) * 0.11) % 1;
        const gx = Math.round(cx - 7 + ph * 14);
        const gy = Math.round(cy - 3 + ((i + id) % 3) * 3 + Math.sin((t * 0.05 + i)) * 1);
        ctx.fillStyle = i === 1 ? glint : dark;
        ctx.fillRect(gx, gy, 2, 1);
        calls++;
      }
    }
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
