import { AxialCoord } from './types';
import { hexKey } from './geometry';

// Pointy-top axial neighbor offsets (same order as hex-state-texture.ts)
export const HEX_NEIGHBORS: readonly [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1],
];

/**
 * Pre-computed adjacency table for the entire hex grid.
 * Stores neighbor *indices* (into the flat HexData[] array) for O(1)
 * traversal without string hashing during simulation ticks.
 *
 * neighbors[i] is a 6-element Int32Array where -1 = no neighbor (map edge).
 */
export class HexGraph {
  readonly neighbors: Int32Array;  // flat: neighbors[i*6 + d] = neighbor index
  readonly count: number;

  constructor(hexLookup: ReadonlyMap<string, number>, coords: ReadonlyArray<AxialCoord>) {
    this.count = coords.length;
    const flat = new Int32Array(this.count * 6);
    flat.fill(-1);

    for (let i = 0; i < this.count; i++) {
      const { q, r } = coords[i]!;
      const base = i * 6;
      for (let d = 0; d < 6; d++) {
        const [dq, dr] = HEX_NEIGHBORS[d]!;
        const idx = hexLookup.get(hexKey(q + dq, r + dr));
        flat[base + d] = idx ?? -1;
      }
    }

    this.neighbors = flat;
  }

  /** Get all 6 neighbor indices for hex at given index. -1 = no neighbor. */
  getNeighbors(hexIndex: number): Int32Array {
    const base = hexIndex * 6;
    return this.neighbors.subarray(base, base + 6);
  }
}
