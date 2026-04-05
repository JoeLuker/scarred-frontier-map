import { describe, it, expect } from 'vitest';
import { buildTornadoMesh, type TornadoDescriptor } from '../tornado-mesh';
import { PLANAR } from '../../core/constants';
import { TORNADO_VERTEX_STRIDE } from '../types';

const T = PLANAR.TORNADO;
const SHELLS = 3; // concentric shells per tornado
const VERTS_PER_SHELL = T.RINGS * T.SEGMENTS;
const INDICES_PER_SHELL = (T.RINGS - 1) * T.SEGMENTS * 6;
const VERTS_PER_TORNADO = VERTS_PER_SHELL * SHELLS;
const INDICES_PER_TORNADO = INDICES_PER_SHELL * SHELLS;

const DESCRIPTOR: TornadoDescriptor = {
  centerX: 100,
  centerZ: 200,
  topY: 50,
  baseRadius: 20,
  twistSpeed: T.TWIST_SPEED,
};

describe('buildTornadoMesh', () => {
  it('returns null for empty descriptors', () => {
    expect(buildTornadoMesh([], 0)).toBeNull();
  });

  it('returns correct vertex and index counts for one tornado', () => {
    const result = buildTornadoMesh([DESCRIPTOR], -1);
    expect(result).not.toBeNull();
    expect(result!.vertexCount).toBe(VERTS_PER_TORNADO);
    expect(result!.indexCount).toBe(INDICES_PER_TORNADO);
    expect(result!.vertices.length).toBe(VERTS_PER_TORNADO * TORNADO_VERTEX_STRIDE);
    expect(result!.indices.length).toBe(INDICES_PER_TORNADO);
  });

  it('scales linearly for multiple tornados', () => {
    const d2: TornadoDescriptor = { ...DESCRIPTOR, centerX: 300 };
    const result = buildTornadoMesh([DESCRIPTOR, d2], -1);
    expect(result).not.toBeNull();
    expect(result!.vertexCount).toBe(VERTS_PER_TORNADO * 2);
    expect(result!.indexCount).toBe(INDICES_PER_TORNADO * 2);
  });

  it('all indices are within vertex range', () => {
    const result = buildTornadoMesh([DESCRIPTOR], -1)!;
    for (let i = 0; i < result.indices.length; i++) {
      expect(result.indices[i]).toBeLessThan(result.vertexCount);
      expect(result.indices[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it('center_xz matches descriptor for all vertices', () => {
    const result = buildTornadoMesh([DESCRIPTOR], -1)!;
    const S = TORNADO_VERTEX_STRIDE;
    for (let v = 0; v < result.vertexCount; v++) {
      expect(result.vertices[v * S]).toBe(DESCRIPTOR.centerX);
      expect(result.vertices[v * S + 1]).toBe(DESCRIPTOR.centerZ);
    }
  });

  it('world_y interpolates between topY and gougeY', () => {
    const gougeY = -2;
    const result = buildTornadoMesh([DESCRIPTOR], gougeY)!;
    const S = TORNADO_VERTEX_STRIDE;
    for (let v = 0; v < result.vertexCount; v++) {
      const y = result.vertices[v * S + 2]!;
      expect(y).toBeGreaterThanOrEqual(gougeY - 0.001);
      expect(y).toBeLessThanOrEqual(DESCRIPTOR.topY + 0.001);
    }
  });

  it('height_frac spans 0 to 1', () => {
    const result = buildTornadoMesh([DESCRIPTOR], -1)!;
    const S = TORNADO_VERTEX_STRIDE;
    let minHF = 1, maxHF = 0;
    for (let v = 0; v < result.vertexCount; v++) {
      const hf = result.vertices[v * S + 5]!;
      if (hf < minHF) minHF = hf;
      if (hf > maxHF) maxHF = hf;
      expect(hf).toBeGreaterThanOrEqual(0);
      expect(hf).toBeLessThanOrEqual(1);
    }
    expect(minHF).toBeCloseTo(0, 5);
    expect(maxHF).toBeCloseTo(1, 5);
  });

  it('local_angle covers full circle per ring', () => {
    const result = buildTornadoMesh([DESCRIPTOR], -1)!;
    const S = TORNADO_VERTEX_STRIDE;
    // Check first ring of first shell: angles should span [0, 2π)
    const angles: number[] = [];
    for (let seg = 0; seg < T.SEGMENTS; seg++) {
      angles.push(result.vertices[seg * S + 3]!);
    }
    expect(angles[0]).toBeCloseTo(0, 5);
    expect(angles[angles.length - 1]!).toBeLessThan(Math.PI * 2);
    // Monotonically increasing
    for (let i = 1; i < angles.length; i++) {
      expect(angles[i]!).toBeGreaterThan(angles[i - 1]!);
    }
  });

  it('opacity_base is positive for all shells', () => {
    const result = buildTornadoMesh([DESCRIPTOR], -1)!;
    const S = TORNADO_VERTEX_STRIDE;
    for (let v = 0; v < result.vertexCount; v++) {
      expect(result.vertices[v * S + 7]).toBeGreaterThan(0);
    }
  });

  it('inner shells have smaller radius than outer', () => {
    const result = buildTornadoMesh([DESCRIPTOR], -1)!;
    const S = TORNADO_VERTEX_STRIDE;
    // First vertex of each shell — compare local_radius (index 4)
    const radii: number[] = [];
    for (let s = 0; s < SHELLS; s++) {
      radii.push(result.vertices[s * VERTS_PER_SHELL * S + 4]!);
    }
    // Outer shell first, inner last — radii should decrease
    for (let i = 1; i < radii.length; i++) {
      expect(radii[i]!).toBeLessThan(radii[i - 1]!);
    }
  });
});
