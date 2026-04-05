import { describe, it, expect } from 'vitest';
import { HexStore } from '../components/HexStore';
import { OverlayStore } from '../components/OverlayStore';
import { PlanarAlignment } from '../../core/types';

describe('HexStore', () => {
  it('creates correct hex count for radius 2', () => {
    const store = HexStore.create(2);
    // Radius 2: 3*2*3 + 1 = 19 hexes
    expect(store.hexCount).toBe(19);
  });

  it('creates correct hex count for radius 3', () => {
    const store = HexStore.create(3);
    // Radius 3: 3*3*4 + 1 = 37 hexes
    expect(store.hexCount).toBe(37);
  });

  it('origin is findable by coordinate', () => {
    const store = HexStore.create(2);
    const idx = store.getIndex(0, 0);
    expect(idx).toBeGreaterThanOrEqual(0);
    const coord = store.getCoord(idx);
    expect(coord.q).toBe(0);
    expect(coord.r).toBe(0);
  });

  it('all hexes are reachable by coordinate', () => {
    const store = HexStore.create(3);
    for (let i = 0; i < store.hexCount; i++) {
      const coord = store.getCoord(i);
      const found = store.getIndex(coord.q, coord.r);
      expect(found).toBe(i);
    }
  });

  it('returns -1 for out-of-bounds coordinates', () => {
    const store = HexStore.create(2);
    expect(store.getIndex(100, 100)).toBe(-1);
  });

  it('snapshot and restore preserves terrain state', () => {
    const store = HexStore.create(2);
    store.terrainType[0] = 5;
    store.terrainType[1] = 3;
    store.notes[0] = 'test note';

    const snap = store.snapshot();

    // Mutate after snapshot
    store.terrainType[0] = 0;
    store.notes[0] = 'changed';

    // Restore
    store.restore(snap);
    expect(store.terrainType[0]).toBe(5);
    expect(store.terrainType[1]).toBe(3);
    expect(store.notes[0]).toBe('test note');
  });

  it('snapshot is a deep copy (mutations do not affect it)', () => {
    const store = HexStore.create(2);
    store.terrainType[0] = 7;
    const snap = store.snapshot();
    store.terrainType[0] = 0;
    expect(snap.terrainType[0]).toBe(7);
  });
});

describe('OverlayStore', () => {
  it('starts empty', () => {
    const store = new OverlayStore();
    expect(store.count).toBe(0);
  });

  it('add returns valid ID', () => {
    const store = new OverlayStore();
    const id = store.add(PlanarAlignment.FIRE, 0, 0);
    expect(id).toBeGreaterThanOrEqual(0);
    expect(store.count).toBe(1);
  });

  it('add uses planar defaults', () => {
    const store = new OverlayStore();
    const id = store.add(PlanarAlignment.WATER, 5, 3);
    const slot = store.resolveSlot(id);
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(store.radius[slot]).toBe(8); // WATER default radius
    expect(store.coordQ[slot]).toBe(5);
    expect(store.coordR[slot]).toBe(3);
  });

  it('remove invalidates overlay', () => {
    const store = new OverlayStore();
    const id = store.add(PlanarAlignment.FIRE, 0, 0);
    expect(store.remove(id)).toBe(true);
    expect(store.count).toBe(0);
    expect(store.resolveSlot(id)).toBe(-1);
  });

  it('stale ID rejected after slot reuse', () => {
    const store = new OverlayStore();
    const id1 = store.add(PlanarAlignment.FIRE, 0, 0);
    store.remove(id1);
    const id2 = store.add(PlanarAlignment.WATER, 1, 1);
    // id1 is stale — different generation
    expect(store.resolveSlot(id1)).toBe(-1);
    expect(store.resolveSlot(id2)).toBeGreaterThanOrEqual(0);
  });

  it('modify updates parameters', () => {
    const store = new OverlayStore();
    const id = store.add(PlanarAlignment.EARTH, 0, 0);
    store.modify(id, { radius: 20, q: 10 });
    const slot = store.resolveSlot(id);
    expect(store.radius[slot]).toBe(20);
    expect(store.coordQ[slot]).toBe(10);
  });

  it('activeSlots iterates only active entries', () => {
    const store = new OverlayStore();
    store.add(PlanarAlignment.FIRE, 0, 0);
    store.add(PlanarAlignment.WATER, 1, 1);
    const id3 = store.add(PlanarAlignment.AIR, 2, 2);
    store.remove(id3);

    const slots = [...store.activeSlots()];
    expect(slots.length).toBe(2);
  });

  it('snapshot and restore round-trips', () => {
    const store = new OverlayStore();
    store.add(PlanarAlignment.FIRE, 3, 4);
    store.add(PlanarAlignment.WATER, 5, -2, { radius: 15 });

    const snap = store.snapshot();

    // Clear and restore
    const store2 = new OverlayStore();
    store2.restore(snap);

    expect(store2.count).toBe(2);
    const slots = [...store2.activeSlots()];
    expect(store2.type[slots[0]!]).toBe(PlanarAlignment.FIRE);
    expect(store2.coordQ[slots[0]!]).toBe(3);
    expect(store2.radius[slots[1]!]).toBe(15);
  });

  it('returns -1 when full', () => {
    const store = new OverlayStore();
    for (let i = 0; i < 32; i++) {
      store.add(PlanarAlignment.FIRE, i, 0);
    }
    expect(store.count).toBe(32);
    expect(store.add(PlanarAlignment.WATER, 0, 0)).toBe(-1);
  });
});
