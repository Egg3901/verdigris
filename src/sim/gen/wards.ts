// Ward identity sits between blocks and plots. It is immutable world geometry:
// one seed gives one civic map, and every later system reads the same map.
import { Tile } from '../types';
import type { District } from '../district';
import { cellKey, inBounds, insideIsland } from '../district';
import { mix, Stream } from '../rng';
import type { Block } from './blocks';
import type { RiverPlan } from './river';
import type { StreetPlan } from './streets';

export type WardKind = 'civic' | 'garden' | 'merchant' | 'works' | 'courts' | 'quayside';

export interface Ward {
  id: number;
  kind: WardKind;
  name: string;
  anchorX: number;
  anchorY: number;
  blockIds: number[];
}

const KINDS: readonly WardKind[] = ['civic', 'garden', 'merchant', 'works', 'courts', 'quayside'];
const WARD_ID: Record<WardKind, number> = {
  civic: 0, garden: 1, merchant: 2, works: 3, courts: 4, quayside: 5,
};

const NAMES: Record<WardKind, readonly string[]> = {
  civic: ['Crown Ward', 'Charter Ward', 'Assembly Ward', 'Guildhall Ward'],
  garden: ['Belvedere Ward', 'Limehouse Ward', 'Orchard Ward', 'Prospect Ward'],
  merchant: ['Mercers Ward', 'Exchange Ward', 'Goldsmith Ward', 'Market Ward'],
  works: ['Iron Ward', 'Furnace Ward', 'Boiler Ward', 'Foundry Ward'],
  courts: ['Rookery Ward', 'Narrow Courts', 'Ash Court Ward', 'Backlane Ward'],
  quayside: ['Lower Quays', 'Ropery Ward', 'Dock Ward', 'Wharf Ward'],
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function centreOf(block: Block): { x: number; y: number } {
  return { x: (block.x0 + block.x1) / 2, y: (block.y0 + block.y1) / 2 };
}

function anchorY(river: RiverPlan, x: number, polite: boolean, gap: number): number {
  const ix = clamp(Math.round(x), 0, river.centre.length - 1);
  const cy = river.centre[ix];
  const h = river.centre.length;
  // An archetype river hugging one edge leaves that bank thin. Clamp the gap to
  // the depth of the bank that actually exists, or the anchor lands in the sea
  // and the ward seeds onto a nonsense block.
  const depth = polite ? cy : h - cy;
  const used = Math.min(gap, Math.max(3, depth - 9));
  return cy + (polite ? -used : used);
}

function score(block: Block, ward: Ward, river: RiverPlan): number {
  const c = centreOf(block);
  let value = Math.abs(c.x - ward.anchorX) + Math.abs(c.y - ward.anchorY);
  const wantsPolite = ward.kind === 'civic' || ward.kind === 'garden' || ward.kind === 'merchant';
  if (block.polite !== wantsPolite) value += ward.kind === 'civic' ? 11 : 18;
  const rx = clamp(Math.round(c.x), 0, river.centre.length - 1);
  const riverGap = Math.abs(c.y - river.centre[rx]);
  if (ward.kind === 'quayside') value += riverGap * 1.8;
  if (ward.kind === 'garden') value += Math.max(0, 7 - riverGap) * 0.5;
  return value;
}

function tuneBlock(seed: number, block: Block, kind: WardKind): void {
  const bit = mix(seed, Stream.GenWards, block.id, WARD_ID[kind] + 1) & 1;
  switch (kind) {
    case 'civic':
      block.grain = 4 + bit;
      block.depth = 4;
      break;
    case 'garden':
      block.grain = 2 + bit;
      block.depth = 2 + bit;
      break;
    case 'merchant':
      block.grain = 2 + bit;
      block.depth = 3;
      break;
    case 'works':
      block.grain = 1 + bit;
      block.depth = 2 + bit;
      break;
    case 'courts':
      block.grain = 1;
      block.depth = 2;
      break;
    case 'quayside':
      block.grain = 1 + bit;
      block.depth = 2;
      break;
  }
}

/**
 * Blocks are separated by streets, squares, and parks, so touching bboxes are
 * not enough to describe neighbourhood. A short non-water walk connects blocks
 * across those public spaces while the river still separates the two banks
 * except where a bridge provides a real route.
 */
export function wardBlockAdjacency(district: District, blocks: readonly Block[]): number[][] {
  const out = blocks.map(() => new Set<number>());
  const maxWalk = 6;
  const dx = [1, -1, 0, 0];
  const dy = [0, 0, 1, -1];
  const n = district.width * district.height;
  for (const block of blocks) {
    const seen = new Uint8Array(n);
    const distance = new Uint8Array(n);
    const queue = block.cells.slice();
    for (const k of queue) seen[k] = 1;
    for (let head = 0; head < queue.length; head++) {
      const k = queue[head];
      if (distance[k] >= maxWalk) continue;
      const x = k % district.width;
      const y = (k - x) / district.width;
      for (let i = 0; i < 4; i++) {
        const nx = x + dx[i];
        const ny = y + dy[i];
        if (!inBounds(district, nx, ny) || !insideIsland(district, nx, ny)) continue;
        const nk = cellKey(district, nx, ny);
        if (seen[nk] || district.tile[nk] === Tile.Water) continue;
        seen[nk] = 1;
        distance[nk] = distance[k] + 1;
        const other = district.blockId[nk];
        if (other >= 0 && other !== block.id) {
          out[block.id].add(other);
          out[other].add(block.id);
          // The route reached this block through public space. Record the edge,
          // but do not walk through its private fabric to discover a third block.
          continue;
        }
        queue.push(nk);
      }
    }
  }
  return out.map((ids) => [...ids].sort((a, b) => a - b));
}

/** Assign whole blocks, then flood the ward identity across their adjoining streets. */
export function assignWards(
  district: District, seed: number, blocks: Block[], streets: StreetPlan, river: RiverPlan,
): Ward[] {
  const sx = streets.squareX + (streets.squareW - 1) / 2;
  const sy = streets.squareY + (streets.squareW - 1) / 2;
  const jitter = (kind: WardKind, axis: number) => (mix(seed, Stream.GenWards, WARD_ID[kind] + 1, axis) % 7) - 3;
  const anchors: Record<WardKind, [number, number]> = {
    civic: [sx, sy],
    garden: [district.width * 0.24 + jitter('garden', 1), anchorY(river, district.width * 0.24, true, 14)],
    merchant: [district.width * 0.72 + jitter('merchant', 1), anchorY(river, district.width * 0.72, true, 8)],
    works: [district.width * 0.76 + jitter('works', 1), anchorY(river, district.width * 0.76, false, 13)],
    courts: [district.width * 0.28 + jitter('courts', 1), anchorY(river, district.width * 0.28, false, 12)],
    quayside: [district.width * 0.5 + jitter('quayside', 1), anchorY(river, district.width * 0.5, false, 5)],
  };
  const wards = KINDS.map((kind, id): Ward => ({
    id,
    kind,
    name: NAMES[kind][mix(seed, Stream.GenWards, id, 91) % NAMES[kind].length],
    anchorX: anchors[kind][0],
    anchorY: anchors[kind][1],
    blockIds: [],
  }));

  const adjacency = wardBlockAdjacency(district, blocks);
  const claimed = new Set<number>();

  const claim = (ward: Ward, block: Block): void => {
    block.wardId = ward.id;
    ward.blockIds.push(block.id);
    claimed.add(block.id);
  };

  const bestUnclaimed = (ward: Ward, neighboursOnly: boolean): Block | undefined => {
    const candidates = new Set<number>();
    if (neighboursOnly) {
      for (const id of ward.blockIds) {
        for (const other of adjacency[id]) if (!claimed.has(other)) candidates.add(other);
      }
    } else {
      for (const block of blocks) if (!claimed.has(block.id)) candidates.add(block.id);
    }
    let best: Block | undefined;
    let bestScore = Infinity;
    for (const id of candidates) {
      const block = blocks[id];
      const s = score(block, ward, river);
      if (s < bestScore || (s === bestScore && block.id < (best?.id ?? Infinity))) {
        best = block;
        bestScore = s;
      }
    }
    return best;
  };

  // One anchor seed per ward, then two connected growth rounds. Every later
  // claim also comes from a ward frontier, so a ward cannot become an archipelago.
  for (const ward of wards) {
    const block = bestUnclaimed(ward, false);
    if (block) claim(ward, block);
  }
  for (let core = 1; core < 3; core++) {
    for (const ward of wards) {
      const block = bestUnclaimed(ward, true);
      if (block) claim(ward, block);
    }
  }

  while (claimed.size < blocks.length) {
    let bestWard: Ward | undefined;
    let bestBlock: Block | undefined;
    let bestScore = Infinity;
    for (const ward of wards) {
      const block = bestUnclaimed(ward, true);
      if (!block) continue;
      const s = score(block, ward, river);
      if (s < bestScore || (s === bestScore && ward.id < (bestWard?.id ?? Infinity))) {
        bestWard = ward;
        bestBlock = block;
        bestScore = s;
      }
    }
    if (!bestWard || !bestBlock) {
      // A rare isolated block component gets the geographically closest ward.
      // The cell fallback below uses the same rule for blockless land.
      const block = blocks.find((item) => !claimed.has(item.id));
      if (!block) break;
      bestWard = wards.reduce((best, ward) => score(block, ward, river) < score(block, best, river) ? ward : best);
      bestBlock = block;
    }
    claim(bestWard, bestBlock);
  }

  // Rebalance. An archetype that pushes the river toward one edge leaves the
  // thin bank short of blocks, and a ward there can starve below the three the
  // validator demands. Starving wards take an adjacent block from a rich
  // neighbour, but only when the donor keeps a connected remainder.
  const donorStaysConnected = (donor: Ward, removed: number): boolean => {
    const rest = donor.blockIds.filter((id) => id !== removed);
    if (rest.length <= 1) return true;
    const wanted = new Set(rest);
    const reached = new Set<number>([rest[0]]);
    const queue = [rest[0]];
    for (let head = 0; head < queue.length; head++) {
      for (const other of adjacency[queue[head]]) {
        if (!wanted.has(other) || reached.has(other)) continue;
        reached.add(other);
        queue.push(other);
      }
    }
    return reached.size === wanted.size;
  };
  const relocated = new Set<number>();
  for (let round = 0; round < 12; round++) {
    let moved = false;
    for (const starving of wards) {
      if (starving.blockIds.length >= 3) continue;
      let take = -1;
      let takeScore = Infinity;
      for (const id of starving.blockIds) {
        for (const other of adjacency[id]) {
          const donor = wards[blocks[other].wardId];
          if (donor === starving || donor.blockIds.length <= 3) continue;
          if (!donorStaysConnected(donor, other)) continue;
          const s = score(blocks[other], starving, river);
          if (s < takeScore) { takeScore = s; take = other; }
        }
      }
      if (take < 0) {
        // Stuck: the ward sits in an isolated block cluster too small to feed
        // it. Donate its blocks to adjacent wards and re-seed it inside the
        // nearest ward rich enough to spare three.
        if (relocated.has(starving.id)) continue;
        relocated.add(starving.id);
        for (const id of [...starving.blockIds]) {
          let to: Ward | undefined;
          let toScore = Infinity;
          for (const other of adjacency[id]) {
            const w = wards[blocks[other].wardId];
            if (w === starving) continue;
            const s = score(blocks[id], w, river);
            if (s < toScore) { toScore = s; to = w; }
          }
          if (!to) to = wards.reduce((best, w) => w !== starving
            && score(blocks[id], w, river) < score(blocks[id], best, river) ? w : best,
            wards.find((w) => w !== starving) as Ward);
          blocks[id].wardId = to.id;
          to.blockIds.push(id);
        }
        starving.blockIds = [];
        let seedBlock = -1;
        let seedScore = Infinity;
        for (const donor of wards) {
          if (donor === starving || donor.blockIds.length < 6) continue;
          for (const id of donor.blockIds) {
            if (!donorStaysConnected(donor, id)) continue;
            const s = score(blocks[id], starving, river);
            if (s < seedScore) { seedScore = s; seedBlock = id; }
          }
        }
        if (seedBlock >= 0) {
          const donor = wards[blocks[seedBlock].wardId];
          donor.blockIds = donor.blockIds.filter((id) => id !== seedBlock);
          blocks[seedBlock].wardId = starving.id;
          starving.blockIds.push(seedBlock);
          moved = true;
        }
        continue;
      }
      const donor = wards[blocks[take].wardId];
      donor.blockIds = donor.blockIds.filter((id) => id !== take);
      blocks[take].wardId = starving.id;
      starving.blockIds.push(take);
      moved = true;
    }
    if (!moved) break;
  }

  for (const block of blocks) {
    const ward = wards[block.wardId];
    tuneBlock(seed, block, ward.kind);
    for (const k of block.cells) district.wardId[k] = ward.id;
  }

  // Multi-source flood assigns roads, parks, yards, and quays to the nearest
  // block identity. Water stays at -1, which keeps the map honest at the banks.
  const queue: number[] = [];
  for (const block of blocks) for (const k of block.cells) queue.push(k);
  const dx = [1, -1, 0, 0];
  const dy = [0, 0, 1, -1];
  for (let head = 0; head < queue.length; head++) {
    const k = queue[head];
    const x = k % district.width;
    const y = (k - x) / district.width;
    for (let i = 0; i < 4; i++) {
      const nx = x + dx[i];
      const ny = y + dy[i];
      if (!inBounds(district, nx, ny) || !insideIsland(district, nx, ny)) continue;
      const nk = cellKey(district, nx, ny);
      if (district.wardId[nk] >= 0 || district.tile[nk] === Tile.Water) continue;
      district.wardId[nk] = district.wardId[k];
      queue.push(nk);
    }
  }

  // Some coast seeds produce a tiny park or quay component cut off from every
  // buildable block. Give each residual component one deterministic ward rather
  // than leaving valid land outside the civic map.
  const residualSeen = new Uint8Array(district.width * district.height);
  for (let y = 0; y < district.height; y++) {
    for (let x = 0; x < district.width; x++) {
      const start = cellKey(district, x, y);
      if (residualSeen[start] || !insideIsland(district, x, y)
        || district.tile[start] === Tile.Water || district.wardId[start] >= 0) continue;
      const component: number[] = [start];
      residualSeen[start] = 1;
      let sumX = 0;
      let sumY = 0;
      for (let head = 0; head < component.length; head++) {
        const k = component[head];
        const cx = k % district.width;
        const cy = (k - cx) / district.width;
        sumX += cx;
        sumY += cy;
        for (let i = 0; i < 4; i++) {
          const nx = cx + dx[i];
          const ny = cy + dy[i];
          if (!inBounds(district, nx, ny) || !insideIsland(district, nx, ny)) continue;
          const nk = cellKey(district, nx, ny);
          if (residualSeen[nk] || district.tile[nk] === Tile.Water || district.wardId[nk] >= 0) continue;
          residualSeen[nk] = 1;
          component.push(nk);
        }
      }
      const cx = sumX / component.length;
      const cy = sumY / component.length;
      const polite = district.polite[component[0]] === 1;
      const ward = wards.reduce((best, item) => {
        const bestPolite = best.kind === 'civic' || best.kind === 'garden' || best.kind === 'merchant';
        const itemPolite = item.kind === 'civic' || item.kind === 'garden' || item.kind === 'merchant';
        const bestScore = Math.abs(cx - best.anchorX) + Math.abs(cy - best.anchorY) + (bestPolite === polite ? 0 : 18);
        const itemScore = Math.abs(cx - item.anchorX) + Math.abs(cy - item.anchorY) + (itemPolite === polite ? 0 : 18);
        return itemScore < bestScore ? item : best;
      });
      for (const k of component) district.wardId[k] = ward.id;
    }
  }
  return wards;
}

export function wardAt(wards: readonly Ward[], district: District, x: number, y: number): Ward | undefined {
  if (!inBounds(district, x, y)) return undefined;
  const id = district.wardId[cellKey(district, x, y)];
  return id >= 0 ? wards[id] : undefined;
}
