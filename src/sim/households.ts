// Households. Rent, arrears, and the eviction chain that turns a lost wage into
// a soul leaving the district.
import type { BuildingId, HouseholdId, SoulId } from './types';

export interface Household {
  id: HouseholdId;
  buildingId: BuildingId;
  name: string;
  memberIds: SoulId[];
  /** Farthings. Integers, always: money is the easiest thing to make undeterministic. */
  purse: number;
  rentPerDay: number;
  arrearsDays: number;
  standing: number;
  evictedTick: number;
}

export function householdIncome(h: Household, wageOf: (s: SoulId) => number): number {
  let sum = 0;
  for (const m of h.memberIds) sum += wageOf(m);
  return sum;
}
