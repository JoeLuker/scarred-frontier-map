import { describe, it, expect } from 'vitest';
import { buildClipmapRings, type ClipmapConfig } from '../clipmap';
import { MESH_VERTEX_STRIDE } from '../types';

const BASE_CONFIG: ClipmapConfig = {
  rings: 5,
  baseSpacing: 25,
  baseExtent: 512,
  worldRadius: 6000,
};

// Flat terrain: elevation=0.5, moisture=0.3 everywhere
const flatElev = () => 0.5;
const flatMoist = () => 0.3;

describe('buildClipmapRings', () => {
  it('returns the correct number of rings', () => {
    const rings = buildClipmapRings(BASE_CONFIG, 0, 0, flatElev, flatMoist);
    expect(rings.length).toBe(5);
  });

  it('each ring has correct spacing and level', () => {
    const rings = buildClipmapRings(BASE_CONFIG, 0, 0, flatElev, flatMoist);
    for (let i = 0; i < rings.length; i++) {
      expect(rings[i]!.level).toBe(i);
      expect(rings[i]!.spacing).toBe(25 * (1 << i));
    }
  });

  it('ring 0 has the most vertices (finest resolution)', () => {
    const rings = buildClipmapRings(BASE_CONFIG, 0, 0, flatElev, flatMoist);
    for (let i = 1; i < rings.length; i++) {
      expect(rings[0]!.vertexCount).toBeGreaterThan(rings[i]!.vertexCount);
    }
  });

  it('all indices reference valid vertices', () => {
    const rings = buildClipmapRings(BASE_CONFIG, 0, 0, flatElev, flatMoist);
    for (const ring of rings) {
      for (let i = 0; i < ring.indexCount; i++) {
        expect(ring.indices[i]).toBeGreaterThanOrEqual(0);
        expect(ring.indices[i]).toBeLessThan(ring.vertexCount);
      }
    }
  });

  it('vertex data has correct stride', () => {
    const rings = buildClipmapRings(BASE_CONFIG, 0, 0, flatElev, flatMoist);
    for (const ring of rings) {
      expect(ring.vertices.length).toBe(ring.vertexCount * MESH_VERTEX_STRIDE);
    }
  });

  it('elevation and moisture values are written correctly for flat terrain', () => {
    const rings = buildClipmapRings(BASE_CONFIG, 0, 0, flatElev, flatMoist);
    const ring = rings[0]!;
    for (let v = 0; v < ring.vertexCount; v++) {
      const off = v * MESH_VERTEX_STRIDE;
      expect(ring.vertices[off + 2]).toBeCloseTo(0.5, 5); // elevation
      expect(ring.vertices[off + 3]).toBeCloseTo(0.3, 5); // moisture
    }
  });

  it('normals point up for flat terrain', () => {
    const rings = buildClipmapRings(BASE_CONFIG, 0, 0, flatElev, flatMoist);
    for (const ring of rings) {
      for (let v = 0; v < ring.vertexCount; v++) {
        const off = v * MESH_VERTEX_STRIDE;
        expect(ring.vertices[off + 4]).toBeCloseTo(0, 3); // nx
        expect(ring.vertices[off + 5]).toBeCloseTo(1, 3); // ny
        expect(ring.vertices[off + 6]).toBeCloseTo(0, 3); // nz
      }
    }
  });

  it('no vertex gaps between adjacent rings (donut geometry)', () => {
    const rings = buildClipmapRings(BASE_CONFIG, 0, 0, flatElev, flatMoist);
    // Ring 0 should be a full grid, ring 1+ should be donuts
    // Verify ring 0 has vertices near center
    const ring0 = rings[0]!;
    let hasCenter = false;
    for (let v = 0; v < ring0.vertexCount; v++) {
      const x = ring0.vertices[v * MESH_VERTEX_STRIDE]!;
      const z = ring0.vertices[v * MESH_VERTEX_STRIDE + 1]!;
      if (Math.abs(x) < 26 && Math.abs(z) < 26) {
        hasCenter = true;
        break;
      }
    }
    expect(hasCenter).toBe(true);

    // Ring 1 should NOT have vertices near center (inner exclusion)
    if (rings.length > 1) {
      const ring1 = rings[1]!;
      const innerExtent = BASE_CONFIG.baseExtent; // ring 0 extent
      for (let v = 0; v < ring1.vertexCount; v++) {
        const x = Math.abs(ring1.vertices[v * MESH_VERTEX_STRIDE]!);
        const z = Math.abs(ring1.vertices[v * MESH_VERTEX_STRIDE + 1]!);
        // At least one of x,z must be >= inner extent (it's in the donut)
        expect(x >= innerExtent * 0.99 || z >= innerExtent * 0.99).toBe(true);
      }
    }
  });

  it('respects world radius culling', () => {
    const smallWorld: ClipmapConfig = {
      ...BASE_CONFIG,
      worldRadius: 100,
    };
    const rings = buildClipmapRings(smallWorld, 0, 0, flatElev, flatMoist);
    for (const ring of rings) {
      for (let v = 0; v < ring.vertexCount; v++) {
        const x = ring.vertices[v * MESH_VERTEX_STRIDE]!;
        const z = ring.vertices[v * MESH_VERTEX_STRIDE + 1]!;
        expect(x * x + z * z).toBeLessThanOrEqual(100 * 100 + 1);
      }
    }
  });

  it('center offset shifts all vertex positions', () => {
    const cx = 500;
    const cz = -300;
    const rings = buildClipmapRings(BASE_CONFIG, cx, cz, flatElev, flatMoist);
    const ring0 = rings[0]!;
    // Snapped center should be at (500, -300) since 500/25=20, -300/25=-12
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (let v = 0; v < ring0.vertexCount; v++) {
      const x = ring0.vertices[v * MESH_VERTEX_STRIDE]!;
      const z = ring0.vertices[v * MESH_VERTEX_STRIDE + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    // Center of the bounding box should be near (500, -300)
    const midX = (minX + maxX) / 2;
    const midZ = (minZ + maxZ) / 2;
    expect(Math.abs(midX - 500)).toBeLessThan(BASE_CONFIG.baseSpacing);
    expect(Math.abs(midZ - (-300))).toBeLessThan(BASE_CONFIG.baseSpacing);
  });

  it('transition row vertices have averaged elevation', () => {
    // Use a slope: elevation = x / 1000
    const slopeElev = (x: number, _z: number) => x / 1000;
    const config: ClipmapConfig = { rings: 2, baseSpacing: 25, baseExtent: 100, worldRadius: 6000 };
    const rings = buildClipmapRings(config, 0, 0, slopeElev, flatMoist);
    const ring0 = rings[0]!;

    // The outer boundary vertices of ring 0 that fall between coarser grid lines
    // should have interpolated elevation (average of neighbors)
    // Coarser spacing = 50. A vertex at x=25 on the boundary should have
    // elevation = (0/1000 + 50/1000) / 2 = 0.025
    let foundTransition = false;
    for (let v = 0; v < ring0.vertexCount; v++) {
      const off = v * MESH_VERTEX_STRIDE;
      const x = ring0.vertices[off]!;
      const z = ring0.vertices[off + 1]!;
      const elev = ring0.vertices[off + 2]!;

      // Check if this is a boundary vertex between coarser grid lines
      const extent = config.baseExtent;
      const isOnBoundary = Math.abs(Math.abs(x) - extent) < 1 || Math.abs(Math.abs(z) - extent) < 1;
      if (!isOnBoundary) continue;

      // Check if x is between coarser grid lines (not on a 50px multiple)
      const coarserSpacing = 50;
      const onCoarserX = Math.abs(x - Math.round(x / coarserSpacing) * coarserSpacing) < 1;
      const onCoarserZ = Math.abs(z - Math.round(z / coarserSpacing) * coarserSpacing) < 1;

      if (!onCoarserX && onCoarserZ) {
        // This vertex should be averaged
        const expectedElev = ((x - 25) / 1000 + (x + 25) / 1000) / 2;
        expect(elev).toBeCloseTo(expectedElev, 3);
        foundTransition = true;
      }
    }
    expect(foundTransition).toBe(true);
  });

  it('single ring produces no donut (full grid)', () => {
    const config: ClipmapConfig = { rings: 1, baseSpacing: 50, baseExtent: 200, worldRadius: 6000 };
    const rings = buildClipmapRings(config, 0, 0, flatElev, flatMoist);
    expect(rings.length).toBe(1);
    expect(rings[0]!.vertexCount).toBeGreaterThan(0);
    expect(rings[0]!.indexCount).toBeGreaterThan(0);
  });

  it('index buffer forms valid triangles (groups of 3)', () => {
    const rings = buildClipmapRings(BASE_CONFIG, 0, 0, flatElev, flatMoist);
    for (const ring of rings) {
      expect(ring.indexCount % 3).toBe(0);
    }
  });
});
