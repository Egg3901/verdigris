// The alderman's desk: agenda, investigation links, verdicts and causal ledger.
// This is intentionally one panel over the existing city, not a second game UI.
import type { City } from '../sim/city';
import { dayOf, formatClock } from '../sim/clock';
import { activeMatters, canPressMatter, matterDay, matterInsight, regardFor } from '../sim/matters';
import type { Matter } from '../sim/matters';
import { recentCauses } from '../sim/pressures';
import type { Target } from '../sim/types';
import { fullName } from '../sim/souls';
import { pendingMeetingVisit, visitForMatter } from '../sim/civic-visits';

export interface DeskHooks {
  onFocus: (target: Target) => void;
  onDecline: (id: number) => void;
  onPress: (id: number) => void;
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
  fileWorks: 'entered a works case',
  callDeputation: 'called a deputation',
  fundStrike: 'backed a strike',
  openShelter: 'opened a refuge',
  quarantine: 'established a cordon',
  plantStory: 'put an account in the Herald',
  tipOff: 'laid an information',
  fundBunting: 'paid for the flags',
};

const WAY_IN: Record<Matter['kind'], string> = {
  repair: 'COURSES OPEN · Enter the defect in the Works Register. A deputation may bring forward a stalled case.',
  labour: 'COURSES OPEN · Maintain the picket, use the constables against it, or decline to interfere.',
  refuge: 'COURSES OPEN · View the public room, then open it as a refuge when the rain begins.',
  sanitation: 'COURSES OPEN · Establish a cordon, or enter the defective drain in the Works Register.',
  inquiry: 'COURSES OPEN · Lay an information before the constabulary, or put a defensible account in the Herald.',
  turnout: 'COURSES OPEN · Bring out supporters in the square, or prevent an opponent from attending.',
};

function dueLabel(matter: Matter): string {
  return `DUE DAY ${matterDay(matter)}, ${formatClock(matter.dueAt)}`;
}

function remainingLabel(city: City, matter: Matter): string {
  const end = matter.kind === 'labour' ? matter.respondedAt + 240 : matter.dueAt;
  const left = Math.max(0, end - city.tick);
  const hours = Math.floor(left / 60);
  const minutes = left % 60;
  return hours > 0 ? `${hours}H ${minutes}M TO VERDICT` : `${minutes}M TO VERDICT`;
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
  const peek = el('button', 'dpeek') as HTMLButtonElement;
  peek.addEventListener('click', () => root.removeAttribute('data-peek'));
  const status = el('div', 'dstatus');
  const intro = el('p', 'prose', 'Petitions are entered with a name, an address, and a day for answer. View the place or hear the petitioner before giving an undertaking.');
  const meeting = el('div', 'dmeeting');
  const matters = el('div', 'dmatters');
  const movementHead = el('div', 'heading', 'WHY THE WARD MOVED');
  const movements = el('div', 'dmovements');
  const historyHead = el('div', 'heading', 'THE LEDGER');
  const history = el('div', 'dhistory');
  root.append(peek, close, title, status, meeting, intro, matters, movementHead, movements, historyHead, history);

  let city: City | null = null;
  let prevKey = '';

  function renderMatter(matter: Matter): HTMLElement {
    const current = city as City;
    const card = el('article', 'dmatter');
    card.setAttribute('data-status', matter.status);
    const head = el('div', 'dtitle');
    head.append(el('span', undefined, matter.title.toUpperCase()), el('span', 'dstate', matter.status.toUpperCase()));
    const petition = el('p', 'dpetition', matter.petition);
    const visit = visitForMatter(current, matter.id);
    const visitText = !visit ? ''
      : visit.status === 'scheduled' ? `PETITIONERS DUE AT CIVIC HALL · ${formatClock(visit.startsAt)}`
        : visit.status === 'travelling' ? `PETITIONERS ON THE ROAD · ${visit.arrivedIds.length}/${visit.actorIds.length} ARRIVED`
          : visit.status === 'gathered' || visit.status === 'resolved'
            ? `AT CIVIC HALL · ${visit.arrivedIds.length}/${visit.actorIds.length} PRESENT`
            : matter.presentedAt >= 0 ? `PRESENTED IN PERSON · ${formatClock(matter.presentedAt)}` : 'THE LETTER ARRIVED; ITS AUTHORS DID NOT';
    const visitLine = el('div', 'dvisit', visitText);
    const people = el('div', 'dpeople');
    for (const id of matter.partyIds) {
      const soul = current.souls[id];
      if (!soul) continue;
      const regard = regardFor(current, id);
      const label = regard > 0 ? 'PATRON' : regard < 0 ? 'ESTRANGED' : '';
      const person = el('button', 'dperson', fullName(soul)) as HTMLButtonElement;
      if (label) person.append(el('span', regard > 0 ? 'patron' : 'estranged', label));
      person.setAttribute('aria-label', `${fullName(soul)}${label ? `, ${label.toLowerCase()}` : ''}. Inspect person.`);
      person.addEventListener('click', () => {
        root.setAttribute('data-peek', '1');
        peek.textContent = `${matter.title.toUpperCase()} · RETURN TO DESK`;
        hooks.onFocus({ kind: 'soul', id });
      });
      people.append(person);
    }
    const cause = el('p', 'dcause', `CLERK'S NOTE · ${matter.cause}`);
    const insightText = matterInsight(current, matter);
    const insight = el('p', 'dintel', insightText ? `PRIVATE WORD · ${insightText}` : 'No private word is entered. Hear a petitioner while making the ward round.');
    const test = el('p', 'dtest', `UNDERTAKING · ${matter.test}`);
    const wayIn = el('p', 'dway', WAY_IN[matter.kind]);
    const due = el('div', 'ddue', dueLabel(matter));
    const actions = el('div', 'dactions');
    const inspect = el('button', 'brass', 'INSPECT') as HTMLButtonElement;
    inspect.addEventListener('click', () => {
      root.setAttribute('data-peek', '1');
      peek.textContent = `${matter.title.toUpperCase()} · RETURN TO DESK`;
      hooks.onFocus(matter.target);
    });
    actions.append(inspect);
    if (matter.status === 'open') {
      const decline = el('button', 'brass', 'DECLINE') as HTMLButtonElement;
      decline.addEventListener('click', () => hooks.onDecline(matter.id));
      actions.append(decline);
    }
    if (matter.status === 'pending') {
      actions.append(el('span', 'danswer', `Minuted: ${RESPONSE[matter.response ?? ''] ?? 'action taken'}. ${remainingLabel(current, matter)}.`));
      const press = el('button', 'brass', 'FOLLOW UP · 1') as HTMLButtonElement;
      const why = canPressMatter(current, matter.id);
      press.setAttribute('aria-disabled', String(why !== null));
      press.title = why ?? 'Use one measure of influence to send a clerk after this undertaking.';
      press.addEventListener('click', () => { if (!why) hooks.onPress(matter.id); });
      actions.append(press);
    }
    card.append(head, petition, visitLine, people, cause, insight, test, wayIn, due, actions);
    return card;
  }

  const update = (next: City): void => {
    city = next;
    const key = `${Math.floor(next.tick / 10)}|${next.matters.revision}|${next.civicVisits.revision}|${next.press.causeHead}|${next.traced}|${next.paperCredibility}|${next.budgetLeft}`;
    if (key === prevKey) return;
    prevKey = key;
    const active = activeMatters(next.matters);
    status.textContent = `DAY ${dayOf(next.tick)} · STANDING ${next.matters.standing}/1000 · FOLLOW-UP ${next.budgetLeft}/${next.matters.influenceCap} · ${active.length} MATTER${active.length === 1 ? '' : 'S'} BEFORE YOU`
      + `${next.traced ? ` · ${next.traced} HIGH-HANDED ACT${next.traced === 1 ? '' : 'S'} TRACED` : ''}`;
    const gathering = pendingMeetingVisit(next);
    const lastMeeting = next.matters.meetings.at(-1);
    meeting.textContent = gathering
      ? gathering.status === 'scheduled'
        ? `RATEPAYERS CALLED · ${gathering.actorIds.length} DUE IN THE SQUARE AT ${formatClock(gathering.startsAt)} · VOTE ${formatClock(next.matters.nextMeetingAt)}.`
        : `RATEPAYERS GATHERING · ${gathering.arrivedIds.length}/${gathering.actorIds.length} IN THE SQUARE · VOTE ${formatClock(next.matters.nextMeetingAt)}.`
      : lastMeeting
        ? `LAST MEETING · ${lastMeeting.outcome.toUpperCase()} · ${lastMeeting.text} NEXT SITTING DAY ${dayOf(next.matters.nextMeetingAt)}.`
        : `RATEPAYERS SIT ON DAY ${dayOf(next.matters.nextMeetingAt)}. Their division will settle how many follow-up measures the chair may move each day.`;

    matters.textContent = '';
    if (!active.length) matters.append(el('p', 'dempty', 'No new petition is entered. Reports from the streets continue to arrive.'));
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
        el('span', 'dstate', `${matter.status.toUpperCase()} ${matter.standingDelta > 0 ? '+' : ''}${matter.standingDelta || ''}`),
        el('span', undefined, matter.outcome),
        el('span', 'dwhen', `DAY ${dayOf(matter.resolvedAt)}`),
      );
      history.append(row);
    }
  };

  const open = () => {
    root.hidden = false;
    root.removeAttribute('data-peek');
    if (city) update(city);
    close.focus();
  };
  const toggle = () => { if (root.hidden) open(); else root.hidden = true; };
  return { node: root, update, open, toggle };
}
