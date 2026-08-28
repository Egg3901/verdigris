import { describe, expect, it } from 'vitest';
import { generateWorld, validateWorld } from '../worldgen';
import type { World } from '../worldgen';
import { Tile } from '../types';
import { isConnected } from '../graph';

// Fixed seeds chosen to cover every archetype twice. If pickArchetype's
// weights or stream ever change, these mappings change with them and this
// list must be re-anchored on purpose, not silently.
const SEEDS = [
  'verdigris', // milltown
  'district-04', // milltown
  'coppergate', // port
  'district-16', // port
  'district-01', // garden
  'district-10', // garden
  'district-00', // crossing
  'district-02', // crossing
];

function countKind(w: World, kind: string): number {
  return w.buildings.filter((b) => b.kind === kind).length;
}

function countTile(w: World, tile: number): number {
  let n = 0;
  for (const t of w.district.tile) if (t === tile) n++;
  return n;
}

describe('district archetypes', () => {
  const worlds = SEEDS.map((seed) => generateWorld(seed));

  it('covers every archetype across the fixed seed list', () => {
    const seen = new Set(worlds.map((w) => w.archetype.kind));
    expect([...seen].sort()).toEqual(['crossing', 'garden', 'milltown', 'port']);
  });

  it('keeps every archetype playable', () => {
    for (const w of worlds) {
      const errs = validateWorld(w);
      expect(errs, `${w.seedStr}: ${errs.join('\n')}`).toEqual([]);
      expect(w.river.bridges.length, w.seedStr).toBeGreaterThanOrEqual(1);
      expect(w.streetPlan.squareW, w.seedStr).toBeGreaterThanOrEqual(5);
      expect(isConnected(w.graph), w.seedStr).toBe(true);
      expect(w.souls.length, w.seedStr).toBe(340);
      expect(w.firms.length, w.seedStr).toBeGreaterThan(0);
      // Enough roofs for the matters and economy systems to bite on.
      const dwellings = ['terrace', 'tenement', 'courtdwelling', 'villa', 'lodging']
        .reduce((n, k) => n + countKind(w, k), 0);
      expect(dwellings, w.seedStr).toBeGreaterThanOrEqual(120);
      const industry = ['mill', 'foundry', 'workshop', 'wharfshed', 'warehouse']
        .reduce((n, k) => n + countKind(w, k), 0);
      expect(industry, w.seedStr).toBeGreaterThanOrEqual(8);
      expect(countKind(w, 'pub'), w.seedStr).toBeGreaterThanOrEqual(3);
      expect(w.plots.some((p) => p.court), w.seedStr).toBe(true);
    }
  });

  it('gives each archetype its signature', () => {
    for (const w of worlds) {
      switch (w.archetype.kind) {
        case 'milltown':
          expect(countKind(w, 'mill'), w.seedStr).toBeGreaterThanOrEqual(2);
          expect(countKind(w, 'foundry'), w.seedStr).toBeGreaterThanOrEqual(2);
          // Dense and sooty: fewer trees than any other archetype grows.
          expect(countTile(w, Tile.Park), w.seedStr).toBeLessThan(180);
          break;
        case 'port':
          expect(countKind(w, 'wharfshed'), w.seedStr).toBeGreaterThanOrEqual(5);
          expect(countKind(w, 'warehouse'), w.seedStr).toBeGreaterThanOrEqual(4);
          break;
        case 'garden':
          expect(countTile(w, Tile.Park), w.seedStr).toBeGreaterThan(350);
          expect(w.river.bridges.length, w.seedStr).toBeLessThanOrEqual(2);
          // A narrow river: less water than the crossing town's channel.
          expect(countTile(w, Tile.Water), w.seedStr).toBeLessThan(180);
          break;
        case 'crossing':
          expect(w.river.bridges.length, w.seedStr).toBeGreaterThanOrEqual(2);
          break;
      }
    }
  });

  it('is stable: the same seed always grows the same archetype', () => {
    for (const w of worlds) {
      expect(generateWorld(w.seedStr).archetype.kind).toBe(w.archetype.kind);
    }
  });
});
