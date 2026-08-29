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
  /** Dressed stone for lintels and sills on the better buildings. When unset the
   *  window openings fall back to wall-derived colours. */
  dress?: string;
  /** After dark, bake a few panes lit with a figure at the glass. Off for
   *  burning and scorched shells, where a silhouette would read as a casualty. */
  occupants?: boolean;
}

/**
 * One window pane, recorded at bake time so the per-frame lamplighter can light
 * it in place. The top edge runs (ax,ay) to (bx,by) in sprite coordinates; the
 * pane is four pixels tall below that. The hash drives its own on/off schedule.
 */
export interface WindowLight {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  hash: number;
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
  // The door leaf, a shade off the surround so a painted door reads as joinery
  // rather than as the same dark hole as an unlit window.
  const leaf = shadeHex(skin.wallDark, -0.06);
  faceQuad(ctx, f, t - halfW, t + halfW, top, wallH - 1, leaf);
  faceQuad(ctx, f, t - halfW, t + halfW, top, top + 1, skin.timber);
  // A fanlight over the head: the lintel light every terrace door carries. Warm
  // when the lamps are lit, a dark glaze by day.
  const fan = skin.glassLit ? PAL.litWindow : shadeHex(PAL.darkWindow, 0.08);
  faceQuad(ctx, f, t - halfW + 0.01, t + halfW - 0.01, top + 1, top + 2, fan);
  // A centre stile splits the leaf into two panels, and the west jamb catches a
  // hair of light.
  lineHard(ctx, f.at(t, top + 3), f.at(t, wallH - 2), shadeHex(leaf, -0.14));
  lineHard(ctx, f.at(t - halfW, top + 1), f.at(t - halfW, wallH - 1), shadeHex(skin.wall, 0.1));
  // The brass knob, on the lit face only, where the west light finds it.
  if (f.lit && f.span >= 12) {
    const k = f.at(t + halfW - 0.03, wallH - 5);
    ctx.fillStyle = skin.trim ?? PAL.brass2;
    ctx.fillRect(Math.round(k.x), Math.round(k.y), 1, 1);
  }
  // A step, so the door meets the pavement instead of hovering above it.
  faceQuad(ctx, f, t - halfW - 0.02, t + halfW + 0.02, wallH - 1, wallH, shadeHex(skin.wall, -0.2));
}

/**
 * A glazed shopfront with an awning. Shops and pubs get one, which is what makes
 * a commercial street look commercial from above.
 */
/** Deep paints a signwriter would use on a fascia board, hashed per shop. */
const FASCIA_PAINT = [PAL.soot2, PAL.buntBlue, PAL.verd1, PAL.brick1, PAL.brassInk];

export function drawShopfront(
  ctx: CanvasRenderingContext2D, f: Face, wallH: number, skin: DetailSkin, awning: string,
  salt = 0,
): void {
  const top = Math.max(4, wallH - 13);
  // The glass, over a low stallriser panel so the window sits on joinery rather
  // than running into the pavement.
  faceQuad(ctx, f, 0.08, 0.92, top + 3, wallH - 3, skin.glassLit ? PAL.litWindow : shadeHex(skin.glass, -0.1));
  faceQuad(ctx, f, 0.08, 0.92, wallH - 3, wallH - 1, shadeHex(skin.timber, -0.05));
  // Mullions, so it reads as panes and not as a hole.
  for (let i = 1; i < 4; i++) {
    const t = 0.08 + (0.84 * i) / 4;
    lineHard(ctx, f.at(t, top + 3), f.at(t, wallH - 3), skin.timber);
  }
  // The fascia: a painted lettering board over the glass. Dark signwriter's
  // paint, the shop's name in cream dashes, which is all the type five pixels
  // of board can carry, and a thin top bead.
  const paint = FASCIA_PAINT[(salt >>> 2) % FASCIA_PAINT.length];
  faceQuad(ctx, f, 0.05, 0.95, top, top + 3, paint);
  lineHard(ctx, f.at(0.05, top), f.at(0.95, top), shadeHex(paint, 0.15));
  const letters = 2 + (salt % 3);
  ctx.fillStyle = skin.trim ?? PAL.buntCream;
  for (let i = 0; i < letters; i++) {
    const t = 0.14 + (0.72 * (i + 0.5)) / letters;
    const p = f.at(t, top + 1);
    ctx.fillRect(Math.round(p.x), Math.round(p.y), 2 + ((salt + i) % 2), 1);
  }
  lineHard(ctx, f.at(0.05, top + 3), f.at(0.95, top + 3), skin.outline);
  // The awning, in three tempers: a full blind with a scalloped skirt, a half
  // blind wound out over the door side only, or wound in altogether so the
  // fascia does the talking.
  const blind = (salt >>> 4) % 3;
  if (blind < 2) {
    const a0 = blind === 0 ? 0.06 : 0.5;
    const a1 = 0.94;
    faceQuad(ctx, f, a0, a1, top + 3, top + 6, awning);
    // Stripes, in cloth widths rather than dither.
    const stripes = Math.max(2, Math.round((f.span * (a1 - a0)) / 5));
    for (let i = 0; i < stripes; i++) {
      if ((i & 1) === 0) continue;
      const s0 = a0 + ((a1 - a0) * i) / stripes;
      const s1 = a0 + ((a1 - a0) * (i + 1)) / stripes;
      faceQuad(ctx, f, s0, s1, top + 3, top + 6, shadeHex(awning, 0.3));
    }
    // The scalloped skirt: every other cloth width hangs a pixel lower.
    for (let i = 0; i < stripes; i += 2) {
      const s0 = a0 + ((a1 - a0) * i) / stripes;
      const s1 = a0 + ((a1 - a0) * (i + 1)) / stripes;
      faceQuad(ctx, f, s0, s1, top + 6, top + 7, awning);
    }
  }
}

/** The trades a hanging sign can speak for without any lettering at all. */
export type SignGlyph = 'boot' | 'loaf' | 'scissors' | 'tankard';

// 5x5 one-bit glyphs, top row first, bit 4 leftmost. Bold silhouettes that
// survive one pixel per bit: a boot in profile, a slashed cob loaf, open
// scissors, a tankard with its handle.
const GLYPHS: Record<SignGlyph, number[]> = {
  boot: [0b11000, 0b11000, 0b11000, 0b11100, 0b11111],
  loaf: [0b01110, 0b11111, 0b11011, 0b11111, 0b01110],
  scissors: [0b10001, 0b01010, 0b00100, 0b01010, 0b11011],
  tankard: [0b11100, 0b11111, 0b11101, 0b11111, 0b11100],
};

/**
 * A hanging signboard on a bracket. Pubs and shops. With a glyph it becomes a
 * proper trade sign: the boot, the loaf, the scissors, the tankard, painted on
 * a dark board for the customer who cannot read the fascia.
 */
export function drawSign(
  ctx: CanvasRenderingContext2D, f: Face, t: number, wallH: number, skin: DetailSkin,
  glyph?: SignGlyph, salt = 0,
): void {
  const p = f.at(t, Math.max(2, wallH - 20));
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  if (!glyph) {
    ctx.fillStyle = skin.timber;
    ctx.fillRect(x - 3, y, 6, 1);
    ctx.fillStyle = skin.trim ?? PAL.brass2;
    ctx.fillRect(x - 2, y + 1, 5, 4);
    ctx.fillStyle = skin.outline;
    ctx.fillRect(x - 2, y + 5, 5, 1);
    return;
  }
  // The bracket arm, its drop rod, then the board.
  ctx.fillStyle = PAL.soot2;
  ctx.fillRect(x - 4, y, 8, 1);
  ctx.fillRect(x, y + 1, 1, 1);
  const paint = FASCIA_PAINT[(salt >>> 3) % FASCIA_PAINT.length];
  ctx.fillStyle = shadeHex(paint, -0.1);
  ctx.fillRect(x - 3, y + 2, 7, 7);
  ctx.fillStyle = skin.trim ?? PAL.brass1;
  ctx.fillRect(x - 3, y + 2, 7, 1);
  ctx.fillRect(x - 3, y + 8, 7, 1);
  // The glyph itself, in gold on the trimmed houses and cream on the rest.
  ctx.fillStyle = skin.trim ? PAL.gold : PAL.buntCream;
  const rows = GLYPHS[glyph];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      if ((rows[r] >> (4 - c)) & 1) ctx.fillRect(x - 2 + c, y + 3 + r, 1, 1);
    }
  }
}

/**
 * Windows, in a proper sash grid with a lintel and a sill.
 *
 * Previously a 2x3 black rectangle on a bare lattice, which at zoom 1 read as
 * speckle and at zoom 3 read as a spreadsheet.
 */
export function drawWindowGrid(
  ctx: CanvasRenderingContext2D, f: Face, wallH: number, rows: number, skin: DetailSkin,
  skipGround: boolean, hash: number, lights?: WindowLight[], balconyIron?: string,
  industrial = false,
): void {
  // A mill is mostly window. The machines needed daylight, so the elevation is
  // a grid of tall lights between the piers with barely a wall left between
  // them; ours had a handful of small holes in a dark slab, which is why it
  // read as a warehouse with the lamps off.
  const cols = industrial
    ? Math.max(2, Math.round(f.span / 7))
    : Math.max(1, Math.round(f.span / 13));
  const bottom = skipGround ? wallH - 15 : wallH - 3;
  const usable = bottom - 4;
  if (usable < 6 || rows < 1) return;
  const stepY = Math.max(7, Math.floor(usable / rows));
  let lowestRow = -1;

  // The painted frame: sash timber, lighter than the glass so the opening reads
  // as a window rather than a hole. Warm on the working bank, near-white on the
  // polite one where the joinery is kept up.
  const frame = shadeHex(skin.wall, 0.16);
  // The panes are always baked DARK. Whether one is lit is decided per frame, not
  // here, so a room can turn its light on and off on its own schedule. What this
  // records is WHERE each pane is, so the per-frame pass can light it in place.
  const cold = shadeHex(PAL.darkWindow, f.lit ? 0.06 : 0);
  for (let r = 0; r < rows; r++) {
    const h = 4 + r * stepY;
    if (h + 5 > bottom) break;
    lowestRow = h;
    for (let c = 0; c < cols; c++) {
      const t = (c + 0.5) / cols;
      const halfW = industrial
        ? Math.min(0.1, 2.2 / Math.max(1, f.span))
        : Math.min(0.12, 3 / Math.max(1, f.span));
      const paneHash = (hash + r * 71 + c * 131) >>> 0;
      // After dark, one pane in nine is baked LIT with somebody standing at the
      // glass: a head and shoulders against the lamp behind them. These panes
      // stay out of the per-frame lamplighter so the figure is never painted
      // over; the rest of the house keeps its own schedule around them.
      const occupied = skin.occupants === true && skin.glassLit && paneHash % 9 === 0;
      faceQuad(ctx, f, t - halfW, t + halfW, h, h + 4, occupied ? PAL.litWindow : cold);
      // The meeting rail: the one horizontal bar that divides upper and lower
      // sash. A single line, but it is the mark that says "sash window".
      lineHard(ctx, f.at(t - halfW, h + 2), f.at(t + halfW, h + 2), frame);
      if (industrial) {
        // Cast-iron glazing bars: a mill light is gridded, not sashed.
        lineHard(ctx, f.at(t - halfW, h + 4), f.at(t + halfW, h + 4), frame);
        lineHard(ctx, f.at(t, h), f.at(t, h + 6), frame);
      }
      if (occupied) {
        const drift = (((paneHash >>> 4) % 3) - 1) * 0.02;
        const p = f.at(t + drift, h);
        const px = Math.round(p.x);
        const py = Math.round(p.y);
        ctx.fillStyle = PAL.soot1;
        ctx.fillRect(px, py + 1, 1, 1);
        ctx.fillRect(px - 1, py + 2, 3, 2);
      }
      // A cool reflection catch in the top corner, on the lit face.
      if (f.lit) {
        const g = f.at(t - halfW, h);
        ctx.fillStyle = PAL.arc0;
        ctx.fillRect(Math.round(g.x), Math.round(g.y), 1, 1);
      }
      // Lintel above, sill below: two one-pixel lines that do most of the work of
      // making a hole in a wall look like a window. On a dressed facade both are
      // cut stone, a step brighter than the wall, which is what says the owner
      // paid a mason rather than a plasterer.
      lineHard(ctx, f.at(t - halfW, h - 1), f.at(t + halfW, h - 1), skin.dress ?? skin.wallDark);
      lineHard(ctx, f.at(t - halfW - 0.01, h + 4), f.at(t + halfW + 0.01, h + 4),
        skin.dress ? shadeHex(skin.dress, -0.05) : shadeHex(skin.wall, 0.14));
      // Record the pane for the per-frame lamplighter: its top edge in sprite
      // coordinates, and a stable hash for its own on/off schedule. An occupied
      // pane is already lit in the bake and stays off the register.
      if (lights && !occupied) {
        const a = f.at(t - halfW, h);
        const b = f.at(t + halfW, h);
        lights.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, hash: paneHash });
      }
    }
  }
  // Iron balconies under the first-floor windows of the merchant rows: a shallow
  // platform proud of the sill and three uprights in front of the glass. Drawn
  // after the panes so the rail reads against the window behind it.
  if (balconyIron && lowestRow >= 0 && f.span >= 12) {
    const h = lowestRow;
    for (let c = 0; c < cols; c++) {
      const t = (c + 0.5) / cols;
      const halfW = industrial
        ? Math.min(0.1, 2.2 / Math.max(1, f.span))
        : Math.min(0.12, 3 / Math.max(1, f.span));
      for (const u of [-1, 0, 1]) {
        const p = f.at(t + u * halfW, h + 2);
        ctx.fillStyle = balconyIron;
        ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 3);
      }
      lineHard(ctx, f.at(t - halfW - 0.02, h + 2), f.at(t + halfW + 0.02, h + 2), balconyIron);
      lineHard(ctx, f.at(t - halfW - 0.02, h + 5), f.at(t + halfW + 0.02, h + 5), shadeHex(balconyIron, -0.1));
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
  salt = 0,
): void {
  const eave = { x: quad[0].x + (quad[1].x - quad[0].x) * t, y: quad[0].y + (quad[1].y - quad[0].y) * t };
  const ridge = { x: quad[3].x + (quad[2].x - quad[3].x) * t, y: quad[3].y + (quad[2].y - quad[3].y) * t };
  // Sit it a third of the way up the slope, with a little per-building drift so
  // a terrace of dormers is not a picket line.
  const climb = 0.3 + (salt % 3) * 0.04;
  const base = { x: eave.x + (ridge.x - eave.x) * climb, y: eave.y + (ridge.y - eave.y) * climb };
  const bx = Math.round(base.x);
  const by = Math.round(base.y);
  const style = salt % 3;

  fillPolyHard(ctx, [
    { x: bx - 3, y: by }, { x: bx + 3, y: by },
    { x: bx + 3, y: by - 4 }, { x: bx - 3, y: by - 4 },
  ], skin.wall);
  fillPolyHard(ctx, [
    { x: bx - 1, y: by - 1 }, { x: bx + 2, y: by - 1 },
    { x: bx + 2, y: by - 3 }, { x: bx - 1, y: by - 3 },
  ], skin.glassLit ? skin.glass : PAL.darkWindow);
  if (style === 1) {
    // Shed dormer: a single flat pitch falling toward the eave.
    fillPolyHard(ctx, [
      { x: bx - 4, y: by - 4 }, { x: bx + 4, y: by - 6 },
      { x: bx + 4, y: by - 4 }, { x: bx - 4, y: by - 3 },
    ], roofLit);
    lineHard(ctx, { x: bx - 4, y: by - 4 }, { x: bx + 4, y: by - 6 }, skin.outline);
  } else if (style === 2) {
    // Hipped dormer: the little gable clipped back, wider than it is tall.
    fillPolyHard(ctx, [
      { x: bx - 4, y: by - 4 }, { x: bx + 4, y: by - 4 },
      { x: bx + 2, y: by - 6 }, { x: bx - 2, y: by - 6 },
    ], roofLit);
    lineHard(ctx, { x: bx - 4, y: by - 4 }, { x: bx + 4, y: by - 4 }, skin.outline);
    lineHard(ctx, { x: bx - 2, y: by - 6 }, { x: bx + 2, y: by - 6 }, skin.outline);
  } else {
    // Gabled dormer: the classic peak.
    fillPolyHard(ctx, [
      { x: bx - 4, y: by - 4 }, { x: bx + 4, y: by - 4 }, { x: bx, y: by - 7 },
    ], roofLit);
    lineHard(ctx, { x: bx - 4, y: by - 4 }, { x: bx + 4, y: by - 4 }, skin.outline);
  }
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

/** The covering family a roof was laid in, which decides its baked texture. */
export type RoofKind = 'slate' | 'clay' | 'copper' | 'thatch';

/** Point inside a slope quad: u runs along the eave, v from eave to ridge. */
function quadAt(quad: readonly Pt[], u: number, v: number): Pt {
  const a = { x: quad[0].x + (quad[1].x - quad[0].x) * u, y: quad[0].y + (quad[1].y - quad[0].y) * u };
  const b = { x: quad[3].x + (quad[2].x - quad[3].x) * u, y: quad[3].y + (quad[2].y - quad[3].y) * u };
  return { x: a.x + (b.x - a.x) * v, y: a.y + (b.y - a.y) * v };
}

/**
 * The covering itself, on the near slope. Slate hangs in staggered vertical
 * joints, clay pantiles ripple along their courses, copper is seamed in long
 * standing runs from ridge to eave, thatch is combed diagonally. Sparse marks
 * over the course lines already drawn: at zoom one this is a whisper, at zoom
 * three it is what tells the families apart.
 */
export function drawRoofTexture(
  ctx: CanvasRenderingContext2D, quad: readonly Pt[], kind: RoofKind,
  lit: string, shade: string, salt: number,
): void {
  if (quad.length < 4) return;
  const w = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
  const h = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y);
  if (w < 8 || h < 5) return;
  if (kind === 'copper') {
    // Standing seams, eave to ridge. A seam is a folded RIDGE of metal, so it
    // has a lit edge and a shadow beside it; a single line a tenth lighter
    // than the sheet quantises straight back into the sheet and left the
    // biggest copper roofs in the district as flat green fields.
    const seams = Math.max(3, Math.round(w / 7));
    const hi = shadeHex(lit, 0.28);
    const lo = shadeHex(shade, -0.22);
    const step = 1 / Math.max(1, w);
    for (let i = 1; i < seams; i++) {
      const u = i / seams + (((salt >>> i) & 1) === 0 ? 0.015 : -0.015);
      lineHard(ctx, quadAt(quad, u, 0.05), quadAt(quad, u, 0.95), hi);
      lineHard(ctx, quadAt(quad, u + step, 0.05), quadAt(quad, u + step, 0.95), lo);
    }
    return;
  }
  if (kind === 'thatch') {
    // Combed straw: short diagonal strokes near the eave.
    const marks = Math.max(3, Math.round(w / 7));
    for (let i = 0; i < marks; i++) {
      const u = (i + 0.5) / marks;
      const v = 0.12 + ((salt + i * 13) % 30) / 100;
      lineHard(ctx, quadAt(quad, u - 0.03, v + 0.16), quadAt(quad, u + 0.02, v), shadeHex(shade, -0.05));
    }
    return;
  }
  if (kind === 'slate') {
    // Staggered vertical joints between courses: the hung-slate read.
    const joints = Math.max(3, Math.round(w / 5));
    const dark = shadeHex(shade, -0.05);
    for (let row = 0; row < 3; row++) {
      const v = 0.2 + row * 0.25;
      const off = ((row + (salt >>> 2)) & 1) === 0 ? 0 : 0.5;
      for (let i = 0; i < joints; i++) {
        if (((i + row + salt) % 3) === 0) continue;
        const u = (i + off + 0.5) / joints;
        if (u <= 0.04 || u >= 0.96) continue;
        const p = quadAt(quad, u, v);
        ctx.fillStyle = dark;
        ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
      }
    }
    return;
  }
  // Clay pantiles: a warm fleck and a shadow fleck rippling along each course.
  const ticks = Math.max(3, Math.round(w / 4));
  const warm = shadeHex(lit, 0.1);
  const dark = shadeHex(shade, -0.08);
  for (let row = 0; row < 3; row++) {
    const v = 0.18 + row * 0.27;
    for (let i = 0; i < ticks; i++) {
      const k = (i * 7 + row * 5 + salt) % 9;
      if (k > 3) continue;
      const u = (i + 0.5) / ticks;
      if (u <= 0.04 || u >= 0.96) continue;
      const p = quadAt(quad, u, v);
      ctx.fillStyle = k < 2 ? warm : dark;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
    }
  }
}

/**
 * Ridge tiles: the half-round caps a tiler beds along the ridge. Small nubs on
 * the skyline every few pixels, alternating light and dark so the run reads as
 * separate tiles rather than a thicker line.
 */
export function drawRidgeTiles(
  ctx: CanvasRenderingContext2D, a: Pt, b: Pt, ridge: string, salt: number,
): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 8) return;
  const n = Math.floor(len / 3);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const x = Math.round(a.x + dx * t);
    const y = Math.round(a.y + dy * t);
    ctx.fillStyle = ((i + salt) & 1) === 0 ? shadeHex(ridge, 0.1) : shadeHex(ridge, -0.1);
    ctx.fillRect(x, y - 1, 1, 1);
  }
}

/**
 * Brick courses on a wall face: mortar lines parallel to the eave, joints
 * staggered every other course. This is what stops a brick wall reading as a
 * flat terracotta slab.
 */
export function drawBrickFace(
  ctx: CanvasRenderingContext2D, f: Face, wallH: number, mortar: string, industrial = false,
): void {
  // A works wall is a big plane: full bond with staggered joints at outline
  // contrast turns it into chain-link. Industrial brick gets sparse, quiet
  // horizontal courses only; the tight bond is for the polite streets.
  const course = industrial ? 5 : 3;
  const bricks = Math.max(2, Math.round(f.span / 4));
  for (let h = 2; h < wallH - 1; h += course) {
    lineHard(ctx, f.at(0.02, h), f.at(0.98, h), mortar);
    if (industrial) continue;
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
  // A dark joint AND a bright one on every course turned dressed stone into a
  // checkerboard: at this size the eye reads the noise and never the wall. The
  // bed joint is the only line that earns its place on every course; the
  // highlight and the vertical joints come every other one, so the masonry
  // reads as courses of stone rather than as chainmail.
  let row = 0;
  for (let h = 2; h < wallH - 1; h += course, row++) {
    lineHard(ctx, f.at(0.02, h), f.at(0.98, h), mortar);
    if (h > 2 && (row & 1) === 0) {
      lineHard(ctx, f.at(0.02, h + 1), f.at(0.98, h + 1), hilite);
    }
    if ((row & 1) === 1) continue;
    const stagger = (row & 2) === 0 ? 0 : 0.5;
    for (let i = 1; i < blocks; i++) {
      const t = (i + stagger) / blocks;
      if (t <= 0.04 || t >= 0.96) continue;
      lineHard(ctx, f.at(t, h), f.at(t, Math.min(wallH - 1, h + course - 1)), mortar);
    }
  }
  // Quoins on the leading corner, shared with the better brick buildings.
  drawQuoins(ctx, f, wallH, shadeHex(hilite, 0.06), mortar, course);
}

/**
 * Quoins: alternating dressed corner stones down the leading edge. A hair
 * brighter than the wall, they give a building its weight and mark the corner
 * the eye already reads as the silhouette. Lit face only, so the light does the
 * work of picking them out.
 */
export function drawQuoins(
  ctx: CanvasRenderingContext2D, f: Face, wallH: number,
  quoin: string, mortar: string, course = 4,
): void {
  if (!f.lit || f.span < 10) return;
  for (let h = 2; h < wallH - 2; h += course * 2) {
    faceQuad(ctx, f, 0.0, 0.06, h, Math.min(wallH - 1, h + course), quoin);
    lineHard(ctx, f.at(0.06, h), f.at(0.06, Math.min(wallH - 1, h + course)), mortar);
  }
}

/**
 * A stone string course between storeys. The horizontal band a mason runs at
 * each floor line on a facade worth the trouble: one bright line, one shadow
 * line under it, spaced off the same grid the windows use so the band lands
 * between the rows rather than through them.
 */
export function drawStringCourse(
  ctx: CanvasRenderingContext2D, f: Face, wallH: number, rows: number,
  hilite: string, shadow: string, skipGround: boolean,
): void {
  if (f.span < 10 || wallH < 17 || rows < 2) return;
  const bottom = skipGround ? wallH - 15 : wallH - 3;
  const usable = bottom - 4;
  if (usable < 6) return;
  const stepY = Math.max(7, Math.floor(usable / rows));
  for (let r = 1; r < rows; r++) {
    const h = 4 + r * stepY - 2;
    if (h < 6 || h > wallH - 7) continue;
    lineHard(ctx, f.at(0.02, h), f.at(0.98, h), hilite);
    lineHard(ctx, f.at(0.02, h + 1), f.at(0.98, h + 1), shadow);
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
 * Verdigris weeping from the brass.
 *
 * The game is named for this: rain crosses a gilded cornice and carries copper
 * salts down the stone beneath it. Two or three short green drips under the eave
 * line, on the buildings proud enough to carry trim. Civic pride, oxidising.
 */
export function drawVerdigrisStreaks(
  ctx: CanvasRenderingContext2D, f: Face, wallH: number, salt: number,
): void {
  if (f.span < 8) return;
  const n = 2 + (salt % 2);
  for (let i = 0; i < n; i++) {
    const t = 0.14 + ((salt >>> (2 + i)) % 68) / 100;
    const len = 2 + ((salt + i * 7) % 4);
    lineHard(ctx, f.at(t, 1), f.at(t, Math.min(wallH - 3, 1 + len)),
      i % 2 === 0 ? PAL.verd2 : PAL.verd1);
  }
}

/**
 * Pasted bills at street level: playbills, notices, quack remedies. The working
 * bank's walls are its noticeboard, and a bare brick terrace with nothing stuck
 * to it reads as a film set. One or two small papers, low on the wall where a
 * bill sticker can reach, each with an ink masthead line.
 */
export function drawWallPosters(
  ctx: CanvasRenderingContext2D, f: Face, wallH: number, salt: number,
): void {
  if (f.span < 10) return;
  const colours = [PAL.buntCream, PAL.parch2, PAL.buntRedHi, PAL.buntBlueHi];
  const n = 1 + (salt % 2);
  for (let i = 0; i < n; i++) {
    // Keep clear of the doorway band around t 0.28 to 0.45, where the door and
    // its step are drawn later and would truncate the paper oddly.
    const raw = ((salt >>> (3 + i * 2)) % 55) / 100;
    const t = raw < 0.14 ? 0.5 + raw : 0.08 + raw * 0.1 + (i === 1 ? 0.72 : 0);
    const top = Math.max(4, wallH - 9 - ((salt >>> i) % 3));
    const p = f.at(Math.min(0.9, t), top);
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    const h = 4 + ((salt + i) % 2);
    ctx.fillStyle = colours[(salt + i * 5) % colours.length];
    ctx.fillRect(x, y, 3, h);
    // The masthead: one ink line, which is all the type a bill carries at this
    // scale. A second bill sometimes hangs peeling by a corner.
    ctx.fillStyle = PAL.ink;
    ctx.fillRect(x, y + 1, 3, 1);
    if (((salt >>> 4) + i) % 3 === 0) ctx.fillRect(x + 2, y + h - 1, 1, 1);
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
    // On the worst stucco the render has come away in a sheet and the brick
    // shows through: a ragged warm patch low on the wall, its top edge in
    // shadow where the surviving render stands proud of it.
    if (wear === 2 && material === 'stucco' && f.span >= 9) {
      const pt = Math.min(0.78, t + 0.08);
      const patch = [
        f.at(pt, low - 4), f.at(pt + 0.14, low - 5),
        f.at(pt + 0.17, low), f.at(pt - 0.03, low),
      ];
      fillPolyHard(ctx, patch, PAL.brick1);
      ditherPolyHard(ctx, patch, PAL.brick0, 3);
      lineHard(ctx, patch[0], patch[1], crack);
    }
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
    // The first chip on every worn roof is a missing slate: a black socket where
    // the batten shows through, not a discoloured one. Nothing else on a roof is
    // that dark, which is what makes the loss legible from the air.
    if (i === 0 || (wear === 2 && i === 2)) {
      ctx.fillStyle = PAL.soot0;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), 2, 1);
      if (wear === 2) ctx.fillRect(Math.round(p.x) + 2, Math.round(p.y) - 1, 2, 1);
      continue;
    }
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
    // A run of slates gone together near the eave, where the gutter failed and
    // the frost got under them: two sockets side by side, low on the slope.
    const gap = at(0.6 + ((salt >>> 4) % 20) / 100, 0.2);
    ctx.fillStyle = PAL.soot0;
    ctx.fillRect(Math.round(gap.x), Math.round(gap.y), 3, 1);
    ctx.fillRect(Math.round(gap.x) + 1, Math.round(gap.y) + 1, 2, 1);
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

/**
 * A cast iron downpipe against the party wall. Terraces drained down the joint
 * between houses, so the pipe hugs the edge of the face where two buildings
 * meet, with two brackets and a shoe kicking out at the pavement.
 */
export function drawPartyPipe(
  ctx: CanvasRenderingContext2D, f: Face, wallH: number, iron: string, salt: number,
): void {
  if (f.span < 12) return;
  const t = (salt & 1) === 0 ? 0.04 : 0.96;
  lineHard(ctx, f.at(t, 2), f.at(t, wallH - 1), iron);
  for (const h of [Math.round(wallH * 0.3), Math.round(wallH * 0.68)]) {
    const p = f.at(t, h);
    ctx.fillStyle = shadeHex(iron, 0.15);
    ctx.fillRect(Math.round(p.x) - 1, Math.round(p.y), 3, 1);
  }
  const foot = f.at(t, wallH - 1);
  ctx.fillStyle = iron;
  ctx.fillRect(Math.round(foot.x) + (t < 0.5 ? 0 : -1), Math.round(foot.y), 2, 1);
}

/**
 * Area railings along a civic frontage: the iron fence that guards the light
 * well in front of a public building. Two runs either side of the doorway band,
 * uprights every few pixels under a single rail.
 */
export function drawAreaRailing(
  ctx: CanvasRenderingContext2D, f: Face, wallH: number, iron: string,
): void {
  if (f.span < 14) return;
  const top = wallH - 4;
  for (const [a, b] of [[0.03, 0.2], [0.8, 0.97]] as const) {
    lineHard(ctx, f.at(a, top), f.at(b, top), iron);
    const n = Math.max(2, Math.round((f.span * (b - a)) / 3));
    for (let i = 0; i <= n; i++) {
      const p = f.at(a + ((b - a) * i) / n, top);
      ctx.fillStyle = iron;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 4);
    }
  }
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

/**
 * Snow lying on a roof.
 *
 * The single most convincing winter cue in an isometric town: the ground is
 * mostly hidden by buildings from this angle, so a district reads as snowed on
 * or not by its roofs alone.
 *
 * It is a cap, not a coat. Snow holds at the ridge and slides off the eave, so
 * the cover starts at the ridge line and comes down the slope by an amount that
 * depends on how much has fallen and how steep the pitch is: a shallow roof
 * carries it nearly to the gutter, a steep one keeps a stripe along the ridge
 * and little else. The lower edge is walked in steps with a per-building jitter,
 * because a straight snow line across a roof reads as paint.
 *
 * Melt patches around the chimneys are what makes it look like weather rather
 * than a decal. A working flue is warm masonry and the snow retreats from it,
 * so each stack sits in a ring of bare tile.
 */
export function drawRoofSnow(
  ctx: CanvasRenderingContext2D, quad: readonly Pt[], cover: number, salt: number,
  roofLit: string, roofShade: string, stacks: readonly number[],
): void {
  if (quad.length < 4 || cover <= 0) return;
  // quad is [eaveA, eaveB, ridgeB, ridgeA]. u runs along the roof, v from the
  // eave at 0 to the ridge at 1, the same frame drawRoofPatina uses.
  const at = (u: number, v: number): Pt => {
    const a = { x: quad[0].x + (quad[1].x - quad[0].x) * u, y: quad[0].y + (quad[1].y - quad[0].y) * u };
    const b = { x: quad[3].x + (quad[2].x - quad[3].x) * u, y: quad[3].y + (quad[2].y - quad[3].y) * u };
    return { x: a.x + (b.x - a.x) * v, y: a.y + (b.y - a.y) * v };
  };
  const eaveMid = at(0.5, 0);
  const ridgeMid = at(0.5, 1);
  // How steep the slope is, in screen terms: a steep pitch climbs mostly in y,
  // a shallow one runs away from the camera in x.
  const climb = Math.max(0, eaveMid.y - ridgeMid.y);
  const run = Math.max(1, Math.abs(ridgeMid.x - eaveMid.x));
  const pitch = Math.max(0.4, Math.min(1.35, 1.55 - 0.36 * (climb / run)));
  const depth = Math.max(0.18, Math.min(0.82, (0.26 + (cover / 1000) * 0.36) * pitch));
  const foot = 1 - depth;

  const pale = shadeHex(PAL.slate2, 0.72);
  const shadow = shadeHex(PAL.slate2, 0.46);

  // The cover, with a ragged lower edge. Walked as a strip of quads so each
  // step can carry its own snow line without leaving a gap at the joins. The
  // solid part of the cover is walked with the same jitter: a straight edge
  // anywhere in this shape, on the dither line or on the fill, immediately
  // reads as a sheet thrown over the roof.
  const steps = 7;
  const jitter = (n: number) => ((((salt + n * 37) % 11) - 5) / 100) * 1.3;
  for (let i = 0; i < steps; i++) {
    const u0 = i / steps;
    const u1 = (i + 1) / steps;
    const v0 = Math.max(0.05, foot + jitter(i));
    const v1 = Math.max(0.05, foot + jitter(i + 1));
    ditherPolyHard(ctx, [at(u0, v0), at(u1, v1), at(u1, 1), at(u0, 1)], pale,
      cover >= 700 ? 13 : cover >= 380 ? 10 : 7);
    if (cover >= 380) {
      const lip = depth * (cover >= 700 ? 0.62 : 0.4);
      const s0 = Math.min(0.95, Math.max(0.1, 1 - lip + jitter(i + 3)));
      const s1 = Math.min(0.95, Math.max(0.1, 1 - lip + jitter(i + 4)));
      fillPolyHard(ctx, [at(u0, s0), at(u1, s1), at(u1, 1), at(u0, 1)], pale);
      // A shaded underside where the cover overhangs the tiles it sits on.
      ditherPolyHard(ctx, [
        at(u0, s0), at(u1, s1),
        at(u1, Math.max(0.05, s1 - 0.09)), at(u0, Math.max(0.05, s0 - 0.09)),
      ], shadow, 6);
    }
    // A tongue of snow left in a hollow further down the slope than the rest.
    if (cover >= 380 && ((salt >>> (i % 5)) & 3) === 0) {
      const t0 = (i + 0.2) / steps;
      const t1 = (i + 0.8) / steps;
      ditherPolyHard(ctx, [
        at(t0, Math.max(0.04, foot - 0.13)), at(t1, Math.max(0.04, foot - 0.13)),
        at(t1, foot + 0.04), at(t0, foot + 0.04),
      ], pale, 6);
    }
  }

  // The cap stands proud of the ridge tiles by a pixel: without this the ridge
  // line cuts the snow off flat and the roof looks shaved.
  if (cover >= 380) {
    const a = at(0.02, 1);
    const b = at(0.98, 1);
    lineHard(ctx, { x: a.x, y: a.y - 1 }, { x: b.x, y: b.y - 1 }, PAL.stone4);
    lineHard(ctx, a, b, pale);
  }

  // Bare tile around every flue.
  for (const u of stacks) {
    if (u < -0.1 || u > 1.1) continue;
    const w = 0.13;
    const u0 = Math.max(0, u - w);
    const u1 = Math.min(1, u + w);
    if (u1 - u0 < 0.02) continue;
    const melt = [at(u0, foot + 0.06), at(u1, foot + 0.06), at(u1, 1), at(u0, 1)];
    fillPolyHard(ctx, melt, roofLit);
    ditherPolyHard(ctx, melt, roofShade, 5);
    // Wet tile at the edge of the melt, where the snow is going.
    ditherPolyHard(ctx, [at(u0, foot + 0.06), at(u1, foot + 0.06), at(u1, foot + 0.2), at(u0, foot + 0.2)], shadow, 4);
  }
}


/**
 * Pilasters: the vertical order on a wall.
 *
 * A civic front or a mill flank is not a flat plane with holes in it. It is
 * bays divided by piers, and that vertical rhythm is what the eye reads as
 * architecture before it reads a single window. Without it the biggest
 * buildings in the district were the flattest things in the frame.
 *
 * Two pixels wide: a lit edge and its own shadow. That is the whole trick at
 * this scale, and it is why the pier reads as standing proud of the wall
 * rather than being painted on it.
 */
export function drawPilasters(
  ctx: CanvasRenderingContext2D, f: Face, wallH: number,
  lit: string, shade: string, bays: number,
  opts: { capital?: string; base?: string; top?: number } = {},
): void {
  if (f.span < 10 || bays < 2) return;
  const step = 1 / f.span;
  const top = opts.top ?? 1;
  for (let i = 0; i <= bays; i++) {
    // The end piers sit just inside the corner so they do not fight the quoins.
    const t = i === 0 ? 0.03 : i === bays ? 0.97 : i / bays;
    lineHard(ctx, f.at(t, top), f.at(t, wallH - 1), lit);
    lineHard(ctx, f.at(t + step, top), f.at(t + step, wallH - 1), shade);
    if (opts.capital) {
      // Capital and plinth: a wider block top and bottom, which is what turns
      // a stripe into a column.
      for (let k = 0; k < 2; k++) {
        lineHard(ctx, f.at(t - step, top + k), f.at(t + step * 2, top + k), opts.capital);
      }
    }
    if (opts.base) {
      for (let k = 0; k < 2; k++) {
        lineHard(ctx, f.at(t - step, wallH - 2 - k), f.at(t + step * 2, wallH - 2 - k), opts.base);
      }
    }
  }
}

/**
 * A corbel table: the stepped brick band a mill carries under its eaves. Cheap,
 * and it stops a works elevation ending in a straight line of nothing.
 */
export function drawCorbelTable(
  ctx: CanvasRenderingContext2D, f: Face, brick: string, shadow: string,
): void {
  if (f.span < 10) return;
  const teeth = Math.max(4, Math.round(f.span / 4));
  lineHard(ctx, f.at(0.02, 2), f.at(0.98, 2), brick);
  const step = 1 / f.span;
  for (let i = 0; i < teeth; i++) {
    const t = 0.04 + (i / teeth) * 0.92;
    lineHard(ctx, f.at(t, 3), f.at(t + step, 3), shadow);
  }
}
