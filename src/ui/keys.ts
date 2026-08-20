// One keybinding table. It drives the handlers AND the generated help sheet, so
// the two can never drift apart, and every mouse verb has a keyboard equivalent
// by construction rather than by good intentions.
export type Verb =
  | 'panLeft' | 'panRight' | 'panUp' | 'panDown' | 'recentre'
  | 'zoomIn' | 'zoomOut' | 'zoom1' | 'zoom2' | 'zoom3'
  | 'follow' | 'peek' | 'hide' | 'dismiss'
  | 'pause' | 'slower' | 'faster'
  | 'scrubBack' | 'scrubOn' | 'help';

export interface Binding {
  verb: Verb;
  keys: string[];
  label: string;
  group: 'camera' | 'time' | 'verbs' | 'meta';
}

export const BINDINGS: readonly Binding[] = [
  { verb: 'panLeft', keys: ['ArrowLeft', 'a'], label: 'Pan west', group: 'camera' },
  { verb: 'panRight', keys: ['ArrowRight', 'd'], label: 'Pan east', group: 'camera' },
  { verb: 'panUp', keys: ['ArrowUp', 'w'], label: 'Pan north', group: 'camera' },
  { verb: 'panDown', keys: ['ArrowDown', 's'], label: 'Pan south', group: 'camera' },
  { verb: 'recentre', keys: ['Home'], label: 'Recentre on the district', group: 'camera' },
  { verb: 'zoomIn', keys: ['+', '='], label: 'Closer', group: 'camera' },
  { verb: 'zoomOut', keys: ['-'], label: 'Further out', group: 'camera' },
  { verb: 'zoom1', keys: ['1'], label: 'The whole district', group: 'camera' },
  { verb: 'zoom2', keys: ['2'], label: 'Street level', group: 'camera' },
  { verb: 'zoom3', keys: ['3'], label: 'Close enough to peek', group: 'camera' },

  { verb: 'pause', keys: [' '], label: 'Hold time, or let it run', group: 'time' },
  { verb: 'slower', keys: [','], label: 'Slower', group: 'time' },
  { verb: 'faster', keys: ['.'], label: 'Faster', group: 'time' },
  { verb: 'scrubOn', keys: ['PageDown'], label: 'Advance six hours', group: 'time' },
  { verb: 'scrubBack', keys: ['PageUp'], label: 'Advance to this hour tomorrow', group: 'time' },

  { verb: 'follow', keys: ['f'], label: 'Follow someone', group: 'verbs' },
  { verb: 'peek', keys: ['r'], label: 'Peek in the roof', group: 'verbs' },
  { verb: 'hide', keys: ['h'], label: 'Hide this', group: 'verbs' },
  { verb: 'dismiss', keys: ['Escape'], label: 'Let it go', group: 'verbs' },

  { verb: 'help', keys: ['?'], label: 'This list', group: 'meta' },
];

const LOOKUP = new Map<string, Verb>();
for (const b of BINDINGS) for (const k of b.keys) LOOKUP.set(k.toLowerCase(), b.verb);

export function verbForKey(key: string): Verb | null {
  return LOOKUP.get(key.toLowerCase()) ?? null;
}

export function keycapFor(verb: Verb): string {
  const b = BINDINGS.find((x) => x.verb === verb);
  if (!b) return '';
  const k = b.keys[0];
  return k === ' ' ? 'SPC' : k.length === 1 ? k.toUpperCase() : k;
}
