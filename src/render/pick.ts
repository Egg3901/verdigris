// Picking: agent, then ID buffer, then analytic tile.
//
// Analytic inverse-iso alone is wrong the moment the cursor is over a raised part
// of a building. It returns the ground cell, so clicking a chimney or a mansard
// roof selects the street behind it, and with one to four storey buildings that
// happens constantly. The ID buffer is exact through overhangs and archways and
// costs one getImageData.
//
// Agents win inside a six-pixel slop radius. A player who clicks a person means
// the person, and that slop is also what makes an eleven-pixel soul tappable on
// touch.
import type { City } from '../sim/city';
import { cellKey, inBounds } from '../sim/district';
import type { Camera } from './iso';
import { screenToWorld, worldToCell } from './iso';
import type { Scene } from './scene';
import { collectAgents } from './agents';
import type { AgentDraw } from './agents';

export interface PickResult {
  kind: 'soul' | 'building' | 'cell' | 'none';
  id: number;
  cellX: number;
  cellY: number;
}

const SLOP_X = 6;
const SLOP_TOP = 16;
const SLOP_BOTTOM = 4;

const pool: AgentDraw[] = [];

export function pickAt(
  city: City, scene: Scene, cam: Camera, fracMin: number, sx: number, sy: number,
): PickResult {
  const { wx, wy } = screenToWorld(cam, sx, sy);

  // 1. Agents, front to back. They move, so they are not in the ID buffer.
  const n = collectAgents(city, fracMin, pool);
  for (let i = n - 1; i >= 0; i--) {
    const a = pool[i];
    if (Math.abs(a.wx - wx) > SLOP_X) continue;
    if (wy > a.wy + SLOP_BOTTOM || wy < a.wy - SLOP_TOP) continue;
    return { kind: 'soul', id: a.soulId, cellX: Math.round(a.tx), cellY: Math.round(a.ty) };
  }

  // 2. The ID buffer, pixel-exact.
  const bx = Math.round(wx + scene.originX);
  const by = Math.round(wy + scene.originY);
  if (bx >= 0 && by >= 0 && bx < scene.idBuffer.width && by < scene.idBuffer.height) {
    const px = scene.idCtx.getImageData(bx, by, 1, 1).data;
    if (px[3] > 0 && px[2] === 1) {
      const id = px[0] | (px[1] << 8);
      if (id >= 0 && id < city.buildings.length) {
        const b = city.buildings[id];
        return { kind: 'building', id, cellX: b.ox, cellY: b.oy };
      }
    }
  }

  // 3. The ground cell, which is what a click on a street or a lamp needs.
  const { tx, ty } = worldToCell(wx, wy);
  if (!inBounds(city.district, tx, ty)) return { kind: 'none', id: -1, cellX: -1, cellY: -1 };
  const k = cellKey(city.district, tx, ty);
  const bid = city.district.buildingId[k];
  if (bid >= 0) return { kind: 'building', id: bid, cellX: tx, cellY: ty };
  return { kind: 'cell', id: k, cellX: tx, cellY: ty };
}
