/**
 * CPU mesh builder for floating island geometry.
 *
 * Produces two separate meshes (top surface + underside with walls) from:
 *   - IslandClassify readback data (solid/normDist/noiseVal per grid vertex)
 *   - CPU hex lookup for per-hex planar params (intensity, lift, fragmentation)
 *   - Terrain grid data (positions, elevations, moistures)
 *
 * 8-float island vertex layout:
 *   [pos_x, pos_z, world_y, elevation, moisture, normal_x, normal_y, normal_z]
 *
 * Uses marching squares (from marching-squares.ts) for smooth organic boundaries
 * via edge-interpolated crossing vertices.
 */

import { ISLAND_VERTEX_STRIDE } from './types';
import { computeDisplacedY } from './terrain-mesh';
import type { MeshBuffers, TerrainGridData } from './terrain-mesh';
import type { IslandReadbackData } from './island-classify';
import {
  extractIsoband, resolveVert, getEdgeEndpoints, getCrossingInfo,
  MS_TRIS, MS_WALLS,
  type IsobandResult,
} from './marching-squares';
import { pixelToHex } from '../core/geometry';
import { PLANAR } from '../core/config';
import type { HexData, PlanarAlignment } from '../core/types';

// ============================================================
// CPU-side noise (cosmetic underside rocky texture)
// ============================================================

function hashF(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function simpleNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hashF(ix, iy);
  const b = hashF(ix + 1, iy);
  const c = hashF(ix, iy + 1);
  const d = hashF(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function stalactiteNoise(x: number, z: number): number {
  const n1 = simpleNoise(x * 0.015, z * 0.015);
  const n2 = simpleNoise(x * 0.06 + 5.3, z * 0.06 + 7.1);
  const n3 = simpleNoise(x * 0.18 + 13.7, z * 0.18 + 11.3);
  return n1 * n1 * 0.6 + n2 * 0.3 + n3 * 0.1;
}

// ============================================================
// Types + constants
// ============================================================

export interface IslandMeshResult {
  readonly top: MeshBuffers;
  readonly underside: MeshBuffers;
}

export interface IslandRenderParams {
  readonly seaLevel: number;
  readonly landRange: number;
  readonly heightScale: number;
}

const BASE_THICKNESS = 0.06;     // Fraction of heightScale — max cone depth at island center
const STALACTITE_AMP = 0.006;    // Fraction of heightScale — rocky noise on cone surface

// ============================================================
// Terrain Y replication (must match VS pipeline)
// ============================================================

function displacementCurve(h: number): number {
  return h * h * h;
}

function applyAirSmoothing(y: number, heightScale: number, pi: number): number {
  const smoothT = pi * pi;
  const medianY = displacementCurve(PLANAR.AIR.SMOOTH_MEDIAN) * heightScale;
  return y + (medianY - y) * smoothT * PLANAR.AIR.SMOOTH_FACTOR;
}

function computeVertexY(
  elev: number, pi: number, lift: number, x: number, z: number,
  depthFrac: number, compTScale: number,
  seaLevel: number, landRange: number, heightScale: number,
): { topY: number; bottomY: number } {
  const baseY = computeDisplacedY(elev, seaLevel, landRange, heightScale);
  const smoothedY = applyAirSmoothing(baseY, heightScale, pi);
  const chunkAlt = simpleNoise(x * PLANAR.AIR.ALT_VARIATION_FREQ, z * PLANAR.AIR.ALT_VARIATION_FREQ);
  const altMul = 0.8 + chunkAlt * 0.4;
  const liftHeight = lift * PLANAR.AIR.MAX_LIFT_FRACTION * heightScale * altMul;
  const topY = smoothedY + liftHeight;
  const baseThick = BASE_THICKNESS * depthFrac * heightScale * compTScale;
  const stalactite = stalactiteNoise(x, z) * STALACTITE_AMP * depthFrac * heightScale * compTScale;
  return { topY, bottomY: topY - baseThick - stalactite };
}

// ============================================================
// Grid algorithms for cone depth scaling
// ============================================================

/** Two-pass distance transform: distance from each solid vertex to nearest boundary. */
function computeDistanceField(
  solid: Uint8Array, cols: number, rows: number,
): Float32Array {
  const total = cols * rows;
  const dist = new Float32Array(total);
  const INF = cols + rows;
  for (let i = 0; i < total; i++) dist[i] = solid[i] ? INF : 0;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      if (!solid[idx]) continue;
      if (col > 0) dist[idx] = Math.min(dist[idx]!, dist[idx - 1]! + 1);
      if (row > 0) dist[idx] = Math.min(dist[idx]!, dist[idx - cols]! + 1);
    }
  }
  for (let row = rows - 1; row >= 0; row--) {
    for (let col = cols - 1; col >= 0; col--) {
      const idx = row * cols + col;
      if (!solid[idx]) continue;
      if (col < cols - 1) dist[idx] = Math.min(dist[idx]!, dist[idx + 1]! + 1);
      if (row < rows - 1) dist[idx] = Math.min(dist[idx]!, dist[idx + cols]! + 1);
    }
  }
  return dist;
}

/** Flood-fill connected components. Returns component ID per vertex + max distance per component. */
function computeComponents(
  solid: Uint8Array, distField: Float32Array, cols: number, rows: number,
): { componentOf: Int32Array; maxDist: number[] } {
  const total = cols * rows;
  const componentOf = new Int32Array(total);
  componentOf.fill(-1);
  const maxDist: number[] = [];
  let nextId = 0;
  const queue: number[] = [];

  for (let i = 0; i < total; i++) {
    if (!solid[i] || componentOf[i] !== -1) continue;
    const id = nextId++;
    let compMax = 0;
    queue.length = 0;
    queue.push(i);
    componentOf[i] = id;
    while (queue.length > 0) {
      const idx = queue.pop()!;
      const d = distField[idx]!;
      if (d > compMax) compMax = d;
      const r = (idx / cols) | 0;
      const c = idx % cols;
      for (const n of [
        c > 0 ? idx - 1 : -1,
        c < cols - 1 ? idx + 1 : -1,
        r > 0 ? idx - cols : -1,
        r < rows - 1 ? idx + cols : -1,
      ]) {
        if (n >= 0 && solid[n] && componentOf[n] === -1) {
          componentOf[n] = id;
          queue.push(n);
        }
      }
    }
    maxDist.push(compMax);
  }
  return { componentOf, maxDist };
}

// ============================================================
// Wall quad emitter
// ============================================================

function writeWallQuad(
  wallVerts: Float32Array,
  wallIndices: Uint32Array,
  wallVertOff: number,
  wallIdxOff: number,
  vertBaseIdx: number,
  ax: number, az: number, topAy: number, botAy: number,
  bx: number, bz: number, topBy: number, botBy: number,
  outsideX: number, outsideZ: number,
): { verts: number; indices: number } {
  const edx = bx - ax;
  const edz = bz - az;
  let nx = -edz;
  let nz = edx;
  const midX = (ax + bx) * 0.5;
  const midZ = (az + bz) * 0.5;
  if (nx * (outsideX - midX) + nz * (outsideZ - midZ) < 0) { nx = -nx; nz = -nz; }
  const nlen = Math.sqrt(nx * nx + nz * nz);
  if (nlen < 0.001) return { verts: 0, indices: 0 };
  nx /= nlen;
  nz /= nlen;

  const S = ISLAND_VERTEX_STRIDE;
  const o0 = wallVertOff * S;
  const o1 = (wallVertOff + 1) * S;
  const o2 = (wallVertOff + 2) * S;
  const o3 = (wallVertOff + 3) * S;

  wallVerts[o0] = ax; wallVerts[o0+1] = az; wallVerts[o0+2] = topAy; wallVerts[o0+3] = 0; wallVerts[o0+4] = 0;
  wallVerts[o0+5] = nx; wallVerts[o0+6] = 0; wallVerts[o0+7] = nz;
  wallVerts[o1] = bx; wallVerts[o1+1] = bz; wallVerts[o1+2] = topBy; wallVerts[o1+3] = 0; wallVerts[o1+4] = 0;
  wallVerts[o1+5] = nx; wallVerts[o1+6] = 0; wallVerts[o1+7] = nz;
  wallVerts[o2] = bx; wallVerts[o2+1] = bz; wallVerts[o2+2] = botBy; wallVerts[o2+3] = 0; wallVerts[o2+4] = 0;
  wallVerts[o2+5] = nx; wallVerts[o2+6] = 0; wallVerts[o2+7] = nz;
  wallVerts[o3] = ax; wallVerts[o3+1] = az; wallVerts[o3+2] = botAy; wallVerts[o3+3] = 0; wallVerts[o3+4] = 0;
  wallVerts[o3+5] = nx; wallVerts[o3+6] = 0; wallVerts[o3+7] = nz;

  const b = vertBaseIdx;
  wallIndices[wallIdxOff]     = b;     wallIndices[wallIdxOff + 1] = b + 1;
  wallIndices[wallIdxOff + 2] = b + 2; wallIndices[wallIdxOff + 3] = b;
  wallIndices[wallIdxOff + 4] = b + 2; wallIndices[wallIdxOff + 5] = b + 3;

  return { verts: 4, indices: 6 };
}

// ============================================================
// Main mesh builder
// ============================================================

/**
 * Build island top + underside meshes from classify readback data + hex data.
 *
 * Pipeline:
 *   1. Classify vertices (hex lookup → vertIsland/intensity/lift)
 *   2. Extract isoband (marching squares → edge crossings, cell cases, vertex indices)
 *   3. Compute depth analysis (distance field + connected components)
 *   4. Write vertex buffers (grid corners + edge crossings, top + bottom Y)
 *   5. Write index buffers (marching squares triangulation)
 *   6. Emit wall quads + combine into underside mesh
 */
export function buildIslandMesh(
  readback: IslandReadbackData,
  hexes: HexData[],
  grid: TerrainGridData,
  hexSize: number,
  params: IslandRenderParams,
): IslandMeshResult | null {
  const { positions, elevations, moistures, cols, rows, spacing, cullRadius2 } = grid;
  const { seaLevel, landRange, heightScale } = params;
  const { solid: readbackSolid, noiseVal: readbackNoise } = readback;
  const totalVerts = cols * rows;
  const quadCols = cols - 1;
  const quadRows = rows - 1;

  // ── 1. Classify vertices ──────────────────────────────────
  const hexMap = new Map<string, { intensity: number; lift: number; frag: number }>();
  const AIR: PlanarAlignment = 'Plane of Air' as PlanarAlignment;
  for (let i = 0; i < hexes.length; i++) {
    const h = hexes[i]!;
    if (h.planarAlignment !== AIR) continue;
    hexMap.set(`${h.coordinates.q},${h.coordinates.r}`, {
      intensity: h.planarIntensity,
      lift: h.planarLift,
      frag: h.planarFragmentation,
    });
  }

  const vertIsland = new Uint8Array(totalVerts);
  const vertIntensity = new Float32Array(totalVerts);
  const vertLift = new Float32Array(totalVerts);

  for (let i = 0; i < totalVerts; i++) {
    if (!readbackSolid[i]) continue;
    const x = positions[i * 2]!;
    const z = positions[i * 2 + 1]!;
    if (x * x + z * z > cullRadius2) continue;
    const hex = pixelToHex(x, z, hexSize);
    const hexData = hexMap.get(`${hex.q},${hex.r}`);
    if (!hexData) continue;
    vertIsland[i] = 1;
    vertIntensity[i] = hexData.intensity;
    vertLift[i] = hexData.lift;
  }

  // ── 2. Extract isoband ────────────────────────────────────
  const iso = extractIsoband(vertIsland, readbackNoise, cols, rows);
  if (!iso) return null;

  // ── 3. Depth analysis (cone scaling per connected component) ──
  const distField = computeDistanceField(vertIsland, cols, rows);
  const { componentOf, maxDist } = computeComponents(vertIsland, distField, cols, rows);
  const maxUncappedDepth = (BASE_THICKNESS + STALACTITE_AMP) * heightScale;
  const compTScale = maxDist.map(md => {
    const worldWidth = 2 * md * spacing;
    return maxUncappedDepth > 0 ? Math.min(1, worldWidth / maxUncappedDepth) : 1;
  });

  // ── 4. Write vertex buffers ───────────────────────────────
  const S = ISLAND_VERTEX_STRIDE;
  const topVertices = new Float32Array(iso.totalMeshVerts * S);
  const bottomVertices = new Float32Array(iso.totalMeshVerts * S);
  const invSpacing2 = 1 / (2 * spacing);

  // Pre-compute Y for all used grid vertices (needed for central-difference normals)
  const topYGrid = new Float32Array(totalVerts);
  const bottomYGrid = new Float32Array(totalVerts);

  for (let idx = 0; idx < totalVerts; idx++) {
    if (!iso.vertUsed[idx]) continue;
    const x = positions[idx * 2]!;
    const z = positions[idx * 2 + 1]!;
    const dist = distField[idx]!;
    const comp = componentOf[idx]!;
    const md = comp >= 0 ? maxDist[comp]! : 0;
    const { topY, bottomY } = computeVertexY(
      elevations[idx]!, vertIntensity[idx]!, vertLift[idx]!, x, z,
      md > 0 ? dist / md : 0, comp >= 0 ? compTScale[comp]! : 1,
      seaLevel, landRange, heightScale,
    );
    topYGrid[idx] = topY;
    bottomYGrid[idx] = bottomY;
  }

  // Write grid corner vertices with central-difference normals
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      const vi = iso.gridToVert[idx]!;
      if (vi < 0) continue;

      const x = positions[idx * 2]!;
      const z = positions[idx * 2 + 1]!;
      const topY = topYGrid[idx]!;
      const bottomY = bottomYGrid[idx]!;

      const leftIdx = col > 0 ? idx - 1 : idx;
      const rightIdx = col < cols - 1 ? idx + 1 : idx;
      const upIdx = row > 0 ? idx - cols : idx;
      const downIdx = row < rows - 1 ? idx + cols : idx;

      // Top normals
      const tL = iso.vertUsed[leftIdx] ? topYGrid[leftIdx]! : topY;
      const tR = iso.vertUsed[rightIdx] ? topYGrid[rightIdx]! : topY;
      const tU = iso.vertUsed[upIdx] ? topYGrid[upIdx]! : topY;
      const tD = iso.vertUsed[downIdx] ? topYGrid[downIdx]! : topY;
      let tnx = -(tR - tL) * invSpacing2;
      let tny = 1.0;
      let tnz = -(tD - tU) * invSpacing2;
      let tlen = Math.sqrt(tnx * tnx + tny * tny + tnz * tnz);
      tnx /= tlen; tny /= tlen; tnz /= tlen;

      const to = vi * S;
      topVertices[to] = x; topVertices[to+1] = z; topVertices[to+2] = topY;
      topVertices[to+3] = elevations[idx]!; topVertices[to+4] = moistures[idx]!;
      topVertices[to+5] = tnx; topVertices[to+6] = tny; topVertices[to+7] = tnz;

      // Bottom normals (face downward)
      const bL = iso.vertUsed[leftIdx] ? bottomYGrid[leftIdx]! : bottomY;
      const bR = iso.vertUsed[rightIdx] ? bottomYGrid[rightIdx]! : bottomY;
      const bU = iso.vertUsed[upIdx] ? bottomYGrid[upIdx]! : bottomY;
      const bD = iso.vertUsed[downIdx] ? bottomYGrid[downIdx]! : bottomY;
      let bnx = (bR - bL) * invSpacing2;
      let bny = -1.0;
      let bnz = (bD - bU) * invSpacing2;
      let blen = Math.sqrt(bnx * bnx + bny * bny + bnz * bnz);
      bnx /= blen; bny /= blen; bnz /= blen;

      const bo = vi * S;
      bottomVertices[bo] = x; bottomVertices[bo+1] = z; bottomVertices[bo+2] = bottomY;
      bottomVertices[bo+3] = 0; bottomVertices[bo+4] = 0;
      bottomVertices[bo+5] = bnx; bottomVertices[bo+6] = bny; bottomVertices[bo+7] = bnz;
    }
  }

  // Write edge crossing vertices
  // Store crossing positions/Y for wall quad generation
  const hEdgeCols = quadCols;
  const hCrossData = new Float32Array(rows * hEdgeCols * 4); // x, z, topY, bottomY
  const vCrossData = new Float32Array(quadRows * cols * 4);

  function writeEdgeCrossing(
    vi: number, i0: number, i1: number, t: number,
    crossData: Float32Array, crossDataOffset: number,
  ): void {
    const x = positions[i0 * 2]! + t * (positions[i1 * 2]! - positions[i0 * 2]!);
    const z = positions[i0 * 2 + 1]! + t * (positions[i1 * 2 + 1]! - positions[i0 * 2 + 1]!);
    const elev = elevations[i0]! + t * (elevations[i1]! - elevations[i0]!);
    const moist = moistures[i0]! + t * (moistures[i1]! - moistures[i0]!);

    const solidIdx = vertIsland[i0] ? i0 : i1;
    const pi = vertIntensity[solidIdx]!;
    const lift = vertLift[solidIdx]!;

    const crossDist = distField[i0]! + t * (distField[i1]! - distField[i0]!);
    const comp0 = componentOf[i0]!;
    const comp1 = componentOf[i1]!;
    const comp = comp0 >= 0 ? comp0 : comp1;
    const md = comp >= 0 ? maxDist[comp]! : 0;
    const depthFrac = md > 0 ? Math.max(0, crossDist / md) : 0;
    const tsc = comp >= 0 ? compTScale[comp]! : 1;

    const { topY, bottomY } = computeVertexY(
      elev, pi, lift, x, z, depthFrac, tsc, seaLevel, landRange, heightScale,
    );

    const to = vi * S;
    topVertices[to] = x; topVertices[to+1] = z; topVertices[to+2] = topY;
    topVertices[to+3] = elev; topVertices[to+4] = moist;
    topVertices[to+5] = 0; topVertices[to+6] = 1; topVertices[to+7] = 0;

    bottomVertices[to] = x; bottomVertices[to+1] = z; bottomVertices[to+2] = bottomY;
    bottomVertices[to+3] = 0; bottomVertices[to+4] = 0;
    bottomVertices[to+5] = 0; bottomVertices[to+6] = -1; bottomVertices[to+7] = 0;

    crossData[crossDataOffset] = x;
    crossData[crossDataOffset + 1] = z;
    crossData[crossDataOffset + 2] = topY;
    crossData[crossDataOffset + 3] = bottomY;
  }

  // Horizontal edge crossings
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < hEdgeCols; col++) {
      const eIdx = row * hEdgeCols + col;
      const vi = iso.hEdgeToVert[eIdx]!;
      if (vi < 0) continue;
      const i0 = row * cols + col;
      writeEdgeCrossing(vi, i0, i0 + 1, iso.hCrossT[eIdx]!, hCrossData, eIdx * 4);
    }
  }

  // Vertical edge crossings
  for (let row = 0; row < quadRows; row++) {
    for (let col = 0; col < cols; col++) {
      const eIdx = row * cols + col;
      const vi = iso.vEdgeToVert[eIdx]!;
      if (vi < 0) continue;
      const i0 = row * cols + col;
      writeEdgeCrossing(vi, i0, i0 + cols, iso.vCrossT[eIdx]!, vCrossData, eIdx * 4);
    }
  }

  // ── 5. Write index buffers ────────────────────────────────
  const topIndices = new Uint32Array(iso.totalTriIndices);
  const bottomIndices = new Uint32Array(iso.totalTriIndices);
  let topIdxCount = 0;
  let botIdxCount = 0;

  for (let qr = 0; qr < quadRows; qr++) {
    for (let qc = 0; qc < quadCols; qc++) {
      const caseIdx = iso.cellCases[qr * quadCols + qc]!;
      if (caseIdx === 0) continue;
      const tris = MS_TRIS[caseIdx]!;
      for (let i = 0; i < tris.length; i += 3) {
        const v0 = resolveVert(iso, qr, qc, tris[i]!, cols);
        const v1 = resolveVert(iso, qr, qc, tris[i + 1]!, cols);
        const v2 = resolveVert(iso, qr, qc, tris[i + 2]!, cols);
        topIndices[topIdxCount++] = v0;
        topIndices[topIdxCount++] = v1;
        topIndices[topIdxCount++] = v2;
        bottomIndices[botIdxCount++] = v0;
        bottomIndices[botIdxCount++] = v2;
        bottomIndices[botIdxCount++] = v1;
      }
    }
  }

  // ── 6. Wall quads + combine underside ─────────────────────

  function getCrossData(qr: number, qc: number, localId: number): { x: number; z: number; topY: number; bottomY: number } {
    const { edgeIdx, isHorizontal } = getCrossingInfo(iso, qr, qc, localId, cols);
    const arr = isHorizontal ? hCrossData : vCrossData;
    const off = edgeIdx * 4;
    return { x: arr[off]!, z: arr[off + 1]!, topY: arr[off + 2]!, bottomY: arr[off + 3]! };
  }

  const maxWallVerts = iso.totalContourSegments * 4;
  const maxWallIndices = iso.totalContourSegments * 6;
  const wallVerts = new Float32Array(maxWallVerts * S);
  const wallIndices = new Uint32Array(maxWallIndices);
  let wallVertCount = 0;
  let wallIdxCount = 0;

  for (let qr = 0; qr < quadRows; qr++) {
    for (let qc = 0; qc < quadCols; qc++) {
      const caseIdx = iso.cellCases[qr * quadCols + qc]!;
      const walls = MS_WALLS[caseIdx]!;
      if (walls.length === 0) continue;

      // Outside reference: centroid of non-solid corners
      const g00 = qr * cols + qc;
      const corners = [g00, g00 + 1, g00 + cols + 1, g00 + cols];
      let outsideX = 0, outsideZ = 0, outsideCount = 0;
      for (let ci = 0; ci < 4; ci++) {
        const gi = corners[ci]!;
        if (!vertIsland[gi]) {
          outsideX += positions[gi * 2]!;
          outsideZ += positions[gi * 2 + 1]!;
          outsideCount++;
        }
      }
      if (outsideCount > 0) { outsideX /= outsideCount; outsideZ /= outsideCount; }

      for (let wi = 0; wi < walls.length; wi += 2) {
        const a = getCrossData(qr, qc, walls[wi]!);
        const b = getCrossData(qr, qc, walls[wi + 1]!);
        const r = writeWallQuad(
          wallVerts, wallIndices, wallVertCount, wallIdxCount,
          iso.totalMeshVerts + wallVertCount,
          a.x, a.z, a.topY, a.bottomY,
          b.x, b.z, b.topY, b.bottomY,
          outsideX, outsideZ,
        );
        wallVertCount += r.verts;
        wallIdxCount += r.indices;
      }
    }
  }

  // Combine underside (bottom surface + walls)
  const totalUnderVerts = iso.totalMeshVerts + wallVertCount;
  const totalUnderIndices = botIdxCount + wallIdxCount;
  const combinedUnderVerts = new Float32Array(totalUnderVerts * S);
  combinedUnderVerts.set(bottomVertices.subarray(0, iso.totalMeshVerts * S));
  combinedUnderVerts.set(wallVerts.subarray(0, wallVertCount * S), iso.totalMeshVerts * S);
  const combinedUnderIndices = new Uint32Array(totalUnderIndices);
  combinedUnderIndices.set(bottomIndices.subarray(0, botIdxCount));
  combinedUnderIndices.set(wallIndices.subarray(0, wallIdxCount), botIdxCount);

  return {
    top: {
      vertices: topVertices.subarray(0, iso.totalMeshVerts * S),
      indices: topIndices.subarray(0, topIdxCount),
      vertexCount: iso.totalMeshVerts,
      indexCount: topIdxCount,
    },
    underside: {
      vertices: combinedUnderVerts,
      indices: combinedUnderIndices,
      vertexCount: totalUnderVerts,
      indexCount: totalUnderIndices,
    },
  };
}
