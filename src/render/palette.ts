// The palette contract.
//
// Every non-transparent pixel the game draws is a member of PAL, and alpha is
// exactly 0 or 255. This is what makes two hundred buildings feel like one city,
// and it is what makes the ID picking buffer exact: source-in stamping needs a
// hard alpha edge or the silhouette bleeds.
//
// Ramps are 3 to 4 entries with wide luminance gaps, so they stay legible for
// colourblind players and at night.
//
// GOLD IS UNDER HALF A PERCENT OF PIXELS. The discipline is the whole effect: a
// city that gilds everything reads as cheap, and a city that gilds one clock face
// reads as proud. That restraint is the brief.
//
// art/palette.py mirrors this file and art/bake.py regenerates it. The generated
// copy is asserted against this one by a test, so there is one source of truth.
export const PAL = {
  // void and background
  void: '#0d0f13',
  voidhi: '#161b22',

  // ROOFS. The single most important group in the game: a town seen from above
  // is a field of roofs, and the silhouette plus the colour of those roofs is
  // most of what the eye reads. Saturated and warm, in four families that carry
  // the district's social geography.
  tileRed0: '#5e2418',
  tileRed1: '#8f3a24',
  tileRed2: '#b8583a',
  tileRed3: '#d4794a',
  slate0: '#232a3d',
  slate1: '#3b4763',
  slate2: '#5c6b8c',
  moss0: '#2a3a1f',
  moss1: '#46602f',
  moss2: '#6b8a45',
  thatch0: '#5a4423',
  thatch1: '#8a6c33',
  thatch2: '#b89a53',

  // verdigris: the name of the game, and the civic roof
  verd0: '#123028',
  verd1: '#1f5a48',
  verd2: '#3d8f74',
  verd3: '#6fc4a2',

  // WALLS. Warm cream stucco, ochre, timber and brick.
  cream0: '#7a6a4c',
  cream1: '#b09c72',
  cream2: '#ddc79a',
  cream3: '#f2e3c0',
  ochre0: '#6b4d22',
  ochre1: '#a5773a',
  ochre2: '#d1a662',
  brick0: '#40201a',
  brick1: '#6e3527',
  brick2: '#9c5138',
  wood0: '#2e2015',
  wood1: '#4f3722',
  wood2: '#7d5b34',
  plaster0: '#6d6a62',
  plaster1: '#a09a8c',
  plaster2: '#cfc7b4',

  // white stone: the civic pride
  stone0: '#3f4149',
  stone1: '#75766f',
  stone2: '#aeab97',
  stone3: '#dcd5b8',
  stone4: '#f5eeda',

  // brass and gold leaf
  brass0: '#4a3411',
  brassInk: '#6b4a12',
  brass1: '#8a6318',
  brass2: '#c9942c',
  brass3: '#f0c552',
  gold: '#ffe79a',

  // soot and iron: the rot
  soot0: '#111318',
  soot1: '#22262d',
  soot2: '#383d46',
  soot3: '#5b616b',

  // bunting and awnings: the papering-over
  buntRed: '#a8352f',
  buntRedHi: '#d4574a',
  buntCream: '#efe3c2',
  buntBlue: '#2a4a6b',
  buntBlueHi: '#4479a6',

  // river
  riv0: '#132b33',
  riv1: '#215261',
  riv2: '#357e85',
  rivGlint: '#8fd0c4',

  // ground
  grass0: '#28401f',
  grass1: '#3d5f2a',
  grass2: '#557f36',
  grass3: '#7aa348',
  dirt0: '#4a3823',
  dirt1: '#6f5535',
  dirt2: '#997c4d',
  cobble0: '#4b4740',
  cobble1: '#6f6a5f',
  cobble2: '#8f8878',

  // vegetation
  leaf0: '#1c2f18',
  leaf1: '#33501f',
  leaf2: '#4f7a2c',
  leaf3: '#79a445',

  // light sources
  gas0: '#6b4a12',
  gas1: '#e0a83f',
  gas2: '#ffdd93',
  arc0: '#9fb8d6',
  arc1: '#e8f2ff',
  litWindow: '#f6c96d',
  litWindow2: '#ffe6ac',
  darkWindow: '#20242e',

  // smoke
  smoke0: '#262a30',
  smoke1: '#3f444c',
  smoke2: '#5c626d',

  // ink and paper: the UI plates
  ink: '#1a1109',
  parch0: '#6b5c42',
  parch1: '#a8946c',
  parch2: '#d8c9a3',
  parch3: '#efe4c6',
} as const;

export type PaletteKey = keyof typeof PAL;

/** Entries that get BRIGHTER at night rather than darker. One rule, and it is the
 *  single line that sells gaslight: a computed night palette always looks like a
 *  filter, and lifting the emissives is what makes it look chosen. */
export const EMISSIVE: readonly PaletteKey[] = [
  'gas1', 'gas2', 'arc0', 'arc1', 'litWindow', 'litWindow2', 'gold', 'brass3',
];

const EMISSIVE_SET = new Set<string>(EMISSIVE);

export interface LightGrade {
  mul: [number, number, number];
  add: [number, number, number];
  desat: number;
}

export const LIGHT: Record<Variant, LightGrade | null> = {
  day: null,
  dusk: { mul: [0.74, 0.66, 0.74], add: [18, 8, 22], desat: 0.16 },
  night: { mul: [0.30, 0.34, 0.52], add: [6, 9, 20], desat: 0.42 },
};

/** Art-directed night colours. The computed tint handles the long tail; these are
 *  the ones worth deciding by hand. */
export const NIGHT_OVERRIDE: Partial<Record<PaletteKey, string>> = {
  stone2: '#4a5566',
  stone3: '#63708a',
  stone4: '#7e8ca6',
  cream2: '#5d6379',
  cream3: '#767d95',
  tileRed1: '#3d2a34',
  tileRed2: '#54394a',
  verd2: '#1f4a44',
  verd3: '#2f6d63',
  gold: '#ffe0a0',
  riv1: '#0d1a24',
  riv2: '#16303a',
  slate1: '#1a2130',
};

export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  // NaN is coerced to 0 rather than allowed through. An unguarded NaN here emits
  // "#NaNNaNNaN", which is not a parse error: assigning it to ctx.fillStyle is
  // silently IGNORED, the previous fill is kept, and on a fresh canvas that is
  // black. A third of the district rendered as black holes before this line
  // existed, and nothing anywhere reported an error.
  const c = (n: number) => {
    const v = Number.isFinite(n) ? n : 0;
    return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  };
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Grade one palette entry into a lighting variant. Emissives are lifted, not dimmed. */
export function gradeColour(key: PaletteKey, variant: Variant): string {
  const override = variant === 'night' ? NIGHT_OVERRIDE[key] : undefined;
  if (override) return override;
  const grade = LIGHT[variant];
  if (!grade) return PAL[key];
  let [r, g, b] = hexToRgb(PAL[key]);
  if (EMISSIVE_SET.has(key)) {
    const lift = variant === 'night' ? 1.18 : 1.08;
    return rgbToHex(r * lift, g * lift, b * lift);
  }
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  r = r + (lum - r) * grade.desat;
  g = g + (lum - g) * grade.desat;
  b = b + (lum - b) * grade.desat;
  return rgbToHex(r * grade.mul[0] + grade.add[0], g * grade.mul[1] + grade.add[1], b * grade.mul[2] + grade.add[2]);
}

/**
 * Grade an arbitrary colour, not just a palette key.
 *
 * The per-key version below only works for entries that exist in PAL, but by the
 * time a wall colour reaches the compositor it has been washed, sooted and
 * floored, so it is no longer a palette member. This takes the same grade and
 * applies it to whatever it is handed.
 */
export function gradeHex(hex: string, variant: Variant, emissive = false): string {
  const grade = LIGHT[variant];
  if (!grade) return hex;
  let [r, g, b] = hexToRgb(hex);
  if (emissive) {
    const lift = variant === 'night' ? 1.18 : 1.08;
    return rgbToHex(r * lift, g * lift, b * lift);
  }
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  r = r + (lum - r) * grade.desat;
  g = g + (lum - g) * grade.desat;
  b = b + (lum - b) * grade.desat;
  return rgbToHex(r * grade.mul[0] + grade.add[0], g * grade.mul[1] + grade.add[1], b * grade.mul[2] + grade.add[2]);
}

export type Variant = 'day' | 'dusk' | 'night';

/** Which lighting variant a tick falls in. Dawn borrows the dusk grade: the light
 *  is the same colour temperature going up as coming down. */
export function variantFor(minuteOfDay: number): Variant {
  if (minuteOfDay >= 1260 || minuteOfDay < 330) return 'night';
  if (minuteOfDay >= 1140 || minuteOfDay < 450) return 'dusk';
  return 'day';
}

/**
 * Shade toward black or white, on a FIXED LADDER.
 *
 * The amount is snapped to twentieths before it is applied. Pixel art works from
 * a bounded palette; letting every building compute its own continuous wash meant
 * the frame carried 1,235 distinct colours even after the antialiasing was gone,
 * and no two buildings of the same kind shared a single shade. Quantising the
 * ladder keeps all the variety that was intended (a wash of -0.1 is still a wash
 * of -0.1) while collapsing the accidental variety that was not.
 */
const SHADE_STEP = 0.05;

export function shadeHex(hex: string, amount: number): string {
  const snapped = Math.round(amount / SHADE_STEP) * SHADE_STEP;
  if (snapped === 0) return hex;
  const [r, g, b] = hexToRgb(hex);
  const t = snapped < 0 ? 0 : 255;
  const k = Math.abs(snapped);
  return rgbToHex(r + (t - r) * k, g + (t - g) * k, b + (t - b) * k);
}
