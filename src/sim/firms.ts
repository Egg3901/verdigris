// Firms, deliberately thin.
//
// One orders integer and one margin. No price discovery, no markets, no supply
// chains. Simulating a real economy would eat the entire build and nobody
// watching a city from above can see a price anyway. What a firm needs to do is
// employ people, pay them, and be capable of stopping.
import type { BuildingId, FirmId, SoulId } from './types';

export type FirmKind = 'mill' | 'foundry' | 'workshop' | 'wharf' | 'shop' | 'paper' | 'utility' | 'civic';

export interface Firm {
  id: FirmId;
  buildingId: BuildingId;
  name: string;
  kind: FirmKind;
  workerIds: SoulId[];
  /** 0..1000 order book. Falls when the tram is late or the gas is out. */
  orders: number;
  margin: number;
  /** Per-worker daily wage in farthings, before the district wage pressure. */
  wageBase: number;
  wageOffset: number;
  strikeUntil: number;
  closedUntil: number;
  output: number;
}

export const FIRM_WAGE: Record<FirmKind, number> = {
  mill: 26,
  foundry: 30,
  workshop: 28,
  wharf: 24,
  shop: 32,
  paper: 34,
  utility: 30,
  civic: 44,
};

export function isStruck(f: Firm, tick: number): boolean {
  return f.strikeUntil > tick;
}

export function isClosed(f: Firm, tick: number): boolean {
  return f.closedUntil > tick;
}

export function isRunning(f: Firm, tick: number): boolean {
  return !isStruck(f, tick) && !isClosed(f, tick);
}
