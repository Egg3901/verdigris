import { describe, expect, it } from 'vitest';
import { attachedRowEdges } from '../scene';
import { serviceYardClassFor } from '../props';

describe('building blocks', () => {
  it('finds both occupied ends of an east to west row', () => {
    const grid = new Int16Array(8 * 6).fill(-1);
    const building = { id: 5, ox: 2, oy: 2, w: 2, d: 2 };
    grid[2 * 8 + 1] = 7;
    grid[3 * 8 + 4] = 8;
    expect(attachedRowEdges({ width: 8, height: 6, buildingId: grid }, building, true)).toBe(3);
  });

  it('finds only direct joins and ignores the building itself', () => {
    const grid = new Int16Array(8 * 6).fill(-1);
    const building = { id: 5, ox: 2, oy: 2, w: 2, d: 2 };
    grid[1 * 8 + 2] = 5;
    grid[4 * 8 + 3] = 9;
    grid[1 * 8 + 1] = 10;
    expect(attachedRowEdges({ width: 8, height: 6, buildingId: grid }, building, false)).toBe(2);
  });

  it('assigns yard compounds from the premises they serve', () => {
    expect(serviceYardClassFor('tenement')).toBe('domestic');
    expect(serviceYardClassFor('villa')).toBe('garden');
    expect(serviceYardClassFor('foundry')).toBe('works');
    expect(serviceYardClassFor('pub')).toBe('delivery');
    expect(serviceYardClassFor('townhall')).toBeNull();
  });
});
