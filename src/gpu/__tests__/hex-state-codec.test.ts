import { describe, it, expect } from 'vitest';
import { encodeR, encodeRLift, encodeG, encodeB, encodeA, decodeA } from '../hex-state-codec';

describe('R channel (overlay radius, 0-71 hex → 0-255)', () => {
  it('encodes boundary values and clamps', () => {
    expect(encodeR(0)).toBe(0);
    expect(encodeR(71)).toBe(255);
    expect(encodeR(10)).toBe(Math.round(10 * 255 / 71));
    expect(encodeR(100)).toBe(255); // clamp
  });
});

describe('R channel lift variant (Fire/Water, 0.0-1.0 → 0-255)', () => {
  it('encodes boundary values and clamps', () => {
    expect(encodeRLift(0)).toBe(0);
    expect(encodeRLift(0.5)).toBe(128);
    expect(encodeRLift(1.0)).toBe(255);
    expect(encodeRLift(2.0)).toBe(255); // clamp
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
    expect(encodeG(0, 1.0) & 0x1F).toBe(31);
    expect(encodeG(0, 2.0) & 0x1F).toBe(31); // clamp
  });

  it('keeps plane type and fragmentation independent', () => {
    const byte = encodeG(4, 0.5);
    expect(byte >> 5).toBe(4);
    expect(byte & 0x1F).toBe(16); // 0.5 * 31 = 15.5 → 16
  });
});

describe('B channel (intensity)', () => {
  it('encodes boundary values and clamps', () => {
    expect(encodeB(0)).toBe(0);
    expect(encodeB(0.5)).toBe(128);
    expect(encodeB(1.0)).toBe(255);
    expect(encodeB(2.0)).toBe(255); // clamp
  });
});

describe('A channel (terrain_id + sector boundary)', () => {
  it('round-trips all terrain IDs 0-15 with both boundary states', () => {
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
    expect(encodeA(5, true) - encodeA(5, false)).toBe(1);
  });
});
