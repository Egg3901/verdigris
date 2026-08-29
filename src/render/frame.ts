// The frame orchestrator, and the draw-call budget.
//
// Layer order on the single world canvas:
//   a. ground bitmap        1 blit, with the lamp pools already baked into it
//   b. main pass            statics, props and agents merged in depth order
//   c. selection reticle
//
// The whole point of the flatten-per-building compositor is that b is one
// drawImage per visible object from a small number of source canvases, so the
// browser batches it. If this ever needs WebGL, the Renderer interface is where
// it slots in, but at a few hundred buildings on Canvas2D it does not.
import type { City } from '../sim/city';
import { PAL, gradeHex } from './palette';
import type { Camera } from './iso';
import { TILE_W, TILE_H, clampDpr, screenToWorld } from './iso';
import { isoX, isoY } from './iso';
import type { Scene } from './scene';
import { collectAgents } from './agents';
import type { AgentDraw } from './agents';
import { drawSoul } from './fallback';
import { collectHazards, collectVehicles, drawHazard, drawSmoke, drawVehicle, drawWeatherFx, drawFog, drawFloodFx, drawRiverFx, drawLamps, drawBirds, drawDoorGlow, drawSnowCover } from './fx';
import type { HazardDraw, VehicleDraw } from './fx';
import { variantFor } from './palette';
import { minuteOfDay } from '../sim/clock';
import { lineHard, fillPolyHard, ditherPolyHard } from './raster';
import { houseCorners } from './house';
import { soulPos } from '../sim/souls';
import { weatherAt } from '../sim/weather';
import { mix, Stream } from '../sim/rng';

export interface Selection {
  buildingId: number;
  soulId: number;
}

export interface FrameStats {
  calls: number;
  agents: number;
  statics: number;
}

const CALL_BUDGET = 1200;

const agentPool: AgentDraw[] = [];
const vehiclePool: VehicleDraw[] = [];
const hazardPool: HazardDraw[] = [];

export function drawFrame(
  ctx: CanvasRenderingContext2D, city: City, scene: Scene, cam: Camera,
  viewW: number, viewH: number, fracMin: number, sel: Selection,
): FrameStats {
  const dpr = clampDpr(window.devicePixelRatio || 1);
  const k = cam.zoom * dpr;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = PAL.void;
  ctx.fillRect(0, 0, viewW * dpr, viewH * dpr);
  ctx.setTransform(k, 0, 0, k, Math.round(cam.ox * dpr), Math.round(cam.oy * dpr));

  const stats: FrameStats = { calls: 0, agents: 0, statics: 0 };

  // Viewport in world coordinates, with a margin for tall sprites hanging above.
  const tl = screenToWorld(cam, -TILE_W * 2, -240);
  const br = screenToWorld(cam, viewW + TILE_W * 2, viewH + TILE_H * 4);

  ctx.drawImage(scene.ground, -scene.originX, -scene.originY);
  stats.calls++;

  // Lying snow goes straight onto the ground bitmap, before the water, the
  // lamps and the walls: it is a covering on the street, so the lamp pool
  // lights it and the building in front of it hides it.
  stats.calls += drawSnowCover(ctx, city, scene.variant, tl, br);

  // Gaslight pools go down between the ground and the buildings, so they light
  // the street and still fall behind the walls that stand in front of them. Drawn
  // per frame, they catch one at a time as evening comes on and flicker.
  // The river moves under everything that stands beside it.
  stats.calls += drawRiverFx(ctx, city, fracMin, scene.variant, tl, br);
  stats.calls += drawLamps(ctx, city, fracMin, scene.variant, tl, br);
  // Doorway light goes down with the lamp pools, for the same occlusion reason:
  // it lies on the pavement, and the buildings drawn after it stand over it.
  stats.calls += drawDoorGlow(ctx, city, fracMin, scene.variant, tl, br);

  const agentCount = collectAgents(city, fracMin, agentPool);
  const vehicleCount = collectVehicles(city, scene.cartRoutes, fracMin, tl, br, vehiclePool);
  const hazardCount = collectHazards(city, fracMin, tl, br, hazardPool);
  const weather = weatherAt(city.seed, city.tick);
  stats.agents = agentCount;

  // Merge-walk static and dynamic world objects. Vehicles share actor depth, so
  // a carriage on a far street is hidden by a nearer facade instead of floating
  // across it. Smoke is deliberately outside this pass because it rises above
  // the roofs that emitted it.
  let ai = 0;
  let si = 0;
  let pi = 0;
  let vi = 0;
  let hi = 0;
  const statics = scene.statics;
  const props = scene.props;

  // Per-frame window lighting. Panes are baked dark; here each one is lit on its
  // own schedule, so rooms come on through the evening and go dark as the night
  // wears on, individually, rather than the whole town switching at once.
  const nm = nightWindowMinute((minuteOfDay(city.tick) + fracMin) % 1440);
  const litWindows = nm >= 0;
  const flickFrame = Math.floor((city.tick + fracMin) * 3);
  const warmA = gradeHex(PAL.litWindow, scene.variant, true);
  const warmB = gradeHex(PAL.litWindow2, scene.variant, true);
  const spill = gradeHex(PAL.gas1, scene.variant, true);

  while (si < statics.length || ai < agentCount || pi < props.length || vi < vehicleCount || hi < hazardCount) {
    const sDepth = si < statics.length ? statics[si].depth : Infinity;
    const pDepth = pi < props.length ? props[pi].depth : Infinity;
    const aDepth = ai < agentCount ? agentPool[ai].depth : Infinity;
    const vDepth = vi < vehicleCount ? vehiclePool[vi].depth : Infinity;
    const hDepth = hi < hazardCount ? hazardPool[hi].depth : Infinity;
    if (pDepth <= sDepth && pDepth <= aDepth && pDepth <= vDepth && pDepth <= hDepth) {
      const p = props[pi++];
      const px = p.wx - p.ax;
      const py = p.wy - p.ay;
      if (px > br.wx || py > br.wy || px + p.sprite.width < tl.wx || py + p.sprite.height < tl.wy) continue;
      ctx.drawImage(p.sprite, Math.round(px), Math.round(py));
      stats.calls++;
      continue;
    }
    const useStatic = sDepth <= aDepth && sDepth <= vDepth && sDepth <= hDepth;
    if (useStatic) {
      const s = statics[si++];
      const x = s.wx - s.ax;
      const y = s.wy - s.ay;
      if (x > br.wx || y > br.wy || x + s.sprite.width < tl.wx || y + s.sprite.height < tl.wy) continue;
      ctx.drawImage(s.sprite, Math.round(x), Math.round(y));
      stats.calls++;
      stats.statics++;
      // Light this building's windows, drawn immediately after its sprite so they
      // sit at the right depth and are occluded by whatever stands in front.
      if (litWindows && s.windows.length) {
        const bx = Math.round(x);
        const by = Math.round(y);
        for (const w of s.windows) {
          const glow = windowGlow(w.hash, nm, flickFrame);
          if (glow === 0) continue;
          const a0 = { x: bx + w.ax, y: by + w.ay };
          const b0 = { x: bx + w.bx, y: by + w.by };
          fillPolyHard(ctx, [a0, b0, { x: b0.x, y: b0.y + 4 }, { x: a0.x, y: a0.y + 4 }],
            (w.hash % 6 === 0) ? warmB : warmA);
          if (glow === 1) {
            // The spill follows the pane's own slope and stays shallow. A deep
            // axis-aligned skirt under a sloped pane reads as a crooked window.
            ditherPolyHard(ctx, [
              { x: a0.x + 1, y: a0.y + 4 }, { x: b0.x - 1, y: b0.y + 4 },
              { x: b0.x - 1, y: b0.y + 6 }, { x: a0.x + 1, y: a0.y + 6 },
            ], spill, 4);
            // The bright sash catch sits inside the glass, mid-pane, never on the
            // frame: on a face sloping the other way the old corner pixel landed
            // outside the window entirely.
            ctx.fillStyle = warmB;
            ctx.fillRect(Math.round((a0.x + b0.x) / 2), Math.round((a0.y + b0.y) / 2) + 1, 1, 1);
          }
          stats.calls++;
        }
      }
    } else if (vDepth <= aDepth && vDepth <= hDepth) {
      stats.calls += drawVehicle(ctx, vehiclePool[vi++], scene.variant);
    } else if (aDepth <= hDepth) {
      const a = agentPool[ai++];
      if (a.wx > br.wx || a.wy > br.wy || a.wx < tl.wx || a.wy < tl.wy) continue;
      const umbrella = weather.precipitation > 0
        && mix(city.seed, Stream.Weather, weather.watch, a.soulId) % 100 < 78;
      drawSoul(ctx, a.wx, a.wy, a.coat, a.hat, a.step, a.soulId, scene.variant, umbrella, a.vendor);
      stats.calls++;
    } else {
      stats.calls += drawHazard(ctx, hazardPool[hi++], scene.variant);
    }
  }

  // Smoke is atmospheric: it rises above its source and therefore belongs above
  // the depth-sorted street pass.
  const variant = variantFor(minuteOfDay(city.tick), weatherAt(city.seed, city.tick).kind);
  // Water on the ground first, then the fog that lies over it, then the smoke
  // that climbs through the fog, then the rain in front of all of it.
  stats.calls += drawFloodFx(ctx, city, fracMin, variant, tl, br);
  stats.calls += drawFog(ctx, city, fracMin, variant, tl, br);
  stats.calls += drawSmoke(ctx, city, fracMin, variant, tl, br);
  stats.calls += drawBirds(ctx, city, fracMin, variant, tl, br);
  stats.calls += drawWeatherFx(ctx, city, fracMin, variant, tl, br);

  // Selection belongs to the ground plane, not to a sprite's rectangular canvas
  // bounds. Four iso corner brackets read as an instrument sight and never expose
  // the invisible padding around a flattened building.
  const reticle = gradeHex(PAL.gas2, scene.variant, true);
  if (sel.buildingId >= 0 && city.buildings[sel.buildingId]) {
    const b = city.buildings[sel.buildingId];
    const sx = b.ox + b.w - 1;
    const sy = b.oy + b.d - 1;
    const c = houseCorners(isoX(sx, sy), isoY(sx, sy), b.w, b.d, 0);
    const edges = [[c.W, c.N], [c.N, c.E], [c.E, c.S], [c.S, c.W]] as const;
    for (const [a, z] of edges) {
      lineHard(ctx, a, { x: a.x + (z.x - a.x) * 0.22, y: a.y + (z.y - a.y) * 0.22 }, reticle);
      lineHard(ctx, z, { x: z.x + (a.x - z.x) * 0.22, y: z.y + (a.y - z.y) * 0.22 }, reticle);
    }
    stats.calls += 8;
  } else if (sel.soulId >= 0 && city.souls[sel.soulId]) {
    const p = soulPos(city.graph, city.souls[sel.soulId], fracMin);
    const x = isoX(p.cx, p.cy);
    const y = isoY(p.cx, p.cy);
    lineHard(ctx, { x: x - 5, y }, { x, y: y - 3 }, reticle);
    lineHard(ctx, { x, y: y - 3 }, { x: x + 5, y }, reticle);
    lineHard(ctx, { x: x + 5, y }, { x, y: y + 3 }, reticle);
    lineHard(ctx, { x, y: y + 3 }, { x: x - 5, y }, reticle);
    stats.calls += 4;
  }

  if (import.meta.env.DEV && stats.calls > CALL_BUDGET) {
    console.warn(`draw-call budget breached: ${stats.calls} > ${CALL_BUDGET}`);
  }
  return stats;
}

/**
 * Minutes into the night, or -1 by day. The night runs from 6pm (0) round to
 * 6:30am (750), so a window schedule can be expressed as one rising number
 * without wrapping at midnight.
 */
function nightWindowMinute(m: number): number {
  if (m >= 1140) return m - 1140;
  if (m < 450) return m + 300;
  return -1;
}

/**
 * Whether a window is lit, and how: 0 dark, 1 lit, 2 lit but guttering. Each
 * pane lights at its own hour and goes dark at its own, a few wake in the small
 * hours, and all of them flicker like the lamp or candle behind them. Purely a
 * function of the pane hash and the clock, so it is stable frame to frame and
 * the same on every machine.
 */
function windowGlow(hash: number, nm: number, flickFrame: number): 0 | 1 | 2 {
  const onset = hash % 240;                 // lit up between 6 and 10pm
  const sleep = onset + 90 + ((hash >>> 8) % 450); // dark 1.5 to 9 hours later
  let lit = nm >= onset && nm < sleep;
  let edge = Math.min(Math.abs(nm - onset), Math.abs(nm - sleep));
  if (!lit && (hash & 7) === 0) {
    // A few rooms wake briefly in the small hours.
    const wake = 600 + ((hash >>> 5) % 120);
    const until = wake + 25 + ((hash >>> 3) % 45);
    if (nm >= wake && nm < until) { lit = true; edge = Math.min(Math.abs(nm - wake), Math.abs(nm - until)); }
  }
  if (!lit) return 0;
  const flick = mix(hash, flickFrame) % 100;
  // Through the switching minute the pane blinks as the light is lit or put out.
  if (edge < 3 && flick < 50) return 0;
  // A steady gaslight gutter, and the spill drops out with it.
  if (flick < 7) return 2;
  return 1;
}
