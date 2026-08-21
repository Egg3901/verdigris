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
import { drawTrams, drawSmoke, drawCarts } from './fx';
import { variantFor } from './palette';
import { minuteOfDay } from '../sim/clock';
import { lineHard } from './raster';
import { houseCorners } from './house';
import { soulPos } from '../sim/souls';

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

  const agentCount = collectAgents(city, fracMin, agentPool);
  stats.agents = agentCount;

  // Merge-walk three pre-sorted lists: statics, props and the freshly sorted
  // agents. All three share one depth key, so a soul walks behind a tree on the
  // far side of the street and in front of one on the near side, for free.
  let ai = 0;
  let si = 0;
  let pi = 0;
  const statics = scene.statics;
  const props = scene.props;
  while (si < statics.length || ai < agentCount || pi < props.length) {
    const sDepth = si < statics.length ? statics[si].depth : Infinity;
    const pDepth = pi < props.length ? props[pi].depth : Infinity;
    const aDepth = ai < agentCount ? agentPool[ai].depth : Infinity;
    if (pDepth <= sDepth && pDepth <= aDepth) {
      const p = props[pi++];
      const px = p.wx - p.ax;
      const py = p.wy - p.ay;
      if (px > br.wx || py > br.wy || px + p.sprite.width < tl.wx || py + p.sprite.height < tl.wy) continue;
      ctx.drawImage(p.sprite, Math.round(px), Math.round(py));
      stats.calls++;
      continue;
    }
    const useStatic = sDepth <= aDepth;
    if (useStatic) {
      const s = statics[si++];
      const x = s.wx - s.ax;
      const y = s.wy - s.ay;
      if (x > br.wx || y > br.wy || x + s.sprite.width < tl.wx || y + s.sprite.height < tl.wy) continue;
      ctx.drawImage(s.sprite, Math.round(x), Math.round(y));
      stats.calls++;
      stats.statics++;
    } else {
      const a = agentPool[ai++];
      if (a.wx > br.wx || a.wy > br.wy || a.wx < tl.wx || a.wy < tl.wy) continue;
      drawSoul(ctx, a.wx, a.wy, a.coat, a.hat, a.step, a.soulId, scene.variant);
      stats.calls++;
    }
  }

  // Vehicles and smoke, above the structures: smoke is over the roofline by
  // definition, and the tram runs down the middle of the street.
  const variant = variantFor(minuteOfDay(city.tick));
  stats.calls += drawTrams(ctx, city, variant);
  stats.calls += drawCarts(ctx, city, scene.cartRoutes, fracMin, variant, tl, br);
  stats.calls += drawSmoke(ctx, city, fracMin, variant, tl, br);

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
