import { describe, expect, it } from 'vitest';
import { countIslandCells } from '../district';
import { CAPS } from '../types';
import { generateWorld, validateWorld } from '../worldgen';

const SEEDS = Array.from({ length: 64 }, (_, i) => `district-${String(i).padStart(2, '0')}`);

describe('large procedural district corpus', () => {
  it('keeps varied districts dense, playable and inside the graph budget', () => {
    let maxNodes = 0;
    let maxBuildings = 0;
    const bridgeCounts = new Set<number>();
    const squarePositions = new Set<string>();
    const gateCounts = new Set<number>();
    const coastAreas = new Set<number>();

    for (const seed of SEEDS) {
      const world = generateWorld(seed);
      const errors = validateWorld(world);
      maxNodes = Math.max(maxNodes, world.graph.n);
      maxBuildings = Math.max(maxBuildings, world.buildings.length);
      bridgeCounts.add(world.river.bridges.length);
      squarePositions.add(`${world.streetPlan.squareX},${world.streetPlan.squareY},${world.streetPlan.squareW}`);
      gateCounts.add(world.streetPlan.anchors.filter((a) => a.label === 'gate').length);
      coastAreas.add(countIslandCells(world.district));

      expect(errors, `${seed}: ${errors.join('\n')}`).toEqual([]);
      expect(world.buildings.length, seed).toBeGreaterThanOrEqual(260);
      expect(world.buildings.length, seed).toBeLessThanOrEqual(360);
      expect(world.souls.length, seed).toBe(340);
      expect(world.graph.n, seed).toBeLessThanOrEqual(CAPS.nodes);
      expect(world.plots.some((plot) => plot.court), seed).toBe(true);
    }

    expect(maxNodes).toBeLessThan(CAPS.nodes);
    expect(maxBuildings).toBeLessThanOrEqual(CAPS.buildings);
    // Garden boroughs can drop to a single crossing; crossing towns still
    // produce two or three. The corpus must show the full archetype spread.
    expect([...bridgeCounts].sort()).toEqual([1, 2, 3]);
    expect(squarePositions.size).toBeGreaterThan(12);
    expect(gateCounts.size).toBeGreaterThan(2);
    expect(coastAreas.size).toBeGreaterThan(12);
  }, 20_000);
});
