import { describe, expect, it } from 'vitest';
import { generateWorld, validateWorld } from '../worldgen';
import { wardBlockAdjacency } from '../gen/wards';

function signature(seed: string): string {
  const w = generateWorld(seed);
  return w.wards.map((ward) => `${ward.kind}:${ward.name}:${ward.blockIds.join(',')}`).join('|');
}

describe('ward identity', () => {
  it('is deterministic and changes materially with the seed', () => {
    expect(signature('verdigris')).toBe(signature('verdigris'));
    expect(signature('verdigris')).not.toBe(signature('coppergate'));
  });

  it('covers residual coastal land in known awkward seeds', () => {
    for (const seed of ['ward-audit-8', 'ward-audit-69', 'ward-audit-71']) {
      expect(validateWorld(generateWorld(seed)), seed).toEqual([]);
    }
  });

  it('keeps six named, populated wards tied through blocks, plots, and buildings', () => {
    for (const seed of ['verdigris', 'coppergate', 'jubilee']) {
      const w = generateWorld(seed);
      expect(w.wards.map((ward) => ward.kind)).toEqual([
        'civic', 'garden', 'merchant', 'works', 'courts', 'quayside',
      ]);
      expect(new Set(w.wards.map((ward) => ward.name)).size, seed).toBe(6);
      for (const ward of w.wards) expect(ward.blockIds.length, `${seed}:${ward.kind}`).toBeGreaterThanOrEqual(3);
      for (const block of w.blocks) expect(w.wards[block.wardId], `${seed}:block ${block.id}`).toBeDefined();
      for (const plot of w.plots) {
        expect(plot.wardId, `${seed}:plot ${plot.id}`).toBe(w.blocks[plot.blockId].wardId);
      }
      for (const building of w.buildings) {
        expect(w.wards[w.plots[building.plotId].wardId], `${seed}:building ${building.id}`).toBeDefined();
      }
    }
  });

  it('grows every ward as one connected block territory', () => {
    for (const seed of ['verdigris', 'coppergate', 'jubilee', 'ward-audit-31']) {
      const w = generateWorld(seed);
      const adjacency = wardBlockAdjacency(w.district, w.blocks);
      for (const ward of w.wards) {
        const wanted = new Set(ward.blockIds);
        const reached = new Set<number>();
        const queue = [ward.blockIds[0]];
        reached.add(queue[0]);
        for (let head = 0; head < queue.length; head++) {
          for (const other of adjacency[queue[head]]) {
            if (!wanted.has(other) || reached.has(other)) continue;
            reached.add(other);
            queue.push(other);
          }
        }
        expect(reached.size, `${seed}:${ward.kind}`).toBe(wanted.size);
      }
    }
  });

  it('preserves the intended class banks', () => {
    for (const seed of ['verdigris', 'coppergate', 'jubilee']) {
      const w = generateWorld(seed);
      const blockShare = (kind: string, polite: boolean) => {
        const ward = w.wards.find((item) => item.kind === kind);
        const blocks = ward ? ward.blockIds.map((id) => w.blocks[id]) : [];
        return blocks.filter((block) => block.polite === polite).length / Math.max(1, blocks.length);
      };
      expect(blockShare('garden', true), `${seed}:garden`).toBeGreaterThan(0.7);
      expect(blockShare('merchant', true), `${seed}:merchant`).toBeGreaterThan(0.7);
      expect(blockShare('works', false), `${seed}:works`).toBeGreaterThan(0.7);
      expect(blockShare('courts', false), `${seed}:courts`).toBeGreaterThan(0.7);
      expect(blockShare('quayside', false), `${seed}:quayside`).toBeGreaterThan(0.7);
    }
  });

  it('puts quayside closer to the river than the other working wards', () => {
    for (const seed of ['verdigris', 'coppergate', 'jubilee']) {
      const w = generateWorld(seed);
      const averageGap = (kind: string) => {
        const ward = w.wards.find((item) => item.kind === kind);
        const blocks = ward ? ward.blockIds.map((id) => w.blocks[id]) : [];
        return blocks.reduce((total, block) => {
          const x = Math.round((block.x0 + block.x1) / 2);
          const y = (block.y0 + block.y1) / 2;
          return total + Math.abs(y - w.river.centre[x]);
        }, 0) / Math.max(1, blocks.length);
      };
      expect(averageGap('quayside'), `${seed}:works`).toBeLessThan(averageGap('works'));
      expect(averageGap('quayside'), `${seed}:courts`).toBeLessThan(averageGap('courts'));
    }
  });
});
