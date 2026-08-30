import { describe, expect, it } from 'vitest';
import { MIN_PER_DAY } from '../../sim/clock';
import { newCity, warp } from '../../sim/city';
import { buildingEvolutionBandAt, buildingRepairMemory, buildingVisualRevision } from '../scene';

describe('visible city evolution', () => {
  it('adds rooftop life in three broad chapters of the aldermanic term', () => {
    expect(buildingEvolutionBandAt(0)).toBe(0);
    expect(buildingEvolutionBandAt(7 * MIN_PER_DAY - 1)).toBe(0);
    expect(buildingEvolutionBandAt(7 * MIN_PER_DAY)).toBe(1);
    expect(buildingEvolutionBandAt(21 * MIN_PER_DAY)).toBe(2);
    expect(buildingEvolutionBandAt(42 * MIN_PER_DAY)).toBe(3);
  });

  it('rebakes when a firm falls silent or a picket closes its gate', () => {
    const city = newCity('evolution-revision');
    warp(city, 641);
    const firm = city.firms.find((item) => item.workerIds.length >= 4);
    if (!firm) throw new Error('firm fixture missing');
    firm.output = 40;
    const running = buildingVisualRevision(city);
    firm.output = 0;
    const idle = buildingVisualRevision(city);
    expect(idle).not.toBe(running);
    firm.output = 40;
    firm.strikeUntil = city.tick + 60;
    expect(buildingVisualRevision(city)).not.toBe(running);
  });

  it('remembers only physical completed works at an address', () => {
    const city = newCity('repair-memory');
    const buildingId = city.buildings[0].id;
    const add = (kind: 'fabric' | 'drain' | 'gas', status: 'completed' | 'skimmed') => {
      city.works.orders.push({
        id: city.works.orders.length, buildingId, kind, status,
        filedAt: 0, startsAt: 0, dueAt: 0, resolvedAt: 0,
        workshopFirmId: 0, pneumatic: false, pressed: false, inspected: false,
      });
    };
    add('fabric', 'completed');
    add('gas', 'skimmed');
    expect(buildingRepairMemory(city, buildingId)).toBe(1);
    add('drain', 'completed');
    add('gas', 'completed');
    expect(buildingRepairMemory(city, buildingId)).toBe(7);
  });
});
