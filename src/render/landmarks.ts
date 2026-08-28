// Hand-shaped landmarks. Nine silhouettes that have to read at 32x16, which means
// they cannot be the same extruded box as a terrace with a different colour.
//
// Each of these is baked once into the building sprite. Per-frame cost is zero.
import { PAL, shadeHex } from './palette';
import { fillPolyHard, ditherPolyHard, lineHard, fillEllipseHard } from './raster';
import type { Pt } from './raster';

/** The slice of a house the finials need. Kept here so this file does not import
 *  house.ts (house.ts imports this one). */
export interface FinialSpec {
  w: number;
  d: number;
  wallH: number;
  roofH: number;
  finialH: number;
  finial: string;
  skin: {
    wallLit: string;
    wallShade: string;
    gableLit: string;
    gableShade: string;
    roofLit: string;
    roofShade: string;
    roofRidge: string;
    trim?: string;
    chimney?: string;
    window?: string;
    windowLit?: boolean;
    outline: string;
  };
}

export interface Corners {
  W: Pt; N: Pt; E: Pt; S: Pt;
}

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const up = (p: Pt, h: number): Pt => ({ x: p.x, y: p.y - h });
const lerp = (a: Pt, b: Pt, t: number): Pt => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
});

function poly(ctx: CanvasRenderingContext2D, pts: Pt[], fill: string, texture = 0): void {
  fillPolyHard(ctx, pts, fill);
  if (texture > 0) ditherPolyHard(ctx, pts, shadeHex(fill, -0.14), texture);
}

/**
 * The mooring mast: a tapering iron lattice with two platforms, a brass cap,
 * and guy wires. It used to be a six-storey box with a pyramid on it, which at
 * this scale read as a factory with a hat.
 */
export function drawMooringMast(
  ctx: CanvasRenderingContext2D, ground: Corners, spec: FinialSpec,
): void {
  const { skin } = spec;
  const c = mid(mid(ground.W, ground.E), mid(ground.N, ground.S));
  const H = spec.finialH;
  const hutH = 8;
  // Equipment hut at the south, so the lattice has something to stand on.
  poly(ctx, [
    { x: c.x - 8, y: c.y - hutH }, { x: c.x + 2, y: c.y - hutH + 4 },
    { x: c.x + 2, y: c.y + 4 }, { x: c.x - 8, y: c.y },
  ], skin.wallLit, 2);
  poly(ctx, [
    { x: c.x + 2, y: c.y - hutH + 4 }, { x: c.x + 10, y: c.y - hutH },
    { x: c.x + 10, y: c.y }, { x: c.x + 2, y: c.y + 4 },
  ], skin.wallShade, 2);
  poly(ctx, [
    { x: c.x - 8, y: c.y - hutH }, { x: c.x + 2, y: c.y - hutH + 4 },
    { x: c.x + 10, y: c.y - hutH }, { x: c.x, y: c.y - hutH - 3 },
  ], skin.roofLit);

  const iron = PAL.soot3;
  const ironHi = shadeHex(PAL.soot3, 0.2);
  const baseHalf = 8;
  const topHalf = 2;
  const legs: [Pt, Pt][] = [
    [{ x: c.x - baseHalf, y: c.y + 2 }, { x: c.x - topHalf, y: c.y - H }],
    [{ x: c.x + baseHalf, y: c.y + 2 }, { x: c.x + topHalf, y: c.y - H }],
    [{ x: c.x - 5, y: c.y - 3 }, { x: c.x - 1, y: c.y - H - 2 }],
    [{ x: c.x + 5, y: c.y - 3 }, { x: c.x + 1, y: c.y - H - 2 }],
  ];
  for (const [a, b] of legs) {
    lineHard(ctx, a, b, iron);
    lineHard(ctx, { x: a.x + 1, y: a.y }, { x: b.x + 1, y: b.y }, iron);
  }

  const step = 7;
  for (let y = 5; y < H - 6; y += step) {
    const t = y / H;
    const half = baseHalf + (topHalf - baseHalf) * t;
    const yy = c.y - y;
    lineHard(ctx, { x: c.x - half, y: yy }, { x: c.x + half, y: yy }, iron);
    lineHard(ctx, { x: c.x - half, y: yy }, { x: c.x + half - 1, y: yy - step }, ironHi);
    lineHard(ctx, { x: c.x + half, y: yy }, { x: c.x - half + 1, y: yy - step }, ironHi);
  }

  // Platforms at a third and two thirds.
  for (const k of [0.34, 0.66]) {
    const y = c.y - H * k;
    const half = 5 - k * 2;
    poly(ctx, [
      { x: c.x - half, y: y - 1 }, { x: c.x + half, y: y - 1 },
      { x: c.x + half, y: y + 1 }, { x: c.x - half, y: y + 1 },
    ], PAL.soot2);
    lineHard(ctx, { x: c.x - half, y: y - 1 }, { x: c.x + half, y: y - 1 }, PAL.soot3);
  }

  // Guy wires to the footprint corners.
  const cap = { x: c.x, y: c.y - H };
  lineHard(ctx, cap, ground.W, ironHi);
  lineHard(ctx, cap, ground.E, ironHi);
  lineHard(ctx, cap, ground.S, ironHi);

  // Brass cap and a lamp at the top: this is where the gold budget is spent.
  const finial = spec.skin.trim ?? PAL.brass2;
  ctx.fillStyle = finial;
  ctx.fillRect(Math.round(c.x) - 3, Math.round(c.y - H) - 5, 7, 5);
  ctx.fillStyle = PAL.gold;
  ctx.fillRect(Math.round(c.x), Math.round(c.y - H) - 10, 1, 5);
  ctx.fillRect(Math.round(c.x) - 2, Math.round(c.y - H) - 6, 5, 2);
  ctx.fillRect(Math.round(c.x) - 1, Math.round(c.y - H) - 8, 3, 2);
}

/** One brick chimney shaft, lit on the west face, sooted at the crown. */
function drawOneStack(
  ctx: CanvasRenderingContext2D, base: Pt, H: number, bw: number, brick: string,
): void {
  const lit = shadeHex(brick, 0.18);
  const shade = shadeHex(brick, -0.22);
  const mortar = shadeHex(brick, -0.28);
  const topY = base.y - H;
  poly(ctx, [
    { x: base.x - bw, y: base.y - 2 }, { x: base.x, y: base.y + 2 },
    { x: base.x, y: topY + 4 }, { x: base.x - bw, y: topY },
  ], lit, 2);
  poly(ctx, [
    { x: base.x, y: base.y + 2 }, { x: base.x + bw, y: base.y - 1 },
    { x: base.x + bw, y: topY + 1 }, { x: base.x, y: topY + 4 },
  ], shade, 2);
  for (let y = 6; y < H - 6; y += 3) {
    lineHard(ctx, { x: base.x - bw, y: base.y - 2 - y }, { x: base.x, y: base.y + 2 - y }, mortar);
  }
  // The crown is sooted black from years of firing, then a flared lip and a
  // dark flue mouth. This is what makes a chimney read as a working flue.
  const soot = Math.min(H - 8, 10);
  poly(ctx, [
    { x: base.x - bw, y: topY + soot }, { x: base.x, y: topY + soot + 2 },
    { x: base.x, y: topY + 4 }, { x: base.x - bw, y: topY },
  ], shadeHex(PAL.soot1, 0.05), 3);
  poly(ctx, [
    { x: base.x - bw - 2, y: topY }, { x: base.x + bw + 2, y: topY + 2 },
    { x: base.x + bw, y: topY + 5 }, { x: base.x - bw, y: topY + 3 },
  ], shadeHex(brick, -0.08));
  poly(ctx, [
    { x: base.x - 2, y: topY + 1 }, { x: base.x + 2, y: topY + 2 },
    { x: base.x + 1, y: topY + 4 }, { x: base.x - 1, y: topY + 3 },
  ], PAL.soot0);
}

/**
 * A mill or foundry chimney range: not one stack but a cluster, a tall main
 * shaft with one or two shorter ones behind it, which is the silhouette that
 * says "works" across the whole district. Rising from the west corners so they
 * catch the light and overlap into a mass.
 */
export function drawStack(
  ctx: CanvasRenderingContext2D, ground: Corners, eave: Corners, spec: FinialSpec,
): void {
  const H = spec.wallH + spec.roofH + spec.finialH;
  const brick = spec.skin.chimney ?? PAL.brick1;
  const big = spec.w * spec.d >= 6;
  // Draw far/shorter stacks first so the tall near one overlaps them.
  drawOneStack(ctx, lerp(ground.N, ground.E, 0.32), Math.round(H * 0.7), 4, shadeHex(brick, -0.06));
  if (big) drawOneStack(ctx, lerp(ground.W, ground.N, 0.5), Math.round(H * 0.82), 5, brick);
  drawOneStack(ctx, lerp(ground.W, ground.S, 0.18), H, 6, brick);
  void eave;
}

/** Chapel spire: a square drum on the west ridge, then a thin pyramid. */
export function drawSpire(
  ctx: CanvasRenderingContext2D, eave: Corners, spec: FinialSpec, alongX: boolean,
): void {
  const { roofH, skin, finialH } = spec;
  const over = 1.5;
  const W = { x: eave.W.x - over, y: eave.W.y };
  const N = { x: eave.N.x, y: eave.N.y - over / 2 };
  const E = { x: eave.E.x + over, y: eave.E.y };
  const S = { x: eave.S.x, y: eave.S.y + over / 2 };
  const r0 = up(alongX ? mid(W, N) : mid(N, E), roofH);
  const r1 = up(alongX ? mid(S, E) : mid(W, S), roofH);
  const base = lerp(r0, r1, 0.2);
  const drum = 8;
  const hs = 5;
  // Drum in stone, so the slate spire reads against it.
  poly(ctx, [
    { x: base.x - hs, y: base.y - drum }, { x: base.x, y: base.y - drum + 2 },
    { x: base.x, y: base.y + 2 }, { x: base.x - hs, y: base.y },
  ], skin.gableLit ?? skin.wallLit);
  poly(ctx, [
    { x: base.x, y: base.y - drum + 2 }, { x: base.x + hs, y: base.y - drum },
    { x: base.x + hs, y: base.y }, { x: base.x, y: base.y + 2 },
  ], skin.gableShade ?? skin.wallShade);
  ctx.fillStyle = skin.window ?? PAL.darkWindow;
  ctx.fillRect(Math.round(base.x) - 2, Math.round(base.y) - drum + 3, 2, 5);

  const apex = up(base, finialH);
  const s = 6;
  const dW = { x: base.x - s, y: base.y - drum + 1 };
  const dE = { x: base.x + s, y: base.y - drum + 1 };
  const dN = { x: base.x, y: base.y - drum - 2 };
  const dS = { x: base.x, y: base.y - drum + 3 };
  poly(ctx, [dN, dE, apex], skin.roofShade);
  poly(ctx, [dE, dS, apex], shadeHex(skin.roofShade, -0.12));
  poly(ctx, [dS, dW, apex], skin.roofLit);
  poly(ctx, [dW, dN, apex], skin.roofLit);
  lineHard(ctx, dS, apex, skin.roofRidge);
  lineHard(ctx, apex, dE, skin.roofRidge);
  ctx.fillStyle = skin.trim ?? PAL.gold;
  ctx.fillRect(Math.round(apex.x) - 1, Math.round(apex.y) - 4, 3, 2);
  ctx.fillRect(Math.round(apex.x), Math.round(apex.y) - 7, 1, 4);
}

/** Civic dome on a short drum, sitting on the roof centre. */
export function drawDome(
  ctx: CanvasRenderingContext2D, eave: Corners, spec: FinialSpec,
): void {
  const { roofH, skin } = spec;
  const c = mid(mid(eave.W, eave.E), mid(eave.N, eave.S));
  const span = Math.hypot(eave.E.x - eave.W.x, eave.E.y - eave.W.y);
  const rx = Math.max(8, span * 0.22);
  const ry = rx * 0.48;
  const drum = Math.max(4, Math.round(roofH * 0.22));
  const body = skin.roofLit;
  const shade = skin.roofShade;
  // Drum, west-lit.
  poly(ctx, [
    { x: c.x - rx, y: c.y }, { x: c.x, y: c.y + ry },
    { x: c.x, y: c.y + ry - drum }, { x: c.x - rx, y: c.y - drum },
  ], shadeHex(skin.wallLit, -0.04));
  poly(ctx, [
    { x: c.x, y: c.y + ry }, { x: c.x + rx, y: c.y },
    { x: c.x + rx, y: c.y - drum }, { x: c.x, y: c.y + ry - drum },
  ], shadeHex(skin.wallShade, -0.04));
  fillEllipseHard(ctx, c.x, c.y - drum, rx, ry, shade);
  // Dome: stacked ellipses, light from the west.
  const dh = Math.max(10, roofH);
  fillEllipseHard(ctx, c.x, c.y - drum - dh * 0.28, rx, ry, body);
  fillEllipseHard(ctx, c.x - 1, c.y - drum - dh * 0.28, rx * 0.55, ry * 0.7, shadeHex(body, 0.12));
  fillEllipseHard(ctx, c.x, c.y - drum - dh * 0.58, rx * 0.72, ry * 0.62, shadeHex(body, 0.06));
  fillEllipseHard(ctx, c.x - 1, c.y - drum - dh * 0.58, rx * 0.38, ry * 0.4, skin.roofRidge);
  fillEllipseHard(ctx, c.x, c.y - drum - dh * 0.82, rx * 0.38, ry * 0.32, shade);

  // Ribs down the dome, from the lantern base to the springing line. These are
  // most of what says "dome" rather than "green blob" at this size.
  const crown = { x: c.x, y: c.y - drum - dh * 0.8 };
  for (const k of [-1, -0.5, 0, 0.5, 1]) {
    const rim = { x: c.x + rx * k, y: c.y - drum - ry * (1 - Math.abs(k)) * 0.3 };
    lineHard(ctx, crown, rim, shadeHex(k <= 0 ? shadeHex(body, 0.1) : shade, -0.05));
  }
  // A gold band at the springing, the one place the civic gilding is spent.
  const gild = skin.trim ?? PAL.gold;
  fillEllipseHard(ctx, c.x, c.y - drum, rx, ry, gild);
  fillEllipseHard(ctx, c.x, c.y - drum + 1, rx - 1, ry - 1, shadeHex(gild, -0.1));
  fillEllipseHard(ctx, c.x, c.y - drum, rx - 2, ry - 1, shade);

  // A little arcade of windows around the drum, warm when lit.
  const drumGlass = skin.windowLit ? PAL.litWindow : PAL.darkWindow;
  ctx.fillStyle = drumGlass;
  for (const k of [-0.62, -0.2, 0.2, 0.62]) {
    const wx = Math.round(c.x + rx * k);
    ctx.fillRect(wx, Math.round(c.y - drum + 1), 1, Math.max(2, drum - 1));
  }

  // Lantern, gold needle, and a small flag: the postcard finish.
  ctx.fillStyle = skin.wallLit;
  ctx.fillRect(Math.round(c.x) - 2, Math.round(c.y - drum - dh) - 1, 4, 5);
  ctx.fillStyle = gild;
  ctx.fillRect(Math.round(c.x), Math.round(c.y - drum - dh) - 8, 1, 7);
  ctx.fillStyle = PAL.buntRed;
  ctx.fillRect(Math.round(c.x) + 1, Math.round(c.y - drum - dh) - 8, 3, 2);
}

/** A glazed lantern on the ridge: exchange, school. */
export function drawCupola(
  ctx: CanvasRenderingContext2D, eave: Corners, spec: FinialSpec, alongX: boolean,
): void {
  const { roofH, skin } = spec;
  const over = 1.5;
  const W = { x: eave.W.x - over, y: eave.W.y };
  const N = { x: eave.N.x, y: eave.N.y - over / 2 };
  const E = { x: eave.E.x + over, y: eave.E.y };
  const S = { x: eave.S.x, y: eave.S.y + over / 2 };
  const r0 = up(alongX ? mid(W, N) : mid(N, E), roofH);
  const r1 = up(alongX ? mid(S, E) : mid(W, S), roofH);
  const b = mid(r0, r1);
  const h = 8;
  const w = 5;
  poly(ctx, [
    { x: b.x - w, y: b.y - h }, { x: b.x, y: b.y - h + 2 },
    { x: b.x, y: b.y + 2 }, { x: b.x - w, y: b.y },
  ], skin.wallLit);
  poly(ctx, [
    { x: b.x, y: b.y - h + 2 }, { x: b.x + w, y: b.y - h },
    { x: b.x + w, y: b.y }, { x: b.x, y: b.y + 2 },
  ], skin.wallShade);
  ctx.fillStyle = skin.windowLit ? PAL.litWindow : PAL.darkWindow;
  ctx.fillRect(Math.round(b.x) - 3, Math.round(b.y) - h + 3, 2, 3);
  ctx.fillRect(Math.round(b.x) + 1, Math.round(b.y) - h + 3, 2, 3);
  poly(ctx, [
    { x: b.x - w - 1, y: b.y - h }, { x: b.x + w + 1, y: b.y - h },
    { x: b.x, y: b.y - h - 5 },
  ], skin.roofLit);
  lineHard(ctx, { x: b.x - w - 1, y: b.y - h }, { x: b.x + w + 1, y: b.y - h }, skin.outline);

  // A clock face on the lantern: the exchange and the school keep time for the
  // ward. Pale dial, gilt rim, two hands.
  const cx = Math.round(b.x - 1);
  const cy = Math.round(b.y - h + 4);
  fillEllipseHard(ctx, cx, cy, 3, 3, skin.trim ?? PAL.gold);
  fillEllipseHard(ctx, cx, cy, 2, 2, PAL.buntCream);
  ctx.fillStyle = PAL.soot0;
  ctx.fillRect(cx, cy - 2, 1, 2);
  ctx.fillRect(cx, cy, 2, 1);

  // A weathervane on the peak.
  const vane = skin.trim ?? PAL.brass2;
  ctx.fillStyle = vane;
  ctx.fillRect(Math.round(b.x), Math.round(b.y - h - 5) - 4, 1, 4);
  ctx.fillRect(Math.round(b.x) - 1, Math.round(b.y - h - 5) - 4, 3, 1);
  ctx.fillStyle = PAL.gold;
  ctx.fillRect(Math.round(b.x) + 1, Math.round(b.y - h - 5) - 5, 2, 1);
}

/** Two gasometers beside a low engine house: the gasworks postcard. */
export function drawGasometers(
  ctx: CanvasRenderingContext2D, ground: Corners, spec: FinialSpec,
): void {
  const c = mid(mid(ground.W, ground.E), mid(ground.N, ground.S));
  const iron = PAL.soot2;
  const ring = PAL.soot3;
  const body = spec.skin.wallShade;
  const lit = spec.skin.wallLit;
  const tanks: [number, number, number, number][] = [
    [c.x - 6, c.y + 3, 12, 26],
    [c.x + 14, c.y - 3, 10, 20],
  ];
  for (const [cx, cy, rx, h] of tanks) {
    const ry = rx * 0.45;
    poly(ctx, [
      { x: cx - rx, y: cy }, { x: cx, y: cy },
      { x: cx, y: cy - h }, { x: cx - rx, y: cy - h },
    ], lit);
    poly(ctx, [
      { x: cx, y: cy }, { x: cx + rx, y: cy },
      { x: cx + rx, y: cy - h }, { x: cx, y: cy - h },
    ], body);
    fillEllipseHard(ctx, cx, cy, rx, ry, shadeHex(body, -0.1));
    fillEllipseHard(ctx, cx, cy - h, rx, ry, shadeHex(lit, 0.08));
    // A bright crown highlight, so the drum reads as a filled cylinder.
    fillEllipseHard(ctx, cx - 1, cy - h, rx * 0.5, ry * 0.6, shadeHex(lit, 0.16));
    for (let i = 1; i < 4; i++) {
      const y = cy - (h * i) / 4;
      lineHard(ctx, { x: cx - rx, y }, { x: cx + rx, y }, ring);
    }

    // The guide frame: the iron cage a gasholder rises and falls inside, and the
    // thing that makes a gasworks a gasworks rather than two oil drums. Standards
    // stand a little proud of the drum, joined by a top ring above the crown and
    // one tier of diagonal bracing.
    const frameH = h + 4;
    const cols = 5;
    const standX: number[] = [];
    for (let i = 0; i < cols; i++) {
      const x = Math.round(cx - rx + (2 * rx * i) / (cols - 1));
      standX.push(x);
      lineHard(ctx, { x, y: cy + 1 }, { x, y: cy - frameH }, i === 0 || i === cols - 1 ? iron : ring);
    }
    // Top ring and a lower ring, drawn as flattened ellipses on the frame.
    fillEllipseHard(ctx, cx, cy - frameH, rx + 1, ry * 0.7, iron);
    fillEllipseHard(ctx, cx, cy - frameH + 1, rx - 1, ry * 0.6, body);
    // Diagonal bracing across the top tier of each bay.
    for (let i = 0; i + 1 < cols; i++) {
      const a = { x: standX[i], y: cy - frameH + 4 };
      const b = { x: standX[i + 1], y: cy - frameH + 1 };
      lineHard(ctx, a, i % 2 === 0 ? { x: b.x, y: b.y } : { x: a.x, y: a.y }, ring);
      lineHard(ctx, { x: standX[i], y: cy - frameH * 0.5 },
        { x: standX[i + 1], y: cy - frameH * 0.5 + (i % 2 ? -3 : 3) }, ring);
    }
  }
}

export function drawFinial(
  ctx: CanvasRenderingContext2D,
  ground: Corners, eave: Corners, spec: FinialSpec, alongX: boolean,
): void {
  switch (spec.finial) {
    case 'mast': return;
    case 'stack': drawStack(ctx, ground, eave, spec); return;
    case 'spire': drawSpire(ctx, eave, spec, alongX); return;
    case 'dome': drawDome(ctx, eave, spec); return;
    case 'cupola': drawCupola(ctx, eave, spec, alongX); return;
    case 'gasometer': drawGasometers(ctx, ground, spec); return;
    default: return;
  }
}

