import { TerrainType, PlanarAlignment, AxialCoord } from '../../core/types';
import { WORLD } from '../../core/constants';
import { hexKey } from '../../core/geometry';

/**
 * SoA storage for hex-level game state. Derived from the simulation field
 * by HexSampleSystem — hexes don't own the physics, they observe it.
 *
 * All arrays indexed by hex index (0..hexCount-1).
 * Hex (q,r) → index via the coordToIndex lookup.
 */
export class HexStore {
  readonly hexCount: number;
  readonly gridRadius: number;

  // Identity (immutable after init)
  readonly coordQ: Int16Array;
  readonly coordR: Int16Array;
  readonly groupId: Uint16Array;

  // Terrain state (derived from sim field sampling)
  readonly terrainType: Uint8Array;
  readonly element: Uint8Array;
  readonly elevation: Float32Array;
  readonly moisture: Float32Array;
  readonly waterHeight: Float32Array;
  readonly temperature: Float32Array;
  readonly hasRiver: Uint8Array;

  // Planar state (derived from overlay evaluation)
  readonly planarAlignment: Uint8Array;
  readonly planarIntensity: Float32Array;
  readonly planarFragmentation: Float32Array;
  readonly planarLift: Float32Array;
  readonly planarRadius: Float32Array;

  // Game annotations (user-edited, snapshotted)
  readonly notes: string[];

  // Coord → index lookup
  private readonly coordToIndex: Map<string, number>;

  private constructor(
    hexCount: number,
    gridRadius: number,
    coordQ: Int16Array,
    coordR: Int16Array,
    groupId: Uint16Array,
    coordToIndex: Map<string, number>,
  ) {
    this.hexCount = hexCount;
    this.gridRadius = gridRadius;
    this.coordQ = coordQ;
    this.coordR = coordR;
    this.groupId = groupId;
    this.coordToIndex = coordToIndex;

    // Allocate derived state arrays
    this.terrainType = new Uint8Array(hexCount);
    this.element = new Uint8Array(hexCount);
    this.elevation = new Float32Array(hexCount);
    this.moisture = new Float32Array(hexCount);
    this.waterHeight = new Float32Array(hexCount);
    this.temperature = new Float32Array(hexCount);
    this.hasRiver = new Uint8Array(hexCount);

    this.planarAlignment = new Uint8Array(hexCount);
    this.planarIntensity = new Float32Array(hexCount);
    this.planarFragmentation = new Float32Array(hexCount);
    this.planarLift = new Float32Array(hexCount);
    this.planarRadius = new Float32Array(hexCount);

    this.notes = new Array(hexCount).fill('');
  }

  /** Generate the hex grid (same cube-coordinate iteration as v1). */
  static create(gridRadius: number = WORLD.GRID_RADIUS): HexStore {
    const coords: AxialCoord[] = [];

    for (let q = -gridRadius; q <= gridRadius; q++) {
      for (let r = -gridRadius; r <= gridRadius; r++) {
        if (Math.abs(q + r) > gridRadius) continue;
        coords.push({ q, r });
      }
    }

    const hexCount = coords.length;
    const coordQ = new Int16Array(hexCount);
    const coordR = new Int16Array(hexCount);
    const groupId = new Uint16Array(hexCount);
    const coordToIndex = new Map<string, number>();

    for (let i = 0; i < hexCount; i++) {
      const { q, r } = coords[i]!;
      coordQ[i] = q;
      coordR[i] = r;
      coordToIndex.set(hexKey(q, r), i);
      // Pack sector ID into groupId (simple hash for now)
      const spacing = WORLD.RING_WIDTH;
      const sq = Math.round((2 * q + r) / (3 * spacing));
      const sr = Math.round((r - q) / (3 * spacing));
      groupId[i] = ((sq + 128) << 8) | (sr + 128);
    }

    return new HexStore(hexCount, gridRadius, coordQ, coordR, groupId, coordToIndex);
  }

  /** O(1) coordinate → index lookup. Returns -1 if not found. */
  getIndex(q: number, r: number): number {
    return this.coordToIndex.get(hexKey(q, r)) ?? -1;
  }

  /** Get coordinates for a hex index. */
  getCoord(index: number): AxialCoord {
    return { q: this.coordQ[index]!, r: this.coordR[index]! };
  }

  /** Snapshot the mutable terrain + planar state for undo. */
  snapshot(): {
    terrainType: Uint8Array;
    element: Uint8Array;
    planarAlignment: Uint8Array;
    planarIntensity: Float32Array;
    notes: string[];
  } {
    return {
      terrainType: this.terrainType.slice(),
      element: this.element.slice(),
      planarAlignment: this.planarAlignment.slice(),
      planarIntensity: this.planarIntensity.slice(),
      notes: [...this.notes],
    };
  }

  /** Restore from a snapshot. */
  restore(snap: ReturnType<HexStore['snapshot']>): void {
    this.terrainType.set(snap.terrainType);
    this.element.set(snap.element);
    this.planarAlignment.set(snap.planarAlignment);
    this.planarIntensity.set(snap.planarIntensity);
    for (let i = 0; i < this.hexCount; i++) {
      this.notes[i] = snap.notes[i] ?? '';
    }
  }
}
