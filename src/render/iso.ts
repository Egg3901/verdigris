// Isometric constants and the camera.
//
// THE INTEGER TRANSFORM CONTRACT, which nothing may violate:
//   dprInt = clamp(round(devicePixelRatio), 1, 2)
//   zoom is 1, 2 or 3, never fractional
//   setTransform(zoom*dprInt, 0, 0, zoom*dprInt, round(ox*dprInt), round(oy*dprInt))
//   imageSmoothingEnabled = false
// Every atlas pixel then lands on an exact N by N block of device pixels. A
// tweened fractional zoom would blur the whole city, which is why the zoom
// control is a discrete stepper and not a slider.
import { GRID_W, GRID_H } from '../sim/types';

export const TILE_W = 32;
export const TILE_H = 16;

/** Headroom above the grid for the mooring mast and the campanile. */
export const HEAD_ROOM = 160;
export const FOOT_ROOM = 48;

export type ZoomStep = 1 | 2 | 3;
export const ZOOM_STEPS: readonly ZoomStep[] = [1, 2, 3];

export interface Camera {
  /** CSS-px offset of the world origin. Floats for smooth panning; rounded to
   *  integers in DEVICE px at draw time only, so a slow follow steps by one pixel.
   *  That step is correct for pixel art and reads as deliberate. Do not smooth it. */
  ox: number;
  oy: number;
  zoom: ZoomStep;
}

export function isoX(tx: number, ty: number): number {
  return (tx - ty) * (TILE_W / 2);
}

export function isoY(tx: number, ty: number): number {
  return (tx + ty) * (TILE_H / 2);
}

/** Inverse iso: the GROUND cell under a world point. Correct for the floor and
 *  wrong for anything raised, which is why picking uses the ID buffer instead and
 *  only falls back to this for street and district queries. */
export function worldToCell(wx: number, wy: number): { tx: number; ty: number } {
  const a = wx / (TILE_W / 2);
  const b = wy / (TILE_H / 2);
  return { tx: Math.floor((a + b) / 2), ty: Math.floor((b - a) / 2) };
}

export interface Bounds {
  minX: number; maxX: number; minY: number; maxY: number; w: number; h: number;
}

/**
 * World-pixel bounds of the ISLAND, not of the grid.
 *
 * Using the grid lets the player pan into the empty void corners of the square,
 * which look broken. The island is a diamond inscribed in the grid, so its
 * extremes are the four grid corners projected.
 */
export function worldBounds(): Bounds {
  const minX = isoX(0, GRID_H - 1) - TILE_W / 2;
  const maxX = isoX(GRID_W - 1, 0) + TILE_W / 2;
  const minY = isoY(0, 0) - TILE_H / 2 - HEAD_ROOM;
  const maxY = isoY(GRID_W - 1, GRID_H - 1) + TILE_H / 2 + FOOT_ROOM;
  return { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY };
}

export function defaultCamera(viewW: number, viewH: number): Camera {
  const b = worldBounds();
  // Take the largest step that still shows the whole district. The old
  // thresholds gave a 1440x900 monitor zoom 1, so the island occupied about a
  // quarter of the screen and two thirds of the first impression was void.
  const fit = Math.min(viewW / b.w, viewH / b.h);
  const zoom: ZoomStep = fit >= 2.6 ? 3 : fit >= 0.92 ? 2 : 1;
  const cam: Camera = { ox: 0, oy: 0, zoom };
  centreOn(cam, viewW, viewH, b.minX + b.w / 2, b.minY + b.h / 2);
  return cam;
}

export function centreOn(cam: Camera, viewW: number, viewH: number, wx: number, wy: number): void {
  cam.ox = viewW / 2 - cam.zoom * wx;
  cam.oy = viewH / 2 - cam.zoom * wy;
}

export function screenToWorld(cam: Camera, sx: number, sy: number): { wx: number; wy: number } {
  return { wx: (sx - cam.ox) / cam.zoom, wy: (sy - cam.oy) / cam.zoom };
}

export function worldToScreen(cam: Camera, wx: number, wy: number): { sx: number; sy: number } {
  return { sx: wx * cam.zoom + cam.ox, sy: wy * cam.zoom + cam.oy };
}

/** Zoom about a screen anchor, preserving the world point under it. */
export function zoomTo(cam: Camera, step: ZoomStep, anchorX: number, anchorY: number): void {
  if (step === cam.zoom) return;
  const k = step / cam.zoom;
  cam.ox = anchorX - k * (anchorX - cam.ox);
  cam.oy = anchorY - k * (anchorY - cam.oy);
  cam.zoom = step;
}

export interface Insets {
  top: number; right: number; bottom: number; left: number;
}

/**
 * Clamp against the island bounds, minus the panel insets, so a building can
 * always be panned out from under the inspector card. At zoom 1 the island may
 * not travel more than 15 percent of the viewport off any edge; zoomed in, its
 * edge may reach the viewport edge.
 */
export function clampCamera(cam: Camera, viewW: number, viewH: number, insets: Insets): void {
  const b = worldBounds();
  const safeW = Math.max(120, viewW - insets.left - insets.right);
  const safeH = Math.max(120, viewH - insets.top - insets.bottom);
  const spanX = b.w * cam.zoom;
  const spanY = b.h * cam.zoom;

  const slackX = spanX < safeW ? (safeW - spanX) / 2 : Math.min(safeW * 0.15, safeW * 0.5);
  const slackY = spanY < safeH ? (safeH - spanY) / 2 : Math.min(safeH * 0.15, safeH * 0.5);

  const minOx = insets.left + safeW - spanX - cam.zoom * b.minX - slackX;
  const maxOx = insets.left - cam.zoom * b.minX + slackX;
  const minOy = insets.top + safeH - spanY - cam.zoom * b.minY - slackY;
  const maxOy = insets.top - cam.zoom * b.minY + slackY;

  cam.ox = Math.min(maxOx, Math.max(minOx, cam.ox));
  cam.oy = Math.min(maxOy, Math.max(minOy, cam.oy));
}

export function clampDpr(dpr: number): number {
  return Math.max(1, Math.min(2, Math.round(dpr)));
}

/**
 * Depth key. Ascending order is painter's order.
 *   primary   tx + ty          (float for agents, south-corner tile for buildings)
 *   secondary layer            0 flush props, 1 buildings, 2 agents, 3 overhead
 *   tertiary  tx
 * Layer 3 is how a pneumatic tube spanning a street, or a bunting swag, draws over
 * the souls underneath it for free.
 */
export const LAYER_FLUSH = 0;
export const LAYER_STRUCT = 1;
export const LAYER_AGENT = 2;
export const LAYER_OVERHEAD = 3;

export function depthKey(tx: number, ty: number, layer: number): number {
  return (tx + ty) * 1000 + layer * 100 + Math.min(99, Math.max(0, tx));
}
