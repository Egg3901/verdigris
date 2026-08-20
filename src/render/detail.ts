// Facade and roof detail: the things that make a 30px building read as a building
// rather than as a shaded prism.
//
// All of it is drawn through the hard rasteriser and baked once per building, so
// it costs nothing per frame. There is no reason any of this needed to wait for a
// sprite atlas: a baked sprite is a baked sprite whether the pixels came from
// Pillow or from a scanline fill.
//
// FACE COORDINATES. A wall in this projection is a parallelogram: two corners at
// the eave, the same two dropped by wallH. So any point on it is
//   lerp(cornerA, cornerB, t) + (0, h)
// with t running along the frontage and h down from the eave. Every door, sign,
// awning and shopfront below is placed in those two numbers, which is why they
// all sit flat on the wall instead of floating.
import { PAL, shadeHex } from './palette';
import { fillPolyHard, lineHard, ditherPolyHard } from './raster';
import type { Pt } from './raster';

export interface Face {
  /** Point on the face. t is 0..1 along it, h is pixels down from the eave. */
  at: (t: number, h: number) => Pt;
  /** Screen length of the face, for spacing things along it. */
  span: number;
  lit: boolean;
}

export function makeFace(a: Pt, b: Pt, lit: boolean): Face {
  return {
    at: (t, h) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t + h }),
    span: Math.hypot(b.x - a.x, b.y - a.y),
    lit,
  };
}

/** A quad on the face, in face coordinates. */
function faceQuad(
  ctx: CanvasRenderingContext2D, f: Face,
  t0: number, t1: number, h0: number, h1: number, colour: string,
): void {
  fillPolyHard(ctx, [f.at(t0, h0), f.at(t1, h0), f.at(t1, h1), f.at(t0, h1)], colour);
}

export interface DetailSkin {
  wall: string;
  wallDark: string;
  timber: string;
  glass: string;
  glassLit: boolean;
  trim?: string;
  outline: string;
}

/**
 * A door. Every dwelling in the district has one, which sounds obvious until you
 * notice that before this there was not a single door anywhere in Verdigris.
 */
export function drawDoor(
  ctx: CanvasRenderingContext2D, f: Face, t: number, wallH: number, skin: DetailSkin,
): void {
  const halfW = Math.min(0.16, 5 / Math.max(1, f.span));
  const top = Math.max(3, wallH - 11);
  faceQuad(ctx, f, t - halfW, t + halfW, top, wallH - 1, skin.wallDark);
  faceQuad(ctx, f, t - halfW, t + halfW, top, top + 1, skin.timber);
  // A step, so the door meets the pavement instead of hovering above it.
  faceQuad(ctx, f, t - halfW - 0.02, t + halfW + 0.02, wallH - 1, wallH, shadeHex(skin.wall, -0.2));
}

/**
 * A glazed shopfront with an awning. Shops and pubs get one, which is what makes
 * a commercial street look commercial from above.
 */
export function drawShopfront(
  ctx: CanvasRenderingContext2D, f: Face, wallH: number, skin: DetailSkin, awning: string,
): void {
  const top = Math.max(4, wallH - 13);
  // The glass.
  faceQuad(ctx, f, 0.08, 0.92, top + 3, wallH - 2, skin.glassLit ? PAL.litWindow : shadeHex(skin.glass, -0.1));
  // Mullions, so it reads as panes and not as a hole.
  for (let i = 1; i < 4; i++) {
    const t = 0.08 + (0.84 * i) / 4;
    lineHard(ctx, f.at(t, top + 3), f.at(t, wallH - 2), skin.timber);
  }
  // The awning: a striped band, projecting a pixel or two below the fascia.
  faceQuad(ctx, f, 0.05, 0.95, top, top + 3, awning);
  ditherPolyHard(ctx, [f.at(0.05, top), f.at(0.95, top), f.at(0.95, top + 3), f.at(0.05, top + 3)],
    shadeHex(awning, 0.28), 8);
  lineHard(ctx, f.at(0.05, top + 3), f.at(0.95, top + 3), skin.outline);
}

/** A hanging signboard on a bracket. Pubs and shops. */
export function drawSign(
  ctx: CanvasRenderingContext2D, f: Face, t: number, wallH: number, skin: DetailSkin,
): void {
  const top = Math.max(2, wallH - 20);
  const p = f.at(t, top);
  ctx.fillStyle = skin.timber;
  ctx.fillRect(Math.round(p.x) - 3, Math.round(p.y), 6, 1);
  ctx.fillStyle = skin.trim ?? PAL.brass2;
  ctx.fillRect(Math.round(p.x) - 2, Math.round(p.y) + 1, 5, 4);
  ctx.fillStyle = skin.outline;
  ctx.fillRect(Math.round(p.x) - 2, Math.round(p.y) + 5, 5, 1);
}

/**
 * Windows, in a proper sash grid with a lintel and a sill.
 *
 * Previously a 2x3 black rectangle on a bare lattice, which at zoom 1 read as
 * speckle and at zoom 3 read as a spreadsheet.
 */
export function drawWindowGrid(
  ctx: CanvasRenderingContext2D, f: Face, wallH: number, rows: number, skin: DetailSkin,
  skipGround: boolean, hash: number,
): void {
  const cols = Math.max(1, Math.round(f.span / 13));
  const bottom = skipGround ? wallH - 15 : wallH - 3;
  const usable = bottom - 4;
  if (usable < 6 || rows < 1) return;
  const stepY = Math.max(7, Math.floor(usable / rows));

  for (let r = 0; r < rows; r++) {
    const h = 4 + r * stepY;
    if (h + 5 > bottom) break;
    for (let c = 0; c < cols; c++) {
      const t = (c + 0.5) / cols;
      // Not every pane is lit, or a lit town reads as a string of fairy lights.
      const dark = skin.glassLit && ((hash + r * 7 + c * 13) % 3 === 0);
      const glass = skin.glassLit && !dark ? skin.glass : shadeHex(PAL.darkWindow, f.lit ? 0.06 : 0);
      const halfW = Math.min(0.12, 3 / Math.max(1, f.span));
      faceQuad(ctx, f, t - halfW, t + halfW, h, h + 4, glass);
      // Lintel above, sill below: two one-pixel lines that do most of the work of
      // making a hole in a wall look like a window.
      lineHard(ctx, f.at(t - halfW, h - 1), f.at(t + halfW, h - 1), skin.wallDark);
      lineHard(ctx, f.at(t - halfW - 0.01, h + 4), f.at(t + halfW + 0.01, h + 4), shadeHex(skin.wall, 0.14));
    }
  }
}

/**
 * Boarded windows and a leaning look for a building whose fabric has gone.
 *
 * This is the rot, made visible on the building itself rather than only in the
 * prose. A district where a third of the fabric has failed should look like it.
 */
export function drawBoarded(
  ctx: CanvasRenderingContext2D, f: Face, wallH: number, skin: DetailSkin,
): void {
  const cols = Math.max(1, Math.round(f.span / 13));
  for (let c = 0; c < cols; c++) {
    const t = (c + 0.5) / cols;
    const halfW = Math.min(0.13, 4 / Math.max(1, f.span));
    const h = Math.max(5, wallH - 14);
    lineHard(ctx, f.at(t - halfW, h), f.at(t + halfW, h + 5), skin.timber);
    lineHard(ctx, f.at(t - halfW, h + 5), f.at(t + halfW, h), skin.timber);
  }
}

/** Horizontal courses across a roof slope: tile or slate lines. */
export function drawCourses(
  ctx: CanvasRenderingContext2D, quad: readonly Pt[], colour: string, steps: number,
): void {
  if (quad.length < 4) return;
  // quad is [eaveA, eaveB, ridgeB, ridgeA]; walk from eave to ridge.
  for (let i = 1; i < steps; i++) {
    const k = i / steps;
    const a = { x: quad[0].x + (quad[3].x - quad[0].x) * k, y: quad[0].y + (quad[3].y - quad[0].y) * k };
    const b = { x: quad[1].x + (quad[2].x - quad[1].x) * k, y: quad[1].y + (quad[2].y - quad[1].y) * k };
    lineHard(ctx, a, b, colour);
  }
}

/**
 * A dormer on a roof slope: a small gabled box with its own window.
 *
 * Dormers are most of what gives a steep roof a silhouette at this scale, and
 * they are the difference between a mansard and a wedge.
 */
export function drawDormer(
  ctx: CanvasRenderingContext2D, quad: readonly Pt[], t: number, skin: DetailSkin, roofLit: string,
): void {
  const eave = { x: quad[0].x + (quad[1].x - quad[0].x) * t, y: quad[0].y + (quad[1].y - quad[0].y) * t };
  const ridge = { x: quad[3].x + (quad[2].x - quad[3].x) * t, y: quad[3].y + (quad[2].y - quad[3].y) * t };
  // Sit it a third of the way up the slope.
  const base = { x: eave.x + (ridge.x - eave.x) * 0.34, y: eave.y + (ridge.y - eave.y) * 0.34 };
  const bx = Math.round(base.x);
  const by = Math.round(base.y);

  fillPolyHard(ctx, [
    { x: bx - 3, y: by }, { x: bx + 3, y: by },
    { x: bx + 3, y: by - 4 }, { x: bx - 3, y: by - 4 },
  ], skin.wall);
  fillPolyHard(ctx, [
    { x: bx - 1, y: by - 1 }, { x: bx + 2, y: by - 1 },
    { x: bx + 2, y: by - 3 }, { x: bx - 1, y: by - 3 },
  ], skin.glassLit ? skin.glass : PAL.darkWindow);
  // Its own little pitched roof.
  fillPolyHard(ctx, [
    { x: bx - 4, y: by - 4 }, { x: bx + 4, y: by - 4 }, { x: bx, y: by - 7 },
  ], roofLit);
  lineHard(ctx, { x: bx - 4, y: by - 4 }, { x: bx + 4, y: by - 4 }, skin.outline);
}

/**
 * Bunting: the theme, hung on a wall.
 *
 * Triangles on a slack line. This is the only art in the game that exists purely
 * to be a lie, and it is the one the player pays for.
 */
export function drawBunting(
  ctx: CanvasRenderingContext2D, f: Face, wallH: number,
): void {
  const top = Math.max(2, wallH - 22);
  const flags = Math.max(3, Math.round(f.span / 7));
  const colours = [PAL.buntRed, PAL.buntCream, PAL.buntBlue, PAL.buntRedHi];
  for (let i = 0; i < flags; i++) {
    const t = (i + 0.5) / flags;
    // Slack: the line dips in the middle, which is what makes it read as string.
    const sag = Math.sin(t * Math.PI) * 3;
    const p = f.at(t, top + sag);
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    fillPolyHard(ctx, [
      { x: x - 2, y }, { x: x + 2, y }, { x, y: y + 4 },
    ], colours[i % colours.length]);
  }
  // The line itself, drawn after so it sits on top of the flag tops.
  for (let i = 0; i < flags; i++) {
    const t0 = i / flags;
    const t1 = (i + 1) / flags;
    lineHard(ctx,
      f.at(t0, top + Math.sin(t0 * Math.PI) * 3),
      f.at(t1, top + Math.sin(t1 * Math.PI) * 3),
      PAL.wood0);
  }
}
