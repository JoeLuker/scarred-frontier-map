import { describe, it, expect } from 'vitest';
import { encodeR, encodeRLift, encodeG, encodeB, encodeA, decodeA } from '../hex-state-codec';

describe('R channel (overlay radius, 0-71 hex → 0-255)', () => {
  it('encodes radius 0 as 0', () => {
    expect(encodeR(0)).toBe(0);
  });

  it('encodes max radius 71 as 255', () => {
    expect(encodeR(71)).toBe(255);
  });

  it('encodes radius 10 as ~36', () => {
    expect(encodeR(10)).toBe(Math.round(10 * 255 / 71));
  });

  it('clamps above 255', () => {
    expect(encodeR(100)).toBe(255);
  });

  it('monotonically increases with radius', () => {
    let prev = -1;
    for (let r = 0; r <= 71; r++) {
      const v = encodeR(r);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('R channel lift variant (Fire/Water, 0.0-1.0 → 0-255)', () => {
  it('encodes 0.0 as 0', () => {
    expect(encodeRLift(0)).toBe(0);
  });

  it('encodes 1.0 as 255', () => {
    expect(encodeRLift(1.0)).toBe(255);
  });

  it('encodes 0.5 as 128', () => {
    expect(encodeRLift(0.5)).toBe(128);
  });

  it('clamps above 255', () => {
    expect(encodeRLift(2.0)).toBe(255);
  });
});

describe('G channel (plane_type + fragmentation)', () => {
  it('encodes plane type in high 3 bits', () => {
    for (let id = 0; id <= 7; id++) {
      const byte = encodeG(id, 0);
      expect(byte >> 5).toBe(id);
      expect(byte & 0x1F).toBe(0);
    }
  });

  it('encodes fragmentation in low 5 bits', () => {
    const byte = encodeG(0, 1.0);
    expect(byte).toBe(31);
    expect(byte & 0x1F).toBe(31);
  });

  it('keeps plane type and fragmentation independent', () => {
    const byte = encodeG(4, 0.5);
    expect(byte >> 5).toBe(4);
    // 0.5 * 31 = 15.5 → rounds to 16
    expect(byte & 0x1F).toBe(16);
  });

  it('round-trips fragmentation at key values', () => {
    // 0.0 → 0/31, 0.5 → ~16/31, 1.0 → 31/31
    expect(encodeG(0, 0) & 0x1F).toBe(0);
    expect(encodeG(0, 1.0) & 0x1F).toBe(31);
    const midBits = encodeG(0, 0.5) & 0x1F;
    expect(midBits / 31).toBeCloseTo(0.5, 1);
  });

  it('clamps fragmentation to 5-bit max', () => {
    const byte = encodeG(0, 2.0);
    expect(byte & 0x1F).toBe(31);
  });

  it('all plane types 0-7 are distinguishable', () => {
    const frag = 0.5;
    const types = new Set<number>();
    for (let id = 0; id <= 7; id++) {
      types.add(encodeG(id, frag) >> 5);
    }
    expect(types.size).toBe(8);
  });
});

describe('B channel (intensity)', () => {
  it('encodes 0.0 as 0', () => {
    expect(encodeB(0)).toBe(0);
  });

  it('encodes 1.0 as 255', () => {
    expect(encodeB(1.0)).toBe(255);
  });

  it('encodes 0.5 as ~128', () => {
    expect(encodeB(0.5)).toBe(128);
  });

  it('clamps above 255', () => {
    expect(encodeB(2.0)).toBe(255);
  });
});

describe('A channel (terrain_id + sector boundary)', () => {
  it('round-trips zero terrain, no boundary', () => {
    const byte = encodeA(0, false);
    expect(byte).toBe(0);
    const decoded = decodeA(byte);
    expect(decoded.terrainId).toBe(0);
    expect(decoded.sectorBoundary).toBe(false);
  });

  it('round-trips terrain ID 10 with boundary', () => {
    const byte = encodeA(10, true);
    expect(byte).toBe(10 * 16 + 1);
    const decoded = decodeA(byte);
    expect(decoded.terrainId).toBe(10);
    expect(decoded.sectorBoundary).toBe(true);
  });

  it('round-trips all terrain IDs 0-15', () => {
    for (let id = 0; id <= 15; id++) {
      for (const boundary of [false, true]) {
        const byte = encodeA(id, boundary);
        const decoded = decodeA(byte);
        expect(decoded.terrainId).toBe(id);
        expect(decoded.sectorBoundary).toBe(boundary);
      }
    }
  });

  it('terrain ID and boundary are independent', () => {
    const withBoundary = encodeA(5, true);
    const withoutBoundary = encodeA(5, false);
    expect(withBoundary - withoutBoundary).toBe(1);
  });
});
