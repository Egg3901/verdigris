// Civic memory is deliberately a fixed set of address records, not an ever-growing
// chronicle. Every address keeps the last decisive civic episode and its scars;
// households carry the part of that history which still changes their lives.
import type { City } from './city';
import type { Disaster } from './disasters';
import type { WorkOrder } from './works';
import type { BuildingId, HouseholdId, SoulId } from './types';

export type CivicCause = 'none' | 'fire' | 'flood' | 'collapse' | 'fabric' | 'drain' | 'gas';
export type CivicVerdict = 'none' | 'open' | 'madeGood' | 'failed';

export interface CivicRecord {
  buildingId: BuildingId;
  episode: number;
  cause: CivicCause;
  verdict: CivicVerdict;
  openedAt: number;
  resolvedAt: number;
  disasterId: number;
  worksOrderId: number;
  /** 0 none, 1 heard, 2 dismissed or too thin. */
  hallOutcome: 0 | 1 | 2;
  severity: number;
  scars: number;
  failedWorks: number;
  completedWorks: number;
  householdIds: HouseholdId[];
}

export interface InstitutionLedger {
  worksKept: number;
  worksFailed: number;
  hallHeard: number;
  hallDismissed: number;
  reliefHelped: number;
  reliefHarmed: number;
}

export interface CivicMemoryState {
  records: CivicRecord[];
  householdBurden: Uint16Array;
  householdRecovery: Uint8Array;
  householdLastBuilding: Int16Array;
  institutions: InstitutionLedger;
  revision: number;
}

const MAX_HOUSEHOLDS_PER_RECORD = 12;

function clamp(v: number): number {
  return Math.max(0, Math.min(1000, Math.round(v)));
}

function capped(v: number): number {
  return Math.max(0, Math.min(32767, v));
}

export function newCivicMemory(buildingCount: number, householdCount: number): CivicMemoryState {
  const records: CivicRecord[] = [];
  for (let id = 0; id < buildingCount; id++) {
    records.push({
      buildingId: id, episode: 0, cause: 'none', verdict: 'none',
      openedAt: -1, resolvedAt: -1, disasterId: -1, worksOrderId: -1,
      hallOutcome: 0, severity: 0, scars: 0, failedWorks: 0, completedWorks: 0,
      householdIds: [],
    });
  }
  return {
    records,
    householdBurden: new Uint16Array(householdCount),
    householdRecovery: new Uint8Array(householdCount),
    householdLastBuilding: new Int16Array(householdCount).fill(-1),
    institutions: { worksKept: 0, worksFailed: 0, hallHeard: 0, hallDismissed: 0, reliefHelped: 0, reliefHarmed: 0 },
    revision: 0,
  };
}

export function civicRecordAt(city: City, buildingId: BuildingId): CivicRecord | null {
  return city.civic.records[buildingId] ?? null;
}

export function civicHouseholdBurden(city: City, householdId: HouseholdId): number {
  return city.civic.householdBurden[householdId] ?? 0;
}

/** A bounded long tail, strong enough to change later participation but not a new pressure. */
export function civicGrievanceTarget(city: City, householdId: HouseholdId): number {
  return Math.min(90, Math.trunc(civicHouseholdBurden(city, householdId) / 11));
}

function householdsForDisaster(city: City, event: Disaster): HouseholdId[] {
  const found = new Set<HouseholdId>();
  const addSoul = (id: SoulId) => {
    const householdId = city.souls[id]?.householdId;
    if (householdId !== undefined && householdId >= 0) found.add(householdId);
  };
  for (const id of event.evacuatedIds) addSoul(id);
  for (const id of event.affectedBuildingIds) {
    const b = city.buildings[id];
    if (!b) continue;
    for (const householdId of b.householdIds) found.add(householdId);
  }
  const firm = city.firms[city.buildings[event.buildingId]?.firmId ?? -1];
  if (firm) for (const soulId of firm.workerIds) addSoul(soulId);
  return [...found].sort((a, b) => a - b).slice(0, MAX_HOUSEHOLDS_PER_RECORD);
}

function beginEpisode(record: CivicRecord, cause: CivicCause, severity: number, tick: number, disasterId: number, households: HouseholdId[]): void {
  if (record.cause !== 'none') record.scars = capped(record.scars + 1);
  record.episode = capped(record.episode + 1);
  record.cause = cause;
  record.verdict = 'open';
  record.openedAt = tick;
  record.resolvedAt = -1;
  record.disasterId = disasterId;
  record.worksOrderId = -1;
  record.hallOutcome = 0;
  record.severity = clamp(severity);
  record.householdIds = households.slice(0, MAX_HOUSEHOLDS_PER_RECORD);
}

function addBurden(city: City, householdIds: readonly HouseholdId[], buildingId: BuildingId, amount: number, takePurse: boolean): void {
  for (const householdId of householdIds) {
    const household = city.households[householdId];
    if (!household) continue;
    city.civic.householdBurden[householdId] = clamp(civicHouseholdBurden(city, householdId) + amount);
    city.civic.householdRecovery[householdId] = 0;
    city.civic.householdLastBuilding[householdId] = buildingId;
    if (takePurse) household.purse = Math.max(0, household.purse - Math.max(4, Math.trunc(amount / 8)));
  }
}

/** Called after the physical disaster is committed. Its records survive the short disaster lifecycle. */
export function openCivicDisaster(city: City, event: Disaster): void {
  const record = civicRecordAt(city, event.buildingId);
  if (!record) return;
  const households = householdsForDisaster(city, event);
  beginEpisode(record, event.kind, event.severity, event.startedAt, event.id, households);
  addBurden(city, households, event.buildingId, 120 + Math.trunc(event.severity / 8), true);
  city.civic.revision++;
}

function causeForWorks(kind: WorkOrder['kind']): CivicCause {
  return kind === 'fabric' ? 'fabric' : kind;
}

function householdsForBuilding(city: City, buildingId: BuildingId): HouseholdId[] {
  const b = city.buildings[buildingId];
  if (!b) return [];
  const found = new Set<HouseholdId>(b.householdIds);
  const firm = city.firms[b.firmId];
  if (firm) for (const soulId of firm.workerIds) found.add(city.souls[soulId].householdId);
  return [...found].filter((id) => id >= 0).sort((a, b) => a - b).slice(0, MAX_HOUSEHOLDS_PER_RECORD);
}

/** A filed case makes an ordinary defect part of the district's remembered civic record. */
export function fileCivicWorks(city: City, order: WorkOrder): void {
  const record = civicRecordAt(city, order.buildingId);
  if (!record) return;
  if (record.verdict !== 'open') {
    beginEpisode(record, causeForWorks(order.kind), 280, order.filedAt, -1, householdsForBuilding(city, order.buildingId));
  }
  record.worksOrderId = order.id;
  record.verdict = 'open';
  city.civic.revision++;
}

/** Works outcomes are only recorded at their real state transition, never from display state. */
export function resolveCivicWorks(city: City, order: WorkOrder, completed: boolean): void {
  const record = civicRecordAt(city, order.buildingId);
  if (!record || record.worksOrderId !== order.id) return;
  record.resolvedAt = order.resolvedAt;
  if (completed) {
    record.verdict = 'madeGood';
    record.completedWorks = capped(record.completedWorks + 1);
    city.civic.institutions.worksKept = capped(city.civic.institutions.worksKept + 1);
    for (const householdId of record.householdIds) {
      city.civic.householdBurden[householdId] = clamp(civicHouseholdBurden(city, householdId) - 110);
      city.civic.householdRecovery[householdId] = 1;
    }
  } else {
    record.verdict = 'failed';
    record.failedWorks = capped(record.failedWorks + 1);
    city.civic.institutions.worksFailed = capped(city.civic.institutions.worksFailed + 1);
    addBurden(city, record.householdIds, record.buildingId, 95, false);
  }
  city.civic.revision++;
}

export function recordCivicHearing(city: City, orderId: number, heard: boolean): void {
  const record = city.civic.records.find((candidate) => candidate.worksOrderId === orderId);
  if (!record) return;
  record.hallOutcome = heard ? 1 : 2;
  if (heard) city.civic.institutions.hallHeard = capped(city.civic.institutions.hallHeard + 1);
  else city.civic.institutions.hallDismissed = capped(city.civic.institutions.hallDismissed + 1);
  city.civic.revision++;
}

/** Relief is credited only when a guest reached a provider and received its actual result. */
export function recordCivicRelief(city: City, soulId: SoulId, helped: boolean): void {
  const householdId = city.souls[soulId]?.householdId;
  if (householdId === undefined || householdId < 0) return;
  if (helped) {
    city.civic.institutions.reliefHelped = capped(city.civic.institutions.reliefHelped + 1);
    city.civic.householdBurden[householdId] = clamp(civicHouseholdBurden(city, householdId) - 25);
  } else {
    city.civic.institutions.reliefHarmed = capped(city.civic.institutions.reliefHarmed + 1);
    addBurden(city, [householdId], city.souls[soulId].homeId, 35, false);
  }
  city.civic.revision++;
}

/** Recovery is slow and only follows an actually completed repair. */
export function tickCivicRecoveryDaily(city: City): void {
  for (let householdId = 0; householdId < city.civic.householdBurden.length; householdId++) {
    if (city.civic.householdRecovery[householdId] === 0) continue;
    const before = city.civic.householdBurden[householdId];
    const after = Math.max(0, before - 10);
    if (after === before) continue;
    city.civic.householdBurden[householdId] = after;
    city.civic.revision++;
  }
}

export function civicSummary(city: City, buildingId: BuildingId): string {
  const record = civicRecordAt(city, buildingId);
  if (!record || record.cause === 'none') return institutionSummary(city, buildingId);
  const cause = record.cause === 'fire' ? 'FIRE' : record.cause === 'flood' ? 'FLOOD'
    : record.cause === 'collapse' ? 'COLLAPSE' : record.cause === 'fabric' ? 'STRUCTURE'
      : record.cause === 'drain' ? 'DRAINS' : 'GAS MAIN';
  const verdict = record.verdict === 'madeGood' ? 'MADE GOOD' : record.verdict === 'failed' ? 'SIGNED OFF, DEFECT REMAINS'
    : record.verdict === 'open' ? 'UNRESOLVED' : '';
  const recordLine = `CIVIC RECORD ${record.episode} · ${cause} · ${verdict}${record.householdIds.length ? ` · ${record.householdIds.length} HOUSEHOLDS` : ''}`;
  const institution = institutionSummary(city, buildingId);
  return institution ? `${recordLine}\n${institution}` : recordLine;
}

export function civicBuildingClause(city: City, buildingId: BuildingId): string {
  const record = civicRecordAt(city, buildingId);
  if (!record || record.cause === 'none') return '';
  if (record.verdict === 'madeGood') return `The civic record says the ${record.cause} case was actually made good.`;
  if (record.verdict === 'failed') return `The civic record carries ${record.failedWorks} failed works ${record.failedWorks === 1 ? 'case' : 'cases'} here.`;
  return `The civic record still carries a ${record.cause} case affecting ${record.householdIds.length} household${record.householdIds.length === 1 ? '' : 's'}.`;
}

export function civicHouseholdClause(city: City, householdId: HouseholdId): string {
  const burden = civicHouseholdBurden(city, householdId);
  if (burden < 80) return '';
  const buildingId = city.civic.householdLastBuilding[householdId] ?? -1;
  const name = city.buildings[buildingId]?.name;
  return name ? `The household is still recovering from ${name}.` : 'The household is still carrying a civic loss.';
}

function institutionSummary(city: City, buildingId: BuildingId): string {
  const kind = city.buildings[buildingId]?.kind;
  const l = city.civic.institutions;
  if (kind === 'townhall' && (l.hallHeard || l.hallDismissed)) return `TOWN HALL · ${l.hallHeard} HEARD · ${l.hallDismissed} TURNED AWAY`;
  if (kind === 'workshop' && (l.worksKept || l.worksFailed)) return `WORKS RECORD · ${l.worksKept} MADE GOOD · ${l.worksFailed} FAILED`;
  if ((kind === 'chapel' || kind === 'bathhouse' || kind === 'dispensary') && (l.reliefHelped || l.reliefHarmed)) {
    return `RELIEF RECORD · ${l.reliefHelped} HELPED · ${l.reliefHarmed} HARMED`;
  }
  return '';
}
