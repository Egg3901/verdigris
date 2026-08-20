// Bootstrap, the fixed-step loop, and input.
//
// The float simMin lives HERE and nowhere else. city.tick is an integer and the
// sim never sees a fraction, which is what makes the world a pure function of
// (seedStr, tickCount, nudges) and lets the QA goldens exist at all.
import './style.css';
import { newCity, tickCity, warp, hashWorld, soulsOutdoors } from './sim/city';
import type { City } from './sim/city';
import { MAX_TICKS_PER_FRAME, MIN_PER_DAY, SPEEDS, minuteOfDay } from './sim/clock';
import { buildScene, refreshBuilding, debugSkin } from './render/scene';
import type { Scene } from './render/scene';
import { drawFrame } from './render/frame';
import type { Selection } from './render/frame';
import { pickAt } from './render/pick';
import {
  clampCamera, clampDpr, defaultCamera, centreOn, isoX, isoY, worldBounds, zoomTo, ZOOM_STEPS,
} from './render/iso';
import type { Camera, ZoomStep } from './render/iso';
import { mountShell } from './ui/shell';
import type { Shell } from './ui/shell';
import { verbForKey, NUDGE_VERBS } from './ui/keys';
import type { Verb } from './ui/keys';
import { soulPos } from './sim/souls';
import { INTERVENTIONS, canApply, apply as applyNudge } from './sim/interventions';
import type { InterventionKind, Target } from './sim/types';

const params = new URLSearchParams(location.search);
const SEED = params.get('seed') ?? 'verdigris';

const canvas = document.getElementById('world') as HTMLCanvasElement;
const shellRoot = document.getElementById('shell') as HTMLElement;
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('canvas 2d unavailable');

const city: City = newCity(SEED);
let scene: Scene = buildScene(city);

let viewW = window.innerWidth;
let viewH = window.innerHeight;
let cam: Camera = defaultCamera(viewW, viewH);
const sel: Selection = { buildingId: -1, soulId: -1 };

let speedIndex = 1;
let simMin = 0;
let lastTickAt = 0;
let follow = -1;
let shell: Shell;

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

/** Why each nudge is or is not available right now, for the greyed-out menu. */
function nudgeReasons(): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const [verb, kindStr] of Object.entries(NUDGE_VERBS)) {
    const kind = kindStr as InterventionKind;
    const target = targetFor(kind);
    if (!target) {
      const wants = INTERVENTIONS[kind].targets;
      out.set(verb, wants.includes('soul') ? 'Pick somebody first.' : 'Pick a building first.');
      continue;
    }
    out.set(verb, canApply(city, kind, target));
  }
  return out;
}

function doVerb(verb: Verb): void {
  const nudgeKind = NUDGE_VERBS[verb] as InterventionKind | undefined;
  if (nudgeKind) {
    const target = targetFor(nudgeKind);
    if (!target) {
      shell.say('Nothing selected to aim that at.');
      return;
    }
    const why = canApply(city, nudgeKind, target);
    if (why) {
      shell.say(why);
      return;
    }
    applyNudge(city, nudgeKind, target);
    shell.say(city.log[city.log.length - 1]?.text ?? 'Done.');
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
        shell.say(`Following ${city.souls[follow].given} ${city.souls[follow].family}.`);
      }
      break;
    case 'peek':
      if (sel.buildingId >= 0) {
        const b = city.buildings[sel.buildingId];
        b.peeked = !b.peeked;
        refreshBuilding(city, scene, b.id);
        if (cam.zoom < 3) setZoom(3);
        shell.say(`${b.name}, roof off.`);
      }
      break;
    case 'hide':
      sel.buildingId = -1;
      sel.soulId = -1;
      follow = -1;
      break;
    case 'dismiss':
      if (follow >= 0) { follow = -1; shell.say('No longer following.'); }
      else { sel.buildingId = -1; sel.soulId = -1; }
      break;
    case 'help':
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
  onSelectSoul: (id) => { sel.soulId = id; sel.buildingId = -1; },
  onDismiss: () => { sel.buildingId = -1; sel.soulId = -1; follow = -1; },
  onVerb: doVerb,
  onSetSpeed: (i) => { speedIndex = i; },
  onScrubTo: scrubToMinuteOfDay,
  onZoom: setZoom,
});

// Input.
let dragging = false;
let dragMoved = false;
let lastX = 0;
let lastY = 0;
let wheelAccum = 0;

canvas.addEventListener('pointerdown', (ev) => {
  dragging = true;
  dragMoved = false;
  lastX = ev.clientX;
  lastY = ev.clientY;
  canvas.setPointerCapture(ev.pointerId);
});

canvas.addEventListener('pointermove', (ev) => {
  if (!dragging) return;
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

canvas.addEventListener('pointerup', (ev) => {
  dragging = false;
  canvas.releasePointerCapture(ev.pointerId);
  if (dragMoved) return;
  const hit = pickAt(city, scene, cam, fracMin(), ev.clientX, ev.clientY);
  if (hit.kind === 'soul') { sel.soulId = hit.id; sel.buildingId = -1; }
  else if (hit.kind === 'building') { sel.buildingId = hit.id; sel.soulId = -1; }
  else { sel.buildingId = -1; sel.soulId = -1; }
});

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

window.addEventListener('keydown', (ev) => {
  if (ev.target instanceof HTMLInputElement) return;
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
  state: () => { tick: number; outdoors: number; buildings: number; souls: number };
}

(window as unknown as { __verdigris: QaHook }).__verdigris = {
  city,
  setSpeed: (i) => { speedIndex = i; },
  warp: (minutes) => { warp(city, minutes); simMin = city.tick; },
  freeze: () => { speedIndex = 0; },
  hash: () => hashWorld(city),
  zoom: (step) => setZoom(step),
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
};

void scene;
