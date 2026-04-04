import { describe, it, expect } from 'vitest';
import { HexGraph, HEX_NEIGHBORS } from '../graph';
import { hexKey } from '../geometry';

describe('HexGraph', () => {
  // Build a small hex grid: radius 2 → 19 hexes
  function buildSmallGrid() {
    const coords: { q: number; r: number }[] = [];
    const lookup = new Map<string, number>();
    const radius = 2;

    for (let q = -radius; q <= radius; q++) {
      for (let r = -radius; r <= radius; r++) {
        if (Math.abs(q + r) > radius) continue;
        const idx = coords.length;
        coords.push({ q, r });
        lookup.set(hexKey(q, r), idx);
      }
    }

    return { coords, lookup, radius };
  }

  it('builds correct neighbor count', () => {
    const { coords, lookup } = buildSmallGrid();
    const graph = new HexGraph(lookup, coords);
    expect(graph.count).toBe(coords.length);
  });

  it('origin has 6 neighbors', () => {
    const { coords, lookup } = buildSmallGrid();
    const graph = new HexGraph(lookup, coords);

    const originIdx = lookup.get(hexKey(0, 0))!;
    const nb = graph.getNeighbors(originIdx);

    let validCount = 0;
    for (let d = 0; d < 6; d++) {
      if (nb[d]! !== -1) validCount++;
    }
    expect(validCount).toBe(6);
  });

  it('neighbors point to correct coordinates', () => {
    const { coords, lookup } = buildSmallGrid();
    const graph = new HexGraph(lookup, coords);

    const originIdx = lookup.get(hexKey(0, 0))!;
    const nb = graph.getNeighbors(originIdx);

    for (let d = 0; d < 6; d++) {
      const ni = nb[d]!;
      if (ni === -1) continue;
      const [dq, dr] = HEX_NEIGHBORS[d]!;
      const expected = coords[ni]!;
      expect(expected.q).toBe(dq);
      expect(expected.r).toBe(dr);
    }
  });

  it('edge hexes have fewer than 6 neighbors', () => {
    const { coords, lookup } = buildSmallGrid();
    const graph = new HexGraph(lookup, coords);

    // (2, 0) is on the edge
    const edgeIdx = lookup.get(hexKey(2, 0))!;
    const nb = graph.getNeighbors(edgeIdx);

    let validCount = 0;
    for (let d = 0; d < 6; d++) {
      if (nb[d]! !== -1) validCount++;
    }
    expect(validCount).toBeLessThan(6);
    expect(validCount).toBeGreaterThanOrEqual(2);
  });

  it('neighbor relationship is symmetric', () => {
    const { coords, lookup } = buildSmallGrid();
    const graph = new HexGraph(lookup, coords);

    for (let i = 0; i < coords.length; i++) {
      const nb = graph.getNeighbors(i);
      for (let d = 0; d < 6; d++) {
        const ni = nb[d]!;
        if (ni === -1) continue;
        // ni should have i as one of its neighbors
        const nnb = graph.getNeighbors(ni);
        let found = false;
        for (let dd = 0; dd < 6; dd++) {
          if (nnb[dd] === i) { found = true; break; }
        }
        expect(found, `hex ${i} → ${ni} not symmetric`).toBe(true);
      }
    }
  });
});
