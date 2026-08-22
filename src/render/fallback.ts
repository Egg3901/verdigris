// Iso primitives drawn from code.
//
// These are the fallback the atlas loader drops back to when a frame is missing,
// and they are also what the whole city is built from before the baker exists.
// The rule for the first milestones is: fake the SPRITES, never fake the
// ARCHITECTURE. The compositor, the depth sort, the ID buffer and the camera
// contract are all built against these boxes, so when the real atlas lands it
// drops in behind an unchanged blit() and the town changes in one commit.
import { TILE_W, TILE_H, isoX, isoY } from './iso';
import { fillPolyHard, lineHard } from './raster';
import { PAL, gradeHex, quantizeWorldColour, shadeHex } from './palette';
import type { Variant } from './palette';

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

/** The ground diamond, scanline filled.
 *
 *  The comment on isoDiamondPath above has always said "never a polygon fill: the
 *  shape has to be byte-identical every time or the ground shimmers", and then
 *  this function did exactly that. Antialiased diamond edges left a semi
 *  transparent seam between every pair of adjacent cells, which at magnification
 *  read as a visible lattice of lozenges across every street. */
export function drawIsoDiamond(ctx: CanvasRenderingContext2D, cx: number, cy: number, fill: string): void {
  fillPolyHard(ctx, [
    { x: cx, y: cy - TILE_H / 2 },
    { x: cx + TILE_W / 2, y: cy },
    { x: cx, y: cy + TILE_H / 2 },
    { x: cx - TILE_W / 2, y: cy },
  ], fill);
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
  fillPolyHard(ctx, [
    { x: west.x, y: west.y - hPx }, { x: west.x, y: west.y },
    { x: south.x, y: south.y }, { x: south.x, y: south.y - hPx },
  ], c.left);

  // Right face (south to east), shaded.
  fillPolyHard(ctx, [
    { x: south.x, y: south.y - hPx }, { x: south.x, y: south.y },
    { x: east.x, y: east.y }, { x: east.x, y: east.y - hPx },
  ], c.right);

  // Top face. All four corners are lifted by hPx: lifting only three of them
  // turns every roof in the city into a dark chevron, which is exactly what it
  // looked like the first time this ran.
  fillPolyHard(ctx, [
    { x: north.x, y: north.y - hPx }, { x: east.x, y: east.y - hPx },
    { x: south.x, y: south.y - hPx }, { x: west.x, y: west.y - hPx },
  ], c.top);

  if (c.outline) {
    // Selective ink outline on the south and east silhouette only, away from the
    // light. A full outline makes an iso town read as a sheet of stickers.
    lineHard(ctx, west, south, c.outline);
    lineHard(ctx, south, east, c.outline);
  }
}

/**
 * A soul.
 *
 * The old version was a 4x7 coat block with a 4x3 hat sitting flush on top of it
 * and one leg stub. Magnified, there was NO HEAD: the hat met the shoulders
 * directly, and because the hat was the same width as the body there was no
 * shoulder line either, so a pale-coated child rendered as a solid stick with a
 * slightly different cap. They read as candles.
 *
 * Same eleven-pixel budget, spent better: a 2px crown over a 1px band of skin
 * over a 4px body, legs in a constant dark rather than the coat colour, and a
 * contact shadow so they stand on the street instead of hovering over it.
 */
const SKIN = [PAL.cream1, PAL.cream2, PAL.ochre1, PAL.wood2];
const LEG = PAL.ink;

export function drawSoul(
  ctx: CanvasRenderingContext2D, x: number, y: number,
  coat: string, hat: string, step: number, salt = 0, variant: Variant = 'day',
  umbrella = false, basket = false,
): void {
  const px = Math.round(x);
  const py = Math.round(y);
  const bob = step === 1 ? -1 : step === 3 ? 1 : 0;

  // Contact shadow first, at ground level, never bobbing. Without it every soul
  // in the district floats a pixel above the cobbles.
  ctx.fillStyle = gradeHex(PAL.soot0, variant);
  ctx.fillRect(px - 2, py, 4, 1);

  // Legs. A constant dark, so a cream coat does not produce cream legs.
  ctx.fillStyle = gradeHex(LEG, variant);
  if (step === 0 || step === 2) {
    ctx.fillRect(px - 1, py - 3, 1, 3);
    ctx.fillRect(px, py - 3, 1, 3);
  } else {
    // Mid-stride: one leg forward, one back, which is the whole gait read.
    ctx.fillRect(px - 2, py - 3, 1, 3);
    ctx.fillRect(px + 1, py - 3, 1, 3);
  }

  // Body, two pixels narrower than the old block so there are shoulders.
  const body = gradeHex(coat, variant);
  ctx.fillStyle = body;
  ctx.fillRect(px - 2, py - 9 + bob, 4, 6);
  // A darker side, west light as everywhere else.
  ctx.fillStyle = quantizeWorldColour(shadeHex(body, -0.15), variant);
  ctx.fillRect(px + 1, py - 9 + bob, 1, 6);

  // The head. One pixel of skin is all it takes, and it is the whole difference.
  ctx.fillStyle = gradeHex(SKIN[salt % SKIN.length], variant);
  ctx.fillRect(px - 1, py - 11 + bob, 2, 2);

  // Crown narrower than the shoulders, with a brim the full width.
  ctx.fillStyle = gradeHex(hat, variant);
  ctx.fillRect(px - 2, py - 12 + bob, 4, 1);
  ctx.fillRect(px - 1, py - 14 + bob, 2, 2);

  if (umbrella) {
    const cloth = gradeHex([PAL.slate2, PAL.buntRed, PAL.verd2, PAL.buntBlue][salt % 4], variant);
    fillPolyHard(ctx, [
      { x: px - 5, y: py - 14 + bob }, { x: px, y: py - 18 + bob },
      { x: px + 5, y: py - 14 + bob }, { x: px + 3, y: py - 13 + bob },
      { x: px, y: py - 14 + bob }, { x: px - 3, y: py - 13 + bob },
    ], cloth);
    lineHard(ctx, { x: px, y: py - 17 + bob }, { x: px, y: py - 7 + bob }, gradeHex(PAL.wood0, variant));
    ctx.fillStyle = gradeHex(PAL.rivGlint, variant);
    ctx.fillRect(px - 3, py - 15 + bob, 2, 1);
  }
  if (basket) {
    ctx.fillStyle = gradeHex(PAL.wood2, variant);
    ctx.fillRect(px + 2, py - 7 + bob, 2, 2);
    ctx.fillStyle = gradeHex(PAL.ochre1, variant);
    ctx.fillRect(px + 2, py - 8 + bob, 1, 1);
  }
}
