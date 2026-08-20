// Houses: walls, and the roofs that actually matter.
//
// A town seen from above is a FIELD OF ROOFS. The silhouette and the colour of
// those roofs is most of what the eye reads, and drawing flat-topped boxes
// instead of pitched ones is the difference between a city and a bar chart.
//
// Geometry, for a footprint w by d extruded to wallH with a gable roof:
//   corners at eave height are W (min tx, max ty), N (min tx, min ty),
//   E (max tx, min ty), S (max tx, max ty)
//   the ridge runs along the LONGER axis, from the midpoint of one end edge to
//   the midpoint of the other, lifted by roofH
//   two slopes, two gable triangles, and only the near slope and near gable are
//   ever visible from this camera
//
// Light comes from the west, upper left, always.
import { TILE_W, TILE_H, isoX, isoY } from './iso';
import { shadeHex } from './palette';
import { fillPolyHard, ditherPolyHard, lineHard } from './raster';
import { PAL } from './palette';
import {
  makeFace, drawDoor, drawShopfront, drawSign, drawWindowGrid, drawBoarded,
  drawCourses, drawDormer, drawBunting,
} from './detail';
import type { DetailSkin } from './detail';

export type RoofShape = 'gable' | 'hip' | 'pyramid' | 'flat' | 'mansard';

export interface HouseSkin {
  wallLit: string;
  wallShade: string;
  /** The triangular ends of a gable roof. Held separately because they are large,
   *  camera-facing surfaces: deriving them from a sooted wall colour is what
   *  turned a third of the district into black holes. */
  gableLit: string;
  gableShade: string;
  roofLit: string;
  roofShade: string;
  roofRidge: string;
  trim?: string;
  /** Chimney brick. Never the wall colour: a cream chimney reads as a candle. */
  chimney?: string;
  window?: string;
  /** Windows glow rather than recede once the lamps are lit. */
  windowLit?: boolean;
  outline: string;
}

export interface HouseSpec {
  w: number;
  d: number;
  wallH: number;
  roofH: number;
  shape: RoofShape;
  /** Chimney count, 0 to 3. Placed deterministically along the ridge. */
  chimneys: number;
  /** Rows of windows on the visible faces. */
  windowRows: number;
  /** A glazed ground floor with an awning: shops, pubs, banks. */
  shopfront?: boolean;
  /** A hanging signboard. */
  sign?: boolean;
  /** Dormers on the near roof slope. */
  dormers?: number;
  /** Windows boarded over: the rot, on the building itself. */
  boarded?: boolean;
  /** Flags up. The player paid for these. */
  bunting?: boolean;
  /** Awning colour for a shopfront. */
  awning?: string;
  /** Stable per-building number, so detail varies without being random. */
  salt?: number;
  skin: HouseSkin;
  /** Ridge along the tx axis when true, otherwise along ty. Defaults to the
   *  longer footprint axis, which is what makes a terrace read as a row. */
  ridgeAlongX?: boolean;
}

interface Pt { x: number; y: number }

/** World-pixel bounds of the whole house relative to its SOUTH corner tile centre. */
export function houseBounds(spec: HouseSpec) {
  const sx = spec.w - 1;
  const sy = spec.d - 1;
  const ox = isoX(sx, sy);
  const oy = isoY(sx, sy);
  const top = spec.wallH + spec.roofH + (spec.chimneys > 0 ? 9 : 0);
  return {
    minX: isoX(0, sy) - TILE_W / 2 - ox,
    maxX: isoX(sx, 0) + TILE_W / 2 - ox,
    minY: isoY(0, 0) - TILE_H / 2 - top - oy,
    maxY: isoY(sx, sy) + TILE_H / 2 - oy,
  };
}

function corners(ox: number, oy: number, w: number, d: number, lift: number) {
  const sx = w - 1;
  const sy = d - 1;
  const bx = ox - isoX(sx, sy);
  const by = oy - isoY(sx, sy) - lift;
  return {
    W: { x: bx + isoX(0, sy) - TILE_W / 2, y: by + isoY(0, sy) },
    N: { x: bx + isoX(0, 0), y: by + isoY(0, 0) - TILE_H / 2 },
    E: { x: bx + isoX(sx, 0) + TILE_W / 2, y: by + isoY(sx, 0) },
    S: { x: bx + isoX(sx, sy), y: by + isoY(sx, sy) + TILE_H / 2 },
  };
}

/** Every face goes through the hard rasteriser. ctx.fill() would antialias the
 *  diagonals, which is the whole reason this looked like vector art. */
function poly(ctx: CanvasRenderingContext2D, pts: Pt[], fill: string, texture = 0): void {
  fillPolyHard(ctx, pts, fill);
  // A light ordered dither of the shade colour into the lit colour. Pixel art
  // shades by scattering existing colours rather than blending toward new ones,
  // and this is where a flat face stops being flat.
  if (texture > 0) ditherPolyHard(ctx, pts, shadeHex(fill, -0.14), texture);
}

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const up = (p: Pt, h: number): Pt => ({ x: p.x, y: p.y - h });

/**
 * Draw a house. ox, oy is where the SOUTH corner tile's diamond centre sits.
 */
export function drawHouse(ctx: CanvasRenderingContext2D, ox: number, oy: number, spec: HouseSpec): void {
  const { w, d, wallH, skin } = spec;
  const ground = corners(ox, oy, w, d, 0);
  const eave = corners(ox, oy, w, d, wallH);

  // Walls. Only the +ty face (W to S) and the +tx face (S to E) are visible.
  poly(ctx, [eave.W, ground.W, ground.S, eave.S], skin.wallLit, 2);
  poly(ctx, [eave.S, ground.S, ground.E, eave.E], skin.wallShade, 3);

  const alongX = spec.ridgeAlongX ?? w >= d;
  const roofQuad = drawRoof(ctx, eave, spec, alongX);
  drawFacade(ctx, eave, spec);
  if (roofQuad && spec.dormers) {
    const n = Math.min(3, spec.dormers);
    for (let i = 0; i < n; i++) {
      drawDormer(ctx, roofQuad, (i + 1) / (n + 1), detailSkin(spec), spec.skin.roofLit);
    }
  }

  if (skin.trim) {
    // The cornice: one line where the wall meets the eave. This is the gilding,
    // and it is deliberately on the buildings whose fabric is worst.
    lineHard(ctx, eave.W, eave.S, skin.trim);
    lineHard(ctx, eave.S, eave.E, skin.trim);
  }

  // Selective ink outline on the south and east silhouette only, away from the
  // light. A full outline makes an iso town read as a sheet of stickers.
  lineHard(ctx, ground.W, ground.S, skin.outline);
  lineHard(ctx, ground.S, ground.E, skin.outline);
}

function detailSkin(spec: HouseSpec): DetailSkin {
  return {
    wall: spec.skin.wallLit,
    wallDark: shadeHex(spec.skin.wallShade, -0.2),
    timber: shadeHex(spec.skin.wallShade, -0.3),
    glass: spec.skin.window ?? PAL.darkWindow,
    glassLit: spec.skin.windowLit === true,
    trim: spec.skin.trim,
    outline: spec.skin.outline,
  };
}

/**
 * Everything that happens on a wall: shopfront, door, windows, sign, boards,
 * bunting. Drawn AFTER the roof so an awning can overlap the eave line, which is
 * how a real shopfront sits.
 */
function drawFacade(
  ctx: CanvasRenderingContext2D,
  eave: { W: Pt; N: Pt; E: Pt; S: Pt },
  spec: HouseSpec,
): void {
  const skin = detailSkin(spec);
  const salt = spec.salt ?? 0;
  const lit = makeFace(eave.W, eave.S, true);
  const shade = makeFace(eave.S, eave.E, false);

  for (const f of [lit, shade]) {
    if (f.span < 8) continue;
    drawWindowGrid(ctx, f, spec.wallH, spec.windowRows, skin, spec.shopfront === true, salt + (f.lit ? 0 : 5));
    if (spec.boarded) drawBoarded(ctx, f, spec.wallH, skin);
  }

  // The shopfront and the door go on the lit face: the one the camera can see.
  if (spec.shopfront && lit.span >= 10) {
    drawShopfront(ctx, lit, spec.wallH, skin, spec.awning ?? PAL.buntRed);
  } else if (lit.span >= 8) {
    drawDoor(ctx, lit, 0.28 + ((salt % 5) / 12), spec.wallH, skin);
  }
  if (spec.sign && lit.span >= 10) drawSign(ctx, lit, 0.8, spec.wallH, skin);
  if (spec.bunting && lit.span >= 12) drawBunting(ctx, lit, spec.wallH);
}

function drawRoof(
  ctx: CanvasRenderingContext2D,
  eave: { W: Pt; N: Pt; E: Pt; S: Pt },
  spec: HouseSpec, alongX: boolean,
): Pt[] | null {
  const { roofH, skin } = spec;
  const over = 1.5; // eaves overhang, which is what casts the shadow line

  const W = { x: eave.W.x - over, y: eave.W.y };
  const N = { x: eave.N.x, y: eave.N.y - over / 2 };
  const E = { x: eave.E.x + over, y: eave.E.y };
  const S = { x: eave.S.x, y: eave.S.y + over / 2 };

  if (spec.shape === 'flat') {
    poly(ctx, [N, E, S, W], skin.roofShade);
    poly(ctx, [
      { x: N.x, y: N.y - 3 }, { x: E.x, y: E.y - 3 },
      { x: S.x, y: S.y - 3 }, { x: W.x, y: W.y - 3 },
    ], skin.roofLit);
    return null;
  }

  if (spec.shape === 'pyramid') {
    const apex = up(mid(mid(W, E), mid(N, S)), roofH);
    poly(ctx, [N, E, apex], skin.roofShade);
    poly(ctx, [E, S, apex], shadeHex(skin.roofShade, -0.12));
    poly(ctx, [W, N, apex], skin.roofLit);
    poly(ctx, [S, W, apex], skin.roofLit);
    lineHard(ctx, S, apex, skin.roofRidge);
    lineHard(ctx, apex, E, skin.roofRidge);
    return null;
  }

  // Gable and hip both have a ridge. Along tx the ridge spans the W-N edge
  // midpoint to the S-E edge midpoint; along ty it is the other pair.
  const r0 = up(alongX ? mid(W, N) : mid(N, E), roofH);
  const r1 = up(alongX ? mid(S, E) : mid(W, S), roofH);

  if (spec.shape === 'hip' || spec.shape === 'mansard') {
    // Hip: the ridge is pulled in from both ends, so all four faces slope.
    const pull = 0.28;
    const h0 = { x: r0.x + (r1.x - r0.x) * pull, y: r0.y + (r1.y - r0.y) * pull };
    const h1 = { x: r1.x + (r0.x - r1.x) * pull, y: r1.y + (r0.y - r1.y) * pull };
    if (alongX) {
      poly(ctx, [N, E, h1, h0], skin.roofShade, 3);
      poly(ctx, [W, N, h0], skin.roofLit);
      poly(ctx, [W, S, h1, h0], skin.roofLit, 4);
      poly(ctx, [S, E, h1], shadeHex(skin.roofShade, -0.1));
    } else {
      poly(ctx, [E, S, h1, h0], skin.roofShade, 3);
      poly(ctx, [N, E, h0], shadeHex(skin.roofShade, 0.06));
      poly(ctx, [W, S, h1, h0], skin.roofLit, 4);
      poly(ctx, [W, N, h0], skin.roofLit);
    }
    ridgeLine(ctx, h0, h1, skin.roofRidge);
    chimneys(ctx, h0, h1, spec);
    const nearHip: Pt[] = [W, S, h1, h0];
    drawCourses(ctx, nearHip, shadeHex(skin.roofLit, -0.1), 4);
    return nearHip;
  }

  // Gable. Far slope first, then the near one, then the near gable triangle.
  if (alongX) {
    poly(ctx, [N, E, r1, r0], skin.roofShade, 3);
    poly(ctx, [W, S, r1, r0], skin.roofLit, 4);
    poly(ctx, [S, E, r1], skin.gableShade);
    poly(ctx, [W, N, r0], skin.gableLit);
  } else {
    poly(ctx, [E, S, r1, r0], skin.roofShade, 3);
    poly(ctx, [W, N, r0, r1], skin.roofLit, 4);
    poly(ctx, [W, S, r1], skin.gableLit);
    poly(ctx, [N, E, r0], skin.gableShade);
  }
  ridgeLine(ctx, r0, r1, skin.roofRidge);
  chimneys(ctx, r0, r1, spec);
  // Tile courses on the near slope. Four lines, and a roof stops being a plane.
  const near: Pt[] = [W, S, r1, r0];
  drawCourses(ctx, near, shadeHex(skin.roofLit, -0.12), 4);
  return near;
}

function ridgeLine(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, colour: string): void {
  lineHard(ctx, a, b, colour);
}

/**
 * Chimneys, at the ridge ENDS.
 *
 * They used to sit at t = 1/2 on every single house in the district, in the WALL
 * colour, four pixels wide on a seven pixel roof: bright cream sticks dead centre
 * of every terrace, reading as candles. A chimney belongs at a gable end because
 * that is where the flue runs, it is brick or soot rather than stucco, and it is
 * narrow.
 */
function chimneys(ctx: CanvasRenderingContext2D, r0: Pt, r1: Pt, spec: HouseSpec): void {
  if (spec.chimneys <= 0) return;
  const n = Math.min(3, spec.chimneys);
  const stops = n === 1 ? [0.12] : n === 2 ? [0.1, 0.9] : [0.1, 0.5, 0.9];
  const brick = spec.skin.chimney ?? PAL.brick0;
  for (let i = 0; i < stops.length; i++) {
    const t = stops[i];
    const x = Math.round(r0.x + (r1.x - r0.x) * t);
    const y = Math.round(r0.y + (r1.y - r0.y) * t);
    const h = 4 + ((i + (spec.salt ?? 0)) % 2);
    ctx.fillStyle = brick;
    ctx.fillRect(x - 1, y - h, 3, h);
    ctx.fillStyle = shadeHex(brick, 0.15);
    ctx.fillRect(x - 1, y - h, 1, h);
    ctx.fillStyle = spec.skin.outline;
    ctx.fillRect(x - 1, y - h - 1, 3, 1);
  }
}
