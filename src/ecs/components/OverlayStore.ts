import { PlanarAlignment } from '../../core/types';
import type { OverlayId, OverlayParams } from '../types';
import { PLANAR_DEFAULTS } from '../../core/constants';

const MAX_OVERLAYS = 32;

/**
 * Slot-pool allocator for planar overlays.
 * Overlay IDs are packed: (slot << 8) | generation.
 * Generation prevents stale references after slot reuse.
 */
export class OverlayStore {
  readonly active: Uint8Array;
  readonly generation: Uint8Array;
  readonly type: Uint8Array;
  readonly coordQ: Int16Array;
  readonly coordR: Int16Array;
  readonly radius: Float32Array;
  readonly intensity: Float32Array;
  readonly falloff: Float32Array;
  readonly fragmentation: Float32Array;
  readonly lift: Float32Array;

  constructor() {
    this.active = new Uint8Array(MAX_OVERLAYS);
    this.generation = new Uint8Array(MAX_OVERLAYS);
    this.type = new Uint8Array(MAX_OVERLAYS);
    this.coordQ = new Int16Array(MAX_OVERLAYS);
    this.coordR = new Int16Array(MAX_OVERLAYS);
    this.radius = new Float32Array(MAX_OVERLAYS);
    this.intensity = new Float32Array(MAX_OVERLAYS);
    this.falloff = new Float32Array(MAX_OVERLAYS);
    this.fragmentation = new Float32Array(MAX_OVERLAYS);
    this.lift = new Float32Array(MAX_OVERLAYS);
  }

  /** Allocate a new overlay. Returns OverlayId or -1 if full. */
  add(alignment: PlanarAlignment, q: number, r: number, params?: Partial<OverlayParams>): OverlayId {
    // Find first free slot
    for (let slot = 0; slot < MAX_OVERLAYS; slot++) {
      if (this.active[slot] === 0) {
        const gen = (this.generation[slot]! + 1) & 0xFF;
        this.generation[slot] = gen;
        this.active[slot] = 1;
        this.type[slot] = alignment;
        this.coordQ[slot] = q;
        this.coordR[slot] = r;

        const defaults = PLANAR_DEFAULTS[alignment];
        this.radius[slot] = params?.radius ?? defaults?.radius ?? 5;
        this.intensity[slot] = params?.intensity ?? defaults?.intensity ?? 1;
        this.falloff[slot] = params?.falloff ?? defaults?.falloff ?? 3;
        this.fragmentation[slot] = params?.fragmentation ?? defaults?.fragmentation ?? 0.5;
        this.lift[slot] = params?.lift ?? defaults?.lift ?? 0.5;

        return (slot << 8) | gen;
      }
    }
    return -1;
  }

  /** Remove an overlay by ID. Returns true if found and removed. */
  remove(id: OverlayId): boolean {
    const slot = id >> 8;
    const gen = id & 0xFF;
    if (slot < 0 || slot >= MAX_OVERLAYS) return false;
    if (this.active[slot] !== 1 || this.generation[slot] !== gen) return false;
    this.active[slot] = 0;
    return true;
  }

  /** Modify overlay parameters. Returns true if found. */
  modify(id: OverlayId, changes: Partial<OverlayParams> & { q?: number; r?: number }): boolean {
    const slot = id >> 8;
    const gen = id & 0xFF;
    if (slot < 0 || slot >= MAX_OVERLAYS) return false;
    if (this.active[slot] !== 1 || this.generation[slot] !== gen) return false;

    if (changes.q !== undefined) this.coordQ[slot] = changes.q;
    if (changes.r !== undefined) this.coordR[slot] = changes.r;
    if (changes.radius !== undefined) this.radius[slot] = changes.radius;
    if (changes.intensity !== undefined) this.intensity[slot] = changes.intensity;
    if (changes.falloff !== undefined) this.falloff[slot] = changes.falloff;
    if (changes.fragmentation !== undefined) this.fragmentation[slot] = changes.fragmentation;
    if (changes.lift !== undefined) this.lift[slot] = changes.lift;

    return true;
  }

  /** Resolve overlay ID to slot index, or -1 if invalid/stale. */
  resolveSlot(id: OverlayId): number {
    const slot = id >> 8;
    const gen = id & 0xFF;
    if (slot < 0 || slot >= MAX_OVERLAYS) return -1;
    if (this.active[slot] !== 1 || this.generation[slot] !== gen) return -1;
    return slot;
  }

  /** Iterate over active overlay slots. */
  *activeSlots(): IterableIterator<number> {
    for (let i = 0; i < MAX_OVERLAYS; i++) {
      if (this.active[i] === 1) yield i;
    }
  }

  /** Number of active overlays. */
  get count(): number {
    let n = 0;
    for (let i = 0; i < MAX_OVERLAYS; i++) {
      if (this.active[i] === 1) n++;
    }
    return n;
  }

  /** Snapshot for undo. */
  snapshot(): Uint8Array {
    // Pack all arrays into a single buffer
    const buf = new Uint8Array(MAX_OVERLAYS * 30); // generous
    const view = new DataView(buf.buffer);
    for (let i = 0; i < MAX_OVERLAYS; i++) {
      const off = i * 30;
      buf[off] = this.active[i]!;
      buf[off + 1] = this.generation[i]!;
      buf[off + 2] = this.type[i]!;
      view.setInt16(off + 3, this.coordQ[i]!, true);
      view.setInt16(off + 5, this.coordR[i]!, true);
      view.setFloat32(off + 7, this.radius[i]!, true);
      view.setFloat32(off + 11, this.intensity[i]!, true);
      view.setFloat32(off + 15, this.falloff[i]!, true);
      view.setFloat32(off + 19, this.fragmentation[i]!, true);
      view.setFloat32(off + 23, this.lift[i]!, true);
      // 27-29 = padding
    }
    return buf.slice();
  }

  /** Restore from snapshot. */
  restore(buf: Uint8Array): void {
    const view = new DataView(buf.buffer, buf.byteOffset);
    for (let i = 0; i < MAX_OVERLAYS; i++) {
      const off = i * 30;
      this.active[i] = buf[off]!;
      this.generation[i] = buf[off + 1]!;
      this.type[i] = buf[off + 2]!;
      this.coordQ[i] = view.getInt16(off + 3, true);
      this.coordR[i] = view.getInt16(off + 5, true);
      this.radius[i] = view.getFloat32(off + 7, true);
      this.intensity[i] = view.getFloat32(off + 11, true);
      this.falloff[i] = view.getFloat32(off + 15, true);
      this.fragmentation[i] = view.getFloat32(off + 19, true);
      this.lift[i] = view.getFloat32(off + 23, true);
    }
  }
}
