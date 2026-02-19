import { describe, it, expect } from 'vitest';
import { hash, hashNorm, smoothNoise, fbm } from '../noise';

describe('hash', () => {
  it('is deterministic', () => {
    expect(hash(3, 7, 42)).toBe(hash(3, 7, 42));
    expect(hash(0, 0, 0)).toBe(hash(0, 0, 0));
  });

  it('produces different values for different inputs', () => {
    const a = hash(0, 0, 0);
    const b = hash(1, 0, 0);
    const c = hash(0, 1, 0);
    const d = hash(0, 0, 1);
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it('returns unsigned 32-bit integers', () => {
    for (let i = -10; i <= 10; i++) {
      const h = hash(i, -i, 12345);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(4294967296);
      expect(Number.isInteger(h)).toBe(true);
    }
  });

  it('handles negative coordinates', () => {
    const h = hash(-100, -200, 999);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(4294967296);
  });
});

describe('hashNorm', () => {
  it('returns values in [0, 1)', () => {
    for (let x = -50; x <= 50; x += 7) {
      for (let y = -50; y <= 50; y += 7) {
        const v = hashNorm(x, y, 42);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
  });

  it('is deterministic', () => {
    expect(hashNorm(5, 10, 99)).toBe(hashNorm(5, 10, 99));
  });
});

describe('smoothNoise', () => {
  it('returns values in [0, 1]', () => {
    for (let i = 0; i < 100; i++) {
      const x = Math.random() * 200 - 100;
      const y = Math.random() * 200 - 100;
      const v = smoothNoise(x, y, 42);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic', () => {
    expect(smoothNoise(1.5, 2.7, 42)).toBe(smoothNoise(1.5, 2.7, 42));
  });

  it('is continuous (small input change → small output change)', () => {
    const a = smoothNoise(5.0, 5.0, 42);
    const b = smoothNoise(5.001, 5.0, 42);
    expect(Math.abs(a - b)).toBeLessThan(0.01);
  });

  it('at integer coords equals hash of that lattice point', () => {
    // smoothNoise at an exact integer = bl corner hash (since weights are 0)
    const v = smoothNoise(3, 7, 42);
    const expected = hashNorm(3, 7, 42);
    expect(v).toBeCloseTo(expected, 10);
  });
});

describe('fbm', () => {
  it('returns values in [0, 1]', () => {
    for (let i = 0; i < 100; i++) {
      const x = Math.random() * 100 - 50;
      const y = Math.random() * 100 - 50;
      const v = fbm(x, y, 42, 4);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic', () => {
    expect(fbm(3.5, 7.2, 42, 3)).toBe(fbm(3.5, 7.2, 42, 3));
  });

  it('more octaves produces more detail', () => {
    // Sample along a line — more octaves should have higher roughness
    // (more high-frequency variation between adjacent samples)
    const samples1: number[] = [];
    const samples4: number[] = [];
    for (let i = 0; i < 100; i++) {
      const x = i * 0.1;
      samples1.push(fbm(x, 0, 42, 1));
      samples4.push(fbm(x, 0, 42, 4));
    }

    const roughness = (arr: number[]) => {
      let sum = 0;
      for (let i = 1; i < arr.length; i++) sum += Math.abs(arr[i]! - arr[i - 1]!);
      return sum / (arr.length - 1);
    };

    // 4-octave fbm adds high-frequency detail → larger adjacent-sample differences
    expect(roughness(samples4)).toBeGreaterThan(roughness(samples1));
  });
});
