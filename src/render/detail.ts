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

export type WallMaterial = 'stucco' | 'brick' | 'ashlar' | 'timber' | 'wood' | 'glazed';

/**
 * Brick courses on a wall face: mortar lines parallel to the eave, joints
 * staggered every other course. This is what stops a brick wall reading as a
 * flat terracotta slab.
 */
export function drawBrickFace(
  ctx: CanvasRenderingContext2D, f: Face, wallH: number, mortar: string,
): void {
  const course = 3;
  const bricks = Math.max(2, Math.round(f.span / 4));
  for (let h = 2; h < wallH - 1; h += course) {
    lineHard(ctx, f.at(0.02, h), f.at(0.98, h), mortar);
    const stagger = ((h / course) & 1) === 0 ? 0 : 0.5;
    for (let i = 1; i < bricks; i++) {
      const t = (i + stagger) / bricks;
      if (t <= 0.04 || t >= 0.96) continue;
      lineHard(ctx, f.at(t, h), f.at(t, Math.min(wallH - 1, h + course - 1)), mortar);
    }
  }
}

/**
 * Ashlar: larger dressed blocks with a highlight on the top of each course, the
 * civic and villa read.
 */
export function drawAshlarFace(
  ctx: CanvasRenderingContext2D, f: Face, wallH: number, mortar: string, hilite: string,
): void {
  const course = 4;
  const blocks = Math.max(2, Math.round(f.span / 7));
  for (let h = 2; h < wallH - 1; h += course) {
    lineHard(ctx, f.at(0.02, h), f.at(0.98, h), mortar);
    if (h > 2) lineHard(ctx, f.at(0.02, h + 1), f.at(0.98, h + 1), hilite);
    const stagger = ((h / course) & 1) === 0 ? 0 : 0.5;
    for (let i = 1; i < blocks; i++) {
      const t = (i + stagger) / blocks;
      if (t <= 0.04 || t >= 0.96) continue;
      lineHard(ctx, f.at(t, h), f.at(t, Math.min(wallH - 1, h + course - 1)), mortar);
    }
  }
}

/**
 * Timber framing: posts, a mid rail, and one diagonal brace per bay. The working
 * bank's cheaper construction, made visible.
 */
export function drawTimberFace(
  ctx: CanvasRenderingContext2D, f: Face, wallH: number, timber: string,
): void {
  const bays = Math.max(2, Math.round(f.span / 10));
  lineHard(ctx, f.at(0.02, wallH * 0.48), f.at(0.98, wallH * 0.48), timber);
  lineHard(ctx, f.at(0.02, wallH * 0.48 + 1), f.at(0.98, wallH * 0.48 + 1), timber);
  lineHard(ctx, f.at(0.04, 1), f.at(0.04, wallH - 1), timber);
  lineHard(ctx, f.at(0.06, 1), f.at(0.06, wallH - 1), timber);
  lineHard(ctx, f.at(0.96, 1), f.at(0.96, wallH - 1), timber);
  lineHard(ctx, f.at(0.94, 1), f.at(0.94, wallH - 1), timber);
  for (let i = 1; i < bays; i++) {
    const t = i / bays;
    lineHard(ctx, f.at(t, 1), f.at(t, wallH - 1), timber);
    const t0 = (i - 1) / bays;
    if ((i & 1) === 1) {
      lineHard(ctx, f.at(t0 + 0.04, 2), f.at(t - 0.04, wallH * 0.48), timber);
    } else {
      lineHard(ctx, f.at(t0 + 0.04, wallH * 0.48), f.at(t - 0.04, wallH - 2), timber);
    }
  }
}

/** Vertical weatherboards on warehouses and sheds. */
export function drawBoardFace(
  ctx: CanvasRenderingContext2D, f: Face, wallH: number, seam: string,
): void {
  const n = Math.max(3, Math.round(f.span / 3));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    lineHard(ctx, f.at(t, 1), f.at(t, wallH - 1), seam);
  }
}

/**
 * Iron-and-glass: a stone plinth and a mullioned wall. The winter garden, and
 * nothing else, because glass everywhere would flatten the town.
 */
export function drawGlazedFace(
  ctx: CanvasRenderingContext2D, f: Face, wallH: number, skin: DetailSkin, iron: string,
): void {
  faceQuad(ctx, f, 0.02, 0.98, wallH - 4, wallH, skin.wall);
  faceQuad(ctx, f, 0.04, 0.96, 2, wallH - 4, skin.glassLit ? PAL.rivGlint : shadeHex(PAL.darkWindow, 0.08));
  const cols = Math.max(3, Math.round(f.span / 6));
  const rows = Math.max(2, Math.floor((wallH - 6) / 5));
  for (let i = 0; i <= cols; i++) {
    const t = 0.04 + (0.92 * i) / cols;
    lineHard(ctx, f.at(t, 2), f.at(t, wallH - 4), iron);
  }
  for (let r = 0; r <= rows; r++) {
    const h = 2 + ((wallH - 6) * r) / rows;
    lineHard(ctx, f.at(0.04, h), f.at(0.96, h), iron);
  }
}

/** Sparse stucco mottling: a second colour scattered, not blended. */
export function drawStuccoMottle(
  ctx: CanvasRenderingContext2D, pts: readonly Pt[], colour: string, salt: number,
): void {
  ditherPolyHard(ctx, pts, colour, 3 + (salt % 3));
}

/**
 * Ridge cresting: a run of spikes along the ridge. Silhouette work, cheap, and
 * the difference between a civic roof and a warehouse.
 */
export function drawRidgeCrest(
  ctx: CanvasRenderingContext2D, a: Pt, b: Pt, colour: string, fancy: boolean,
): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 4) return;
  const step = fancy ? 3 : 5;
  const n = Math.max(2, Math.floor(len / step));
  ctx.fillStyle = colour;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = Math.round(a.x + dx * t);
    const y = Math.round(a.y + dy * t);
    ctx.fillRect(x, y - (fancy ? 3 : 2), 1, fancy ? 3 : 2);
    if (fancy && i % 2 === 0) ctx.fillRect(x - 1, y - 2, 3, 1);
  }
}

/**
 * A washing line on the lit face: the working bank, hung out to dry. Three bits
 * of cloth on a sagging string.
 */
export function drawWashingLine(
  ctx: CanvasRenderingContext2D, f: Face, wallH: number, salt: number,
): void {
  const top = Math.max(3, wallH - 12);
  const cloth = [PAL.buntCream, PAL.buntBlue, PAL.plaster2, PAL.ochre2];
  const n = 3 + (salt % 2);
  lineHard(ctx, f.at(0.12, top), f.at(0.88, top + 2), PAL.wood0);
  for (let i = 0; i < n; i++) {
    const t = 0.2 + (0.6 * i) / Math.max(1, n - 1);
    const p = f.at(t, top + Math.sin(t * Math.PI) * 2);
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    ctx.fillStyle = cloth[(i + salt) % cloth.length];
    ctx.fillRect(x - 2, y + 1, 3, 5 + (i % 3));
  }
}

/**
 * Soot streaks down a wall from the eave. Working-bank weathering, not a wash
 * of the whole face.
 */
export function drawSootStreaks(
  ctx: CanvasRenderingContext2D, f: Face, wallH: number, soot: string, salt: number,
): void {
  const n = 2 + (salt % 3);
  for (let i = 0; i < n; i++) {
    const t = 0.15 + ((i * 17 + salt) % 70) / 100;
    lineHard(ctx, f.at(t, 1), f.at(t, Math.min(wallH - 2, 4 + ((salt + i) % 8))), soot);
  }
}

/**
 * Local scars say more about a facade than another overall shade ever could.
 * These marks sit below doors and windows, so the address keeps its use as well
 * as its condition.
 */
export function drawFacadePatina(
  ctx: CanvasRenderingContext2D, f: Face, wallH: number, material: WallMaterial,
  wear: 0 | 1 | 2, drainState: 0 | 1 | 2, salt: number, skin: DetailSkin,
): void {
  if (wear === 0 || f.span < 7) return;
  const crack = skin.wallDark;
  const low = Math.max(4, wallH - 7);
  if (material === 'stucco' || material === 'ashlar') {
    const t = 0.18 + ((salt >>> 3) % 54) / 100;
    const a = f.at(t, Math.max(3, low - 7));
    const b = f.at(t + 0.04, low - 3);
    const c = f.at(t - 0.02, low);
    lineHard(ctx, a, b, crack);
    lineHard(ctx, b, c, crack);
    if (wear === 2) lineHard(ctx, b, f.at(t + 0.12, low - 1), crack);
  } else if (material === 'brick') {
    const p = f.at(0.2 + ((salt >>> 5) % 52) / 100, low - 3);
    ctx.fillStyle = crack;
    ctx.fillRect(Math.round(p.x), Math.round(p.y), wear === 2 ? 3 : 2, 1);
    if (wear === 2) ctx.fillRect(Math.round(p.x) + 1, Math.round(p.y) + 1, 1, 2);
  } else if (material === 'timber' || material === 'wood') {
    const a = f.at(0.12 + ((salt >>> 4) % 28) / 100, low - 4);
    const b = f.at(0.37 + ((salt >>> 6) % 22) / 100, low - 4);
    lineHard(ctx, a, b, PAL.wood2);
    lineHard(ctx, f.at(0.5, low - 5), f.at(0.5, low + 1), skin.outline);
  } else {
    const p = f.at(0.58, low - 3);
    ctx.fillStyle = PAL.buntCream;
    ctx.fillRect(Math.round(p.x), Math.round(p.y), 2, 1);
  }

  if (drainState === 2) {
    const a = f.at(0.79, Math.max(2, wallH - 5));
    const b = f.at(0.76, wallH - 1);
    lineHard(ctx, a, b, PAL.riv1);
    if (wear === 2) lineHard(ctx, f.at(0.7, wallH - 1), f.at(0.9, wallH - 1), PAL.riv2);
  }
}

/** A working threshold needs a cargo door, not a cottage front door. */
export function drawFreightDoor(
  ctx: CanvasRenderingContext2D, f: Face, t: number, wallH: number, skin: DetailSkin,
  frontage: 'works' | 'warehouse' | 'wharf',
): void {
  const half = frontage === 'wharf' ? 0.27 : frontage === 'warehouse' ? 0.24 : 0.21;
  const top = Math.max(3, wallH - (frontage === 'works' ? 14 : 12));
  faceQuad(ctx, f, t - half, t + half, top, wallH - 1, skin.wallDark);
  lineHard(ctx, f.at(t - half, top), f.at(t + half, wallH - 1), skin.timber);
  lineHard(ctx, f.at(t + half, top), f.at(t - half, wallH - 1), skin.timber);
  lineHard(ctx, f.at(t, top), f.at(t, wallH - 1), skin.outline);
  lineHard(ctx, f.at(t - half - 0.02, wallH - 1), f.at(t + half + 0.02, wallH - 1), shadeHex(skin.wall, -0.2));
  if (frontage !== 'works') {
    const beamA = f.at(t - half - 0.06, Math.max(1, top - 2));
    const beamB = f.at(t + half + 0.08, Math.max(1, top - 2));
    lineHard(ctx, beamA, beamB, PAL.wood1);
    const hook = f.at(t + half + 0.04, top + 1);
    lineHard(ctx, hook, { x: hook.x, y: hook.y + 4 }, skin.outline);
  } else {
    const board = f.at(t + half + 0.08, top + 2);
    ctx.fillStyle = PAL.buntCream;
    ctx.fillRect(Math.round(board.x), Math.round(board.y), 2, 3);
    ctx.fillStyle = PAL.buntRed;
    ctx.fillRect(Math.round(board.x), Math.round(board.y) + 1, 2, 1);
  }
}

/** A civic doorway gets a stone step and a brass notice, not another cottage door. */
export function drawCivicThreshold(
  ctx: CanvasRenderingContext2D, f: Face, t: number, wallH: number, skin: DetailSkin,
): void {
  const half = Math.min(0.18, 6 / Math.max(1, f.span));
  const top = Math.max(3, wallH - 13);
  faceQuad(ctx, f, t - half, t + half, top, wallH - 2, skin.wallDark);
  lineHard(ctx, f.at(t - half, top), f.at(t + half, top), skin.trim ?? PAL.brass2);
  lineHard(ctx, f.at(t - half - 0.04, wallH - 1), f.at(t + half + 0.04, wallH - 1), PAL.stone2);
  lineHard(ctx, f.at(t - half - 0.08, wallH), f.at(t + half + 0.08, wallH), PAL.stone1);
  const notice = f.at(t + half + 0.09, top + 3);
  ctx.fillStyle = skin.trim ?? PAL.brass2;
  ctx.fillRect(Math.round(notice.x), Math.round(notice.y), 2, 3);
  ctx.fillStyle = PAL.buntCream;
  ctx.fillRect(Math.round(notice.x), Math.round(notice.y), 2, 1);
}

/** Small, bounded roof repairs and failed tiles, never a second roof silhouette. */
export function drawRoofPatina(
  ctx: CanvasRenderingContext2D, quad: readonly Pt[], wear: 1 | 2, salt: number,
  roofLit: string, roofShade: string, ridge: string,
): void {
  if (quad.length < 4) return;
  const at = (u: number, v: number): Pt => {
    const a = { x: quad[0].x + (quad[1].x - quad[0].x) * u, y: quad[0].y + (quad[1].y - quad[0].y) * u };
    const b = { x: quad[3].x + (quad[2].x - quad[3].x) * u, y: quad[3].y + (quad[2].y - quad[3].y) * u };
    return { x: a.x + (b.x - a.x) * v, y: a.y + (b.y - a.y) * v };
  };
  const chips = wear === 2 ? 4 : 2;
  for (let i = 0; i < chips; i++) {
    const u = 0.12 + ((salt + i * 19) % 71) / 100;
    const v = 0.34 + ((salt + i * 11) % 38) / 100;
    const p = at(u, v);
    ctx.fillStyle = i % 2 === 0 ? shadeHex(roofShade, -0.1) : shadeHex(roofLit, 0.08);
    ctx.fillRect(Math.round(p.x), Math.round(p.y), 2, 1);
  }
  if (wear === 2) {
    const a = at(0.26, 0.56);
    const b = at(0.55, 0.56);
    const c = at(0.55, 0.76);
    const d = at(0.26, 0.76);
    fillPolyHard(ctx, [a, b, c, d], shadeHex(roofLit, -0.08));
    ditherPolyHard(ctx, [a, b, c, d], shadeHex(roofShade, -0.08), 5);
    lineHard(ctx, a, b, ridge);
  }
}

/**
 * A patched roof: one quadrant of a slope in a different colour, dithered in.
 * The working bank's mended tiles.
 */
export function drawRoofPatch(
  ctx: CanvasRenderingContext2D, quad: readonly Pt[], colour: string,
): void {
  if (quad.length < 4) return;
  const a = {
    x: quad[0].x + (quad[1].x - quad[0].x) * 0.30,
    y: quad[0].y + (quad[1].y - quad[0].y) * 0.30,
  };
  const b = {
    x: quad[0].x + (quad[1].x - quad[0].x) * 0.52,
    y: quad[0].y + (quad[1].y - quad[0].y) * 0.52,
  };
  const c = {
    x: quad[3].x + (quad[2].x - quad[3].x) * 0.52,
    y: quad[3].y + (quad[2].y - quad[3].y) * 0.52,
  };
  const d = {
    x: quad[3].x + (quad[2].x - quad[3].x) * 0.15,
    y: quad[3].y + (quad[2].y - quad[3].y) * 0.15,
  };
  const patch = [
    {
      x: a.x + (d.x - a.x) * 0.2, y: a.y + (d.y - a.y) * 0.2,
    },
    {
      x: b.x + (c.x - b.x) * 0.2, y: b.y + (c.y - b.y) * 0.2,
    },
    {
      x: b.x + (c.x - b.x) * 0.55, y: b.y + (c.y - b.y) * 0.55,
    },
    {
      x: a.x + (d.x - a.x) * 0.55, y: a.y + (d.y - a.y) * 0.55,
    },
  ];
  fillPolyHard(ctx, patch, colour);
  ditherPolyHard(ctx, patch, shadeHex(colour, -0.12), 6);
}

/** Iron railings along an eave, for polite villas and the bank. */
export function drawEaveRail(
  ctx: CanvasRenderingContext2D, a: Pt, b: Pt, colour: string,
): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 6) return;
  const n = Math.max(4, Math.floor(len / 3));
  ctx.fillStyle = colour;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = Math.round(a.x + dx * t);
    const y = Math.round(a.y + dy * t);
    ctx.fillRect(x, y - 3, 1, 3);
  }
  lineHard(ctx, { x: a.x, y: a.y - 3 }, { x: b.x, y: b.y - 3 }, colour);
}
