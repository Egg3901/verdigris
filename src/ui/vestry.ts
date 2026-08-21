// The vestry: where the player passes and repeals ordinances.
//
// Ten laws existed in the simulation, with real mechanisms, compliance keyed to
// character, enforcement, capture and repeal, and there was no way to reach any
// of it from the game. A system the player cannot touch is a system that is not
// in the product.
//
// The panel is deliberately a MINUTE BOOK rather than a control surface: rows of
// ordinances, the hour or the fee each is set at, whether it is in force, and
// whether the sitting was packed. The verbs are "move" and "rescind", because
// this is a parish vestry and not a settings screen.
import { formatClock } from '../sim/clock';
import type { City } from '../sim/city';
import {
  ORDINANCES, canEnact, canRepeal, enact, inForce, ordinanceOf, paramSpecOf, repeal,
} from '../sim/ordinances';
import type { OrdinanceKind } from '../sim/types';

export interface VestryHooks {
  /** Toast, so a refusal is visible rather than only announced. */
  say: (text: string, kind?: 'info' | 'loss' | 'gain') => void;
  /** The currently selected building, for the ordinances that need a street. */
  selectedBuilding: () => number;
}

export interface Vestry {
  node: HTMLElement;
  update: (city: City) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Render a parameter as the thing it is, not as an integer. */
function formatParam(kind: OrdinanceKind, value: number): string {
  const spec = paramSpecOf(kind);
  switch (spec.kind) {
    case 'hour': return formatClock(value);
    case 'fee': return `${value}d`;
    case 'street': return value < 0 ? 'no street chosen' : `street ${value}`;
    default: return '';
  }
}

export function mountVestry(hooks: VestryHooks): Vestry {
  const root = el('div', 'plate');
  root.id = 'vestry';
  root.hidden = true;
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'The vestry');

  const head = el('div', 'name', 'THE VESTRY');
  const status = el('div', 'vstatus');
  const close = el('button', 'close', '×') as HTMLButtonElement;
  close.setAttribute('aria-label', 'Close the vestry');
  close.addEventListener('click', () => { root.hidden = true; });
  root.append(close, head, status);

  const rows: {
    kind: OrdinanceKind;
    row: HTMLElement;
    state: HTMLElement;
    param: HTMLElement;
    act: HTMLButtonElement;
    less: HTMLButtonElement;
    more: HTMLButtonElement;
    why: HTMLElement;
  }[] = [];

  // Each ordinance's pending setting lives here, not in the sim: it is what the
  // player has dialled up but not yet moved.
  const pending = new Map<OrdinanceKind, number>();

  for (const def of ORDINANCES) {
    const spec = paramSpecOf(def.kind);
    pending.set(def.kind, def.defaultParam);

    const row = el('div', 'vrow');
    const title = el('div', 'vtitle');
    const label = el('span', 'vlabel', def.label.toUpperCase());
    const state = el('span', 'vstate');
    title.append(label, state);

    const blurb = el('div', 'vblurb', def.blurb);

    const controls = el('div', 'vcontrols');
    const less = el('button', 'brass', '−') as HTMLButtonElement;
    const param = el('span', 'vparam');
    const more = el('button', 'brass', '+') as HTMLButtonElement;
    const act = el('button', 'brass', 'MOVE') as HTMLButtonElement;

    const bump = (dir: number) => {
      if (spec.kind === 'none' || spec.kind === 'street') return;
      const cur = pending.get(def.kind) ?? def.defaultParam;
      const next = Math.max(spec.min, Math.min(spec.max, cur + dir * spec.step));
      pending.set(def.kind, next);
      param.textContent = `${spec.label} ${formatParam(def.kind, next)}`;
    };
    less.addEventListener('click', () => bump(-1));
    more.addEventListener('click', () => bump(1));
    less.setAttribute('aria-label', `Earlier or lower: ${def.label}`);
    more.setAttribute('aria-label', `Later or higher: ${def.label}`);

    if (spec.kind === 'none' || spec.kind === 'street') {
      less.hidden = true;
      more.hidden = true;
    }
    controls.append(less, param, more, act);

    const why = el('div', 'vwhy');
    row.append(title, blurb, controls, why);
    root.append(row);
    rows.push({ kind: def.kind, row, state, param, act, less, more, why });
  }

  const footer = el('div', 'vfoot');
  root.append(footer);

  let lastCity: City | null = null;

  for (const r of rows) {
    r.act.addEventListener('click', () => {
      const city = lastCity;
      if (!city) return;
      if (inForce(city, r.kind)) {
        const why = canRepeal(city, r.kind);
        if (why) { hooks.say(why, 'loss'); return; }
        repeal(city, r.kind);
        hooks.say(`${ORDINANCES.find((d) => d.kind === r.kind)?.label ?? r.kind} is rescinded.`, 'gain');
        return;
      }
      const why = canEnact(city, r.kind);
      if (why) { hooks.say(why, 'loss'); return; }
      const spec = paramSpecOf(r.kind);
      // The cart bylaw needs a street, and the only way to name one is to have
      // picked a building on it.
      let param = pending.get(r.kind);
      if (spec.kind === 'street') {
        const b = hooks.selectedBuilding();
        if (b < 0) { hooks.say('Choose a building on the street you mean, first.', 'loss'); return; }
        param = city.buildings[b].streetId;
        if (param < 0) { hooks.say('That building is not on a named street.', 'loss'); return; }
      }
      enact(city, r.kind, param);
      const ord = ordinanceOf(city, r.kind);
      hooks.say(
        ord.captured
          ? `It passed, but the sitting was packed. It is not the law you moved.`
          : `${ORDINANCES.find((d) => d.kind === r.kind)?.label ?? r.kind} is in force.`,
        ord.captured ? 'loss' : 'gain',
      );
    });
  }

  let prevKey = '';
  const update: Vestry['update'] = (city) => {
    lastCity = city;
    if (root.hidden) return;
    // Ten rows of text, three attributes each, rewritten sixty times a second
    // while the panel is open. Nothing on it changes faster than the game-hour.
    const key = `${city.laws.enforcement}|${city.laws.lastSat}|${Math.floor(city.tick / 10)}|`
      + city.laws.slots.map((o) => `${o.inForce}${o.param}${o.captured}${o.enforced}${o.breached}`).join(',');
    if (key === prevKey) return;
    prevKey = key;

    // Enforcement is the number that decides whether any of this means anything,
    // so it is the first thing on the page rather than buried per row.
    // Thresholds set from the range the system actually produces, measured over
    // three days: min 134, quartiles 177 / 248 / 304, max 446. The first pass used
    // 380 and 620, which were taken from the pre-institutional number and left the
    // panel reading "a dead letter" almost permanently.
    const enf = city.laws.enforcement;
    const word = enf > 330 ? 'firmly kept' : enf > 210 ? 'kept after a fashion' : 'a dead letter';
    status.textContent = `Enforcement ${enf} of 1000: ${word}.`;

    for (const r of rows) {
      const spec = paramSpecOf(r.kind);
      const live = inForce(city, r.kind);
      const ord = ordinanceOf(city, r.kind);
      r.row.setAttribute('data-live', String(live));
      r.state.textContent = live
        ? (ord.captured ? 'IN FORCE, PACKED' : 'IN FORCE')
        : '';
      const shown = live ? ord.param : (pending.get(r.kind) ?? 0);
      r.param.textContent = spec.kind === 'none' ? '' : `${spec.label} ${formatParam(r.kind, shown)}`;
      r.act.textContent = live ? 'RESCIND' : 'MOVE';
      r.less.hidden = live || spec.kind === 'none' || spec.kind === 'street';
      r.more.hidden = live || spec.kind === 'none' || spec.kind === 'street';

      const why = live ? canRepeal(city, r.kind) : canEnact(city, r.kind);
      r.act.setAttribute('aria-disabled', String(why !== null));
      // The generic "already sat today" applies to every row at once, so it goes
      // in the footer rather than repeated ten times down the page.
      r.why.textContent = why && why !== 'The vestry has already sat today.' ? why : '';
      if (live && ord.enforced + ord.breached > 0) {
        r.why.textContent = `${ord.enforced} turned back, ${ord.breached} defied it.`;
      }
    }

    const sat = canEnact(city, 'curfew') === 'The vestry has already sat today.';
    footer.textContent = sat
      ? 'The vestry has sat today. It meets again tomorrow.'
      : 'The vestry will hear one motion today.';
  };

  return { node: root, update };
}
