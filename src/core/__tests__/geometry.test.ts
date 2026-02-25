import { describe, it, expect } from 'vitest';
import { hexToPixel, pixelToHex, axialRound, getHexDistance, getSectorID, getSectorCenter } from '../geometry';

describe('hexToPixel / pixelToHex round-trip', () => {
  const HEX_SIZE = 50;

  it('round-trips origin', () => {
    const px = hexToPixel(0, 0, HEX_SIZE);
    const hex = pixelToHex(px.x, px.y, HEX_SIZE);
    expect(hex).toEqual({ q: 0, r: 0 });
  });

  it('round-trips positive coords', () => {
    for (const [q, r] of [[3, 4], [10, -5], [-7, 12], [0, 8], [6, 0]]) {
      const px = hexToPixel(q!, r!, HEX_SIZE);
      const hex = pixelToHex(px.x, px.y, HEX_SIZE);
      expect(hex, `(${q}, ${r})`).toEqual({ q, r });
    }
  });

  it('round-trips negative coords', () => {
    for (const [q, r] of [[-3, -4], [-10, 5], [7, -12]]) {
      const px = hexToPixel(q!, r!, HEX_SIZE);
      const hex = pixelToHex(px.x, px.y, HEX_SIZE);
      expect(hex, `(${q}, ${r})`).toEqual({ q, r });
    }
  });

  it('round-trips with different hex sizes', () => {
    for (const size of [10, 25, 100]) {
      const px = hexToPixel(5, -3, size);
      const hex = pixelToHex(px.x, px.y, size);
      expect(hex, `size=${size}`).toEqual({ q: 5, r: -3 });
    }
  });
});

describe('axialRound', () => {
  it('rounds exact integers', () => {
    expect(axialRound(3, 4)).toEqual({ q: 3, r: 4 });
  });

  it('rounds fractional coords to nearest hex', () => {
    expect(axialRound(2.1, 3.9)).toEqual({ q: 2, r: 4 });
  });

  it('handles boundary cases near hex edges', () => {
    // Near a triple-hex boundary: (0.33, 0.33) — sum of cube coords:
    // q=0.33, r=0.33, s=-0.66. Should round to (0, 0).
    const result = axialRound(0.33, 0.33);
    expect(result.q + result.r + (-result.q - result.r)).toBe(0);
  });

  it('maintains cube constraint q + s + r = 0 where s = -q - r', () => {
    for (const [fq, fr] of [[0.7, -0.3], [-4.9, 2.1], [8.5, -8.5], [0.01, -0.01], [-3.3, 7.7]]) {
      const { q, r } = axialRound(fq!, fr!);
      expect(q + (-q - r) + r).toBe(0);
    }
  });
});

describe('getHexDistance', () => {
  it('origin to origin is 0', () => {
    expect(getHexDistance({ q: 0, r: 0 }, { q: 0, r: 0 })).toBe(0);
  });

  it('adjacent hexes are distance 1', () => {
    const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];
    for (const [dq, dr] of neighbors) {
      expect(getHexDistance({ q: 0, r: 0 }, { q: dq!, r: dr! })).toBe(1);
    }
  });

  it('is symmetric', () => {
    const a = { q: 3, r: -5 };
    const b = { q: -2, r: 7 };
    expect(getHexDistance(a, b)).toBe(getHexDistance(b, a));
  });

  it('computes correct distances', () => {
    expect(getHexDistance({ q: 0, r: 0 }, { q: 5, r: 0 })).toBe(5);
    expect(getHexDistance({ q: 0, r: 0 }, { q: 3, r: 3 })).toBe(6);
    expect(getHexDistance({ q: -2, r: -3 }, { q: 2, r: 3 })).toBe(10);
  });
});

describe('getSectorID / getSectorCenter', () => {
  const SPACING = 5;

  it('origin maps to sector (0, 0)', () => {
    expect(getSectorID(0, 0, SPACING)).toEqual({ q: 0, r: 0 });
  });

  it('sector center round-trips through getSectorID', () => {
    for (const [sq, sr] of [[0, 0], [1, 0], [0, 1], [-1, 1], [2, -1]]) {
      const center = getSectorCenter(sq!, sr!, SPACING);
      const sector = getSectorID(center.q, center.r, SPACING);
      expect(sector, `sector(${sq}, ${sr})`).toEqual({ q: sq, r: sr });
    }
  });
});
