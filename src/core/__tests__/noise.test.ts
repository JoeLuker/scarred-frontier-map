import { describe, it, expect } from 'vitest';
import { hash, hashNorm, smoothNoise, fbm } from '../noise';

describe('hash', () => {
  it('is deterministic', () => {
    expect(hash(3, 7, 42)).toBe(hash(3, 7, 42));
  });

  it('produces different values for different inputs', () => {
    const vals = [hash(0, 0, 0), hash(1, 0, 0), hash(0, 1, 0), hash(0, 0, 1)];
    expect(new Set(vals).size).toBe(4);
  });

  it('returns unsigned 32-bit integers', () => {
    for (const [x, y, s] of [[0, 0, 0], [-100, -200, 999], [5, -5, 12345]]) {
      const h = hash(x!, y!, s!);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(4294967296);
      expect(Number.isInteger(h)).toBe(true);
    }
  });
});

describe('hashNorm', () => {
  it('is deterministic and in [0, 1)', () => {
    expect(hashNorm(5, 10, 99)).toBe(hashNorm(5, 10, 99));
    for (const [x, y] of [[0, 0], [-50, 50], [100, -100]]) {
      const v = hashNorm(x!, y!, 42);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('smoothNoise', () => {
  it('is deterministic', () => {
    expect(smoothNoise(1.5, 2.7, 42)).toBe(smoothNoise(1.5, 2.7, 42));
  });

  it('is continuous (small input change → small output change)', () => {
    const a = smoothNoise(5.0, 5.0, 42);
    const b = smoothNoise(5.001, 5.0, 42);
    expect(Math.abs(a - b)).toBeLessThan(0.01);
  });

  it('at integer coords equals hash of that lattice point', () => {
    expect(smoothNoise(3, 7, 42)).toBeCloseTo(hashNorm(3, 7, 42), 10);
  });
});

describe('fbm', () => {
  it('is deterministic', () => {
    expect(fbm(3.5, 7.2, 42, 3)).toBe(fbm(3.5, 7.2, 42, 3));
  });

  it('more octaves produces more detail (higher roughness)', () => {
    const sample = (octaves: number) => {
      const vals: number[] = [];
      for (let i = 0; i < 50; i++) vals.push(fbm(i * 0.1, 0, 42, octaves));
      let sum = 0;
      for (let i = 1; i < vals.length; i++) sum += Math.abs(vals[i]! - vals[i - 1]!);
      return sum / (vals.length - 1);
    };
    expect(sample(4)).toBeGreaterThan(sample(1));
  });
});
