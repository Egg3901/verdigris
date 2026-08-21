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
  drawBrickFace, drawAshlarFace, drawTimberFace, drawBoardFace, drawGlazedFace,
  drawStuccoMottle, drawRidgeCrest, drawWashingLine, drawSootStreaks,
  drawRoofPatch, drawEaveRail,
} from './detail';
import type { DetailSkin, WallMaterial } from './detail';
import { drawFinial, drawMooringMast } from './landmarks';
import type { Corners } from './landmarks';

export type RoofShape =
  | 'gable' | 'hip' | 'pyramid' | 'flat' | 'mansard' | 'gambrel' | 'sawtooth' | 'dome';

export type Finial = 'none' | 'spire' | 'dome' | 'cupola' | 'stack' | 'mast' | 'gasometer';

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
  material: WallMaterial;
  polite: boolean;
  patched?: boolean;
  washing?: boolean;
  cresting?: boolean;
  railings?: boolean;
  finial: Finial;
  finialH: number;
}

interface Pt { x: number; y: number }

/** World-pixel bounds of the whole house relative to its SOUTH corner tile centre. */
export function houseBounds(spec: HouseSpec) {
  const sx = spec.w - 1;
  const sy = spec.d - 1;
  const ox = isoX(sx, sy);
  const oy = isoY(sx, sy);
  const top = spec.wallH + spec.roofH + spec.finialH + (spec.chimneys > 0 ? 9 : 0);
  return {
    minX: isoX(0, sy) - TILE_W / 2 - ox - 2,
    maxX: isoX(sx, 0) + TILE_W / 2 - ox + 2,
    minY: isoY(0, 0) - TILE_H / 2 - top - oy,
    maxY: isoY(sx, sy) + TILE_H / 2 - oy + 2,
  };
}

export function houseCorners(ox: number, oy: number, w: number, d: number, lift: number): Corners {
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
const lerp = (a: Pt, b: Pt, t: number): Pt => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
});

/**
 * Draw a house. ox, oy is where the SOUTH corner tile's diamond centre sits.
 */
export function drawHouse(ctx: CanvasRenderingContext2D, ox: number, oy: number, spec: HouseSpec): void {
  const { w, d, wallH, skin } = spec;
  const ground = houseCorners(ox, oy, w, d, 0);
  const eave = houseCorners(ox, oy, w, d, wallH);

  if (spec.finial === 'mast') {
    drawMooringMast(ctx, ground, spec);
    return;
  }

  const litPts: Pt[] = [eave.W, ground.W, ground.S, eave.S];
  const shadePts: Pt[] = [eave.S, ground.S, ground.E, eave.E];
  const mottle = spec.material === 'stucco' ? 4 : spec.material === 'brick' ? 1 : 2;
  poly(ctx, litPts, skin.wallLit, mottle);
  poly(ctx, shadePts, skin.wallShade, mottle + 1);

  const lit = makeFace(eave.W, eave.S, true);
  const shade = makeFace(eave.S, eave.E, false);
  drawMaterials(ctx, lit, shade, litPts, shadePts, spec);

  const alongX = spec.ridgeAlongX ?? w >= d;
  const roofQuad = drawRoof(ctx, eave, spec, alongX);
  drawFinial(ctx, ground, eave, spec, alongX);
  drawFacade(ctx, eave, spec);
  if (roofQuad && spec.dormers) {
    const n = Math.min(3, spec.dormers);
    for (let i = 0; i < n; i++) {
      drawDormer(ctx, roofQuad, (i + 1) / (n + 1), detailSkin(spec), spec.skin.roofLit);
    }
  }
  if (roofQuad && spec.patched) {
    drawRoofPatch(ctx, roofQuad, shadeHex(skin.roofShade, -0.08));
  }

  if (spec.washing && lit.span >= 10) drawWashingLine(ctx, lit, wallH, spec.salt ?? 0);

  if (skin.trim) {
    // The cornice: one line where the wall meets the eave. This is the gilding,
    // and it is deliberately on the buildings whose fabric is worst.
    lineHard(ctx, eave.W, eave.S, skin.trim);
    lineHard(ctx, eave.S, eave.E, skin.trim);
  }
  if (spec.railings) {
    drawEaveRail(ctx, eave.W, eave.S, spec.polite ? PAL.soot2 : PAL.soot1);
  }

  // Selective ink outline on the south and east silhouette only, away from the
  // light. A full outline makes an iso town read as a sheet of stickers.
  lineHard(ctx, ground.W, ground.S, skin.outline);
  lineHard(ctx, ground.S, ground.E, skin.outline);

  // AND a line where the roof meets the wall, on the same two near edges.
  //
  // Without it, a packed terrace at night is a field of dark wedges: the roofs
  // are all the same value, they overlap by design because the plots are one
  // cell apart, and nothing says where one building stops. The handful with a
  // gilded cornice read perfectly and everything else read as mush, which is
  // what gave the game away. This is that cornice line, in ink, for the
  // buildings that cannot afford brass.
  if (!skin.trim) {
    lineHard(ctx, eave.W, eave.S, skin.outline);
    lineHard(ctx, eave.S, eave.E, skin.outline);
  }
}

function drawMaterials(
  ctx: CanvasRenderingContext2D, lit: ReturnType<typeof makeFace>, shade: ReturnType<typeof makeFace>,
  litPts: Pt[], shadePts: Pt[], spec: HouseSpec,
): void {
  const { wallH, skin, material, salt } = spec;
  const mortar = material === 'brick' ? skin.outline : shadeHex(skin.wallShade, -0.4);
  const ds = detailSkin(spec);
  for (const f of [lit, shade]) {
    if (f.span < 6) continue;
    switch (material) {
      case 'brick':
        drawBrickFace(ctx, f, wallH, mortar);
        break;
      case 'ashlar':
        drawAshlarFace(ctx, f, wallH, mortar, shadeHex(skin.wallLit, 0.1));
        break;
      case 'timber':
        drawTimberFace(ctx, f, wallH, ds.timber);
        break;
      case 'wood':
        drawBoardFace(ctx, f, wallH, shadeHex(skin.wallShade, -0.16));
        break;
      case 'glazed':
        drawGlazedFace(ctx, f, wallH, ds, PAL.soot2);
        break;
      default:
        drawStuccoMottle(ctx, f.lit ? litPts : shadePts, shadeHex(skin.wallLit, f.lit ? 0.08 : -0.1), salt ?? 0);
        break;
    }
    if (!spec.polite) drawSootStreaks(ctx, f, wallH, shadeHex(PAL.soot1, 0), salt ?? 0);
  }
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
    if (spec.material !== 'glazed') {
      drawWindowGrid(ctx, f, spec.wallH, spec.windowRows, skin, spec.shopfront === true, salt + (f.lit ? 0 : 5));
    }
    if (spec.boarded) drawBoarded(ctx, f, spec.wallH, skin);
  }

  // The shopfront and the door go on the lit face: the one the camera can see.
  if (spec.shopfront && lit.span >= 10) {
    drawShopfront(ctx, lit, spec.wallH, skin, spec.awning ?? PAL.buntRed);
  } else if (lit.span >= 8 && spec.material !== 'glazed') {
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

  if (spec.shape === 'dome') {
    // A low hip as the surrounding roof, then the drum and dome sit on it.
    const low = Math.max(5, Math.round(roofH * 0.4));
    const pull = 0.28;
    const r0 = up(alongX ? mid(W, N) : mid(N, E), low);
    const r1 = up(alongX ? mid(S, E) : mid(W, S), low);
    const h0 = { x: r0.x + (r1.x - r0.x) * pull, y: r0.y + (r1.y - r0.y) * pull };
    const h1 = { x: r1.x + (r0.x - r1.x) * pull, y: r1.y + (r0.y - r1.y) * pull };
    poly(ctx, [W, S, h1, h0], skin.roofLit, 3);
    poly(ctx, [S, E, h1], shadeHex(skin.roofShade, -0.1));
    poly(ctx, [N, E, h1, h0], skin.roofShade, 2);
    ridgeLine(ctx, h0, h1, skin.roofRidge, spec);
    return [W, S, h1, h0];
  }

  if (spec.shape === 'sawtooth') {
    return drawSawtooth(ctx, W, N, E, S, spec, alongX);
  }

  if (spec.shape === 'gambrel') {
    return drawGambrel(ctx, W, N, E, S, spec, alongX);
  }

  if (spec.shape === 'mansard') {
    return drawMansard(ctx, W, N, E, S, spec, alongX);
  }

  // Gable and hip both have a ridge. Along tx the ridge spans the W-N edge
  // midpoint to the S-E edge midpoint; along ty it is the other pair.
  const r0 = up(alongX ? mid(W, N) : mid(N, E), roofH);
  const r1 = up(alongX ? mid(S, E) : mid(W, S), roofH);

  if (spec.shape === 'hip') {
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
    ridgeLine(ctx, h0, h1, skin.roofRidge, spec);
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
  ridgeLine(ctx, r0, r1, skin.roofRidge, spec);
  chimneys(ctx, r0, r1, spec);
  // Tile courses on the near slope. Four lines, and a roof stops being a plane.
  const near: Pt[] = [W, S, r1, r0];
  drawCourses(ctx, near, shadeHex(skin.roofLit, -0.12), 4);
  return near;
}

function drawMansard(
  ctx: CanvasRenderingContext2D, W: Pt, N: Pt, E: Pt, S: Pt,
  spec: HouseSpec, alongX: boolean,
): Pt[] {
  const { roofH, skin } = spec;
  const c = mid(mid(W, E), mid(N, S));
  const inset = 0.32;
  const deckH = Math.max(6, Math.round(roofH * 0.72));
  const I = {
    W: up(lerp(W, c, inset), deckH),
    N: up(lerp(N, c, inset), deckH),
    E: up(lerp(E, c, inset), deckH),
    S: up(lerp(S, c, inset), deckH),
  };
  // Steep lower faces. Near first after far so the camera-facing slope wins.
  poly(ctx, [N, E, I.E, I.N], skin.roofShade, 3);
  poly(ctx, [S, E, I.E, I.S], shadeHex(skin.roofShade, -0.1));
  poly(ctx, [W, N, I.N, I.W], skin.roofLit);
  poly(ctx, [W, S, I.S, I.W], skin.roofLit, 4);
  const near: Pt[] = [W, S, I.S, I.W];
  drawCourses(ctx, near, shadeHex(skin.roofLit, -0.12), 5);

  // Shallow deck: a small hip.
  const remain = Math.max(3, roofH - deckH);
  const r0 = up(alongX ? mid(I.W, I.N) : mid(I.N, I.E), remain);
  const r1 = up(alongX ? mid(I.S, I.E) : mid(I.W, I.S), remain);
  const pull = 0.22;
  const h0 = lerp(r0, r1, pull);
  const h1 = lerp(r1, r0, pull);
  poly(ctx, [I.N, I.E, h1, h0], shadeHex(skin.roofShade, 0.04));
  poly(ctx, [I.W, I.S, h1, h0], shadeHex(skin.roofLit, 0.06), 2);
  ridgeLine(ctx, h0, h1, skin.roofRidge, spec);
  chimneys(ctx, h0, h1, spec);
  return near;
}

function drawGambrel(
  ctx: CanvasRenderingContext2D, W: Pt, N: Pt, E: Pt, S: Pt,
  spec: HouseSpec, alongX: boolean,
): Pt[] {
  const { roofH, skin } = spec;
  const r0 = up(alongX ? mid(W, N) : mid(N, E), roofH);
  const r1 = up(alongX ? mid(S, E) : mid(W, S), roofH);
  const k = 0.38;
  const breakH = roofH * 0.62;
  // Break points sit higher than a linear slope, which is the whole gambrel read.
  const n0 = alongX
    ? { x: W.x + (r0.x - W.x) * k, y: W.y - breakH }
    : { x: W.x + (r1.x - W.x) * k, y: W.y - breakH };
  const n1 = alongX
    ? { x: S.x + (r1.x - S.x) * k, y: S.y - breakH }
    : { x: S.x + (r1.x - S.x) * k, y: S.y - breakH };
  const f0 = alongX
    ? { x: N.x + (r0.x - N.x) * k, y: N.y - breakH }
    : { x: N.x + (r0.x - N.x) * k, y: N.y - breakH };
  const f1 = alongX
    ? { x: E.x + (r1.x - E.x) * k, y: E.y - breakH }
    : { x: E.x + (r0.x - E.x) * k, y: E.y - breakH };

  if (alongX) {
    poly(ctx, [N, E, f1, f0], skin.roofShade, 2);
    poly(ctx, [f0, f1, r1, r0], shadeHex(skin.roofShade, -0.06), 2);
    poly(ctx, [W, S, n1, n0], skin.roofLit, 3);
    poly(ctx, [n0, n1, r1, r0], shadeHex(skin.roofLit, 0.06), 3);
    // Broken gable silhouette, not a triangle.
    poly(ctx, [S, E, f1, r1, n1], skin.gableShade);
    poly(ctx, [W, N, f0, r0, n0], skin.gableLit);
  } else {
    poly(ctx, [E, S, n1, f1], skin.roofShade, 2);
    poly(ctx, [f1, n1, r1, r0], shadeHex(skin.roofShade, -0.06), 2);
    poly(ctx, [W, N, r0, n0], skin.roofLit, 3);
    poly(ctx, [n0, r0, r1, n1], shadeHex(skin.roofLit, 0.06), 3);
    poly(ctx, [W, S, n1, n0], skin.gableLit);
    poly(ctx, [N, E, f1, f0], skin.gableShade);
  }
  ridgeLine(ctx, r0, r1, skin.roofRidge, spec);
  chimneys(ctx, r0, r1, spec);
  const near: Pt[] = alongX ? [W, S, n1, n0] : [W, N, r0, n0];
  drawCourses(ctx, near, shadeHex(skin.roofLit, -0.12), 3);
  return near;
}

function drawSawtooth(
  ctx: CanvasRenderingContext2D, W: Pt, N: Pt, E: Pt, S: Pt,
  spec: HouseSpec, alongX: boolean,
): Pt[] | null {
  const { roofH, skin } = spec;
  const long = alongX ? spec.w : spec.d;
  const n = Math.max(2, Math.min(4, long - (long > 3 ? 1 : 0)));
  let lastNear: Pt[] | null = null;
  let lastRidge: [Pt, Pt] | null = null;
  for (let i = 0; i < n; i++) {
    const u0 = i / n;
    const u1 = (i + 1) / n;
    // Strips along the long axis. Peak sits near u0 so the steep glazed face
    // is the one the camera catches.
    const a0 = alongX ? lerp(W, S, u0) : lerp(W, N, u0);
    const a1 = alongX ? lerp(W, S, u1) : lerp(W, N, u1);
    const b0 = alongX ? lerp(N, E, u0) : lerp(S, E, u0);
    const b1 = alongX ? lerp(N, E, u1) : lerp(S, E, u1);
    const pk = 0.28;
    const pA = up(lerp(a0, a1, pk), roofH);
    const pB = up(lerp(b0, b1, pk), roofH);
    // Glazed steep face.
    const glass = spec.skin.windowLit ? PAL.rivGlint : shadeHex(PAL.darkWindow, 0.1);
    poly(ctx, [a0, b0, pB, pA], glass, 2);
    lineHard(ctx, a0, pA, PAL.soot2);
    lineHard(ctx, b0, pB, PAL.soot2);
    // Shallow tiled slope.
    poly(ctx, [pA, pB, b1, a1], skin.roofLit, 3);
    poly(ctx, [pB, b1, b0], skin.roofShade);
    lastNear = [pA, a1, b1, pB];
    lastRidge = [pA, pB];
    drawCourses(ctx, [a1, pA, pB, b1], shadeHex(skin.roofLit, -0.12), 3);
  }
  if (lastRidge) {
    ridgeLine(ctx, lastRidge[0], lastRidge[1], skin.roofRidge, spec);
    chimneys(ctx, lastRidge[0], lastRidge[1], spec);
  }
  return lastNear;
}

function ridgeLine(
  ctx: CanvasRenderingContext2D, a: Pt, b: Pt, colour: string, spec?: HouseSpec,
): void {
  lineHard(ctx, a, b, colour);
  if (spec?.cresting) {
    drawRidgeCrest(ctx, a, b, spec.skin.trim ?? spec.skin.roofRidge, spec.polite);
  }
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
