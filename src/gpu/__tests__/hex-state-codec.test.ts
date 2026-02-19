import { describe, it, expect } from 'vitest';
import { encodeR, decodeR, encodeG, encodeB, encodeA, decodeA } from '../hex-state-codec';

describe('R channel (lift + fragmentation)', () => {
  it('round-trips zero values', () => {
    const byte = encodeR(0, 0);
    expect(byte).toBe(0);
    const decoded = decodeR(byte);
    expect(decoded.lift).toBe(0);
    expect(decoded.fragmentation).toBe(0);
  });

  it('round-trips max values', () => {
    const byte = encodeR(1, 1);
    expect(byte).toBe(0xFF);
    const decoded = decodeR(byte);
    expect(decoded.lift).toBe(1);
    expect(decoded.fragmentation).toBe(1);
  });

  it('round-trips mid values', () => {
    const byte = encodeR(0.5, 0.5);
    const decoded = decodeR(byte);
    // 4-bit precision: 0.5 * 15 = 7.5 → rounds to 8, 8/15 ≈ 0.533
    expect(decoded.lift).toBeCloseTo(0.5, 1);
    expect(decoded.fragmentation).toBeCloseTo(0.5, 1);
  });

  it('keeps nibbles independent', () => {
    const byte = encodeR(1, 0);
    expect(byte).toBe(0xF0);
    const decoded = decodeR(byte);
    expect(decoded.lift).toBe(1);
    expect(decoded.fragmentation).toBe(0);

    const byte2 = encodeR(0, 1);
    expect(byte2).toBe(0x0F);
    const decoded2 = decodeR(byte2);
    expect(decoded2.lift).toBe(0);
    expect(decoded2.fragmentation).toBe(1);
  });

  it('clamps values to nibble range', () => {
    // Values > 1 should be clamped to nibble max (15)
    const byte = encodeR(2.0, 2.0);
    expect(byte).toBe(0xFF);
  });
});

describe('G channel (plane type)', () => {
  it('passes through plane type ID', () => {
    for (let id = 0; id <= 7; id++) {
      expect(encodeG(id)).toBe(id);
    }
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
