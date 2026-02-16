import { WorldGenConfig } from '../core/types';
import { sampleTerrain } from '../core/terrain';
import { MESH_VERTEX_STRIDE } from './types';

// Terrain type → integer ID (must match shader TERRAIN_* constants)
const TERRAIN_TYPE_IDS: Record<string, number> = {
  Water: 0,
  Desert: 1,
  Plain: 2,
  Forest: 3,
  Marsh: 4,
  Hill: 5,
  Mountain: 6,
  Settlement: 7,
  'Magma Fields': 8,
  'Crystal Spires': 9,
  'Floating Islands': 10,
};

export interface MeshBuffers {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly vertexCount: number;
  readonly indexCount: number;
}

/**
 * Build a regular triangle-grid terrain mesh covering a circular world area.
 *
 * Vertices are placed on a regular grid with `spacing` distance apart.
 * Each vertex samples the continuous terrain field for elevation/moisture/terrainId.
 * Vertices outside the world circle (gridRadius hexes × hexSize × sqrt(3)) are culled.
 * Triangle pairs fill each grid cell; degenerate triangles at the boundary are skipped.
 */
export function buildTerrainMesh(
  config: WorldGenConfig,
  gridRadius: number,
  hexSize: number,
  spacing: number,
): MeshBuffers {
  const SQRT3 = Math.sqrt(3);
  // World circle radius in pixels: gridRadius hexes × inter-hex distance
  const worldRadius = gridRadius * hexSize * SQRT3;
  const worldRadius2 = worldRadius * worldRadius;
  // Small margin so edge vertices don't pop
  const cullRadius2 = (worldRadius + spacing * 2) * (worldRadius + spacing * 2);

  // Grid dimensions: cover -worldRadius..+worldRadius in both axes
  const halfExtent = worldRadius + spacing * 2;
  const cols = Math.ceil(halfExtent * 2 / spacing) + 1;
  const rows = Math.ceil(halfExtent * 2 / spacing) + 1;
  const originX = -halfExtent;
  const originZ = -halfExtent;

  // Allocate vertex buffer (worst case: all grid points)
  const maxVerts = cols * rows;
  const vertexData = new Float32Array(maxVerts * MESH_VERTEX_STRIDE);

  // Map grid (col, row) → vertex index (-1 if culled)
  const gridToVert = new Int32Array(maxVerts);
  gridToVert.fill(-1);

  let vertCount = 0;

  for (let row = 0; row < rows; row++) {
    const z = originZ + row * spacing;
    for (let col = 0; col < cols; col++) {
      const x = originX + col * spacing;

      // Circular cull
      if (x * x + z * z > cullRadius2) continue;

      const gridIdx = row * cols + col;
      gridToVert[gridIdx] = vertCount;

      // Sample continuous terrain field at world-space pixel coordinates
      // Note: sampleTerrain uses (x, y) where y maps to our z
      const sample = sampleTerrain(x, z, config);

      const off = vertCount * MESH_VERTEX_STRIDE;
      vertexData[off] = x;
      vertexData[off + 1] = z;
      vertexData[off + 2] = sample.elevation;
      vertexData[off + 3] = sample.moisture;
      vertexData[off + 4] = TERRAIN_TYPE_IDS[sample.terrain] ?? 2; // default to Plain

      vertCount++;
    }
  }

  // Build index buffer: two triangles per grid cell
  // Max triangles = 2 per cell, 3 indices per triangle
  const maxIndices = (cols - 1) * (rows - 1) * 6;
  const indexData = new Uint32Array(maxIndices);
  let idxCount = 0;

  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols - 1; col++) {
      const g00 = row * cols + col;
      const g10 = g00 + 1;
      const g01 = (row + 1) * cols + col;
      const g11 = g01 + 1;

      const v00 = gridToVert[g00]!;
      const v10 = gridToVert[g10]!;
      const v01 = gridToVert[g01]!;
      const v11 = gridToVert[g11]!;

      // Skip cells with any culled vertex
      if (v00 < 0 || v10 < 0 || v01 < 0 || v11 < 0) continue;

      // Triangle 1: v00, v01, v10
      indexData[idxCount++] = v00;
      indexData[idxCount++] = v01;
      indexData[idxCount++] = v10;

      // Triangle 2: v10, v01, v11
      indexData[idxCount++] = v10;
      indexData[idxCount++] = v01;
      indexData[idxCount++] = v11;
    }
  }

  return {
    vertices: vertexData.subarray(0, vertCount * MESH_VERTEX_STRIDE),
    indices: indexData.subarray(0, idxCount),
    vertexCount: vertCount,
    indexCount: idxCount,
  };
}

/**
 * Manages GPU buffers for a terrain mesh. Handles creation, upload, and resize.
 */
export class TerrainMesh {
  private device: GPUDevice;
  private _vertexBuffer: GPUBuffer;
  private _indexBuffer: GPUBuffer;
  private _indexCount = 0;
  private _vertexCount = 0;

  private constructor(device: GPUDevice, vertexBuffer: GPUBuffer, indexBuffer: GPUBuffer) {
    this.device = device;
    this._vertexBuffer = vertexBuffer;
    this._indexBuffer = indexBuffer;
  }

  static create(device: GPUDevice, initialVertexCapacity: number = 250000): TerrainMesh {
    const vertexBuffer = device.createBuffer({
      size: initialVertexCapacity * MESH_VERTEX_STRIDE * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    // Generous initial index capacity: ~2 triangles per vertex
    const indexBuffer = device.createBuffer({
      size: initialVertexCapacity * 6 * 4,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    return new TerrainMesh(device, vertexBuffer, indexBuffer);
  }

  upload(mesh: MeshBuffers): void {
    // Resize vertex buffer if needed
    const vertexBytes = mesh.vertices.byteLength;
    if (vertexBytes > this._vertexBuffer.size) {
      this._vertexBuffer.destroy();
      this._vertexBuffer = this.device.createBuffer({
        size: Math.ceil(vertexBytes * 1.5),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }

    // Resize index buffer if needed
    const indexBytes = mesh.indices.byteLength;
    if (indexBytes > this._indexBuffer.size) {
      this._indexBuffer.destroy();
      this._indexBuffer = this.device.createBuffer({
        size: Math.ceil(indexBytes * 1.5),
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
    }

    this.device.queue.writeBuffer(this._vertexBuffer, 0, mesh.vertices);
    this.device.queue.writeBuffer(this._indexBuffer, 0, mesh.indices);
    this._vertexCount = mesh.vertexCount;
    this._indexCount = mesh.indexCount;
  }

  get vertexBuffer(): GPUBuffer { return this._vertexBuffer; }
  get indexBuffer(): GPUBuffer { return this._indexBuffer; }
  get indexCount(): number { return this._indexCount; }
  get vertexCount(): number { return this._vertexCount; }

  destroy(): void {
    this._vertexBuffer.destroy();
    this._indexBuffer.destroy();
  }
}
