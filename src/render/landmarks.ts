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
  // A chimney four pixels wide in near-black is a scratch on the sky. It needs
  // width, and it needs a genuinely lit face, or the batter and the banding do
  // no work at all.
  const lit = shadeHex(brick, 0.22);
  const shade = shadeHex(brick, -0.14);
  const mortar = shadeHex(brick, -0.26);
  const band = shadeHex(brick, 0.3);
  const topY = base.y - H;
  // An industrial chimney batters as it rises: wider at the plinth, drawing
  // in toward the crown. The straight-sided slab was the whole problem.
  const bwTop = Math.max(2, bw - 2);
  poly(ctx, [
    { x: base.x - bw, y: base.y - 2 }, { x: base.x, y: base.y + 2 },
    { x: base.x, y: topY + 4 }, { x: base.x - bwTop, y: topY },
  ], lit, 2);
  poly(ctx, [
    { x: base.x, y: base.y + 2 }, { x: base.x + bw, y: base.y - 1 },
    { x: base.x + bwTop, y: topY + 1 }, { x: base.x, y: topY + 4 },
  ], shade, 2);
  for (let y = 6; y < H - 8; y += 4) {
    const w = bw + (bwTop - bw) * (y / H);
    lineHard(ctx, { x: base.x - w, y: base.y - 2 - y }, { x: base.x, y: base.y + 2 - y }, mortar);
  }
  // One quiet band of dressed brick above the middle, the Victorian stack's
  // signature. Two bright ones read as cracks, not courses.
  {
    const by = base.y - H * 0.62;
    const w = bw + (bwTop - bw) * 0.62;
    lineHard(ctx, { x: base.x - w, y: by - 2 }, { x: base.x, y: by + 2 }, band);
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
  // One bold shaft, and a shorter companion only on the big works. Three
  // overlapping stacks at four storeys made a picket of stripes against the
  // roof plane behind them; a chimney's job is a clean black silhouette.
  if (big) drawOneStack(ctx, lerp(ground.N, ground.E, 0.3), Math.round(H * 0.72), 5, shadeHex(brick, -0.06));
  drawOneStack(ctx, lerp(ground.W, ground.S, 0.18), H, 9, brick);
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
  const { skin } = spec;
  const c = mid(mid(eave.W, eave.E), mid(eave.N, eave.S));
  const span = Math.hypot(eave.E.x - eave.W.x, eave.E.y - eave.W.y);
  const rx = Math.max(7, Math.round(span * 0.17));
  const ry = Math.max(4, Math.round(rx * 0.48));
  // The old dome was a stack of ellipses at nearly the same height, in the same
  // colour as the roof under it, so it read as a pool with a gilt rim painted on
  // a green field. A dome is a thing with HEIGHT: the drum has to stand above
  // the roof and the cap has to rise off the drum.
  const drum = Math.max(7, Math.round(rx * 0.62));
  const domeH = Math.max(9, Math.round(rx * 0.92));
  const copper = PAL.verd2;
  const copperLit = PAL.verd3;
  const copperDark = PAL.verd1;
  const stone = skin.wallLit;
  const gild = skin.trim ?? PAL.gold;

  // Podium, so the drum does not grow straight out of the lead.
  fillEllipseHard(ctx, c.x, c.y, rx + 2, ry + 1, shadeHex(stone, -0.18));
  fillEllipseHard(ctx, c.x, c.y - 1, rx + 2, ry + 1, stone);

  // Drum: a cylinder drawn as scanlines between its base and top ellipses, so
  // the wall is solid and the light falls on the west of it.
  const drumTop = c.y - drum;
  for (let dx = -rx; dx <= rx; dx++) {
    const t = dx / rx;
    const dy = Math.round(ry * Math.sqrt(Math.max(0, 1 - t * t)));
    const x = Math.round(c.x + dx);
    ctx.fillStyle = t < -0.25 ? shadeHex(stone, 0.14)
      : t < 0.35 ? stone : shadeHex(stone, -0.16);
    ctx.fillRect(x, drumTop - dy, 1, Math.max(1, (c.y + dy) - (drumTop - dy)));
  }
  // A colonnade round the drum. Columns say civic at this size more than the
  // cap above them ever does, and the dark between them is what makes them
  // read as standing off the wall rather than painted on it.
  const cols = 9;
  for (let i = 0; i < cols; i++) {
    const t = (i / (cols - 1)) * 2 - 1;
    const dy = Math.round(ry * Math.sqrt(Math.max(0, 1 - t * t)));
    const x = Math.round(c.x + rx * t * 0.94);
    const yTop = drumTop - dy + 2;
    const h = Math.max(2, drum - 3);
    ctx.fillStyle = shadeHex(stone, t < 0 ? 0.28 : -0.12);
    ctx.fillRect(x, yTop, 1, h);
    // Deep shadow in the intercolumniation. Without real dark between them the
    // columns are just stripes of stone on stone and vanish at any distance.
    if (i < cols - 1) {
      ctx.fillStyle = shadeHex(skin.window ?? PAL.darkWindow, -0.25);
      ctx.fillRect(x + 1, yTop + 1, 1, h - 1);
    }
  }
  // Gilded cornice on top of the drum: the one place the civic money shows.
  fillEllipseHard(ctx, c.x, drumTop, rx + 1, ry, gild);
  fillEllipseHard(ctx, c.x, drumTop - 1, rx, ry - 1, shadeHex(gild, -0.22));

  // The cap: a real hemisphere, wide at the springing and narrowing to the
  // crown, every slice a little higher than the one under it.
  const slices = Math.max(8, domeH);
  for (let i = 0; i <= slices; i++) {
    const t = i / slices;
    const r = Math.max(1, Math.round(rx * Math.cos(t * Math.PI * 0.5)));
    const yr = Math.max(1, Math.round(r * 0.48));
    const y = Math.round(drumTop - t * domeH);
    fillEllipseHard(ctx, c.x, y, r, yr, copper);
    // The highlight is a narrow crescent toward the light, not half the dome:
    // at full width it bleaches the copper to mint.
    if (r > 2) {
      fillEllipseHard(ctx, c.x - Math.round(r * 0.42), y,
        Math.max(1, Math.round(r * 0.3)), Math.max(1, Math.round(yr * 0.45)), copperLit);
    }
  }
  // Ribs from the crown to the springing: the seams of the copper, and the
  // strongest single cue that this is a dome and not a dome-coloured hill.
  const crown = { x: c.x, y: drumTop - domeH };
  for (const k of [-0.92, -0.6, -0.25, 0.25, 0.6, 0.92]) {
    const rim = { x: Math.round(c.x + rx * k), y: Math.round(drumTop - ry * (1 - Math.abs(k)) * 0.5) };
    lineHard(ctx, crown, rim, shadeHex(k < 0 ? copperLit : copperDark, 0.12));
  }

  // Lantern, needle and flag: the postcard finish.
  const lanternH = Math.max(4, Math.round(rx * 0.4));
  const lr = Math.max(2, Math.round(rx * 0.22));
  ctx.fillStyle = stone;
  ctx.fillRect(crown.x - lr, crown.y - lanternH, lr * 2, lanternH);
  ctx.fillStyle = skin.windowLit ? PAL.litWindow : (skin.window ?? PAL.darkWindow);
  for (let i = -lr + 1; i < lr; i += 2) {
    ctx.fillRect(crown.x + i, crown.y - lanternH + 1, 1, lanternH - 2);
  }
  fillEllipseHard(ctx, crown.x, crown.y - lanternH, lr + 1,
    Math.max(1, Math.round(lr * 0.5)), copper);
  ctx.fillStyle = gild;
  ctx.fillRect(crown.x, crown.y - lanternH - 5, 1, 5);
  ctx.fillStyle = PAL.buntRed;
  ctx.fillRect(crown.x + 1, crown.y - lanternH - 5, 3, 2);
}

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

