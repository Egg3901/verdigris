// Iso primitives drawn from code.
//
// These are the fallback the atlas loader drops back to when a frame is missing,
// and they are also what the whole city is built from before the baker exists.
// The rule for the first milestones is: fake the SPRITES, never fake the
// ARCHITECTURE. The compositor, the depth sort, the ID buffer and the camera
// contract are all built against these boxes, so when the real atlas lands it
// drops in behind an unchanged blit() and the town changes in one commit.
import { TILE_W, TILE_H, isoX, isoY } from './iso';

export interface BoxColours {
  top: string;
  left: string;
  right: string;
  outline?: string;
}

/** Exact 32x16 diamond from a per-row span table. Never a polygon fill: the shape
 *  has to be byte-identical every time or the ground shimmers as the camera moves. */
export function isoDiamondPath(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.beginPath();
  ctx.moveTo(cx, cy - TILE_H / 2);
  ctx.lineTo(cx + TILE_W / 2, cy);
  ctx.lineTo(cx, cy + TILE_H / 2);
  ctx.lineTo(cx - TILE_W / 2, cy);
  ctx.closePath();
}

export function drawIsoDiamond(ctx: CanvasRenderingContext2D, cx: number, cy: number, fill: string): void {
  isoDiamondPath(ctx, cx, cy);
  ctx.fillStyle = fill;
  ctx.fill();
}

/** World-pixel bounds of a footprint extruded to hPx, relative to the diamond
 *  centre of its SOUTH corner tile. The south corner is the sprite anchor, and
 *  the depth sort depends on that choice. */
export function boxBounds(w: number, d: number, hPx: number) {
  const sx = w - 1;
  const sy = d - 1;
  const originX = isoX(sx, sy);
  const originY = isoY(sx, sy);
  const westX = isoX(0, sy) - TILE_W / 2 - originX;
  const eastX = isoX(sx, 0) + TILE_W / 2 - originX;
  const northY = isoY(0, 0) - TILE_H / 2 - hPx - originY;
  const southY = isoY(sx, sy) + TILE_H / 2 - originY;
  return { minX: westX, maxX: eastX, minY: northY, maxY: southY };
}

/**
 * An extruded footprint. ox, oy is where the SOUTH corner tile's diamond centre
 * sits in the target canvas.
 *
 * Light comes from the west, upper left, always. The left face is therefore the
 * lit one and the right face is the shaded one, and nothing in the game may
 * contradict that or the whole district stops reading as one place.
 */
export function drawIsoBox(
  ctx: CanvasRenderingContext2D, ox: number, oy: number,
  w: number, d: number, hPx: number, c: BoxColours,
): void {
  const sx = w - 1;
  const sy = d - 1;
  const baseX = ox - isoX(sx, sy);
  const baseY = oy - isoY(sx, sy);

  const west = { x: baseX + isoX(0, sy) - TILE_W / 2, y: baseY + isoY(0, sy) };
  const north = { x: baseX + isoX(0, 0), y: baseY + isoY(0, 0) - TILE_H / 2 };
  const east = { x: baseX + isoX(sx, 0) + TILE_W / 2, y: baseY + isoY(sx, 0) };
  const south = { x: baseX + isoX(sx, sy), y: baseY + isoY(sx, sy) + TILE_H / 2 };

  // Left face (west to south), lit.
  ctx.fillStyle = c.left;
  ctx.beginPath();
  ctx.moveTo(west.x, west.y - hPx);
  ctx.lineTo(west.x, west.y);
  ctx.lineTo(south.x, south.y);
  ctx.lineTo(south.x, south.y - hPx);
  ctx.closePath();
  ctx.fill();

  // Right face (south to east), shaded.
  ctx.fillStyle = c.right;
  ctx.beginPath();
  ctx.moveTo(south.x, south.y - hPx);
  ctx.lineTo(south.x, south.y);
  ctx.lineTo(east.x, east.y);
  ctx.lineTo(east.x, east.y - hPx);
  ctx.closePath();
  ctx.fill();

  // Top face. All four corners are lifted by hPx: lifting only three of them
  // turns every roof in the city into a dark chevron, which is exactly what it
  // looked like the first time this ran.
  ctx.fillStyle = c.top;
  ctx.beginPath();
  ctx.moveTo(north.x, north.y - hPx);
  ctx.lineTo(east.x, east.y - hPx);
  ctx.lineTo(south.x, south.y - hPx);
  ctx.lineTo(west.x, west.y - hPx);
  ctx.closePath();
  ctx.fill();

  if (c.outline) {
    // Selective ink outline on the south and east silhouette only, away from the
    // light. A full outline makes an iso town read as a sheet of stickers.
    ctx.strokeStyle = c.outline;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(west.x + 0.5, west.y - 0.5);
    ctx.lineTo(south.x + 0.5, south.y - 0.5);
    ctx.lineTo(east.x + 0.5, east.y - 0.5);
    ctx.stroke();
  }
}

/** A soul: eleven by nineteen pixels at zoom 1, which is small enough that the
 *  click slop in pick.ts is doing most of the work of making them selectable. */
export function drawSoul(
  ctx: CanvasRenderingContext2D, x: number, y: number,
  coat: string, hat: string, step: number,
): void {
  const bob = step === 1 ? -1 : step === 3 ? 1 : 0;
  ctx.fillStyle = coat;
  ctx.fillRect(Math.round(x) - 2, Math.round(y) - 9 + bob, 4, 7);
  ctx.fillRect(Math.round(x) - 1, Math.round(y) - 2, 1, 2);
  ctx.fillRect(Math.round(x), Math.round(y) - 2 - (bob === 0 ? 0 : 1), 1, 2);
  ctx.fillStyle = hat;
  ctx.fillRect(Math.round(x) - 2, Math.round(y) - 12 + bob, 4, 3);
}
