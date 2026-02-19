import { WorldGenConfig } from '../core/types';
import { getTerrainRenderParams } from '../core/config';
import { MESH_VERTEX_STRIDE } from './types';
import type { MeshCompute } from './mesh-compute';

export interface MeshBuffers {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly vertexCount: number;
  readonly indexCount: number;
}

export interface TerrainGridData {
  readonly positions: Float32Array;   // [x, z, x, z, ...] pairs
  readonly elevations: Float32Array;
  readonly moistures: Float32Array;
  readonly cols: number;
  readonly rows: number;
  readonly originX: number;
  readonly originZ: number;
  readonly spacing: number;
  readonly cullRadius2: number;
}

export interface TerrainMeshResult {
  readonly mesh: MeshBuffers;
  readonly grid: TerrainGridData;
}

// --- Height displacement ---
// Must match terrain-renderer.ts WGSL displacement_curve().
// Cubic ease-in: pow(h, 3) compresses low/mid elevations so only the highest
// peaks produce significant displacement. This prevents the ridge noise's sharp
// cusps from creating near-vertical cliffs at moderate elevations.
// Any change here must be mirrored in the vertex shader.

function displacementCurve(h: number): number {
  return h * h * h;
}

// Layer 1 (Geometry): Pure heightfield displacement. No terrain type awareness.
// Exported for CPU-side elevation queries (hover/selection overlay alignment).
export function computeDisplacedY(
  elevation: number,
  seaLevel: number,
  landRange: number,
  heightScale: number,
): number {
  if (elevation >= seaLevel && landRange > 0) {
    const normElev = (elevation - seaLevel) / landRange;
    return displacementCurve(normElev) * heightScale;
  }
  return 0;
}

// --- Thermal erosion ---
// Jacobi-style iteration on a regular grid. Each cell transfers material to
// lower neighbors when slope exceeds a talus threshold. Non-conserving
// (material removed from high points, not deposited). Underwater cells are
// skipped to preserve ocean/river bed stability.

const THERMAL_TALUS = 0.04;   // Max stable slope (elevation units per texel)
const THERMAL_RATE = 0.4;     // Transfer rate per iteration
const THERMAL_MAX_ITERS = 100; // Iterations at erosion=1.0

function thermalErode(
  elevations: Float32Array,
  cols: number,
  rows: number,
  erosionStrength: number,
  seaLevel: number,
): void {
  const iterations = Math.floor(erosionStrength * THERMAL_MAX_ITERS);
  if (iterations <= 0) return;

  const total = cols * rows;
  let src = elevations;
  let dst = new Float32Array(total);

  for (let iter = 0; iter < iterations; iter++) {
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;
        const h = src[idx]!;

        // Skip underwater cells (preserve ocean/river beds)
        if (h <= seaLevel) {
          dst[idx] = h;
          continue;
        }

        let delta = 0;

        // Right neighbor
        if (col + 1 < cols) {
          const d = h - src[idx + 1]!;
          if (d > THERMAL_TALUS) delta += d - THERMAL_TALUS;
        }
        // Left neighbor
        if (col > 0) {
          const d = h - src[idx - 1]!;
          if (d > THERMAL_TALUS) delta += d - THERMAL_TALUS;
        }
        // Down neighbor
        if (row + 1 < rows) {
          const d = h - src[idx + cols]!;
          if (d > THERMAL_TALUS) delta += d - THERMAL_TALUS;
        }
        // Up neighbor
        if (row > 0) {
          const d = h - src[idx - cols]!;
          if (d > THERMAL_TALUS) delta += d - THERMAL_TALUS;
        }

        dst[idx] = h - delta * THERMAL_RATE;
      }
    }

    // Ping-pong: swap src and dst
    const tmp = src;
    src = dst;
    dst = tmp;
  }

  // If result ended up in the temp buffer, copy back to elevations
  if (src !== elevations) {
    elevations.set(src.subarray(0, total));
  }
}

/**
 * Build a regular triangle-grid terrain mesh covering a circular world area.
 *
 * Pass 1 (CPU): Generate full grid positions (no boundary culling yet).
 * Pass 2 (GPU): Upload positions to MeshCompute → get elevation + moisture for all grid cells.
 * Pass 2.5 (CPU): Thermal erosion on the full-grid elevation array.
 * Pass 3 (CPU): Cull to world radius, compute displaced Y + central-difference normals,
 *               write interleaved vertex buffer + index buffer.
 *
 * Layer 1 (Geometry): This mesh knows nothing about hexes. Terrain type is resolved
 * per-fragment in the shader via hex state texture lookup (Layer 3).
 */
export async function buildTerrainMesh(
  meshCompute: MeshCompute,
  config: WorldGenConfig,
  gridRadius: number,
  hexSize: number,
  spacing: number,
): Promise<TerrainMeshResult> {
  const SQRT3 = Math.sqrt(3);
  const worldRadius = gridRadius * hexSize * SQRT3;
  const cullRadius2 = (worldRadius + spacing * 2) * (worldRadius + spacing * 2);

  const halfExtent = worldRadius + spacing * 2;
  const cols = Math.ceil(halfExtent * 2 / spacing) + 1;
  const rows = Math.ceil(halfExtent * 2 / spacing) + 1;
  const originX = -halfExtent;
  const originZ = -halfExtent;

  const { seaLevel, landRange, heightScale } = getTerrainRenderParams(config);

  // --- Pass 1 (CPU): Generate ALL grid positions (no culling) ---
  const totalVerts = cols * rows;
  const gpuPositions = new Float32Array(totalVerts * 2);

  for (let row = 0; row < rows; row++) {
    const z = originZ + row * spacing;
    for (let col = 0; col < cols; col++) {
      const x = originX + col * spacing;
      const idx = row * cols + col;
      gpuPositions[idx * 2] = x;
      gpuPositions[idx * 2 + 1] = z;
    }
  }

  // --- Pass 2 (GPU): Sample elevation + moisture for ALL grid cells ---
  const { elevations, moistures } = await meshCompute.sample(gpuPositions, totalVerts, config);

  // --- Pass 2.5 (CPU): Thermal erosion on full grid ---
  if (config.erosion > 0) {
    thermalErode(elevations, cols, rows, config.erosion, seaLevel);
  }

  // --- Pass 3 (CPU): Cull, compute displaced Y + normals, write vertex data ---
  // Build gridToVert mapping (only vertices inside the world circle)
  const gridToVert = new Int32Array(totalVerts);
  gridToVert.fill(-1);
  let vertCount = 0;

  for (let row = 0; row < rows; row++) {
    const z = originZ + row * spacing;
    for (let col = 0; col < cols; col++) {
      const x = originX + col * spacing;
      if (x * x + z * z <= cullRadius2) {
        gridToVert[row * cols + col] = vertCount++;
      }
    }
  }

  const vertexData = new Float32Array(vertCount * MESH_VERTEX_STRIDE);
  const invSpacing2 = 1 / (2 * spacing);
  let vertIdx = 0;

  for (let row = 0; row < rows; row++) {
    const z = originZ + row * spacing;
    for (let col = 0; col < cols; col++) {
      const x = originX + col * spacing;
      const gridIdx = row * cols + col;
      if (gridToVert[gridIdx]! < 0) continue;

      const elev = elevations[gridIdx]!;
      const y = computeDisplacedY(elev, seaLevel, landRange, heightScale);

      // Neighbor elevations from full grid (no gaps — no need for gridToVert lookups)
      const leftElev = col > 0 ? elevations[gridIdx - 1]! : elev;
      const rightElev = col < cols - 1 ? elevations[gridIdx + 1]! : elev;
      const upElev = row > 0 ? elevations[gridIdx - cols]! : elev;
      const downElev = row < rows - 1 ? elevations[gridIdx + cols]! : elev;

      const yLeft = computeDisplacedY(leftElev, seaLevel, landRange, heightScale);
      const yRight = computeDisplacedY(rightElev, seaLevel, landRange, heightScale);
      const yUp = computeDisplacedY(upElev, seaLevel, landRange, heightScale);
      const yDown = computeDisplacedY(downElev, seaLevel, landRange, heightScale);

      // Central-difference normals
      const dydx = (yRight - yLeft) * invSpacing2;
      const dydz = (yDown - yUp) * invSpacing2;
      let nx = -dydx;
      let ny = 1;
      let nz = -dydz;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= len;
      ny /= len;
      nz /= len;

      const off = vertIdx * MESH_VERTEX_STRIDE;
      vertexData[off] = x;
      vertexData[off + 1] = z;
      vertexData[off + 2] = elev;
      vertexData[off + 3] = moistures[gridIdx]!;
      vertexData[off + 4] = nx;
      vertexData[off + 5] = ny;
      vertexData[off + 6] = nz;
      vertIdx++;
    }
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
    mesh: {
      vertices: vertexData.subarray(0, vertCount * MESH_VERTEX_STRIDE),
      indices: indexData.subarray(0, idxCount),
      vertexCount: vertCount,
      indexCount: idxCount,
    },
    grid: {
      positions: gpuPositions,
      elevations,
      moistures,
      cols,
      rows,
      originX,
      originZ,
      spacing,
      cullRadius2,
    },
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
