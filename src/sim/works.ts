// The Works Register.
//
// A works case is a request, not a magic repair button. It travels through the
// actual pneumatic post, waits for an actual workshop, and succeeds or fails
// against the district's actual coin and rot. The visible scaffold is therefore
// evidence of simulation state, not decoration laid over it.
import type { City } from './city';
import { isRunning } from './firms';
import { DEFS } from './buildings';
import { emit } from './events';
import { applyPressure, pressureOf } from './pressures';
import { connectBuilding, repairSegment, serviceAt } from './networks';
import { fileCivicWorks, resolveCivicWorks } from './civic-memory';

export type WorksKind = 'fabric' | 'drain' | 'gas';
export type WorksStatus = 'filed' | 'working' | 'completed' | 'skimmed' | 'shelved';

export interface WorkOrder {
  id: number;
  buildingId: number;
  kind: WorksKind;
  status: WorksStatus;
  filedAt: number;
  startsAt: number;
  dueAt: number;
  resolvedAt: number;
  workshopFirmId: number;
  pneumatic: boolean;
}

export interface WorksState {
  orders: WorkOrder[];
  /** Changes only when an order changes visual stage. The renderer rebakes then. */
  revision: number;
}

export interface WorksUpdate {
  buildingId: number;
  text: string;
  kind: 'loss' | 'gain' | 'info';
}

export function newWorks(): WorksState {
  return { orders: [], revision: 0 };
}

export function activeOrderFor(city: City, buildingId: number): WorkOrder | null {
  for (let i = city.works.orders.length - 1; i >= 0; i--) {
    const order = city.works.orders[i];
    if (order.buildingId !== buildingId) continue;
    if (order.status === 'filed' || order.status === 'working') return order;
  }
  return null;
}

export function latestOrderFor(city: City, buildingId: number): WorkOrder | null {
  for (let i = city.works.orders.length - 1; i >= 0; i--) {
    if (city.works.orders[i].buildingId === buildingId) return city.works.orders[i];
  }
  return null;
}

/** The most concrete defect wins. A broken service is heard before general decay. */
export function worksNeededAt(city: City, buildingId: number): WorksKind | null {
  const b = city.buildings[buildingId];
  if (!b) return null;
  const def = DEFS[b.kind];
  if (def.needsDrain && (b.drainSeg < 0 || !serviceAt(city.networks.drain, b.id))) return 'drain';
  if (def.needsGas && (b.gasSeg < 0 || !serviceAt(city.networks.gas, b.id))) return 'gas';
  if (b.fabric < 760) return 'fabric';
  return null;
}

export function canFileWorks(city: City, buildingId: number): string | null {
  const b = city.buildings[buildingId];
  if (!b) return 'Nothing there.';
  if (activeOrderFor(city, buildingId)) return 'That address is already in the register.';
  if (!worksNeededAt(city, buildingId)) return 'No defect here is grave enough for the register.';
  return null;
}

export function fileWorks(city: City, buildingId: number): WorkOrder {
  const b = city.buildings[buildingId];
  const kind = worksNeededAt(city, buildingId) ?? 'fabric';
  const pneumatic = b.postSeg >= 0 && serviceAt(city.networks.post, b.id);
  const workshop = city.firms.find((f) => f.kind === 'workshop');
  const startsAt = city.tick + (pneumatic ? 60 : 180);
  const order: WorkOrder = {
    id: city.works.orders.length,
    buildingId,
    kind,
    status: 'filed',
    filedAt: city.tick,
    startsAt,
    dueAt: startsAt + (kind === 'fabric' ? 360 : 240),
    resolvedAt: -1,
    workshopFirmId: workshop?.id ?? -1,
    pneumatic,
  };
  city.works.orders.push(order);
  city.works.revision++;
  fileCivicWorks(city, order);
  emit(city.events, 'worksFiled', buildingId, [], 160, city.tick);
  return order;
}

/**
 * Move one filed case forward in the register without pretending the work is
 * finished. The duration is an invariant: a deputation can win a crew sooner,
 * never make a drain or wall repair itself.
 */
export function expediteFiledOrder(city: City, orderId: number, startsAt: number): boolean {
  const order = city.works.orders[orderId];
  if (!order || order.status !== 'filed') return false;
  const nextStart = Math.max(city.tick, Math.min(order.startsAt, startsAt));
  if (nextStart >= order.startsAt) return false;
  const duration = order.dueAt - order.startsAt;
  order.startsAt = nextStart;
  order.dueAt = nextStart + duration;
  return true;
}

function firstBrokenOnPath(net: City['networks']['gas'], buildingId: number): number {
  let cur = net.buildingSeg[buildingId] ?? -1;
  let guard = 0;
  while (cur >= 0 && cur !== net.root && guard++ < net.parent.length) {
    if (net.segBroken[cur]) return cur;
    cur = net.parent[cur];
  }
  return -1;
}

function completePhysicalWork(city: City, order: WorkOrder): void {
  const b = city.buildings[order.buildingId];
  if (order.kind === 'fabric') {
    b.fabric = Math.min(1000, b.fabric + 180);
    b.facade = Math.min(1000, b.facade + 20);
    return;
  }

  const net = order.kind === 'drain' ? city.networks.drain : city.networks.gas;
  if (net.buildingSeg[b.id] < 0) connectBuilding(net, b.id, b.doorNode);
  const broken = firstBrokenOnPath(net, b.id);
  if (broken >= 0) repairSegment(net, broken);
  if (order.kind === 'drain') b.drainSeg = net.buildingSeg[b.id];
  else b.gasSeg = net.buildingSeg[b.id];
  // Opening a wall and making good also fixes some of the surrounding fabric.
  b.fabric = Math.min(1000, b.fabric + 70);
}

/** Called on the city's existing hourly boundary. Every branch is state-based. */
export function tickWorksHourly(city: City): WorksUpdate[] {
  const out: WorksUpdate[] = [];
  for (const order of city.works.orders) {
    const b = city.buildings[order.buildingId];
    if (!b) continue;

    if (order.status === 'filed' && city.tick >= order.startsAt) {
      if (pressureOf(city.press, 'coin') < 340) {
        order.status = 'shelved';
        order.resolvedAt = city.tick;
        city.works.revision++;
        resolveCivicWorks(city, order, false);
        out.push({
          buildingId: b.id,
          text: `The works case at ${b.name} was entered, numbered, and shelved for want of funds.`,
          kind: 'loss',
        });
        continue;
      }
      order.status = 'working';
      city.works.revision++;
      applyPressure(city.press, 'coin', -55, 'intervention', order.id, 'a crew entered in the works register', city.tick);
      emit(city.events, 'worksBegun', b.id, [], 260, city.tick);
      out.push({ buildingId: b.id, text: `A works gang has put up scaffold at ${b.name}.`, kind: 'info' });
    }

    if (order.status !== 'working' || city.tick < order.dueAt) continue;
    const workshop = city.firms[order.workshopFirmId];
    const honest = pressureOf(city.press, 'rot') < 520;
    const funded = pressureOf(city.press, 'coin') >= 360;
    const crewWorking = Boolean(workshop && isRunning(workshop, city.tick));
    order.resolvedAt = city.tick;
    city.works.revision++;

    if (honest && funded && crewWorking) {
      completePhysicalWork(city, order);
      order.status = 'completed';
      resolveCivicWorks(city, order, true);
      emit(city.events, 'worksCompleted', b.id, [], 220, city.tick);
      out.push({
        buildingId: b.id,
        text: `The scaffold came down at ${b.name}. The work underneath it was actually done.`,
        kind: 'gain',
      });
      continue;
    }

    // The visible backfire: the frontage is washed and a plaque appears, while
    // the pipe or fabric that justified the case is left exactly as it was.
    order.status = 'skimmed';
    b.facade = Math.min(1000, b.facade + 90);
    resolveCivicWorks(city, order, false);
    emit(city.events, 'worksSkimmed', b.id, [], 420, city.tick);
    out.push({
      buildingId: b.id,
      text: `The scaffold came down at ${b.name}. There is fresh paint, a brass plaque, and the same defect.`,
      kind: 'loss',
    });
  }
  return out;
}

/** Visual stage derived from stored state, never a renderer-owned timer. */
export function worksStageFor(city: City, buildingId: number): 0 | 1 | 2 | 3 {
  const order = latestOrderFor(city, buildingId);
  if (!order) return 0;
  if (order.status === 'filed') return 1;
  if (order.status === 'working') return 2;
  if (order.status === 'skimmed' && city.tick - order.resolvedAt < 2880) return 3;
  if (order.status === 'shelved' && city.tick - order.resolvedAt < 2880) return 1;
  return 0;
}

export function worksSummary(city: City, buildingId: number): string {
  const order = latestOrderFor(city, buildingId);
  if (!order) return '';
  const subject = order.kind === 'fabric' ? 'STRUCTURE' : order.kind === 'drain' ? 'DRAINS' : 'GAS MAIN';
  switch (order.status) {
    case 'filed': return `WORKS CASE ${order.id + 1} · ${subject} · FILED`;
    case 'working': return `WORKS CASE ${order.id + 1} · ${subject} · CREW ON SITE`;
    case 'completed': return `WORKS CASE ${order.id + 1} · ${subject} · COMPLETED`;
    case 'skimmed': return `WORKS CASE ${order.id + 1} · ${subject} · SIGNED OFF`;
    case 'shelved': return `WORKS CASE ${order.id + 1} · ${subject} · SHELVED`;
  }
}
