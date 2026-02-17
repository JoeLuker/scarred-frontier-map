import { WorldGenConfig } from '../core/types';
import { sampleTerrain } from '../core/terrain';
import { getTerrainRenderParams } from '../core/config';
import { MESH_VERTEX_STRIDE } from './types';

export interface MeshBuffers {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly vertexCount: number;
  readonly indexCount: number;
}

// --- Height displacement ---
// PARALLEL IMPLEMENTATION: Must match terrain-renderer.ts WGSL karst_height().
// Both use smoothstep(0.12, 0.28, h) * pow(h, 0.65). Any change here must
// be mirrored in the vertex shader, otherwise CPU mesh normals diverge from GPU height.

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function karstHeight(h: number): number {
  const cliff = smoothstep(0.12, 0.28, h);
  const peak = Math.pow(h, 0.65);
  return cliff * peak;
}

// Layer 1 (Geometry): Pure heightfield displacement. No terrain type awareness.
// Rivers have elevation = seaLevel (set by sampleTerrain), so they naturally get y=0.
// Exported for CPU-side elevation queries (hover/selection overlay alignment).
export function computeDisplacedY(
  elevation: number,
  seaLevel: number,
  landRange: number,
  heightScale: number,
): number {
  if (elevation >= seaLevel && landRange > 0) {
    const normElev = (elevation - seaLevel) / landRange;
    return karstHeight(normElev) * heightScale;
  }
  return 0;
}

/**
 * Build a regular triangle-grid terrain mesh covering a circular world area.
 *
 * Vertices are placed on a regular grid with `spacing` distance apart.
 * Each vertex samples the continuous terrain field for elevation and moisture.
 * Smooth normals are computed from displaced height via central differences.
 * Vertices outside the world circle (gridRadius hexes × hexSize × sqrt(3)) are culled.
 * Triangle pairs fill each grid cell; degenerate triangles at the boundary are skipped.
 *
 * Layer 1 (Geometry): This mesh knows nothing about hexes. Terrain type is resolved
 * per-fragment in the shader via hex state texture lookup (Layer 3).
 */
export function buildTerrainMesh(
  config: WorldGenConfig,
  gridRadius: number,
  hexSize: number,
  spacing: number,
): MeshBuffers {
  const SQRT3 = Math.sqrt(3);
  const worldRadius = gridRadius * hexSize * SQRT3;
  const cullRadius2 = (worldRadius + spacing * 2) * (worldRadius + spacing * 2);

  const halfExtent = worldRadius + spacing * 2;
  const cols = Math.ceil(halfExtent * 2 / spacing) + 1;
  const rows = Math.ceil(halfExtent * 2 / spacing) + 1;
  const originX = -halfExtent;
  const originZ = -halfExtent;

  const { seaLevel, landRange, heightScale } = getTerrainRenderParams(config);

  // --- Pass 1: Sample terrain, compute displaced Y, store per-grid-cell data ---
  const maxVerts = cols * rows;
  const gridToVert = new Int32Array(maxVerts);
  gridToVert.fill(-1);

  // Temporary arrays indexed by vertex index
  const posX = new Float32Array(maxVerts);
  const posZ = new Float32Array(maxVerts);
  const displacedY = new Float32Array(maxVerts);
  const elevations = new Float32Array(maxVerts);
  const moistures = new Float32Array(maxVerts);
  // Grid col/row for each vertex (needed for neighbor lookup in pass 2)
  const vertCol = new Int32Array(maxVerts);
  const vertRow = new Int32Array(maxVerts);

  let vertCount = 0;

  for (let row = 0; row < rows; row++) {
    const z = originZ + row * spacing;
    for (let col = 0; col < cols; col++) {
      const x = originX + col * spacing;
      if (x * x + z * z > cullRadius2) continue;

      const gridIdx = row * cols + col;
      gridToVert[gridIdx] = vertCount;

      const sample = sampleTerrain(x, z, config);

      posX[vertCount] = x;
      posZ[vertCount] = z;
      elevations[vertCount] = sample.elevation;
      moistures[vertCount] = sample.moisture;
      displacedY[vertCount] = computeDisplacedY(sample.elevation, seaLevel, landRange, heightScale);
      vertCol[vertCount] = col;
      vertRow[vertCount] = row;

      vertCount++;
    }
  }

  // --- Pass 2: Compute smooth normals from displaced height central differences ---
  const vertexData = new Float32Array(maxVerts * MESH_VERTEX_STRIDE);
  const invSpacing2 = 1 / (2 * spacing);

  for (let i = 0; i < vertCount; i++) {
    const col = vertCol[i]!;
    const row = vertRow[i]!;

    // Look up neighbors in grid space
    const leftIdx = col > 0 ? gridToVert[row * cols + (col - 1)]! : -1;
    const rightIdx = col < cols - 1 ? gridToVert[row * cols + (col + 1)]! : -1;
    const upIdx = row > 0 ? gridToVert[(row - 1) * cols + col]! : -1;
    const downIdx = row < rows - 1 ? gridToVert[(row + 1) * cols + col]! : -1;

    const y = displacedY[i]!;
    const yLeft = leftIdx >= 0 ? displacedY[leftIdx]! : y;
    const yRight = rightIdx >= 0 ? displacedY[rightIdx]! : y;
    const yUp = upIdx >= 0 ? displacedY[upIdx]! : y;
    const yDown = downIdx >= 0 ? displacedY[downIdx]! : y;

    // Central difference gradient → normal
    const dydx = (yRight - yLeft) * invSpacing2;
    const dydz = (yDown - yUp) * invSpacing2;
    // Normal = normalize(-dydx, 1, -dydz)
    let nx = -dydx;
    let ny = 1;
    let nz = -dydz;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx /= len;
    ny /= len;
    nz /= len;

    const off = i * MESH_VERTEX_STRIDE;
    vertexData[off] = posX[i]!;
    vertexData[off + 1] = posZ[i]!;
    vertexData[off + 2] = elevations[i]!;
    vertexData[off + 3] = moistures[i]!;
    vertexData[off + 4] = nx;
    vertexData[off + 5] = ny;
    vertexData[off + 6] = nz;
  }

  // --- Build index buffer ---
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

      if (v00 < 0 || v10 < 0 || v01 < 0 || v11 < 0) continue;

      indexData[idxCount++] = v00;
      indexData[idxCount++] = v01;
      indexData[idxCount++] = v10;

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
    const indexBuffer = device.createBuffer({
      size: initialVertexCapacity * 6 * 4,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    return new TerrainMesh(device, vertexBuffer, indexBuffer);
  }

  upload(mesh: MeshBuffers): void {
    const vertexBytes = mesh.vertices.byteLength;
    if (vertexBytes > this._vertexBuffer.size) {
      this._vertexBuffer.destroy();
      this._vertexBuffer = this.device.createBuffer({
        size: Math.ceil(vertexBytes * 1.5),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }

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
