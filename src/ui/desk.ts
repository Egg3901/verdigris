// The alderman's desk: agenda, investigation links, verdicts and causal ledger.
// This is intentionally one panel over the existing city, not a second game UI.
import type { City } from '../sim/city';
import { dayOf, formatClock } from '../sim/clock';
import { activeMatters, matterDay } from '../sim/matters';
import type { Matter } from '../sim/matters';
import { recentCauses } from '../sim/pressures';
import type { Target } from '../sim/types';

export interface DeskHooks {
  onFocus: (target: Target) => void;
  onDecline: (id: number) => void;
}

export interface Desk {
  node: HTMLElement;
  update: (city: City) => void;
  toggle: () => void;
  open: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const RESPONSE: Record<string, string> = {
  fileWorks: 'a works case',
  callDeputation: 'a public deputation',
  fundStrike: 'a strike fund',
  openShelter: 'a storm refuge',
};

const WAY_IN: Record<Matter['kind'], string> = {
  repair: 'WAYS IN · File a works case. If the number stalls, bring the street to Civic Hall.',
  labour: 'WAYS IN · Fund the strike, or decline and keep your influence for another promise.',
  refuge: 'WAYS IN · Wait for the rain, inspect this public building, then open the refuge.',
};

function dueLabel(matter: Matter): string {
  return `DUE DAY ${matterDay(matter)}, ${formatClock(matter.dueAt)}`;
}

export function mountDesk(hooks: DeskHooks): Desk {
  const root = el('div', 'plate');
  root.id = 'desk';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'false');
  root.setAttribute('aria-label', "The alderman's desk");

  const close = el('button', 'close', '×') as HTMLButtonElement;
  close.setAttribute('aria-label', 'Close the desk');
  close.addEventListener('click', () => { root.hidden = true; });
  const title = el('div', 'name', "THE ALDERMAN'S DESK");
  const status = el('div', 'dstatus');
  const intro = el('p', 'prose', 'The city brings facts, not errands. Read the cause, inspect the place, then decide what your influence is worth.');
  const matters = el('div', 'dmatters');
  const movementHead = el('div', 'heading', 'WHY THE WARD MOVED');
  const movements = el('div', 'dmovements');
  const historyHead = el('div', 'heading', 'THE LEDGER');
  const history = el('div', 'dhistory');
  root.append(close, title, status, intro, matters, movementHead, movements, historyHead, history);

  let city: City | null = null;
  let prevKey = '';

  function renderMatter(matter: Matter): HTMLElement {
    const card = el('article', 'dmatter');
    card.setAttribute('data-status', matter.status);
    const head = el('div', 'dtitle');
    head.append(el('span', undefined, matter.title.toUpperCase()), el('span', 'dstate', matter.status.toUpperCase()));
    const petition = el('p', 'dpetition', matter.petition);
    const cause = el('p', 'dcause', `WHY NOW · ${matter.cause}`);
    const test = el('p', 'dtest', `PROMISE · ${matter.test}`);
    const wayIn = el('p', 'dway', WAY_IN[matter.kind]);
    const due = el('div', 'ddue', dueLabel(matter));
    const actions = el('div', 'dactions');
    const inspect = el('button', 'brass', 'INSPECT') as HTMLButtonElement;
    inspect.addEventListener('click', () => {
      root.hidden = true;
      hooks.onFocus(matter.target);
    });
    actions.append(inspect);
    if (matter.status === 'open') {
      const decline = el('button', 'brass', 'DECLINE') as HTMLButtonElement;
      decline.addEventListener('click', () => hooks.onDecline(matter.id));
      actions.append(decline);
    }
    if (matter.status === 'pending') {
      actions.append(el('span', 'danswer', `Answered with ${RESPONSE[matter.response ?? ''] ?? 'influence'}. The city has not answered back yet.`));
    }
    card.append(head, petition, cause, test, wayIn, due, actions);
    return card;
  }

  const update = (next: City): void => {
    city = next;
    const key = `${Math.floor(next.tick / 60)}|${next.matters.revision}|${next.press.causeHead}|${next.traced}|${next.paperCredibility}`;
    if (key === prevKey) return;
    prevKey = key;
    const active = activeMatters(next.matters);
    status.textContent = `DAY ${dayOf(next.tick)} · STANDING ${next.matters.standing}/1000 · ${active.length} MATTER${active.length === 1 ? '' : 'S'} BEFORE YOU`
      + `${next.traced ? ` · ${next.traced} HIGH-HANDED ACT${next.traced === 1 ? '' : 'S'} TRACED` : ''}`;

    matters.textContent = '';
    if (!active.length) matters.append(el('p', 'dempty', 'Nothing new is before the desk. The district continues without asking permission.'));
    else for (const matter of active) matters.append(renderMatter(matter));

    movements.textContent = '';
    const causes = recentCauses(next.press, 6);
    if (!causes.length) movements.append(el('div', 'dempty', 'No recorded movement yet.'));
    for (const cause of causes) {
      const row = el('div', 'dmovement');
      const sign = cause.delta > 0 ? '+' : '';
      row.append(
        el('span', 'dmetric', cause.key.toUpperCase()),
        el('span', cause.delta > 0 ? 'dup' : 'ddown', `${sign}${cause.delta}`),
        el('span', undefined, cause.note),
        el('span', 'dwhen', formatClock(cause.tick)),
      );
      movements.append(row);
    }

    history.textContent = '';
    const resolved = next.matters.items
      .filter((matter) => matter.status !== 'open' && matter.status !== 'pending')
      .slice(-6)
      .reverse();
    if (!resolved.length) history.append(el('div', 'dempty', 'No promises have come due.'));
    for (const matter of resolved) {
      const row = el('div', 'dverdict');
      row.setAttribute('data-status', matter.status);
      row.append(
        el('span', 'dstate', matter.status.toUpperCase()),
        el('span', undefined, matter.outcome),
        el('span', 'dwhen', `DAY ${dayOf(matter.resolvedAt)}`),
      );
      history.append(row);
    }
  };

  const open = () => {
    root.hidden = false;
    if (city) update(city);
    close.focus();
  };
  const toggle = () => { if (root.hidden) open(); else root.hidden = true; };
  return { node: root, update, open, toggle };
}
