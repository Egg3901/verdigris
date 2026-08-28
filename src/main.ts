// Bootstrap, the fixed-step loop, and input.
//
// The float simMin lives HERE and nowhere else. city.tick is an integer and the
// sim never sees a fraction, which is what makes the world a pure function of
// (seedStr, tickCount, nudges) and lets the QA goldens exist at all.
import './style.css';
import { newCity, tickCity, warp, hashWorld, soulsOutdoors } from './sim/city';
import type { City } from './sim/city';
import { MAX_TICKS_PER_FRAME, MIN_PER_DAY, SPEEDS, minuteOfDay } from './sim/clock';
import { buildScene, refreshBuilding, debugSkin, lightPhase } from './render/scene';
import { renderPalette, variantFor } from './render/palette';
import type { Scene } from './render/scene';
import { drawFrame } from './render/frame';
import type { Selection } from './render/frame';
import { pickAt } from './render/pick';
import {
  clampCamera, clampDpr, defaultCamera, centreOn, isoX, isoY, screenToWorld, worldBounds, zoomTo, ZOOM_STEPS,
} from './render/iso';
import type { Camera, ZoomStep } from './render/iso';
import { mountShell } from './ui/shell';
import type { Shell } from './ui/shell';
import { verbForKey, NUDGE_VERBS } from './ui/keys';
import type { Verb } from './ui/keys';
import { soulPos } from './sim/souls';
import { describeBuilding } from './sim/prose';
import { INTERVENTIONS, canApply, forecastIntervention, apply as applyNudge } from './sim/interventions';
import type { InterventionForecast } from './sim/interventions';
import { enact as enactOrdinance, repeal as repealOrdinance } from './sim/ordinances';
import { startDisaster, canStartDisaster } from './sim/disasters';
import type { DisasterKind } from './sim/disasters';
import { startMarketDay } from './sim/occasions';
import type { InterventionKind, OrdinanceKind, Target } from './sim/types';
import { weatherAt, forceWeather } from './sim/weather';
import type { WeatherKind } from './sim/weather';
import { activeMatters, declineMatter, pressMatter, recommendedFor } from './sim/matters';

const params = new URLSearchParams(location.search);
const SEED = params.get('seed') ?? 'verdigris';

const canvas = document.getElementById('world') as HTMLCanvasElement;
const shellRoot = document.getElementById('shell') as HTMLElement;
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('canvas 2d unavailable');

/**
 * The district opens mid-morning, not at one minute past midnight.
 *
 * newCity starts at tick 0 because the sim has to be a pure function of
 * (seed, tick, nudges) and tick 0 is the only honest place to start it. But that
 * is MIDNIGHT: every soul is asleep, the streets are empty, and at the default
 * speed of one game-minute per second it took a player SIX REAL MINUTES of
 * watching a dark empty town before the first person stepped outside.
 *
 * I never saw it because every screenshot I have taken of this game warped to
 * 641 first. 641 is 10:41 in the morning, the hour on the reference the whole
 * project is modelled on, and it is where the district should open.
 */
const OPENING_TICK = 641;

const city: City = newCity(SEED);
{
  const at = Number(params.get('t'));
  warp(city, Number.isFinite(at) && at > 0 ? at : OPENING_TICK);
}
let scene: Scene = buildScene(city);

let viewW = window.innerWidth;
let viewH = window.innerHeight;
let cam: Camera = defaultCamera(viewW, viewH);
const sel: Selection = { buildingId: -1, soulId: -1 };

// Speed 1 is one game-minute per real second, so a day takes twenty-four real
// minutes and a soul's routine is invisible on the timescale anybody watches for.
// Speed 2 is four minutes per second: a day in six, a commute in five seconds.
let speedIndex = params.get('freeze') === '1' ? 0 : 2;
let simMin = 0;
let lastTickAt = 0;
let follow = -1;
let shell: Shell;
let buntingShown = false;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function resize(): void {
  viewW = window.innerWidth;
  viewH = window.innerHeight;
  const dpr = clampDpr(window.devicePixelRatio || 1);
  canvas.width = Math.round(viewW * dpr);
  canvas.height = Math.round(viewH * dpr);
  canvas.style.width = `${viewW}px`;
  canvas.style.height = `${viewH}px`;
  clampCamera(cam, viewW, viewH, shell ? shell.insets() : { top: 0, right: 0, bottom: 0, left: 0 });
}

function recentre(): void {
  const b = worldBounds();
  centreOn(cam, viewW, viewH, b.minX + b.w / 2, b.minY + b.h / 2);
}

function setZoom(step: ZoomStep, ax = viewW / 2, ay = viewH / 2): void {
  zoomTo(cam, step, ax, ay);
  clampCamera(cam, viewW, viewH, shell.insets());
}

/**
 * What a nudge is aimed at, given what is selected.
 *
 * Some interventions want a person, some want a building, and two are aimed at
 * the district as a whole. Resolving that here rather than in the sim keeps
 * interventions.ts free of UI state.
 */
function targetFor(kind: InterventionKind): Target | null {
  const def = INTERVENTIONS[kind];
  if (def.targets.includes('soul') && sel.soulId >= 0) return { kind: 'soul', id: sel.soulId };
  if (def.targets.includes('building') && sel.buildingId >= 0) return { kind: 'building', id: sel.buildingId };
  if (def.targets.includes('claim') && sel.soulId >= 0) return { kind: 'claim', id: sel.soulId };
  if (def.targets.includes('street') && sel.buildingId >= 0) return { kind: 'street', id: sel.buildingId };
  if (def.targets.includes('square')) return { kind: 'square', id: 0 };
  if (def.targets.includes('line')) return { kind: 'line', id: 0 };
  return null;
}

interface NudgeDecision {
  reason: string | null;
  forecast: InterventionForecast | null;
  recommended: boolean;
}

let nudgeDecisionKey = '';
let nudgeDecisionCache = new Map<string, NudgeDecision>();

/** Why each nudge is or is not available right now, for the greyed-out menu. */
function nudgeReasons(): Map<string, NudgeDecision> {
  const key = `${city.tick}|${city.budgetLeft}|${city.press.causeHead}|${city.matters.revision}|${sel.buildingId}|${sel.soulId}`;
  if (key === nudgeDecisionKey) return nudgeDecisionCache;
  const out = new Map<string, NudgeDecision>();
  for (const [verb, kindStr] of Object.entries(NUDGE_VERBS)) {
    const kind = kindStr as InterventionKind;
    const target = targetFor(kind);
    if (!target) {
      const wants = INTERVENTIONS[kind].targets;
      out.set(verb, {
        reason: wants.includes('soul') ? 'Pick somebody first.' : 'Pick a building first.',
        forecast: null,
        recommended: false,
      });
      continue;
    }
    const matter = activeMatters(city.matters).find((item) =>
      (sel.buildingId >= 0 && item.target.id === sel.buildingId)
      || (sel.soulId >= 0 && item.partyIds.includes(sel.soulId)));
    out.set(verb, {
      reason: canApply(city, kind, target),
      forecast: forecastIntervention(city, kind, target),
      recommended: Boolean(matter && recommendedFor(matter).includes(kind)),
    });
  }
  nudgeDecisionKey = key;
  nudgeDecisionCache = out;
  return out;
}

function doVerb(verb: Verb): void {
  const nudgeKind = NUDGE_VERBS[verb] as InterventionKind | undefined;
  if (nudgeKind) {
    const target = targetFor(nudgeKind);
    if (!target) {
      shell.toast('Nothing chosen to aim that at. Tap a roof, then a name inside it.', 'loss');
      return;
    }
    const why = canApply(city, nudgeKind, target);
    if (why) {
      shell.toast(why, 'loss');
      return;
    }
    applyNudge(city, nudgeKind, target);
    shell.toast(city.log[city.log.length - 1]?.text ?? 'Done.', 'gain');
    return;
  }
  switch (verb) {
    case 'zoomIn': setZoom(ZOOM_STEPS[Math.min(2, ZOOM_STEPS.indexOf(cam.zoom) + 1)]); break;
    case 'zoomOut': setZoom(ZOOM_STEPS[Math.max(0, ZOOM_STEPS.indexOf(cam.zoom) - 1)]); break;
    case 'zoom1': setZoom(1); break;
    case 'zoom2': setZoom(2); break;
    case 'zoom3': setZoom(3); break;
    case 'recentre': recentre(); break;
    case 'panLeft': cam.ox += 48; clampCamera(cam, viewW, viewH, shell.insets()); break;
    case 'panRight': cam.ox -= 48; clampCamera(cam, viewW, viewH, shell.insets()); break;
    case 'panUp': cam.oy += 48; clampCamera(cam, viewW, viewH, shell.insets()); break;
    case 'panDown': cam.oy -= 48; clampCamera(cam, viewW, viewH, shell.insets()); break;
    case 'pause': speedIndex = speedIndex === 0 ? 1 : 0; break;
    case 'slower': speedIndex = Math.max(0, speedIndex - 1); break;
    case 'faster': speedIndex = Math.min(SPEEDS.length - 1, speedIndex + 1); break;
    case 'scrubOn': scrubForward(360); break;
    case 'scrubBack': scrubForward(MIN_PER_DAY); break;
    case 'follow':
      if (sel.soulId >= 0) {
        follow = sel.soulId;
        // Following from the whole-district view steps in to street level: the
        // three zoom steps map onto the three registers of the verbs.
        if (cam.zoom === 1) setZoom(2);
        shell.toast(`Following ${city.souls[follow].given} ${city.souls[follow].family}.`);
      }
      break;
    case 'peek':
      if (sel.buildingId >= 0) {
        const b = city.buildings[sel.buildingId];
        b.peeked = !b.peeked;
        refreshBuilding(city, scene, b.id);
        if (cam.zoom < 3) setZoom(3);
        shell.toast(`${b.name}, roof off.`);
      }
      break;
    case 'hide':
      sel.buildingId = -1;
      sel.soulId = -1;
      follow = -1;
      break;
    case 'dismiss':
      if (follow >= 0) { follow = -1; shell.toast('No longer following.'); }
      else { sel.buildingId = -1; sel.soulId = -1; }
      break;
    case 'selectNear':
      break;
    case 'help':
      shell.toggleHelp();
      break;
    case 'vestry':
      shell.toggleVestry();
      break;
  }
}

/**
 * Time is FORWARD ONLY in this version.
 *
 * The sim is deterministic from (seed, tick, nudges), so a true rewind is a
 * replay, and a replay of a whole day costs about 300ms. That is affordable but
 * it is not free, and it needs a snapshot ring to stay affordable over a month.
 * Rather than ship a scrubber that silently cannot go left, the control says
 * "advance to" and means it.
 */
function scrubForward(minutes: number): void {
  const n = Math.max(0, Math.min(MIN_PER_DAY * 2, minutes));
  warp(city, n);
  simMin = city.tick;
}

function scrubToMinuteOfDay(target: number): void {
  const now = minuteOfDay(city.tick);
  const delta = target >= now ? target - now : MIN_PER_DAY - now + target;
  scrubForward(delta);
}

shell = mountShell(shellRoot, {
  selectedBuilding: () => sel.buildingId,
  onSelectSoul: (id) => { sel.soulId = id; sel.buildingId = -1; },
  onDismiss: () => { sel.buildingId = -1; sel.soulId = -1; follow = -1; },
  onVerb: doVerb,
  onSetSpeed: (i) => { speedIndex = i; },
  onScrubTo: scrubToMinuteOfDay,
  onAdvance: scrubForward,
  onZoom: setZoom,
  onFocusTarget: (target) => {
    if (target.kind === 'building') {
      const b = city.buildings[target.id];
      if (!b) return;
      sel.buildingId = b.id;
      sel.soulId = -1;
      follow = -1;
      if (cam.zoom < 2) setZoom(2);
      centreOn(cam, viewW, viewH, isoX(b.ox, b.oy), isoY(b.ox, b.oy));
      clampCamera(cam, viewW, viewH, shell.insets());
      return;
    }
    if (target.kind === 'soul') {
      const s = city.souls[target.id];
      if (!s) return;
      sel.soulId = s.id;
      sel.buildingId = -1;
      follow = -1;
      if (cam.zoom < 2) setZoom(2);
      const p = soulPos(city.graph, s, fracMin());
      centreOn(cam, viewW, viewH, isoX(p.cx, p.cy), isoY(p.cx, p.cy));
      clampCamera(cam, viewW, viewH, shell.insets());
    }
  },
  onDeclineMatter: (id) => {
    if (declineMatter(city, id)) shell.toast('The petition was declined. Your influence remains; your standing does not.', 'loss');
  },
  onPressMatter: (id) => {
    if (pressMatter(city, id)) shell.toast('A clerk has been sent after it. One influence spent.', 'gain');
  },
  onForceWeather: (kind) => {
    forceWeather(kind as WeatherKind | null);
    shell.toast(kind ? `The weather is set to ${kind}.` : 'The weather is back on its own.', 'info');
  },
  onTriggerDisaster: (kind) => {
    // Prefer the selected building; otherwise find any building it can strike.
    let id = sel.buildingId;
    if (id < 0 || canStartDisaster(city, kind, id)) {
      id = -1;
      for (const b of city.buildings) {
        if (!canStartDisaster(city, kind, b.id)) { id = b.id; break; }
      }
    }
    if (id < 0) {
      shell.toast(`Nothing in the ward can take ${kind === 'collapse' ? 'a collapse' : `a ${kind}`} right now.`, 'loss');
      return;
    }
    if (startDisaster(city, kind, id)) {
      // Take the camera to it, or the disaster happens off-screen and reads as
      // nothing having happened at all.
      const b = city.buildings[id];
      sel.buildingId = id;
      sel.soulId = -1;
      follow = -1;
      if (cam.zoom < 2) setZoom(2);
      centreOn(cam, viewW, viewH, isoX(b.ox, b.oy), isoY(b.ox, b.oy));
      clampCamera(cam, viewW, viewH, shell.insets());
      shell.toast(city.log[city.log.length - 1]?.text ?? 'Done.', 'loss');
    }
  },
});

// Input.
//
// Multi-pointer, because `touch-action: none` on the canvas kills the browser's
// native pinch, and the old single-pointer handler meant a second finger just
// fought the first for the pan. On a phone there was no way to zoom in at all:
// the pinch did nothing and the stepper's + button was underneath the scrubber.
const pointers = new Map<number, { x: number; y: number }>();
let dragMoved = false;
let lastX = 0;
let lastY = 0;
let wheelAccum = 0;
let pinchStart = 0;
let pinchZoom: ZoomStep = 1;

function pinchDistance(): number {
  const pts = [...pointers.values()];
  if (pts.length < 2) return 0;
  return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
}

function pinchCentre(): { x: number; y: number } {
  const pts = [...pointers.values()];
  return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
}

canvas.addEventListener('pointerdown', (ev) => {
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  dragMoved = false;
  lastX = ev.clientX;
  lastY = ev.clientY;
  if (pointers.size === 2) {
    pinchStart = pinchDistance();
    pinchZoom = cam.zoom;
    dragMoved = true; // a pinch is never a tap
  }
  // Capture can throw if the pointer is already gone (or is synthetic).
  try { canvas.setPointerCapture(ev.pointerId); } catch { /* nothing to capture */ }
});

canvas.addEventListener('pointermove', (ev) => {
  if (!pointers.has(ev.pointerId)) return;
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

  if (pointers.size >= 2) {
    if (pinchStart <= 0) return;
    const ratio = pinchDistance() / pinchStart;
    const idx = ZOOM_STEPS.indexOf(pinchZoom);
    // Whole steps only: the integer transform contract forbids a fractional zoom,
    // so a pinch selects a step rather than scaling continuously.
    const step = ratio > 1.35 ? 1 : ratio < 0.74 ? -1 : 0;
    const want = ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, idx + step))];
    if (want !== cam.zoom) {
      const c = pinchCentre();
      setZoom(want, c.x, c.y);
    }
    return;
  }

  const dx = ev.clientX - lastX;
  const dy = ev.clientY - lastY;
  if (Math.abs(dx) + Math.abs(dy) > 3) {
    dragMoved = true;
    follow = -1;
  }
  cam.ox += dx;
  cam.oy += dy;
  lastX = ev.clientX;
  lastY = ev.clientY;
  clampCamera(cam, viewW, viewH, shell.insets());
});

function endPointer(ev: PointerEvent, tap: boolean): void {
  const had = pointers.size;
  pointers.delete(ev.pointerId);
  if (pointers.size < 2) pinchStart = 0;
  try { canvas.releasePointerCapture(ev.pointerId); } catch { /* already gone */ }
  if (!tap || had > 1 || dragMoved) return;
  const hit = pickAt(city, scene, cam, fracMin(), ev.clientX, ev.clientY);
  if (hit.kind === 'soul') { sel.soulId = hit.id; sel.buildingId = -1; }
  else if (hit.kind === 'building') { sel.buildingId = hit.id; sel.soulId = -1; }
  else { sel.buildingId = -1; sel.soulId = -1; }
}

canvas.addEventListener('pointerup', (ev) => endPointer(ev, true));
canvas.addEventListener('pointercancel', (ev) => endPointer(ev, false));

canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  // An accumulator, so a trackpad flick is one step and not five.
  wheelAccum += ev.deltaY > 0 ? -0.25 : 0.25;
  if (Math.abs(wheelAccum) >= 1) {
    const dir = Math.sign(wheelAccum);
    wheelAccum = 0;
    const idx = ZOOM_STEPS.indexOf(cam.zoom);
    const next = ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, idx + dir))];
    setZoom(next, ev.clientX, ev.clientY);
  }
}, { passive: false });

/**
 * Keyboard selection of the world.
 *
 * There was no keyboard path to select a building or a soul at all, so a
 * keyboard-only player could pan, zoom and change speed, and nothing else. Six of
 * the interventions need a target, as do PEEK and FOLLOW, so the game was
 * effectively unplayable without a pointer.
 *
 * Arrows move the selection to the nearest thing in that SCREEN direction, which
 * is the only direction that means anything to someone looking at an isometric
 * projection. A tab order over 350 objects would be hostile; this is a reticle
 * you steer.
 */
function stepSelection(dx: number, dy: number): void {
  const from = currentSelectionPoint();
  let best = -1;
  let bestScore = Infinity;
  for (const b of city.buildings) {
    const wx = isoX(b.ox + b.w - 1, b.oy + b.d - 1);
    const wy = isoY(b.ox + b.w - 1, b.oy + b.d - 1);
    if (b.id === sel.buildingId) continue;
    const vx = wx - from.x;
    const vy = wy - from.y;
    // Must lie in the half-plane we are steering toward.
    const along = vx * dx + vy * dy;
    if (along <= 0) continue;
    const across = Math.abs(vx * dy - vy * dx);
    // Prefer close and on-axis: distance plus a heavy penalty for drifting.
    const score = along + across * 3;
    if (score < bestScore) { bestScore = score; best = b.id; }
  }
  if (best < 0) return;
  sel.buildingId = best;
  sel.soulId = -1;
  const b = city.buildings[best];
  centreOn(cam, viewW, viewH, isoX(b.ox, b.oy), isoY(b.ox, b.oy));
  clampCamera(cam, viewW, viewH, shell.insets());
  shell.say(`${b.name}. ${describeBuilding(city, b.id)}`);
}

function currentSelectionPoint(): { x: number; y: number } {
  if (sel.buildingId >= 0) {
    const b = city.buildings[sel.buildingId];
    return { x: isoX(b.ox + b.w - 1, b.oy + b.d - 1), y: isoY(b.ox + b.w - 1, b.oy + b.d - 1) };
  }
  if (sel.soulId >= 0) {
    const p = soulPos(city.graph, city.souls[sel.soulId], 0);
    return { x: isoX(p.cx, p.cy), y: isoY(p.cx, p.cy) };
  }
  // Nothing selected: steer from the centre of the view.
  const c = screenToWorld(cam, viewW / 2, viewH / 2);
  return { x: c.wx, y: c.wy };
}

window.addEventListener('keydown', (ev) => {
  if (ev.target instanceof HTMLInputElement) return;

  // Shift plus an arrow steers the world selection rather than the camera.
  if (ev.shiftKey && ev.key.startsWith('Arrow')) {
    const dirs: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    };
    const d = dirs[ev.key];
    if (d) { ev.preventDefault(); stepSelection(d[0], d[1]); return; }
  }
  // Space and Enter belong to whatever is focused. The old guard only checked for
  // an input, so focusing PEEK IN THE ROOF and pressing Space paused the sim and
  // did not press the button, which breaks the most basic keyboard convention on
  // the platform.
  const active = document.activeElement;
  const interactive = active instanceof HTMLButtonElement || active instanceof HTMLAnchorElement;
  if (interactive && (ev.key === ' ' || ev.key === 'Enter')) return;
  // Likewise the day ribbon owns its own arrow keys when it has focus.
  if (active instanceof HTMLCanvasElement && active.id === 'daybar') {
    if (ev.key.startsWith('Arrow') || ev.key === 'PageUp' || ev.key === 'PageDown') return;
  }
  const verb = verbForKey(ev.key);
  if (!verb) return;
  ev.preventDefault();
  doVerb(verb);
});

window.addEventListener('resize', resize);
resize();

function fracMin(): number {
  return Math.max(0, Math.min(1, simMin - Math.floor(simMin)));
}

function loop(now: number): void {
  if (simMin < city.tick) simMin = city.tick;
  const dt = lastTickAt ? Math.min(0.25, (now - lastTickAt) / 1000) : 0;
  lastTickAt = now;

  simMin += dt * SPEEDS[speedIndex];
  let ticks = 0;
  while (city.tick < Math.floor(simMin) && ticks < MAX_TICKS_PER_FRAME) {
    tickCity(city);
    ticks++;
  }
  // If the tab was backgrounded, do not spend the next minute catching up.
  if (city.tick < Math.floor(simMin) - MAX_TICKS_PER_FRAME) simMin = city.tick;


  if (follow >= 0) {
    const s = city.souls[follow];
    if (s.inId >= 0) {
      // Releasing on entry, and switching the card to that building's INSIDE
      // list, is the nicest beat in the whole camera and it is free.
      sel.buildingId = s.inId;
      sel.soulId = -1;
      follow = -1;
    } else {
      const p = soulPos(city.graph, s, fracMin());
      const wx = isoX(p.cx, p.cy);
      const wy = isoY(p.cx, p.cy);
      if (reducedMotion) centreOn(cam, viewW, viewH, wx, wy);
      else {
        const target = { x: viewW / 2 - cam.zoom * wx, y: viewH / 2 - cam.zoom * wy };
        cam.ox += (target.x - cam.ox) * Math.min(1, dt * 8);
        cam.oy += (target.y - cam.oy) * Math.min(1, dt * 8);
      }
      clampCamera(cam, viewW, viewH, shell.insets());
    }
  }

  // Rebake when the light changes. Three or four times a game-day, never per
  // frame: the whole point of baking is that the expensive pass is rare.
  const wantVariant = variantFor(minuteOfDay(city.tick));
  const buntingNow = city.buntingUntil > city.tick;
  if (wantVariant !== scene.variant || buntingNow !== buntingShown
    || scene.worksRevision !== city.works.revision
    || scene.deputationRevision !== city.deputations.revision
    || scene.civicVisitRevision !== city.civicVisits.revision
    || scene.disasterRevision !== city.disasters.revision
    || scene.weatherRevision !== weatherAt(city.seed, city.tick).revision
    || scene.shelterRevision !== city.shelters.revision
    || scene.occasionRevision !== city.occasions.revision
    || scene.lightPhase !== lightPhase(minuteOfDay(city.tick))) {
    buntingShown = buntingNow;
    scene = buildScene(city, wantVariant);
  }

  drawFrame(ctx as CanvasRenderingContext2D, city, scene, cam, viewW, viewH, fracMin(), sel);
  shell.update(city, sel, cam.zoom, speedIndex, city.budgetLeft);
  shell.nudgeReasons(nudgeReasons());
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// QA hook. capture.mjs sets speed 0 and moves time only through warp, so a
// golden is a pure function of (seed, tick) and never of wall-clock timing.
interface QaHook {
  city: City;
  setSpeed: (i: number) => void;
  warp: (minutes: number) => void;
  freeze: () => void;
  hash: () => number;
  zoom: (step: ZoomStep) => void;
  select: (kind: 'building' | 'soul', id: number) => void;
  debugSkin: (id: number) => unknown;
  lookAt: (tx: number, ty: number) => void;
  state: () => { tick: number; outdoors: number; buildings: number; souls: number };
  enact: (kind: string, param?: number) => boolean;
  repeal: (kind: string) => boolean;
  nudge: (kind: string, target: Target) => boolean;
  disaster: (kind: string, buildingId: number) => boolean;
  market: () => boolean;
  weather: () => string;
  palette: () => readonly string[];
}

(window as unknown as { __verdigris: QaHook }).__verdigris = {
  city,
  setSpeed: (i) => { speedIndex = i; },
  warp: (minutes) => { warp(city, minutes); simMin = city.tick; },
  freeze: () => { speedIndex = 0; },
  hash: () => hashWorld(city),
  zoom: (step) => setZoom(step),
  lookAt: (tx, ty) => {
    centreOn(cam, viewW, viewH, isoX(tx, ty), isoY(tx, ty));
    clampCamera(cam, viewW, viewH, shell.insets());
  },
  select: (kind, id) => {
    sel.buildingId = kind === 'building' ? id : -1;
    sel.soulId = kind === 'soul' ? id : -1;
  },
  debugSkin: (id: number) => debugSkin(city, city.buildings[id]),
  state: () => ({
    tick: city.tick,
    outdoors: soulsOutdoors(city),
    buildings: city.buildings.length,
    souls: city.souls.length,
  }),
  enact: (kind, param) => enactOrdinance(city, kind as OrdinanceKind, param),
  repeal: (kind) => repealOrdinance(city, kind as OrdinanceKind),
  nudge: (kind, target) => applyNudge(city, kind as InterventionKind, target),
  disaster: (kind, buildingId) => startDisaster(city, kind as DisasterKind, buildingId) !== null,
  market: () => startMarketDay(city) > 0,
  weather: () => weatherAt(city.seed, city.tick).kind,
  palette: () => renderPalette(scene.variant),
};
