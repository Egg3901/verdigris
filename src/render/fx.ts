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
  // puffs over dark blue roofs: present, invisible, and I only found out by
  // counting pixels. Smoke reads against a sky, not in a colour scheme.
  const shades = variant === 'day'
    ? [PAL.smoke2, PAL.smoke1, PAL.smoke0]
    : ['#7b8291', '#5d6472', '#454b57'];

  for (const b of city.buildings) {
    const industrial = b.kind === 'mill' || b.kind === 'foundry' || b.kind === 'gasworks';
    if (!industrial) {
      // Domestic chimneys smoke in the cold hours, and only if there is gas or
      // coal to burn: a household with the main cut has a cold grate, and the
      // prose already says so.
      const m = minuteOfDay(city.tick);
      if (m > 540 && m < 1020) continue;
      if (b.id % 3 !== 0) continue;
      if (!serviceAt(city.networks.gas, b.id)) continue;
    } else if (b.firmId >= 0 && !isRunning(city.firms[b.firmId], city.tick)) {
      // A struck or shut mill does not smoke. This is the clearest visual signal
      // in the game that an intervention landed.
      continue;
    }

    const wx = isoX(b.ox + b.w - 1, b.oy + b.d - 1);
    const wy = isoY(b.ox + b.w - 1, b.oy + b.d - 1);
    if (wx < tl.wx - 40 || wx > br.wx + 40 || wy < tl.wy - 80 || wy > br.wy + 40) continue;

    const puffs = industrial ? 7 : 3;
    const rise = industrial ? 4.5 : 2.6;
    const top = wy - (b.storeys * 8 + 2) - (industrial ? 26 : 14);
    for (let i = 0; i < puffs; i++) {
      // Age cycles, so puffs are continually born at the stack and die above it.
      const age = ((t * 0.06 + i / puffs) % 1);
      const h = age * rise * 14;
      const drift = ((mix(city.seed, 81, b.id, i) >>> 0) % 9) - 4;
      const px = Math.round(wx + drift * age * 2.2);
      const py = Math.round(top - h);
      const r = Math.max(1, Math.round((1 - age) * (industrial ? 4 : 2.5)) + 1);
      const shade = shades[Math.min(2, Math.floor(age * 3))];
      fillPolyHard(ctx, [
        { x: px, y: py - r }, { x: px + r, y: py },
        { x: px, y: py + r }, { x: px - r, y: py },
      ], shade);
      calls++;
    }
  }
  void TILE_W;
  void TILE_H;
  void variantFor;
  return calls;
}
