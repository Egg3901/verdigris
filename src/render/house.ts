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
  /** Structural loss replaces the house silhouette instead of sitting on it. */
  damage?: 'none' | 'collapsed' | 'burning' | 'flooded';
  /** Flags up. The player paid for these. */
  bunting?: boolean;
  /** A temporary cloth notice across the Civic Hall frontage. */
  deputationBanner?: boolean;
  /** A striped public awning marks the building currently taking storm refugees. */
  shelterOpen?: boolean;
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
  /** 1 survey notice, 2 scaffold and tarpaulin, 3 signed-off plaque. */
  worksStage?: 0 | 1 | 2 | 3;
  /** 0 no drain needed, 1 served, 2 disconnected or behind a broken main. */
  drainState?: 0 | 1 | 2;
  /** 0 dry, 1 rain, 2 hard rain. Drives only baked roof and gutter runoff. */
  rainStrength?: 0 | 1 | 2;
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
  const top = spec.damage === 'collapsed'
    ? Math.max(9, Math.round(spec.wallH * 0.5))
    : spec.wallH + spec.roofH + spec.finialH + (spec.chimneys > 0 ? 9 : 0);
  return {
    minX: isoX(0, sy) - TILE_W / 2 - ox - 5,
    maxX: isoX(sx, 0) + TILE_W / 2 - ox + 5,
    minY: isoY(0, 0) - TILE_H / 2 - top - oy,
    maxY: isoY(sx, sy) + TILE_H / 2 - oy + 5,
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

  if (spec.damage === 'collapsed') {
    drawCollapsedHouse(ctx, ox, oy, ground, spec);
    return;
  }

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
  if (spec.damage === 'flooded') drawFloodDamage(ctx, eave, spec);
  if (spec.drainState) drawRainwaterGoods(ctx, eave, spec);
  if (spec.rainStrength) drawRainRunoff(ctx, eave, roofQuad, spec);
  if (roofQuad && spec.dormers) {
    const n = Math.min(3, spec.dormers);
    for (let i = 0; i < n; i++) {
      drawDormer(ctx, roofQuad, (i + 1) / (n + 1), detailSkin(spec), spec.skin.roofLit);
    }
  }
  if (roofQuad && spec.patched) {
    drawRoofPatch(ctx, roofQuad, shadeHex(skin.roofShade, -0.08));
  }
  if (roofQuad && spec.damage === 'burning') drawBurnedRoof(ctx, roofQuad, spec);
  if (spec.shelterOpen) drawShelterEntrance(ctx, eave, roofQuad, spec);

  if (spec.washing && lit.span >= 10) drawWashingLine(ctx, lit, wallH, spec.salt ?? 0);

  if (spec.worksStage) drawWorks(ctx, eave, roofQuad, spec);

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
  // One pixel BELOW the eave, on the wall.
  //
  // Drawn on the eave line itself it landed on the roof, because the roof
  // overhangs its eave by a pixel and a half, so every building wore a stripe
  // across the bottom of its slope. On the wall it is what it is meant to be:
  // the shadow the overhang casts.
  if (!skin.trim) {
    const drop = (p: Pt): Pt => ({ x: p.x, y: p.y + 1 });
    lineHard(ctx, drop(eave.W), drop(eave.S), skin.outline);
    lineHard(ctx, drop(eave.S), drop(eave.E), skin.outline);
  }
}

/**
 * A failed structure is a low, broken shell, not an intact home with a rubble
 * decal. The rear wall is left standing just enough to make the loss legible.
 */
function drawCollapsedHouse(
  ctx: CanvasRenderingContext2D, ox: number, oy: number, ground: Corners, spec: HouseSpec,
): void {
  const low = Math.max(7, Math.round(spec.wallH * 0.45));
  const remnant = houseCorners(ox, oy, spec.w, spec.d, low);
  const litTop = [
    remnant.W,
    { x: remnant.W.x + (remnant.S.x - remnant.W.x) * 0.28, y: remnant.W.y - 2 },
    { x: remnant.W.x + (remnant.S.x - remnant.W.x) * 0.58, y: remnant.W.y + 1 },
    remnant.S,
  ];
  const shadeTop = [
    remnant.S,
    { x: remnant.S.x + (remnant.E.x - remnant.S.x) * 0.34, y: remnant.S.y - 2 },
    { x: remnant.S.x + (remnant.E.x - remnant.S.x) * 0.7, y: remnant.S.y + 1 },
    remnant.E,
  ];

  // The roof is gone. Fill the exposed room before raising the surviving near
  // walls, then leave joists and masonry scattered across that dark interior.
  fillPolyHard(ctx, [ground.W, ground.N, ground.E, ground.S], PAL.soot1);
  ditherPolyHard(ctx, [ground.W, ground.N, ground.E, ground.S], PAL.dirt0, 4);
  const roomMid = mid(ground.N, ground.S);
  lineHard(ctx, lerp(ground.W, ground.N, 0.34), lerp(ground.S, ground.E, 0.3), PAL.wood1);
  lineHard(ctx, lerp(ground.W, ground.N, 0.68), lerp(ground.S, ground.E, 0.64), PAL.wood0);
  ctx.fillStyle = spec.material === 'brick' ? PAL.brick2 : PAL.stone2;
  ctx.fillRect(Math.round(roomMid.x) - 4, Math.round(roomMid.y) - 2, 3, 2);
  ctx.fillRect(Math.round(roomMid.x) + 2, Math.round(roomMid.y), 4, 2);

  fillPolyHard(ctx, [litTop[0], ground.W, ground.S, litTop[3]], spec.skin.wallLit);
  fillPolyHard(ctx, [shadeTop[0], ground.S, ground.E, shadeTop[3]], spec.skin.wallShade);
  fillPolyHard(ctx, litTop, spec.skin.wallLit);
  fillPolyHard(ctx, shadeTop, spec.skin.wallShade);
  ditherPolyHard(ctx, [litTop[0], ground.W, ground.S, litTop[3]], PAL.soot1, 3);

  // One dark void makes this a broken room rather than a deliberately low shed.
  const face = makeFace(remnant.W, remnant.S, true);
  const opening = [face.at(0.42, Math.max(2, low - 7)), face.at(0.64, Math.max(2, low - 7)),
    face.at(0.64, low - 1), face.at(0.42, low - 1)];
  fillPolyHard(ctx, opening, PAL.darkWindow);
  lineHard(ctx, opening[0], opening[1], PAL.soot0);

  const stone = spec.material === 'brick' ? [PAL.brick2, PAL.brick1, PAL.brick0]
    : spec.material === 'ashlar' ? [PAL.stone3, PAL.stone2, PAL.stone1]
      : [PAL.plaster1, PAL.plaster0, PAL.wood1];
  const chips = [
    [-7, -1, 4, 2], [-2, 1, 3, 2], [3, -2, 5, 2], [8, 1, 3, 2],
    [-11, 2, 3, 2], [12, 3, 4, 2], [-5, 4, 4, 2], [5, 5, 3, 1],
  ] as const;
  for (let i = 0; i < chips.length; i++) {
    const [dx, dy, rw, rh] = chips[i];
    ctx.fillStyle = stone[i % stone.length];
    ctx.fillRect(Math.round(ground.S.x + dx), Math.round(ground.S.y + dy), rw, rh);
  }
  lineHard(ctx, { x: ground.S.x - 9, y: ground.S.y + 1 }, { x: ground.S.x + 5, y: ground.S.y + 5 }, PAL.wood0);
  lineHard(ctx, { x: ground.S.x + 2, y: ground.S.y - 1 }, { x: ground.S.x + 12, y: ground.S.y + 3 }, PAL.wood1);
  lineHard(ctx, remnant.W, { x: remnant.W.x - 1, y: remnant.W.y - 5 }, PAL.wood0);
  lineHard(ctx, remnant.E, { x: remnant.E.x + 1, y: remnant.E.y - 4 }, PAL.wood0);
  lineHard(ctx, ground.W, ground.S, spec.skin.outline);
  lineHard(ctx, ground.S, ground.E, spec.skin.outline);
}

/** Broken tiles and a soot-black opening keep the flame attached to real damage. */
function drawBurnedRoof(ctx: CanvasRenderingContext2D, roof: Pt[], spec: HouseSpec): void {
  const topA = lerp(roof[0], roof[1], 0.3);
  const topB = lerp(roof[0], roof[1], 0.66);
  const lowB = lerp(roof[3], roof[2], 0.62);
  const lowA = lerp(roof[3], roof[2], 0.34);
  const hole = [
    { x: topA.x + 1, y: topA.y + 1 }, topB,
    { x: lowB.x - 1, y: lowB.y - 1 }, lowA,
  ];
  fillPolyHard(ctx, hole, PAL.soot0);
  ditherPolyHard(ctx, hole, PAL.soot2, 3);
  lineHard(ctx, topA, topB, spec.material === 'brick' ? PAL.brick0 : PAL.wood0);
  lineHard(ctx, lowA, lowB, PAL.soot1);
  const emberA = lerp(topA, lowB, 0.58);
  const emberB = lerp(topB, lowA, 0.62);
  ctx.fillStyle = PAL.buntRedHi;
  ctx.fillRect(Math.round(emberA.x), Math.round(emberA.y), 2, 1);
  ctx.fillStyle = PAL.brass2;
  ctx.fillRect(Math.round(emberB.x), Math.round(emberB.y), 1, 1);
}

/**
 * A flood must climb the building, not merely recolour the ground beneath it.
 * The uneven dither is the receding waterline, while the dark lower band and
 * snagged boards make the depth readable against doors and shopfronts.
 */
function drawFloodDamage(
  ctx: CanvasRenderingContext2D,
  eave: { W: Pt; N: Pt; E: Pt; S: Pt },
  spec: HouseSpec,
): void {
  const lit = makeFace(eave.W, eave.S, true);
  const shade = makeFace(eave.S, eave.E, false);
  const rise = Math.max(4, Math.min(7, Math.round(spec.wallH * 0.24)));

  for (const face of [lit, shade]) {
    if (face.span < 5) continue;
    const stain = [
      face.at(0, spec.wallH - rise), face.at(1, spec.wallH - rise - (face.lit ? 1 : 0)),
      face.at(1, spec.wallH), face.at(0, spec.wallH),
    ];
    ditherPolyHard(ctx, stain, PAL.riv1, face.lit ? 4 : 3);
    const water = [
      face.at(0, spec.wallH - 2), face.at(1, spec.wallH - 2),
      face.at(1, spec.wallH), face.at(0, spec.wallH),
    ];
    fillPolyHard(ctx, water, face.lit ? PAL.riv2 : PAL.riv1);
    lineHard(ctx, face.at(0.04, spec.wallH - rise), face.at(0.96, spec.wallH - rise - (face.lit ? 1 : 0)), PAL.riv2);
  }

  if (lit.span >= 9) {
    const boardY = spec.wallH - 3;
    lineHard(ctx, lit.at(0.12, boardY), lit.at(0.46, boardY + 1), PAL.wood1);
    const rag = lit.at(0.69, spec.wallH - 2);
    ctx.fillStyle = PAL.buntCream;
    ctx.fillRect(Math.round(rag.x), Math.round(rag.y), 2, 1);
  }
}

/** Wet roof edges and discrete gutter overflow, all inside the building sprite. */
function drawRainRunoff(
  ctx: CanvasRenderingContext2D,
  eave: { W: Pt; N: Pt; E: Pt; S: Pt },
  roof: Pt[] | null,
  spec: HouseSpec,
): void {
  const strength = spec.rainStrength ?? 0;
  if (!strength) return;
  const face = makeFace(eave.W, eave.S, true);
  if (face.span < 5) return;
  if (roof) {
    lineHard(ctx, lerp(roof[3], roof[2], 0.08), lerp(roof[3], roof[2], 0.46), PAL.riv2);
    if (strength === 2) lineHard(ctx, lerp(roof[3], roof[2], 0.62), lerp(roof[3], roof[2], 0.86), PAL.riv1);
  }
  const drips = strength === 2 ? [0.12, 0.38, 0.67, 0.91] : [0.2, 0.76];
  for (let i = 0; i < drips.length; i++) {
    const p = face.at(drips[i], 1);
    const len = strength === 2 && i % 2 === 0 ? 4 : 2;
    lineHard(ctx, p, { x: p.x, y: p.y + len }, i === 0 ? PAL.rivGlint : PAL.riv2);
  }
  if (spec.drainState === 2) {
    const foot = face.at(0.82, spec.wallH + 1);
    lineHard(ctx, { x: foot.x - 4, y: foot.y }, { x: foot.x + 4, y: foot.y }, PAL.riv2);
  }
}

/**
 * Gutters and downpipes make the buried drain network legible on the facade.
 * A served building has a continuous iron run with brackets and a shoe. A failed
 * one has a missing lower section, a damp stain and a pavement puddle.
 */
function drawRainwaterGoods(
  ctx: CanvasRenderingContext2D,
  eave: { W: Pt; N: Pt; E: Pt; S: Pt },
  spec: HouseSpec,
): void {
  const face = makeFace(eave.W, eave.S, true);
  if (face.span < 7) return;
  const iron = spec.polite ? PAL.soot2 : PAL.soot1;
  const state = spec.drainState ?? 0;
  const pipeT = 0.9;

  lineHard(ctx, face.at(0.02, 1), face.at(0.98, 1), iron);
  for (const t of [0.18, 0.5, 0.82]) {
    const p = face.at(t, 1);
    ctx.fillStyle = spec.skin.outline;
    ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 2);
  }

  if (state === 1) {
    lineHard(ctx, face.at(pipeT, 1), face.at(pipeT, spec.wallH - 1), iron);
    lineHard(ctx, face.at(pipeT, spec.wallH - 1), face.at(pipeT - 0.06, spec.wallH + 1), iron);
    for (const h of [Math.round(spec.wallH * 0.34), Math.round(spec.wallH * 0.68)]) {
      const p = face.at(pipeT, h);
      ctx.fillStyle = spec.skin.outline;
      ctx.fillRect(Math.round(p.x) - 1, Math.round(p.y), 3, 1);
    }
    return;
  }

  const breakAt = Math.max(5, Math.round(spec.wallH * 0.5));
  lineHard(ctx, face.at(pipeT, 1), face.at(pipeT, breakAt), iron);
  lineHard(ctx, face.at(pipeT - 0.06, breakAt + 3), face.at(pipeT - 0.06, spec.wallH * 0.72), iron);
  const stain = [face.at(pipeT - 0.16, breakAt + 2), face.at(pipeT + 0.04, breakAt + 2),
    face.at(pipeT + 0.02, spec.wallH), face.at(pipeT - 0.22, spec.wallH)];
  ditherPolyHard(ctx, stain, PAL.riv1, 5);
  const foot = face.at(pipeT - 0.08, spec.wallH + 2);
  lineHard(ctx, { x: foot.x - 4, y: foot.y }, { x: foot.x + 3, y: foot.y }, PAL.riv1);
  lineHard(ctx, { x: foot.x - 2, y: foot.y + 1 }, { x: foot.x + 1, y: foot.y + 1 }, PAL.riv2);
}

/**
 * The works register, made physical.
 *
 * Stage one is only paper and blue chalk. Stage two is a proper timber scaffold
 * and weather sheet. Stage three is the backfire: the scaffold has gone and the
 * brass completion plaque is much more convincing than the work underneath it.
 */
function drawWorks(
  ctx: CanvasRenderingContext2D,
  eave: { W: Pt; N: Pt; E: Pt; S: Pt },
  roof: Pt[] | null,
  spec: HouseSpec,
): void {
  const stage = spec.worksStage ?? 0;
  const face = makeFace(eave.W, eave.S, true);
  if (face.span < 6) return;
  const wood = PAL.wood2;
  const chalk = PAL.buntBlueHi;
  const paper = PAL.buntCream;
  const notice = face.at(0.76, Math.max(4, spec.wallH - 10));

  if (stage === 1) {
    // A survey cross and a posted number. Small, but visible at every zoom.
    const mark = face.at(0.62, Math.max(5, spec.wallH * 0.48));
    lineHard(ctx, { x: mark.x - 2, y: mark.y - 2 }, { x: mark.x + 2, y: mark.y + 2 }, chalk);
    lineHard(ctx, { x: mark.x + 2, y: mark.y - 2 }, { x: mark.x - 2, y: mark.y + 2 }, chalk);
    ctx.fillStyle = paper;
    ctx.fillRect(Math.round(notice.x) - 2, Math.round(notice.y) - 2, 4, 5);
    ctx.fillStyle = PAL.brassInk;
    ctx.fillRect(Math.round(notice.x) - 1, Math.round(notice.y), 2, 1);
    return;
  }

  if (stage === 3) {
    // The administrative object is finer than the thing it claims was repaired.
    ctx.fillStyle = PAL.brass3;
    ctx.fillRect(Math.round(notice.x) - 2, Math.round(notice.y), 5, 3);
    ctx.fillStyle = PAL.gold;
    ctx.fillRect(Math.round(notice.x) - 1, Math.round(notice.y), 3, 1);
    lineHard(ctx, face.at(0.08, spec.wallH - 2), face.at(0.92, spec.wallH - 2), PAL.stone4);
    return;
  }

  // Poles stand proud of the wall and platforms cross it at each storey.
  const levels = Math.max(2, Math.min(4, spec.windowRows + 1));
  for (const t of [0.03, 0.35, 0.67, 0.97]) {
    lineHard(ctx, face.at(t, 1), face.at(t, spec.wallH + 3), wood);
  }
  for (let i = 1; i <= levels; i++) {
    const h = Math.round((spec.wallH * i) / (levels + 1));
    lineHard(ctx, face.at(0, h), face.at(1, h), PAL.wood2);
    if (i < levels) lineHard(ctx, face.at(0.03, h), face.at(0.35, h + Math.max(4, spec.wallH / levels)), wood);
  }
  lineHard(ctx, face.at(0.03, spec.wallH + 2), face.at(0.97, 1), PAL.wood1);

  // A blue weather sheet on the roof is the district-wide read of an active job.
  if (roof) {
    const a = lerp(roof[0], roof[1], 0.18);
    const b = lerp(roof[0], roof[1], 0.58);
    const c = lerp(roof[3], roof[2], 0.58);
    const d = lerp(roof[3], roof[2], 0.18);
    fillPolyHard(ctx, [a, b, c, d], PAL.buntBlueHi);
    ditherPolyHard(ctx, [a, b, c, d], PAL.arc0, 6);
    lineHard(ctx, a, b, PAL.wood1);
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
  if (spec.deputationBanner && lit.span >= 18) drawDeputationBanner(ctx, lit, spec.wallH);
}

/** A plain civic cloth, legible as a temporary public demand rather than signage. */
function drawDeputationBanner(
  ctx: CanvasRenderingContext2D, face: ReturnType<typeof makeFace>, wallH: number,
): void {
  const top = Math.max(4, wallH - 14);
  const bottom = top + 5;
  const a = face.at(0.18, top);
  const b = face.at(0.82, top);
  const c = face.at(0.82, bottom);
  const d = face.at(0.18, bottom);
  fillPolyHard(ctx, [a, b, c, d], PAL.buntCream);
  lineHard(ctx, a, b, PAL.wood0);
  lineHard(ctx, d, c, PAL.buntRed);
  const seal = face.at(0.5, top + 2);
  ctx.fillStyle = PAL.buntBlue;
  ctx.fillRect(Math.round(seal.x) - 1, Math.round(seal.y), 3, 2);
}

/** A dry public threshold, loud enough to find through the rain at zoom one. */
function drawShelterEntrance(
  ctx: CanvasRenderingContext2D, eave: { W: Pt; N: Pt; E: Pt; S: Pt },
  roof: Pt[] | null, spec: HouseSpec,
): void {
  const face = makeFace(eave.W, eave.S, true);
  if (face.span < 9) return;
  const top = Math.max(4, spec.wallH - 9);
  const a = face.at(0.08, top);
  const b = face.at(0.54, top);
  const c = { x: b.x + 2, y: b.y + 3 };
  const d = { x: a.x + 2, y: a.y + 3 };
  fillPolyHard(ctx, [a, b, c, d], PAL.buntBlueHi);
  for (const t of [0.16, 0.48, 0.8]) {
    const p = lerp(a, b, t);
    const q = lerp(d, c, t);
    lineHard(ctx, p, q, PAL.buntCream);
  }
  lineHard(ctx, a, d, PAL.wood1);
  lineHard(ctx, b, c, PAL.wood1);
  const lamp = face.at(0.63, top + 3);
  ctx.fillStyle = PAL.brassInk;
  ctx.fillRect(Math.round(lamp.x) - 1, Math.round(lamp.y) - 1, 3, 4);
  ctx.fillStyle = PAL.gas2;
  ctx.fillRect(Math.round(lamp.x), Math.round(lamp.y), 1, 2);

  const bannerTop = face.at(0.7, Math.max(3, top - 5));
  const bannerBottom = face.at(0.88, top + 1);
  fillPolyHard(ctx, [
    bannerTop, { x: bannerTop.x + 5, y: bannerTop.y + 2 },
    bannerBottom, { x: bannerBottom.x - 5, y: bannerBottom.y - 2 },
  ], PAL.buntCream);
  const mark = face.at(0.79, top - 1);
  ctx.fillStyle = PAL.buntBlue;
  ctx.fillRect(Math.round(mark.x) - 1, Math.round(mark.y), 3, 1);

  // The doorway awning is hidden in a packed street until the player is close.
  // A tied cloth on the near roof slope gives the refuge a district-wide read.
  if (roof) {
    const ra = lerp(roof[0], roof[1], 0.18);
    const rb = lerp(roof[0], roof[1], 0.52);
    const rc = lerp(roof[3], roof[2], 0.52);
    const rd = lerp(roof[3], roof[2], 0.18);
    fillPolyHard(ctx, [ra, rb, rc, rd], PAL.buntCream);
    lineHard(ctx, lerp(ra, rb, 0.5), lerp(rd, rc, 0.5), PAL.buntBlueHi);
    lineHard(ctx, lerp(ra, rd, 0.5), lerp(rb, rc, 0.5), PAL.buntBlue);
  }
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
    // The W-N gable faces away from the camera. It must be behind both slopes;
    // drawing it later lets its wall colour cut through the roof silhouette.
    poly(ctx, [W, N, r0], skin.gableLit);
    poly(ctx, [N, E, r1, r0], skin.roofShade, 3);
    poly(ctx, [W, S, r1, r0], skin.roofLit, 4);
    poly(ctx, [S, E, r1], skin.gableShade);
    // Bargeboards. A gable end is WALL, and where it meets the roof there has to
    // be a board, or the wall triangle bleeds into the slope and the roof loses
    // its edge.
    lineHard(ctx, S, r1, skin.roofRidge);
    lineHard(ctx, E, r1, skin.roofRidge);
  } else {
    // The N-E gable is the back face for this ridge orientation.
    poly(ctx, [N, E, r0], skin.gableShade);
    poly(ctx, [E, S, r1, r0], skin.roofShade, 3);
    poly(ctx, [W, N, r0, r1], skin.roofLit, 4);
    poly(ctx, [W, S, r1], skin.gableLit);
    lineHard(ctx, W, r1, skin.roofRidge);
    lineHard(ctx, S, r1, skin.roofRidge);
  }
  ridgeLine(ctx, r0, r1, skin.roofRidge, spec);
  chimneys(ctx, r0, r1, spec);
  // Tile courses on the near slope. Four lines, and a roof stops being a plane.
  const near: Pt[] = alongX ? [W, S, r1, r0] : [W, N, r0, r1];
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
    // Back-facing broken gable first, for the same occlusion rule as a plain
    // gable roof. Its stepped outline must never paint over either slope.
    poly(ctx, [W, N, f0, r0, n0], skin.gableLit);
    poly(ctx, [N, E, f1, f0], skin.roofShade, 2);
    poly(ctx, [f0, f1, r1, r0], shadeHex(skin.roofShade, -0.06), 2);
    poly(ctx, [W, S, n1, n0], skin.roofLit, 3);
    poly(ctx, [n0, n1, r1, r0], shadeHex(skin.roofLit, 0.06), 3);
    // Broken gable silhouette, not a triangle.
    poly(ctx, [S, E, f1, r1, n1], skin.gableShade);
  } else {
    poly(ctx, [N, E, f1, f0], skin.gableShade);
    poly(ctx, [E, S, n1, f1], skin.roofShade, 2);
    poly(ctx, [f1, n1, r1, r0], shadeHex(skin.roofShade, -0.06), 2);
    poly(ctx, [W, N, r0, n0], skin.roofLit, 3);
    poly(ctx, [n0, r0, r1, n1], shadeHex(skin.roofLit, 0.06), 3);
    poly(ctx, [W, S, n1, n0], skin.gableLit);
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
