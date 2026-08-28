// The diegetic panels. HTML and CSS over the canvas, mounted once and diffed.
//
// The inspector is re-rendered at 4 Hz and only when its subject or key state
// changes. Rebuilding innerHTML every sim tick with hundreds of souls janks, and
// it is the sort of thing that only shows up on the machine you are not testing on.
import { formatClock, phaseLabel, phaseOf, SPEEDS, minuteOfDay, MIN_PER_DAY } from '../sim/clock';
import type { City } from '../sim/city';
import { addressOf } from '../sim/worldgen';
import { describeBuilding, describeSoul, insideList, boundFor, carrying } from '../sim/prose';
import { worksSummary } from '../sim/works';
import { deputationSummary } from '../sim/deputations';
import { disasterSummary } from '../sim/disasters';
import { fullName } from '../sim/souls';
import type { Selection } from '../render/frame';
import type { ZoomStep } from '../render/iso';
import { BINDINGS, keycapFor, NUDGE_VERBS } from './keys';
import type { Verb } from './keys';
import { PAL } from '../render/palette';
import { mountVestry } from './vestry';
import type { Vestry } from './vestry';
import { weatherAt, weatherLabel } from '../sim/weather';
import { shelterSummary } from '../sim/shelters';
import { civicSummary } from '../sim/civic-memory';
import { occasionSummary } from '../sim/occasions';
import { activeMatters } from '../sim/matters';
import { mountDesk } from './desk';
import type { Desk } from './desk';
import type { InterventionKind, Target } from '../sim/types';
import { INTERVENTIONS } from '../sim/interventions';
import type { InterventionForecast } from '../sim/interventions';
import { wardMetrics, metricWord } from '../sim/metrics';
import { civicVisitSummary } from '../sim/civic-visits';

interface NudgeDecision {
  reason: string | null;
  forecast: InterventionForecast | null;
  recommended: boolean;
}

export interface ShellHooks {
  /** The selected building, for ordinances that need a street named. */
  selectedBuilding: () => number;
  onSelectSoul: (id: number) => void;
  onDismiss: () => void;
  onVerb: (verb: Verb) => void;
  onSetSpeed: (index: number) => void;
  onScrubTo: (minuteOfDay: number) => void;
  /** Advance by n game-minutes. Time is forward only, so this is the only verb. */
  onAdvance: (minutes: number) => void;
  onZoom: (step: ZoomStep) => void;
  onFocusTarget: (target: Target) => void;
  onDeclineMatter: (id: number) => void;
  onPressMatter: (id: number) => void;
}

export interface Shell {
  update: (city: City, sel: Selection, zoom: ZoomStep, speedIndex: number, budget: number) => void;
  nudgeReasons: (reasons: Map<string, NudgeDecision>) => void;
  /** On-screen feedback. Refusals used to go only to the visually-hidden live
   *  region, so a sighted player who pressed a key twice got nothing at all. */
  toast: (text: string, kind?: 'info' | 'loss' | 'gain') => void;
  toggleHelp: () => void;
  toggleVestry: () => void;
  toggleDesk: () => void;
  insets: () => { top: number; right: number; bottom: number; left: number };
  say: (text: string) => void;
  destroy: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function mountShell(root: HTMLElement, hooks: ShellHooks): Shell {
  root.textContent = '';
  const a11y = document.getElementById('a11y') as HTMLElement | null;
  let desk: Desk;

  // Pixel scale. Floored at 2 wherever text lives: Silkscreen is designed at 8px
  // and 8 CSS px is not readable by anyone. If the viewport cannot hold a panel,
  // the content shrinks, never the type.
  const applyScale = () => {
    // floor(min(w/480, h/360)) evaluates to 0 on any phone, and the clamp then
    // pinned it to 2, so a 390px handset got exactly the same absolute panel
    // sizes as a 1440px monitor. 258px of title plate plus 237px of verb menu
    // does not fit in 390px, which is why they overlapped.
    const forced = new URLSearchParams(location.search).get('ui');
    if (forced) {
      document.documentElement.style.setProperty('--px', String(Math.max(1, Math.min(4, Number(forced)))));
      return;
    }
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Below the sheet breakpoint the panels are full-width, so a smaller scale
    // buys legible line lengths rather than costing them.
    const px = w < 560 ? 2 : Math.max(2, Math.min(4, Math.floor(Math.min(w / 620, h / 460))));
    document.documentElement.style.setProperty('--px', String(px));
  };
  applyScale();
  window.addEventListener('resize', applyScale);

  // The bottom bar wraps to two rows on a 320px screen, so anything floating
  // above it has to know how tall it actually became rather than assume.
  const measureBar = () => {
    const h = scrub.getBoundingClientRect().height;
    if (h > 0) document.documentElement.style.setProperty('--bar-h', `${Math.round(h)}px`);
  };
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(measureBar).observe(document.documentElement);
  }
  window.addEventListener('resize', measureBar);

  // Title plate.
  const title = el('div', 'plate');
  title.id = 'titleplate';
  const h1 = el('h1', undefined, 'VERDIGRIS');
  const rule = el('div', 'rule');
  const clock = el('div', 'clock');
  clock.setAttribute('aria-hidden', 'true');
  const counts = el('div', 'counts');

  // The scoreboard. Three things the ward is balanced on, read live off the sim.
  const meters = el('div', 'meters');
  meters.setAttribute('role', 'group');
  meters.setAttribute('aria-label', 'How the ward stands');
  const mkMeter = (name: string) => {
    const row = el('div', 'meter');
    const label = el('span', 'meter-label', name);
    const track = el('div', 'meter-track');
    const fill = el('div', 'meter-fill');
    track.append(fill);
    const val = el('span', 'meter-val');
    row.append(label, track, val);
    meters.append(row);
    return { row, fill, val };
  };
  const mHappy = mkMeter('Happiness');
  const mOrder = mkMeter('Order');
  const mMoney = mkMeter('Money');

  // Powers are free now, so the old daily-allowance tokens are gone. The row
  // survives only to carry the desk button.
  const budgetRow = el('div', 'budget');
  const deskBtn = el('button', 'brass', 'DESK') as HTMLButtonElement;
  deskBtn.setAttribute('aria-label', "Open the alderman's desk");
  deskBtn.addEventListener('click', () => toggleDesk());
  budgetRow.append(deskBtn);
  title.append(h1, rule, clock, counts, meters, budgetRow);

  // Inspector.
  const inspector = el('div', 'plate');
  inspector.id = 'inspector';
  inspector.hidden = true;
  inspector.setAttribute('role', 'region');
  inspector.setAttribute('aria-label', 'Inspector');
  const insClose = el('button', 'close', '×');
  insClose.setAttribute('aria-label', 'Close inspector');
  insClose.addEventListener('click', () => hooks.onDismiss());
  const insName = el('div', 'name');
  const insDistrict = el('div', 'district');
  const insProse = el('p', 'prose');
  const insHeading = el('div', 'heading');
  const insList = el('ul');
  insList.setAttribute('role', 'list');
  const insMore = el('div', 'more');
  inspector.append(insClose, insName, insDistrict, insProse, insHeading, insList, insMore);

  // Zoom stepper. The end of the range dims a pip rather than greying a button,
  // so the instrument fiction survives being at the limit.
  const zoomPlate = el('div', 'plate');
  zoomPlate.id = 'zoomstepper';
  const zoomOut = el('button', 'brass', '−');
  zoomOut.setAttribute('aria-label', 'Further out');
  zoomOut.addEventListener('click', () => hooks.onVerb('zoomOut'));
  const zoomLabel = el('span', 'label', 'ZOOM');
  const pips = el('span');
  const zoomIn = el('button', 'brass', '+');
  zoomIn.setAttribute('aria-label', 'Closer');
  zoomIn.addEventListener('click', () => hooks.onVerb('zoomIn'));
  zoomPlate.append(zoomOut, zoomLabel, pips, zoomIn);

  // Time scrubber. The day ribbon is a canvas inside a DOM panel, which is the
  // one place in-canvas UI is correct.
  const scrub = el('div', 'plate');
  scrub.id = 'scrubber';
  const daybar = el('canvas');
  daybar.id = 'daybar';
  const readout = el('div', 'readout');
  const transport = el('div', 'transport');
  const speedButtons: HTMLButtonElement[] = [];
  ['⏸', '▶', '▶▶', '▶▶▶'].forEach((glyph, i) => {
    const b = el('button', 'brass', glyph) as HTMLButtonElement;
    b.setAttribute('aria-label', ['Hold', 'Run', 'Faster', 'Fastest'][i]);
    b.addEventListener('click', () => hooks.onSetSpeed(i));
    speedButtons.push(b);
    transport.append(b);
  });
  // Sheet toggles. Only rendered on narrow screens (CSS decides), and they are
  // the only route to the verbs and the interventions on a phone.
  const sheetbar = el('div');
  sheetbar.id = 'sheetbar';
  const mkSheet = (id: string, label: string) => {
    const b = el('button', 'brass', label) as HTMLButtonElement;
    b.setAttribute('aria-expanded', 'false');
    b.addEventListener('click', () => {
      // A phone has room for one working surface. Leaving the desk or vestry
      // above this sheet made the bottom button appear to work while every
      // action behind it was untappable.
      desk.node.hidden = true;
      vestry.node.hidden = true;
      help.hidden = true;
      const cur = document.documentElement.getAttribute('data-sheet');
      if (cur === id) document.documentElement.removeAttribute('data-sheet');
      else document.documentElement.setAttribute('data-sheet', id);
      syncSheets();
    });
    sheetbar.append(b);
    return b;
  };
  const verbSheetBtn = mkSheet('verbs', 'LOOK');
  const nudgeSheetBtn = mkSheet('nudges', 'ACT');
  const deskSheetBtn = el('button', 'brass', 'DESK') as HTMLButtonElement;
  deskSheetBtn.id = 'desk-sheet';
  deskSheetBtn.setAttribute('aria-label', "Open the alderman's desk");
  deskSheetBtn.addEventListener('click', () => toggleDesk());
  sheetbar.append(deskSheetBtn);
  const vestryBtn = el('button', 'brass', 'VESTRY') as HTMLButtonElement;
  vestryBtn.setAttribute('aria-label', 'The vestry: pass and rescind ordinances');
  vestryBtn.addEventListener('click', () => toggleVestry());
  sheetbar.append(vestryBtn);

  const helpBtn = el('button', 'brass', '?') as HTMLButtonElement;
  helpBtn.setAttribute('aria-label', 'Keys and what this is');
  helpBtn.addEventListener('click', () => toggleHelp());
  sheetbar.append(helpBtn);

  function syncSheets(): void {
    const cur = document.documentElement.getAttribute('data-sheet');
    verbSheetBtn.setAttribute('aria-expanded', String(cur === 'verbs'));
    nudgeSheetBtn.setAttribute('aria-pressed', String(cur === 'nudges'));
    nudgeSheetBtn.setAttribute('aria-expanded', String(cur === 'nudges'));
    verbSheetBtn.setAttribute('aria-pressed', String(cur === 'verbs'));
  }

  scrub.append(daybar, readout, transport, sheetbar);
  daybar.setAttribute('role', 'slider');
  daybar.setAttribute('aria-label', 'Time of day. Forward only: clicking earlier than now advances to that hour tomorrow.');
  daybar.tabIndex = 0;
  daybar.addEventListener('click', (ev) => {
    const rect = daybar.getBoundingClientRect();
    const t = (ev.clientX - rect.left) / rect.width;
    hooks.onScrubTo(Math.max(0, Math.min(MIN_PER_DAY - 1, Math.round(t * MIN_PER_DAY))));
  });
  // A slider with role="slider" and no keydown handler is an ARIA failure, not a
  // gap: arrows on a focused slider were panning the camera instead of moving
  // time. Forward only, so every key advances.
  daybar.addEventListener('keydown', (ev) => {
    const step = ev.key === 'ArrowRight' || ev.key === 'ArrowUp' ? (ev.shiftKey ? 60 : 15)
      : ev.key === 'ArrowLeft' || ev.key === 'ArrowDown' ? (ev.shiftKey ? 60 : 15)
        : ev.key === 'PageDown' || ev.key === 'PageUp' ? 360
          : 0;
    if (!step) return;
    ev.preventDefault();
    ev.stopPropagation();
    hooks.onAdvance(step);
  });

  // Verb menu. Disabled verbs stay in the tab order so the player learns they
  // exist, and lose their keycap so the disabled state is never colour-only.
  const verbs = el('div', 'plate');
  verbs.id = 'verbs';
  const verbList: { verb: Verb; node: HTMLButtonElement }[] = [];
  for (const v of ['peek', 'follow', 'hide'] as Verb[]) {
    const binding = BINDINGS.find((b) => b.verb === v);
    const b = el('button') as HTMLButtonElement;
    const label = el('span', undefined, (binding?.label ?? v).toUpperCase());
    const key = el('span', 'key', keycapFor(v));
    b.append(label, key);
    b.setAttribute('aria-keyshortcuts', keycapFor(v));
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-disabled') === 'true') return;
      hooks.onVerb(v);
    });
    verbList.push({ verb: v, node: b });
    verbs.append(b);
  }

  // The nudge menu. Every entry stays visible whether or not it is available,
  // because knowing that "quarantine a street" exists and is refused is more
  // useful than not knowing it exists. The refusal text is the teaching.
  const nudges = el('div', 'plate');
  nudges.id = 'nudges';
  const nudgeHead = el('div', 'heading', 'USE YOUR POWERS');
  const nudgeHint = el('div', 'hint');
  nudges.append(nudgeHead, nudgeHint);
  const nudgeList: { verb: Verb; node: HTMLButtonElement; why: HTMLElement }[] = [];
  for (const verb of Object.keys(NUDGE_VERBS) as Verb[]) {
    const binding = BINDINGS.find((b) => b.verb === verb);
    const b = el('button') as HTMLButtonElement;
    const label = el('span', undefined, (binding?.label ?? verb).toUpperCase());
    const key = el('span', 'key', keycapFor(verb));
    b.append(label, key);
    b.setAttribute('aria-keyshortcuts', keycapFor(verb));
    const why = el('div', 'why');
    why.id = `why-${verb}`;
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-disabled') === 'true') return;
      hooks.onVerb(verb);
    });
    const row = el('div', 'nudgerow');
    row.append(b, why);
    nudges.append(row);
    nudgeList.push({ verb, node: b, why });
  }

  const ticker = el('div');
  ticker.id = 'ticker';

  // Toast: feedback at the point of action, on screen, for everyone.
  const toastEl = el('div');
  toastEl.id = 'toast';
  toastEl.setAttribute('role', 'status');
  let toastTimer = 0;
  const toast: Shell['toast'] = (text, kind = 'info') => {
    toastEl.textContent = text;
    toastEl.className = kind;
    toastEl.setAttribute('data-show', '1');
    if (a11y) a11y.textContent = text;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.removeAttribute('data-show'), 4200);
  };

  // The help sheet, generated from the binding table so the two cannot drift.
  const help = el('div', 'plate');
  help.id = 'help';
  help.hidden = true;
  help.setAttribute('role', 'dialog');
  help.setAttribute('aria-modal', 'false');
  help.setAttribute('aria-label', 'Keys and what this is');
  const helpClose = el('button', 'close', '\u00d7') as HTMLButtonElement;
  helpClose.setAttribute('aria-label', 'Close');
  helpClose.addEventListener('click', () => toggleHelp());
  const helpIntro = el('p', 'prose');
  helpIntro.textContent = 'You run this ward of Verdigris. Keep three things in balance: how happy '
    + 'the district is, how orderly, and the money in the public purse. Every move you make shifts '
    + 'them, for better or worse. Reward the people or lean on them, build the place up or let it rot. '
    + 'Nothing is judged by the button you press, only by what actually happens on the ground.';
  help.append(helpClose, el('div', 'name', 'VERDIGRIS'), helpIntro);
  const groups: [string, string][] = [
    ['camera', 'LOOK'], ['time', 'TIME'], ['verbs', 'INSPECT'], ['nudges', 'POWERS'],
  ];
  for (const [g, label] of groups) {
    help.append(el('div', 'heading', label));
    const ul = el('ul');
    for (const bnd of BINDINGS.filter((x) => x.group === g)) {
      const li = el('li');
      li.append(el('span', 'k', bnd.keys.map((k) => (k === ' ' ? 'Space' : k)).join(' / ')));
      li.append(el('span', undefined, bnd.label));
      ul.append(li);
    }
    help.append(ul);
  }
  const toggleHelp = () => {
    if (help.hidden) {
      document.documentElement.removeAttribute('data-sheet');
      syncSheets();
      desk.node.hidden = true;
      vestry.node.hidden = true;
    }
    help.hidden = !help.hidden;
    if (!help.hidden) helpClose.focus();
  };

  /*
   * First run.
   *
   * There was no onboarding of any kind, and the only hint that the world was
   * interactive at all was `cursor: crosshair` on the canvas. A stranger saw a
   * small city, a clock, three grey buttons and a panel of eight refusals.
   *
   * Three sentences and a dismiss, shown once. Deliberately not a tutorial: the
   * game begins at the desk, and the only things a player has to be told are how
   * to inspect a matter, that influence is scarce, and that outcomes rather than
   * button presses decide the verdict.
   */
  const firstRun = el('div', 'plate');
  firstRun.id = 'firstrun';
  firstRun.setAttribute('role', 'dialog');
  firstRun.setAttribute('aria-label', 'Welcome');
  const seen = (() => {
    try { return localStorage.getItem('verdigris.seen') === '1'; } catch { return false; }
  })();
  firstRun.hidden = seen;
  firstRun.append(el('div', 'name', 'VERDIGRIS'));
  const fr = el('p', 'prose');
  fr.textContent = 'You run this ward of Verdigris. Hundreds of people live here, and you hold '
    + 'real power over how they live.';
  firstRun.append(fr);
  const list = el('ul');
  for (const line of [
    'Your job is to balance three things: Happiness, Order, and Money, shown top left.',
    'Click a building or a person, then use your powers: help them, or lean on them. Every act moves the three.',
    'Build your perfect district, or squeeze it for all it is worth. What happens on the ground is what counts.',
  ]) {
    const li = el('li');
    li.append(el('span', undefined, line));
    list.append(li);
  }
  firstRun.append(list);
  const frGo = el('button', 'brass', 'TAKE OFFICE') as HTMLButtonElement;
  frGo.addEventListener('click', () => {
    firstRun.hidden = true;
    try { localStorage.setItem('verdigris.seen', '1'); } catch { /* private mode */ }
    desk.open();
  });
  firstRun.append(frGo);

  const vestry: Vestry = mountVestry({
    say: (text, kind) => toast(text, kind),
    selectedBuilding: hooks.selectedBuilding,
  });
  const toggleVestry = () => {
    if (vestry.node.hidden) {
      document.documentElement.removeAttribute('data-sheet');
      syncSheets();
      desk.node.hidden = true;
      help.hidden = true;
    }
    vestry.node.hidden = !vestry.node.hidden;
    vestryBtn.setAttribute('aria-expanded', String(!vestry.node.hidden));
  };

  desk = mountDesk({
    onFocus: hooks.onFocusTarget,
    onDecline: hooks.onDeclineMatter,
    onPress: hooks.onPressMatter,
  });
  const toggleDesk = () => {
    if (desk.node.hidden) {
      document.documentElement.removeAttribute('data-sheet');
      syncSheets();
      vestry.node.hidden = true;
      help.hidden = true;
    }
    desk.toggle();
    deskSheetBtn.setAttribute('aria-expanded', String(!desk.node.hidden));
  };

  root.append(title, inspector, zoomPlate, scrub, verbs, nudges, ticker, toastEl, help, vestry.node, desk.node, firstRun);

  measureBar();
  let insetsAt = -1e9;
  let insetsCache = { top: 0, right: 0, bottom: 0, left: 0 };
  const dayCtx = daybar.getContext('2d');
  let lastKey = '';
  let lastTickerLen = 0;
  let lastInspectorPaint = -1;
  let prevZoom = -1;
  let prevSpeed = -1;

  const say = (text: string) => {
    if (a11y) a11y.textContent = text;
  };

  // Every value the panels display, so the whole update can be skipped when none
  // of it has changed.
  //
  // This ran unconditionally at 60Hz: about twenty DOM writes a frame, two of
  // which (the budget tokens and the zoom pips) rebuilt their children from
  // scratch, plus a canvas redraw of the day ribbon. On a phone that is a layout
  // pass per frame competing with the world render, and it is the likeliest
  // source of the stutter that has nothing to do with the simulation.
  let prevKey = '';
  const update: Shell['update'] = (city, sel, zoom, speedIndex, budget) => {
    const phase = phaseOf(city.tick);
    const weather = weatherAt(city.seed, city.tick);
    const key = `${city.tick}|${zoom}|${speedIndex}|${budget}|${city.matters.influenceCap}|${city.buildings.length}|${city.souls.length}`;
    if (key === prevKey) {
      // Selection and the vestry can change without the clock moving.
      paintIfChanged(city, sel);
      vestry.update(city);
      return;
    }
    prevKey = key;

    clock.textContent = `${formatClock(city.tick)} · ${phaseLabel(phase)} · ${weatherLabel(weather)}`;
    counts.textContent = `${city.buildings.length} ROOFS · ${city.souls.length} SOULS`;
    readout.textContent = `${formatClock(city.tick)} · ${phaseLabel(phase)} · ${weatherLabel(weather)}`;

    const m = wardMetrics(city);
    const setMeter = (meter: { fill: HTMLElement; val: HTMLElement; row: HTMLElement }, name: string, v: number) => {
      meter.fill.style.width = `${v / 10}%`;
      // Green when the ward is holding, amber when strained, red in trouble.
      meter.fill.style.background = v >= 640 ? 'var(--verd2)' : v >= 440 ? '#c9942c' : '#a8352f';
      meter.val.textContent = metricWord(v);
      meter.row.setAttribute('aria-label', `${name}: ${metricWord(v)}, ${Math.round(v / 10)} out of 100`);
    };
    setMeter(mHappy, 'Happiness', m.happiness);
    setMeter(mOrder, 'Order', m.order);
    setMeter(mMoney, 'Money', m.money);

    if (zoom !== prevZoom) {
      prevZoom = zoom;
      pips.textContent = '';
      for (const step of [1, 2, 3]) {
        pips.append(el('span', step <= zoom ? 'pip' : 'pip off'));
      }
      zoomOut.setAttribute('aria-disabled', String(zoom === 1));
      zoomIn.setAttribute('aria-disabled', String(zoom === 3));
    }

    if (speedIndex !== prevSpeed) {
      prevSpeed = speedIndex;
      for (let i = 0; i < speedButtons.length; i++) {
        speedButtons[i].setAttribute('aria-pressed', String(i === speedIndex));
      }
    }

    drawDaybar(dayCtx, daybar, city);
    vestry.update(city);
    desk.update(city);
    const matterCount = activeMatters(city.matters).length;
    deskBtn.textContent = `DESK ${matterCount} · ${city.matters.standing}`;

    paintIfChanged(city, sel);

    for (const { verb, node } of verbList) {
      const ok = verb === 'follow'
        ? sel.soulId >= 0
        : verb === 'peek'
          ? sel.buildingId >= 0
          : sel.buildingId >= 0 || sel.soulId >= 0;
      node.setAttribute('aria-disabled', String(!ok));
    }

    if (city.log.length !== lastTickerLen) {
      lastTickerLen = city.log.length;
      ticker.textContent = '';
      for (const e of city.log.slice(-4)) {
        ticker.append(el('div', e.kind, e.text));
      }
    }
  };

  /** Inspector, diffed by subject and throttled to 4 Hz. */
  function paintIfChanged(city: City, sel: Selection): void {
    const key = `${sel.buildingId}:${sel.soulId}`;
    const now = performance.now();
    if (key !== lastKey || now - lastInspectorPaint > 250) {
      lastKey = key;
      lastInspectorPaint = now;
      paintInspector(city, sel);
    }
  }

  function paintInspector(city: City, sel: Selection): void {
    const wardOf = (buildingId: number): string => {
      const b = city.buildings[buildingId];
      const ward = b ? city.wards[city.plots[b.plotId]?.wardId] : undefined;
      return ward?.name.toUpperCase() ?? '';
    };
    if (sel.soulId >= 0) {
      const s = city.souls[sel.soulId];
      if (!s) { inspector.hidden = true; return; }
      inspector.hidden = false;
      insName.textContent = fullName(s).toUpperCase();
      const home = city.buildings[s.homeId];
      insDistrict.textContent = home ? `${addressOf(city, home)} / ${wardOf(home.id)}` : '';
      insProse.textContent = describeSoul(city, s.id);
      insHeading.textContent = 'CARRYING:';
      insList.textContent = '';
      const li = el('li');
      const span = el('span', undefined, ` ·  ${carrying(city, s)}`);
      li.append(span);
      insList.append(li);
      insMore.textContent = s.inId < 0 ? `BOUND FOR: ${boundFor(city, s)}` : '';
      return;
    }
    if (sel.buildingId >= 0) {
      const b = city.buildings[sel.buildingId];
      if (!b) { inspector.hidden = true; return; }
      inspector.hidden = false;
      insName.textContent = b.name.toUpperCase();
      const street = city.streets[b.streetId];
      insDistrict.textContent = `${(street ? street.name : city.squareName).toUpperCase()} / ${wardOf(b.id)}`;
      insProse.textContent = describeBuilding(city, b.id);
      insHeading.textContent = 'INSIDE:';
      insList.textContent = '';
      // Rows are sized from the space actually available rather than a constant.
      const avail = inspector.clientHeight || window.innerHeight * 0.4;
      const rowPx = 22 * (Number(getComputedStyle(document.documentElement).getPropertyValue('--px')) || 2);
      const cap = Math.max(3, Math.min(12, Math.floor((avail - rowPx * 4) / rowPx)));
      const { lines, more } = insideList(city, b.id, cap);
      for (const line of lines) {
        const li = el('li');
        const btn = el('button', undefined, line.line) as HTMLButtonElement;
        btn.addEventListener('click', () => hooks.onSelectSoul(line.soulId));
        li.append(btn);
        insList.append(li);
      }
      if (!lines.length) {
        const li = el('li');
        li.append(el('span', undefined, ' ·  nobody, just now'));
        insList.append(li);
      }
      const works = worksSummary(city, b.id);
      const deputation = deputationSummary(city, b.id);
      const disaster = disasterSummary(city, b.id);
      const shelter = shelterSummary(city, b.id);
      const civic = civicSummary(city, b.id);
      const occasion = occasionSummary(city, b.id);
      const civicVisit = civicVisitSummary(city, b.id);
      insMore.textContent = [more > 0 ? `…and ${more} more` : '', civicVisit, civic, shelter, occasion, disaster, works, deputation].filter(Boolean).join('\n');
      return;
    }
    inspector.hidden = true;
  }

  let prevNudgeKey = '';
  const nudgeReasons: Shell['nudgeReasons'] = (reasons) => {
    const nudgeKey = [...reasons].map(([verb, item]) =>
      `${verb}:${item.reason ?? ''}:${item.forecast?.posture ?? ''}:${item.forecast?.text ?? ''}:${Number(item.recommended)}`).join('|');
    if (nudgeKey === prevNudgeKey) return;
    prevNudgeKey = nudgeKey;
    // Generic "pick a target" refusals are collapsed into one line at the top of
    // the panel. Six near-identical italic sentences stacked under six rows is a
    // wall of no, not teaching, and it made the rows reflow under the cursor
    // every time the selection changed.
    let needsTarget = 0;
    for (const { verb, node, why } of nudgeList) {
      const decision = reasons.get(verb);
      const reason = decision?.reason;
      const ok = reason === null;
      node.setAttribute('aria-disabled', String(!ok));
      node.toggleAttribute('data-recommended', Boolean(decision?.recommended));
      const generic = reason === 'Pick somebody first.' || reason === 'Pick a building first.';
      if (generic) needsTarget++;
      const kind = NUDGE_VERBS[verb] as InterventionKind;
      const forecast = decision?.forecast;
      const forecastText = forecast
        ? `${forecast.exposure.toUpperCase()} · ${forecast.posture.toUpperCase()} · ${forecast.text}`
        : '';
      const shown = ok ? forecastText : generic ? '' : (reason ?? '');
      node.title = INTERVENTIONS[kind].blurb;
      why.textContent = shown;
      // The same description carries the mechanism while available and the
      // refusal while unavailable, so pointer and screen-reader users get the
      // same decision context.
      if (shown) node.setAttribute('aria-describedby', why.id);
      else node.removeAttribute('aria-describedby');
    }
    const recommended = [...reasons.values()].some((item) => item.recommended);
    nudgeHint.textContent = recommended
      ? 'Marked powers deal with the matter you have open.'
      : needsTarget ? 'Most powers need a target. Click a building, or a person inside it.' : '';
  };

  return {
    update,
    nudgeReasons,
    toast,
    toggleHelp,
    toggleVestry,
    toggleDesk,
    // Cached. This measured four panels with getBoundingClientRect, and it is
    // called from every pointermove during a drag, so it forced a synchronous
    // layout on every frame of every pan.
    insets: () => {
      const now = performance.now();
      if (now - insetsAt > 500) {
        insetsAt = now;
        const t = title.getBoundingClientRect();
        const v = verbs.getBoundingClientRect();
        const s = scrub.getBoundingClientRect();
        const z = zoomPlate.getBoundingClientRect();
        insetsCache = {
          top: t.height + 12,
          right: v.width + 12,
          bottom: Math.max(s.height, z.height) + 12,
          left: z.width + 12,
        };
      }
      return insetsCache;
    },
    say,
    destroy: () => {
      window.removeEventListener('resize', applyScale);
      root.textContent = '';
    },
  };
}

/** The 24 hour ribbon: dithered night, dawn, day and dusk bands with an amber
 *  now-bead. Bands are palette colours, not gradients, so it matches the world. */
function drawDaybar(ctx: CanvasRenderingContext2D | null, canvas: HTMLCanvasElement, city: City): void {
  if (!ctx) return;
  const px = Number(getComputedStyle(document.documentElement).getPropertyValue('--px')) || 2;
  const w = 120;
  const h = 9;
  if (canvas.width !== w) {
    canvas.width = w;
    canvas.height = h;
  }
  canvas.style.width = `${w * px}px`;
  canvas.style.height = `${h * px}px`;
  ctx.imageSmoothingEnabled = false;

  for (let x = 0; x < w; x++) {
    const minute = Math.floor((x / w) * MIN_PER_DAY);
    const p = phaseOf(minute);
    ctx.fillStyle = p === 'night' ? PAL.slate0
      : p === 'dawn' ? PAL.brass1
        : p === 'dusk' ? PAL.brass0
          : p === 'evening' ? PAL.slate2
            : PAL.parch1;
    ctx.fillRect(x, 0, 1, h);
  }
  ctx.fillStyle = PAL.brassInk;
  for (const hour of [6, 12, 18]) {
    ctx.fillRect(Math.round((hour / 24) * w), 0, 1, 3);
  }
  const nowX = Math.round((minuteOfDay(city.tick) / MIN_PER_DAY) * w);
  ctx.fillStyle = PAL.gas2;
  ctx.fillRect(nowX - 1, 0, 3, h);
  ctx.fillStyle = PAL.ink;
  ctx.fillRect(nowX, 0, 1, h);

  canvas.setAttribute('aria-valuenow', String(minuteOfDay(city.tick)));
  canvas.setAttribute('aria-valuemin', '0');
  canvas.setAttribute('aria-valuemax', String(MIN_PER_DAY - 1));
  canvas.setAttribute('aria-valuetext', `${formatClock(city.tick)}, ${phaseLabel(phaseOf(city.tick))}`);
}

export { SPEEDS };
