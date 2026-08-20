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
  void: '#0b0e12',
  voidhi: '#141a21',

  // white stone: the civic pride
  stone0: '#3a3f47',
  stone1: '#6d717a',
  stone2: '#a8a99f',
  stone3: '#d9d6c4',
  stone4: '#f2eeda',

  // verdigris: the name of the game
  verd0: '#123028',
  verd1: '#1f5a48',
  verd2: '#3d8f74',
  verd3: '#6fc4a2',

  // brass and gold leaf
  brass0: '#4a3411',
  brassInk: '#6b4a12',
  brass1: '#8a6318',
  brass2: '#c9942c',
  brass3: '#f0c552',
  gold: '#ffe79a',

  // soot and iron: the rot
  soot0: '#0f1114',
  soot1: '#1e2228',
  soot2: '#33383f',
  soot3: '#545a63',

  // brick and terracotta: the factory quarter
  brick0: '#3b1f18',
  brick1: '#6e3524',
  brick2: '#a4553a',

  // roofs
  slate0: '#1c2230',
  slate1: '#313b4d',
  slate2: '#4e5a70',
  lead0: '#262a2e',
  lead1: '#414750',
  lead2: '#656d78',

  // timber
  wood0: '#2a1d14',
  wood1: '#4b3423',
  wood2: '#7a5636',

  // bunting and awnings: the papering-over
  buntRed: '#8c2f34',
  buntRedHi: '#c04a48',
  buntCream: '#e6dcc0',
  buntBlue: '#26415f',
  buntBlueHi: '#3c6a94',

  // river
  riv0: '#101d26',
  riv1: '#1c3644',
  riv2: '#2f5b66',
  rivGlint: '#7fb1ae',

  // vegetation
  leaf0: '#1a2c1c',
  leaf1: '#2f4a2a',
  leaf2: '#4d6c34',

  // light sources
  gas0: '#6b4a12',
  gas1: '#d9a13c',
  gas2: '#ffd98a',
  arc0: '#9fb8d6',
  arc1: '#e8f2ff',
  litWindow: '#f2c46a',
  litWindow2: '#ffe2a8',

  // smoke
  smoke0: '#23262b',
  smoke1: '#3a3e45',
  smoke2: '#565c66',

  // ink and paper: the UI plates
  ink: '#08090c',
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
  'gas1', 'gas2', 'arc0', 'arc1', 'litWindow', 'litWindow2', 'gold',
];

const EMISSIVE_SET = new Set<string>(EMISSIVE);

export interface LightGrade {
  mul: [number, number, number];
  add: [number, number, number];
  desat: number;
}

export const LIGHT: Record<'day' | 'dusk' | 'night', LightGrade | null> = {
  day: null,
  dusk: { mul: [0.86, 0.78, 0.82], add: [14, 6, 18], desat: 0.1 },
  night: { mul: [0.42, 0.46, 0.62], add: [8, 10, 20], desat: 0.3 },
};

/** Art-directed night colours. The computed tint handles the long tail; these are
 *  the ones worth deciding by hand. */
export const NIGHT_OVERRIDE: Partial<Record<PaletteKey, string>> = {
  stone2: '#4a5566',
  stone3: '#63708a',
  stone4: '#7e8ca6',
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
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Grade one palette entry into a lighting variant. Emissives are lifted, not dimmed. */
export function gradeColour(key: PaletteKey, variant: 'day' | 'dusk' | 'night'): string {
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

export function shadeHex(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const t = amount < 0 ? 0 : 255;
  const k = Math.abs(amount);
  return rgbToHex(r + (t - r) * k, g + (t - g) * k, b + (t - b) * k);
}
