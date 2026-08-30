// Notices under the nuisance provisions.
//
// A notice is a route through the existing world, not a cheaper works button.
// It needs a recent view of the premises, names the occupier entered in the rate
// book, allows time for compliance, and tests that household's actual means.
// Default can be brought before the petty sessions, but an order on paper does
// not repair a drain or wall.
import type { City } from './city';
import { makeGoodAt, worksNeededAt } from './works';
import type { WorksKind } from './works';

export type NoticeStatus = 'served' | 'complied' | 'defaulted' | 'summoned' | 'orderMade' | 'abated';

export interface NuisanceNotice {
  id: number;
  buildingId: number;
  kind: WorksKind;
  householdId: number;
  cost: number;
  status: NoticeStatus;
  servedAt: number;
  dueAt: number;
  summonedAt: number;
  resolvedAt: number;
}

export interface NoticeState {
  notices: NuisanceNotice[];
  revision: number;
}

export interface NoticeUpdate {
  text: string;
  kind: 'loss' | 'gain' | 'info';
}

const COMPLIANCE_MINUTES = 360;
const HEARING_MINUTES = 360;

export function newNotices(): NoticeState {
  return { notices: [], revision: 0 };
}

function isActive(notice: NuisanceNotice): boolean {
  return notice.status === 'served' || notice.status === 'defaulted'
    || notice.status === 'summoned' || notice.status === 'orderMade';
}

export function activeNoticeFor(city: City, buildingId: number): NuisanceNotice | null {
  for (let i = city.notices.notices.length - 1; i >= 0; i--) {
    const notice = city.notices.notices[i];
    if (notice.buildingId === buildingId && isActive(notice)) return notice;
  }
  return null;
}

export function latestNoticeFor(city: City, buildingId: number): NuisanceNotice | null {
  for (let i = city.notices.notices.length - 1; i >= 0; i--) {
    if (city.notices.notices[i].buildingId === buildingId) return city.notices.notices[i];
  }
  return null;
}

function liableHousehold(city: City, buildingId: number): number {
  const b = city.buildings[buildingId];
  if (!b) return -1;
  return b.householdIds
    .filter((id) => Boolean(city.households[id]))
    .sort((a, bId) => city.households[bId].standing - city.households[a].standing || a - bId)[0] ?? -1;
}

function complianceCost(city: City, buildingId: number, kind: WorksKind): number {
  if (kind === 'drain') return 90;
  if (kind === 'gas') return 70;
  const fabric = city.buildings[buildingId]?.fabric ?? 760;
  return Math.max(45, Math.min(180, Math.round((760 - fabric) / 4)));
}

export function canServeNotice(city: City, buildingId: number): string | null {
  if (!city.buildings[buildingId]) return 'There is no such address.';
  if (city.wardRounds.inspectedUntil[buildingId] <= city.tick) return 'View the premises before serving a notice.';
  if (activeNoticeFor(city, buildingId)) return 'A nuisance notice is already alive at this address.';
  if (liableHousehold(city, buildingId) < 0) return 'No occupier is entered in the rate book at this address.';
  if (!worksNeededAt(city, buildingId)) return 'The inspector has no continuing nuisance to name.';
  return null;
}

export function serveNotice(city: City, buildingId: number): NuisanceNotice | null {
  if (canServeNotice(city, buildingId)) return null;
  const kind = worksNeededAt(city, buildingId) as WorksKind;
  const householdId = liableHousehold(city, buildingId);
  const notice: NuisanceNotice = {
    id: city.notices.notices.length,
    buildingId,
    kind,
    householdId,
    cost: complianceCost(city, buildingId, kind),
    status: 'served',
    servedAt: city.tick,
    dueAt: city.tick + COMPLIANCE_MINUTES,
    summonedAt: -1,
    resolvedAt: -1,
  };
  city.notices.notices.push(notice);
  city.notices.revision++;
  return notice;
}

export function canSummonNotice(city: City, buildingId: number): string | null {
  const notice = activeNoticeFor(city, buildingId);
  if (!notice || notice.status !== 'defaulted') return 'No expired nuisance notice is ready for complaint.';
  if (city.budgetLeft <= 0) return 'No influence remains today.';
  return null;
}

export function summonOnNotice(city: City, buildingId: number): NuisanceNotice | null {
  if (canSummonNotice(city, buildingId)) return null;
  const notice = activeNoticeFor(city, buildingId) as NuisanceNotice;
  city.budgetLeft--;
  notice.status = 'summoned';
  notice.summonedAt = city.tick;
  notice.dueAt = city.tick + HEARING_MINUTES;
  city.notices.revision++;
  return notice;
}

function subject(kind: WorksKind): string {
  return kind === 'fabric' ? 'unsound fabric' : kind === 'drain' ? 'defective drain' : 'failed gas service';
}

function canPay(city: City, notice: NuisanceNotice): boolean {
  const household = city.households[notice.householdId];
  return Boolean(household && household.arrearsDays === 0 && household.purse >= notice.cost);
}

function comply(city: City, notice: NuisanceNotice): NoticeUpdate {
  const household = city.households[notice.householdId];
  const building = city.buildings[notice.buildingId];
  household.purse -= notice.cost;
  makeGoodAt(city, notice.buildingId, notice.kind);
  notice.status = 'complied';
  notice.resolvedAt = city.tick;
  city.notices.revision++;
  return {
    text: `The ${household.name} household paid to make good the ${subject(notice.kind)} at ${building.name}. The nuisance notice is satisfied.`,
    kind: 'gain',
  };
}

/** Called on the hourly accounts. Every outcome follows from means and defects. */
export function tickNoticesHourly(city: City): NoticeUpdate[] {
  const out: NoticeUpdate[] = [];
  for (const notice of city.notices.notices) {
    if (!isActive(notice)) continue;
    const building = city.buildings[notice.buildingId];
    const household = city.households[notice.householdId];
    if (!building || !household) continue;

    if (!worksNeededAt(city, notice.buildingId)) {
      notice.status = 'abated';
      notice.resolvedAt = city.tick;
      city.notices.revision++;
      out.push({ text: `The nuisance at ${building.name} has been abated. The notice is discharged.`, kind: 'gain' });
      continue;
    }

    if (notice.status === 'served' && city.tick >= notice.dueAt) {
      if (canPay(city, notice)) {
        out.push(comply(city, notice));
      } else {
        notice.status = 'defaulted';
        city.notices.revision++;
        out.push({
          text: `The time allowed at ${building.name} has expired. The ${household.name} household has not abated the ${subject(notice.kind)}.`,
          kind: 'loss',
        });
      }
      continue;
    }

    if (notice.status === 'summoned' && city.tick >= notice.dueAt) {
      if (canPay(city, notice)) {
        out.push(comply(city, notice));
      } else {
        notice.status = 'orderMade';
        notice.resolvedAt = city.tick;
        city.notices.revision++;
        out.push({
          text: `The petty sessions made an order of abatement against the ${household.name} household. The ${subject(notice.kind)} at ${building.name} remains to be made good.`,
          kind: 'info',
        });
      }
    }
  }
  return out;
}

export function noticeVisualStage(city: City, buildingId: number): 0 | 1 {
  return activeNoticeFor(city, buildingId) ? 1 : 0;
}

export function noticeSummary(city: City, buildingId: number): string {
  const notice = latestNoticeFor(city, buildingId);
  if (!notice) return '';
  const heading = `NUISANCE NOTICE ${notice.id + 1} · ${subject(notice.kind).toUpperCase()}`;
  if (notice.status === 'served') {
    const hours = Math.max(0, Math.ceil((notice.dueAt - city.tick) / 60));
    return `${heading} · ${hours} HOUR${hours === 1 ? '' : 'S'} TO COMPLY`;
  }
  if (notice.status === 'defaulted') return `${heading} · IN DEFAULT`;
  if (notice.status === 'summoned') return `${heading} · BEFORE THE PETTY SESSIONS`;
  if (notice.status === 'orderMade') return `${heading} · ABATEMENT ORDER MADE`;
  return `${heading} · ${notice.status === 'complied' ? 'COMPLIED WITH' : 'DISCHARGED'}`;
}
