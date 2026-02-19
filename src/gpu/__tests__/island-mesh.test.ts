import { describe, it, expect } from 'vitest';
import { buildIslandMesh } from '../island-mesh';
import type { TerrainGridData } from '../terrain-mesh';
import { MESH_VERTEX_STRIDE } from '../types';

/**
 * Build a synthetic terrain grid for testing.
 * Creates a simple rectangular grid with flat elevation.
 */
function makeGrid(cols: number, rows: number, spacing = 25): TerrainGridData {
  const total = cols * rows;
  const positions = new Float32Array(total * 2);
  const elevations = new Float32Array(total);
  const moistures = new Float32Array(total);

  const originX = -(cols - 1) * spacing * 0.5;
  const originZ = -(rows - 1) * spacing * 0.5;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      positions[idx * 2] = originX + c * spacing;
      positions[idx * 2 + 1] = originZ + r * spacing;
      elevations[idx] = 0.5; // flat mid-elevation
      moistures[idx] = 0.5;
    }
  }

  return {
    positions,
    elevations,
    moistures,
    cols,
    rows,
    originX,
    originZ,
    spacing,
    cullRadius2: 1e12, // very large — no culling
  };
}

/**
 * Build classify data where all vertices in a central region are floating.
 * classifyData layout: [is_floating, lift_height, planar_intensity, 0] per vertex.
 */
function makeClassifyData(
  grid: TerrainGridData,
  isFloating: (col: number, row: number) => boolean,
  liftHeight = 100,
  pi = 0.8,
): Float32Array {
  const total = grid.cols * grid.rows;
  const data = new Float32Array(total * 4);
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const idx = r * grid.cols + c;
      const floating = isFloating(c, r);
      data[idx * 4] = floating ? 1.0 : 0.0;
      data[idx * 4 + 1] = floating ? liftHeight : 0;
      data[idx * 4 + 2] = pi;
      data[idx * 4 + 3] = 0;
    }
  }
  return data;
}

const DEFAULT_PARAMS = { seaLevel: 0.3, landRange: 0.7, heightScale: 1000 };

describe('buildIslandMesh', () => {
  it('returns null when no vertices are floating', () => {
    const grid = makeGrid(10, 10);
    const classify = makeClassifyData(grid, () => false);
    expect(buildIslandMesh(classify, grid, DEFAULT_PARAMS)).toBeNull();
  });

  it('returns null when floating vertices form no complete quads', () => {
    const grid = makeGrid(10, 10);
    // Only one vertex floating — can't form any complete quad
    const classify = makeClassifyData(grid, (c, r) => c === 5 && r === 5);
    expect(buildIslandMesh(classify, grid, DEFAULT_PARAMS)).toBeNull();
  });

  it('produces mesh with correct vertex stride', () => {
    const grid = makeGrid(20, 20);
    // Central 10x10 region floating
    const classify = makeClassifyData(grid, (c, r) => c >= 5 && c < 15 && r >= 5 && r < 15);
    const result = buildIslandMesh(classify, grid, DEFAULT_PARAMS);

    expect(result).not.toBeNull();
    expect(result!.top.vertices.length).toBe(result!.top.vertexCount * MESH_VERTEX_STRIDE);
    expect(result!.underside.vertices.length).toBe(result!.underside.vertexCount * MESH_VERTEX_STRIDE);
  });

  it('top and underside have valid index counts', () => {
    const grid = makeGrid(15, 15);
    const classify = makeClassifyData(grid, (c, r) => c >= 3 && c < 12 && r >= 3 && r < 12);
    const result = buildIslandMesh(classify, grid, DEFAULT_PARAMS)!;

    expect(result.top.indexCount).toBeGreaterThan(0);
    expect(result.top.indexCount % 3).toBe(0); // complete triangles
    expect(result.underside.indexCount).toBeGreaterThan(0);
    expect(result.underside.indexCount % 3).toBe(0);
  });

  it('all indices reference valid vertices', () => {
    const grid = makeGrid(12, 12);
    const classify = makeClassifyData(grid, (c, r) => c >= 2 && c < 10 && r >= 2 && r < 10);
    const result = buildIslandMesh(classify, grid, DEFAULT_PARAMS)!;

    for (let i = 0; i < result.top.indexCount; i++) {
      expect(result.top.indices[i]).toBeLessThan(result.top.vertexCount);
    }
    for (let i = 0; i < result.underside.indexCount; i++) {
      expect(result.underside.indices[i]).toBeLessThan(result.underside.vertexCount);
    }
  });

  it('underside includes wall vertices (more verts than top)', () => {
    const grid = makeGrid(15, 15);
    // Interior block → has boundary edges → walls
    const classify = makeClassifyData(grid, (c, r) => c >= 4 && c < 11 && r >= 4 && r < 11);
    const result = buildIslandMesh(classify, grid, DEFAULT_PARAMS)!;

    // Underside = bottom surface + walls, should have more verts than top
    expect(result.underside.vertexCount).toBeGreaterThan(result.top.vertexCount);
  });

  it('top surface vertices have positive Y displacement from lift', () => {
    const grid = makeGrid(10, 10);
    const classify = makeClassifyData(grid, (c, r) => c >= 2 && c < 8 && r >= 2 && r < 8, 200, 0.8);
    const result = buildIslandMesh(classify, grid, DEFAULT_PARAMS)!;

    // Check elevation field (index 2 in vertex stride) — should reflect lift
    let maxElev = -Infinity;
    for (let v = 0; v < result.top.vertexCount; v++) {
      const elev = result.top.vertices[v * MESH_VERTEX_STRIDE + 2]!;
      if (elev > maxElev) maxElev = elev;
    }
    // With lift=200, heightScale=1000, elev field = worldY/heightScale
    // Should be > base terrain displacement
    expect(maxElev).toBeGreaterThan(0);
  });
});
