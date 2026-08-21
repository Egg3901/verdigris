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
// it slots in, but at two hundred buildings on Canvas2D it does not.
import type { City } from '../sim/city';
import { PAL } from './palette';
import type { Camera } from './iso';
import { TILE_W, TILE_H, clampDpr, screenToWorld } from './iso';
import type { Scene } from './scene';
import { collectAgents } from './agents';
import type { AgentDraw } from './agents';
import { drawSoul } from './fallback';
import { drawTrams, drawSmoke, drawCarts } from './fx';
import { variantFor } from './palette';
import { minuteOfDay } from '../sim/clock';

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
      if (s.buildingId === sel.buildingId) {
        ctx.strokeStyle = PAL.gas2;
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(x) - 0.5, Math.round(y) - 0.5, s.sprite.width + 1, s.sprite.height + 1);
        stats.calls++;
      }
    } else {
      const a = agentPool[ai++];
      if (a.wx > br.wx || a.wy > br.wy || a.wx < tl.wx || a.wy < tl.wy) continue;
      drawSoul(ctx, a.wx, a.wy, a.coat, a.hat, a.step, a.soulId);
      stats.calls++;
      if (a.soulId === sel.soulId) {
        ctx.strokeStyle = PAL.gas2;
        ctx.strokeRect(Math.round(a.wx) - 4.5, Math.round(a.wy) - 16.5, 9, 17);
        stats.calls++;
      }
    }
  }

  // Vehicles and smoke, above the structures: smoke is over the roofline by
  // definition, and the tram runs down the middle of the street.
  const variant = variantFor(minuteOfDay(city.tick));
  stats.calls += drawTrams(ctx, city, variant);
  stats.calls += drawCarts(ctx, city, scene.cartRoutes, fracMin, variant, tl, br);
  stats.calls += drawSmoke(ctx, city, fracMin, variant, tl, br);

  if (import.meta.env.DEV && stats.calls > CALL_BUDGET) {
    console.warn(`draw-call budget breached: ${stats.calls} > ${CALL_BUDGET}`);
  }
  return stats;
}
