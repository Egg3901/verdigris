// The frame orchestrator, and the draw-call budget.
//
// Layer order on the single world canvas:
//   a. ground bitmap        1 blit
//   b. main pass            statics and agents merged in depth order, culled
//   c. lamps                additive glow, budgeted
//   d. selection reticle
//
// The whole point of the flatten-per-building compositor is that b is one
// drawImage per visible object from a small number of source canvases, so the
// browser batches it. If this ever needs WebGL, the Renderer interface is where
// it slots in, but at two hundred buildings on Canvas2D it does not.
import type { City } from '../sim/city';
import { isLampHour } from '../sim/clock';
import { serviceAt } from '../sim/networks';
import { PAL } from './palette';
import type { Camera } from './iso';
import { TILE_W, TILE_H, clampDpr, screenToWorld } from './iso';
import type { Scene } from './scene';
import { collectAgents } from './agents';
import type { AgentDraw } from './agents';
import { drawSoul } from './fallback';

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
const LAMP_BUDGET = 72;

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
      drawSoul(ctx, a.wx, a.wy, a.coat, a.hat, a.step);
      stats.calls++;
      if (a.soulId === sel.soulId) {
        ctx.strokeStyle = PAL.gas2;
        ctx.strokeRect(Math.round(a.wx) - 4.5, Math.round(a.wy) - 14.5, 9, 15);
        stats.calls++;
      }
    }
  }

  if (isLampHour(city.tick)) stats.calls += drawLamps(ctx, city, tl, br);

  if (import.meta.env.DEV && stats.calls > CALL_BUDGET) {
    console.warn(`draw-call budget breached: ${stats.calls} > ${CALL_BUDGET}`);
  }
  return stats;
}

/**
 * Lamp glow, additive.
 *
 * Deliberately hard-edged concentric rings rather than createRadialGradient.
 * Smooth bloom over pixel art is the single most common tell of an indie iso game
 * with modern lighting bolted on, and the baked atlas will replace these rings
 * with dithered glow sprites made of the same chunky pixels as everything else.
 */
function drawLamps(
  ctx: CanvasRenderingContext2D, city: City,
  tl: { wx: number; wy: number }, br: { wx: number; wy: number },
): number {
  const prev = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'lighter';
  let drawn = 0;
  for (const b of city.buildings) {
    if (drawn >= LAMP_BUDGET) break;
    if (!b.gasSeg || b.gasSeg < 0) continue;
    if (!serviceAt(city.networks.gas, b.id)) continue;
    if (b.doorNode < 0) continue;
    const wx = (b.doorX - b.doorY) * (TILE_W / 2);
    const wy = (b.doorX + b.doorY) * (TILE_H / 2);
    if (wx < tl.wx || wx > br.wx || wy < tl.wy || wy > br.wy) continue;
    // Flicker is a three-state swap on an integer hash, not a sine on alpha.
    // Gas mantles flutter, and the chunkiness is period-correct.
    const flick = (b.id * 2654435761 + Math.floor(city.tick / 3)) % 3;
    ctx.fillStyle = flick === 0 ? PAL.gas0 : PAL.gas1;
    ctx.globalAlpha = flick === 2 ? 0.1 : 0.16;
    ctx.fillRect(Math.round(wx) - 7, Math.round(wy) - 5, 14, 9);
    ctx.fillRect(Math.round(wx) - 4, Math.round(wy) - 8, 8, 15);
    drawn += 2;
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = prev;
  return drawn;
}
