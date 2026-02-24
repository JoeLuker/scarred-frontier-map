import { describe, it, expect } from 'vitest';
import { buildPlumeMesh, type PlumeDescriptor } from '../plume-mesh';
import { PLANAR } from '../../core/config';
import { TORNADO_VERTEX_STRIDE } from '../types';

const P = PLANAR.PLUME;
const SHELLS = 2; // concentric shells per plume
const VERTS_PER_SHELL = P.RINGS * P.SEGMENTS;
const INDICES_PER_SHELL = (P.RINGS - 1) * P.SEGMENTS * 6;
const VERTS_PER_PLUME = VERTS_PER_SHELL * SHELLS;
const INDICES_PER_PLUME = INDICES_PER_SHELL * SHELLS;

const DESCRIPTOR: PlumeDescriptor = {
  centerX: 50,
  centerZ: 80,
  baseY: 10,
  baseRadius: 15,
  volcanism: 0.7,
};

describe('buildPlumeMesh', () => {
  it('returns null for empty descriptors', () => {
    expect(buildPlumeMesh([], 100)).toBeNull();
  });

  it('returns correct vertex and index counts for one plume', () => {
    const result = buildPlumeMesh([DESCRIPTOR], 100);
    expect(result).not.toBeNull();
    expect(result!.vertexCount).toBe(VERTS_PER_PLUME);
    expect(result!.indexCount).toBe(INDICES_PER_PLUME);
    expect(result!.vertices.length).toBe(VERTS_PER_PLUME * TORNADO_VERTEX_STRIDE);
    expect(result!.indices.length).toBe(INDICES_PER_PLUME);
  });

  it('scales linearly for multiple plumes', () => {
    const d2: PlumeDescriptor = { ...DESCRIPTOR, centerX: 200 };
    const result = buildPlumeMesh([DESCRIPTOR, d2], 100);
    expect(result).not.toBeNull();
    expect(result!.vertexCount).toBe(VERTS_PER_PLUME * 2);
    expect(result!.indexCount).toBe(INDICES_PER_PLUME * 2);
  });

  it('all indices are within vertex range', () => {
    const result = buildPlumeMesh([DESCRIPTOR], 100)!;
    for (let i = 0; i < result.indices.length; i++) {
      expect(result.indices[i]).toBeLessThan(result.vertexCount);
      expect(result.indices[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it('center_xz matches descriptor for all vertices', () => {
    const result = buildPlumeMesh([DESCRIPTOR], 100)!;
    const S = TORNADO_VERTEX_STRIDE;
    for (let v = 0; v < result.vertexCount; v++) {
      expect(result.vertices[v * S]).toBe(DESCRIPTOR.centerX);
      expect(result.vertices[v * S + 1]).toBe(DESCRIPTOR.centerZ);
    }
  });

  it('world_y rises from baseY upward', () => {
    const result = buildPlumeMesh([DESCRIPTOR], 100)!;
    const S = TORNADO_VERTEX_STRIDE;
    const plumeHeight = DESCRIPTOR.baseRadius * P.HEIGHT_FACTOR * DESCRIPTOR.volcanism;
    const expectedTopY = DESCRIPTOR.baseY + plumeHeight;
    for (let v = 0; v < result.vertexCount; v++) {
      const y = result.vertices[v * S + 2]!;
      expect(y).toBeGreaterThanOrEqual(DESCRIPTOR.baseY - 0.001);
      expect(y).toBeLessThanOrEqual(expectedTopY + 0.001);
    }
  });

  it('height_frac spans 0 to 1', () => {
    const result = buildPlumeMesh([DESCRIPTOR], 100)!;
    const S = TORNADO_VERTEX_STRIDE;
    let minHF = 1, maxHF = 0;
    for (let v = 0; v < result.vertexCount; v++) {
      const hf = result.vertices[v * S + 5]!;
      if (hf < minHF) minHF = hf;
      if (hf > maxHF) maxHF = hf;
    }
    expect(minHF).toBeCloseTo(0, 5);
    expect(maxHF).toBeCloseTo(1, 5);
  });

  it('local_radius increases with height (inverted profile)', () => {
    const result = buildPlumeMesh([DESCRIPTOR], 100)!;
    const S = TORNADO_VERTEX_STRIDE;
    // Compare first segment (angle=0) at bottom ring vs top ring of first shell
    const bottomRadius = result.vertices[4]!;  // ring 0, seg 0, local_radius
    const topIdx = (P.RINGS - 1) * P.SEGMENTS; // last ring, seg 0
    const topRadius = result.vertices[topIdx * S + 4]!;
    expect(topRadius).toBeGreaterThan(bottomRadius);
  });

  it('plume height scales with volcanism', () => {
    const low: PlumeDescriptor = { ...DESCRIPTOR, volcanism: 0.2 };
    const high: PlumeDescriptor = { ...DESCRIPTOR, volcanism: 1.0 };
    const resultLow = buildPlumeMesh([low], 100)!;
    const resultHigh = buildPlumeMesh([high], 100)!;
    const S = TORNADO_VERTEX_STRIDE;

    // Find max Y in each
    let maxYLow = -Infinity, maxYHigh = -Infinity;
    for (let v = 0; v < resultLow.vertexCount; v++) {
      const y = resultLow.vertices[v * S + 2]!;
      if (y > maxYLow) maxYLow = y;
    }
    for (let v = 0; v < resultHigh.vertexCount; v++) {
      const y = resultHigh.vertices[v * S + 2]!;
      if (y > maxYHigh) maxYHigh = y;
    }
    expect(maxYHigh).toBeGreaterThan(maxYLow);
  });

  it('opacity scales with volcanism', () => {
    const low: PlumeDescriptor = { ...DESCRIPTOR, volcanism: 0.2 };
    const high: PlumeDescriptor = { ...DESCRIPTOR, volcanism: 1.0 };
    const resultLow = buildPlumeMesh([low], 100)!;
    const resultHigh = buildPlumeMesh([high], 100)!;
    const S = TORNADO_VERTEX_STRIDE;
    // opacity_base at index 7 — compare first vertex of each
    expect(resultHigh.vertices[7]!).toBeGreaterThan(resultLow.vertices[7]!);
  });

  it('inner shell has smaller radius than outer', () => {
    const result = buildPlumeMesh([DESCRIPTOR], 100)!;
    const S = TORNADO_VERTEX_STRIDE;
    // Same height_frac vertex in each shell — compare at the top ring for maximum difference
    const topRingStart = (P.RINGS - 1) * P.SEGMENTS;
    const outerRadius = result.vertices[topRingStart * S + 4]!;
    const innerStart = topRingStart + VERTS_PER_SHELL;
    const innerRadius = result.vertices[innerStart * S + 4]!;
    expect(innerRadius).toBeLessThan(outerRadius);
  });
});
