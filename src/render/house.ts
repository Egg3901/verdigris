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

function poly(ctx: CanvasRenderingContext2D, pts: Pt[], fill: string): void {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fill();
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
  poly(ctx, [eave.W, ground.W, ground.S, eave.S], skin.wallLit);
  poly(ctx, [eave.S, ground.S, ground.E, eave.E], skin.wallShade);

  drawWindows(ctx, ground, eave, spec);

  const alongX = spec.ridgeAlongX ?? w >= d;
  drawRoof(ctx, eave, spec, alongX);

  if (skin.trim) {
    // The cornice: one line where the wall meets the eave. This is the gilding,
    // and it is deliberately on the buildings whose fabric is worst.
    ctx.strokeStyle = skin.trim;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(eave.W.x + 0.5, eave.W.y + 0.5);
    ctx.lineTo(eave.S.x + 0.5, eave.S.y + 0.5);
    ctx.lineTo(eave.E.x + 0.5, eave.E.y + 0.5);
    ctx.stroke();
  }

  // Selective ink outline on the south and east silhouette only, away from the
  // light. A full outline makes an iso town read as a sheet of stickers.
  ctx.strokeStyle = skin.outline;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ground.W.x + 0.5, ground.W.y - 0.5);
  ctx.lineTo(ground.S.x + 0.5, ground.S.y - 0.5);
  ctx.lineTo(ground.E.x + 0.5, ground.E.y - 0.5);
  ctx.stroke();
}

function drawRoof(
  ctx: CanvasRenderingContext2D,
  eave: { W: Pt; N: Pt; E: Pt; S: Pt },
  spec: HouseSpec, alongX: boolean,
): void {
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
    return;
  }

  if (spec.shape === 'pyramid') {
    const apex = up(mid(mid(W, E), mid(N, S)), roofH);
    poly(ctx, [N, E, apex], skin.roofShade);
    poly(ctx, [E, S, apex], shadeHex(skin.roofShade, -0.12));
    poly(ctx, [W, N, apex], skin.roofLit);
    poly(ctx, [S, W, apex], skin.roofLit);
    ctx.strokeStyle = skin.roofRidge;
    ctx.beginPath();
    ctx.moveTo(S.x + 0.5, S.y + 0.5);
    ctx.lineTo(apex.x + 0.5, apex.y + 0.5);
    ctx.lineTo(E.x + 0.5, E.y + 0.5);
    ctx.stroke();
    return;
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
      poly(ctx, [N, E, h1, h0], skin.roofShade);
      poly(ctx, [W, N, h0], skin.roofLit);
      poly(ctx, [W, S, h1, h0], skin.roofLit);
      poly(ctx, [S, E, h1], shadeHex(skin.roofShade, -0.1));
    } else {
      poly(ctx, [E, S, h1, h0], skin.roofShade);
      poly(ctx, [N, E, h0], shadeHex(skin.roofShade, 0.06));
      poly(ctx, [W, S, h1, h0], skin.roofLit);
      poly(ctx, [W, N, h0], skin.roofLit);
    }
    ridgeLine(ctx, h0, h1, skin.roofRidge);
    chimneys(ctx, h0, h1, spec);
    return;
  }

  // Gable. Far slope first, then the near one, then the near gable triangle.
  if (alongX) {
    poly(ctx, [N, E, r1, r0], skin.roofShade);
    poly(ctx, [W, S, r1, r0], skin.roofLit);
    poly(ctx, [S, E, r1], skin.gableShade);
    poly(ctx, [W, N, r0], skin.gableLit);
  } else {
    poly(ctx, [E, S, r1, r0], skin.roofShade);
    poly(ctx, [W, N, r0, r1], skin.roofLit);
    poly(ctx, [W, S, r1], skin.gableLit);
    poly(ctx, [N, E, r0], skin.gableShade);
  }
  ridgeLine(ctx, r0, r1, skin.roofRidge);
  chimneys(ctx, r0, r1, spec);
}

function ridgeLine(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, colour: string): void {
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(a.x + 0.5, a.y + 0.5);
  ctx.lineTo(b.x + 0.5, b.y + 0.5);
  ctx.stroke();
}

/** Chimneys sit ON the ridge, which is the only place they read as chimneys and
 *  not as posts stuck in a roof. */
function chimneys(ctx: CanvasRenderingContext2D, r0: Pt, r1: Pt, spec: HouseSpec): void {
  if (spec.chimneys <= 0) return;
  const n = Math.min(3, spec.chimneys);
  for (let i = 0; i < n; i++) {
    const t = (i + 1) / (n + 1);
    const x = Math.round(r0.x + (r1.x - r0.x) * t);
    const y = Math.round(r0.y + (r1.y - r0.y) * t);
    const h = 7 + (i % 2) * 2;
    ctx.fillStyle = spec.skin.wallShade;
    ctx.fillRect(x - 2, y - h, 4, h);
    ctx.fillStyle = spec.skin.wallLit;
    ctx.fillRect(x - 2, y - h, 2, h);
    ctx.fillStyle = spec.skin.outline;
    ctx.fillRect(x - 2, y - h - 1, 4, 1);
  }
}

/** Window rows on the two visible faces. Small, dark, regular: at this scale a
 *  window is two pixels and its job is rhythm, not detail. */
function drawWindows(
  ctx: CanvasRenderingContext2D,
  ground: { W: Pt; N: Pt; E: Pt; S: Pt },
  eave: { W: Pt; N: Pt; E: Pt; S: Pt },
  spec: HouseSpec,
): void {
  if (!spec.skin.window || spec.windowRows <= 0) return;
  ctx.fillStyle = spec.skin.window;
  const lit = spec.skin.windowLit === true;
  const rows = Math.min(4, spec.windowRows);

  for (const [a, b, litFace] of [[eave.W, eave.S, true], [eave.S, eave.E, false]] as [Pt, Pt, boolean][]) {
    const spanX = b.x - a.x;
    const spanY = b.y - a.y;
    const cells = Math.max(1, Math.round(Math.abs(spanX) / 11));
    for (let r = 0; r < rows; r++) {
      const yOff = 5 + r * Math.max(6, Math.floor((spec.wallH - 4) / rows));
      if (yOff > spec.wallH - 3) break;
      for (let c = 0; c < cells; c++) {
        const t = (c + 0.5) / cells;
        const x = Math.round(a.x + spanX * t);
        const y = Math.round(a.y + spanY * t) + yOff;
        // Not every window in a building is lit, or the town reads as a grid of
        // fairy lights. Two in three, chosen by a stable hash of the pane.
        if (lit && ((x * 7 + y * 13 + r * 5) % 3 === 0)) continue;
        ctx.globalAlpha = litFace ? 1 : 0.8;
        ctx.fillRect(x - 1, y, 2, 3);
      }
    }
  }
  ctx.globalAlpha = 1;
  void ground;
}
