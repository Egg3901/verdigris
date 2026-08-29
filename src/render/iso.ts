// Isometric constants and the camera.
//
// THE INTEGER TRANSFORM CONTRACT, which nothing may violate:
//   dprInt = clamp(round(devicePixelRatio), 1, 2)
//   zoom * dprInt is an integer (1, 2 or 3 on a plain display; a phone may
//   also use 1/dprInt, which is one atlas pixel per device pixel)
//   setTransform(zoom*dprInt, 0, 0, zoom*dprInt, round(ox*dprInt), round(oy*dprInt))
//   imageSmoothingEnabled = false
// Every atlas pixel then lands on an exact N by N block of device pixels. A
// tweened fractional zoom would blur the whole city, which is why the zoom
// control is a discrete stepper and not a slider.
import { islandTileBounds } from '../sim/district';

export const TILE_W = 32;
export const TILE_H = 16;

/** Headroom above the grid for the mooring mast and the campanile. */
export const HEAD_ROOM = 120;
export const FOOT_ROOM = 64;

export type ZoomStep = number;
export const ZOOM_STEPS: readonly ZoomStep[] = [1, 2, 3];

/**
 * The zoom steps a given device may use.
 *
 * The contract that matters is that zoom * dprInt is an INTEGER, so every atlas
 * pixel lands on an exact block of device pixels. It was written down as "zoom
 * is 1, 2 or 3" because on a plain display those are the only values that
 * satisfy it. On a 2x or 3x screen, which is to say on a phone, 1/dprInt also
 * satisfies it exactly: it renders one atlas pixel per DEVICE pixel and shows
 * twice or three times as much district. That is the honest way to give a
 * phone a wider view, and it costs nothing in sharpness.
 */
export function zoomStepsFor(dprInt: number): readonly ZoomStep[] {
  return dprInt >= 2 ? [1 / dprInt, 1, 2, 3] : ZOOM_STEPS;
}

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
 * Using the grid lets the player pan into empty void, and worse, the default
 * camera frames a box far larger than the district so the town sits small and
 * off-centre. The bounds include the seeded coastline's maximum excursion.
 */
export function worldBounds(): Bounds {
  const { min, max } = islandTileBounds();
  const minX = isoX(min, max) - TILE_W / 2;
  const maxX = isoX(max, min) + TILE_W / 2;
  const minY = isoY(min, min) - TILE_H / 2 - HEAD_ROOM;
  const maxY = isoY(max, max) + TILE_H / 2 + FOOT_ROOM;
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

/**
 * The backing store must be an INTEGER multiple of the CSS size, and that integer
 * has to be the device's own ratio, or the browser resamples the whole picture.
 *
 * This was capped at 2 to save memory. On a phone reporting devicePixelRatio 3
 * that means a 780px backing store stretched across 1170 device pixels: a 1.5x
 * upscale of pixel art. Every second art pixel lands on two device pixels and
 * every other on one, so diagonals step unevenly, one-pixel eave lines come out
 * thicker in some places than others, and the whole district reads as janky.
 * It is the same class of mistake as antialiasing, arriving one layer further out.
 *
 * Three costs about eleven megabytes on a modern phone, which is affordable.
 */
export function clampDpr(dpr: number): number {
  return Math.max(1, Math.min(3, Math.round(dpr)));
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
