import { MESH_VERTEX_STRIDE } from './types';
import { computeDisplacedY } from './terrain-mesh';
import type { MeshBuffers, TerrainGridData } from './terrain-mesh';
import { PLANAR } from '../core/config';

// --- CPU-side value noise for underside rocky texture ---
// Does NOT need to match any GPU noise — purely cosmetic.

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

export interface IslandMeshResult {
  readonly top: MeshBuffers;
  readonly underside: MeshBuffers;
}

export interface IslandRenderParams {
  readonly seaLevel: number;
  readonly landRange: number;
  readonly heightScale: number;
}

// Underside profile constants
const BASE_THICKNESS = 0.06;     // Fraction of heightScale — max cone depth at island center
const STALACTITE_AMP = 0.006;    // Fraction of heightScale — subtle rocky noise on cone surface

// Must match terrain-mesh.ts displacementCurve (also in VS)
function displacementCurve(h: number): number {
  return h * h * h;
}

// Replicate VS Air ground smoothing: y = mix(y, median_y, pi² * SMOOTH_FACTOR)
// Must match terrain-renderer.ts VS Air branch exactly.
function applyAirSmoothing(y: number, heightScale: number, pi: number): number {
  const smoothT = pi * pi;
  const medianY = displacementCurve(PLANAR.AIR.SMOOTH_MEDIAN) * heightScale;
  return y + (medianY - y) * smoothT * PLANAR.AIR.SMOOTH_FACTOR;
}

/**
 * Two-pass distance transform on a grid.
 * Returns approximate distance (in grid cells) from each vertex
 * to the nearest non-solid boundary. Non-solid vertices get 0.
 */
function computeDistanceField(
  solid: Uint8Array,
  cols: number,
  rows: number,
): Float32Array {
  const total = cols * rows;
  const dist = new Float32Array(total);
  const INF = cols + rows;

  for (let i = 0; i < total; i++) {
    dist[i] = solid[i] ? INF : 0;
  }

  // Forward pass
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      if (!solid[idx]) continue;
      if (col > 0) dist[idx] = Math.min(dist[idx]!, dist[idx - 1]! + 1);
      if (row > 0) dist[idx] = Math.min(dist[idx]!, dist[idx - cols]! + 1);
    }
  }

  // Backward pass
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

/**
 * Flood-fill connected components on solid vertices.
 * Returns component ID per vertex (-1 for non-solid) and max distance per component.
 */
function computeComponents(
  solid: Uint8Array,
  distField: Float32Array,
  cols: number,
  rows: number,
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
      const row = (idx / cols) | 0;
      const col = idx % cols;
      for (const n of [
        col > 0 ? idx - 1 : -1,
        col < cols - 1 ? idx + 1 : -1,
        row > 0 ? idx - cols : -1,
        row < rows - 1 ? idx + cols : -1,
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
// Write a single wall quad (4 verts, 2 triangles) into the output arrays.
// Returns the number of wall vertices added (always 4, or 0 on degenerate).
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
  heightScale: number,
): { verts: number; indices: number } {
  const edx = bx - ax;
  const edz = bz - az;
  let nx = -edz;
  let nz = edx;
  const midX = (ax + bx) * 0.5;
  const midZ = (az + bz) * 0.5;
  if (nx * (outsideX - midX) + nz * (outsideZ - midZ) < 0) {
    nx = -nx;
    nz = -nz;
  }
  const nlen = Math.sqrt(nx * nx + nz * nz);
  if (nlen < 0.001) return { verts: 0, indices: 0 };
  nx /= nlen;
  nz /= nlen;

  const S = MESH_VERTEX_STRIDE;
  const o0 = wallVertOff * S;
  const o1 = (wallVertOff + 1) * S;
  const o2 = (wallVertOff + 2) * S;
  const o3 = (wallVertOff + 3) * S;

  // topA, topB, botB, botA
  wallVerts[o0] = ax; wallVerts[o0+1] = az; wallVerts[o0+2] = topAy / heightScale; wallVerts[o0+3] = 0;
  wallVerts[o0+4] = nx; wallVerts[o0+5] = 0; wallVerts[o0+6] = nz;

  wallVerts[o1] = bx; wallVerts[o1+1] = bz; wallVerts[o1+2] = topBy / heightScale; wallVerts[o1+3] = 0;
  wallVerts[o1+4] = nx; wallVerts[o1+5] = 0; wallVerts[o1+6] = nz;

  wallVerts[o2] = bx; wallVerts[o2+1] = bz; wallVerts[o2+2] = botBy / heightScale; wallVerts[o2+3] = 0;
  wallVerts[o2+4] = nx; wallVerts[o2+5] = 0; wallVerts[o2+6] = nz;

  wallVerts[o3] = ax; wallVerts[o3+1] = az; wallVerts[o3+2] = botAy / heightScale; wallVerts[o3+3] = 0;
  wallVerts[o3+4] = nx; wallVerts[o3+5] = 0; wallVerts[o3+6] = nz;

  const b = vertBaseIdx;
  wallIndices[wallIdxOff]     = b;
  wallIndices[wallIdxOff + 1] = b + 1;
  wallIndices[wallIdxOff + 2] = b + 2;
  wallIndices[wallIdxOff + 3] = b;
  wallIndices[wallIdxOff + 4] = b + 2;
  wallIndices[wallIdxOff + 5] = b + 3;

  return { verts: 4, indices: 6 };
}

export function buildIslandMesh(
  classifyData: Float32Array,
  grid: TerrainGridData,
  params: IslandRenderParams,
): IslandMeshResult | null {
  const { positions, elevations, moistures, cols, rows, originX, originZ, spacing, cullRadius2 } = grid;
  const { seaLevel, landRange, heightScale } = params;
  const totalVerts = cols * rows;
  const quadCols = cols - 1;
  const quadRows = rows - 1;
  const totalQuads = quadCols * quadRows;

  // ================================================================
  // Phase 1: Per-vertex classification from GPU results
  // ================================================================
  const vertIsland = new Uint8Array(totalVerts);
  for (let i = 0; i < totalVerts; i++) {
    const x = positions[i * 2]!;
    const z = positions[i * 2 + 1]!;
    if (x * x + z * z > cullRadius2) continue;
    if (classifyData[i * 4]! > 0.5) {
      vertIsland[i] = 1;
    }
  }

  // ================================================================
  // Phase 2: Solid quads — the single source of truth for all mesh topology.
  // A quad is solid iff all 4 corners are island vertices.
  // ================================================================
  const solidQuad = new Uint8Array(totalQuads);
  let solidCount = 0;
  for (let qr = 0; qr < quadRows; qr++) {
    for (let qc = 0; qc < quadCols; qc++) {
      const g00 = qr * cols + qc;
      const g10 = g00 + 1;
      const g01 = g00 + cols;
      const g11 = g01 + 1;
      if (vertIsland[g00] && vertIsland[g10] && vertIsland[g01] && vertIsland[g11]) {
        solidQuad[qr * quadCols + qc] = 1;
        solidCount++;
      }
    }
  }

  if (solidCount === 0) return null;

  // ================================================================
  // Phase 3: Derive solid vertices — only vertices that belong to at least
  // one solid quad get included in the mesh. This prevents orphan geometry.
  // ================================================================
  const vertUsed = new Uint8Array(totalVerts);
  for (let qr = 0; qr < quadRows; qr++) {
    for (let qc = 0; qc < quadCols; qc++) {
      if (!solidQuad[qr * quadCols + qc]) continue;
      const g00 = qr * cols + qc;
      vertUsed[g00] = 1;
      vertUsed[g00 + 1] = 1;
      vertUsed[g00 + cols] = 1;
      vertUsed[g00 + cols + 1] = 1;
    }
  }

  // ================================================================
  // Phase 4: Distance field + connected components on solid vertices
  // ================================================================
  const distField = computeDistanceField(vertUsed, cols, rows);
  const { componentOf, maxDist } = computeComponents(vertUsed, distField, cols, rows);

  const depth = new Float32Array(totalVerts);
  for (let i = 0; i < totalVerts; i++) {
    const comp = componentOf[i]!;
    if (comp < 0) continue;
    const md = maxDist[comp]!;
    depth[i] = md > 0 ? distField[i]! / md : 0;
  }

  const maxUncappedDepth = (BASE_THICKNESS + STALACTITE_AMP) * heightScale;
  const compThicknessScale = maxDist.map(md => {
    const worldWidth = 2 * md * spacing;
    return maxUncappedDepth > 0 ? Math.min(1, worldWidth / maxUncappedDepth) : 1;
  });

  // ================================================================
  // Phase 5: Compute per-vertex Y positions (top + bottom)
  // ================================================================
  const gridToVert = new Int32Array(totalVerts);
  gridToVert.fill(-1);
  let vertCount = 0;
  for (let i = 0; i < totalVerts; i++) {
    if (vertUsed[i]) gridToVert[i] = vertCount++;
  }

  const topYGrid = new Float32Array(totalVerts);
  const bottomYGrid = new Float32Array(totalVerts);

  for (let i = 0; i < totalVerts; i++) {
    if (!vertUsed[i]) continue;

    const elev = elevations[i]!;
    const baseY = computeDisplacedY(elev, seaLevel, landRange, heightScale);
    const pi = classifyData[i * 4 + 2]!;
    const smoothedY = applyAirSmoothing(baseY, heightScale, pi);
    const liftHeight = classifyData[i * 4 + 1]!;
    const topY = smoothedY + liftHeight;
    topYGrid[i] = topY;

    const d = depth[i]!;
    const envelope = d; // linear cone: 0 at edge, 1 at center

    const comp = componentOf[i]!;
    const tScale = comp >= 0 ? compThicknessScale[comp]! : 1;
    const baseThick = BASE_THICKNESS * envelope * heightScale * tScale;

    const x = positions[i * 2]!;
    const z = positions[i * 2 + 1]!;
    const stalactite = stalactiteNoise(x, z) * STALACTITE_AMP * envelope * heightScale * tScale;

    bottomYGrid[i] = topY - baseThick - stalactite;
  }

  // ================================================================
  // Phase 6: Write vertex buffers (top + bottom, shared indexing)
  // ================================================================
  const topVertices = new Float32Array(vertCount * MESH_VERTEX_STRIDE);
  const bottomVertices = new Float32Array(vertCount * MESH_VERTEX_STRIDE);
  const invSpacing2 = 1 / (2 * spacing);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      const vi = gridToVert[idx]!;
      if (vi < 0) continue;

      const x = positions[idx * 2]!;
      const z = positions[idx * 2 + 1]!;
      const moist = moistures[idx]!;

      const leftIdx = col > 0 ? idx - 1 : idx;
      const rightIdx = col < cols - 1 ? idx + 1 : idx;
      const upIdx = row > 0 ? idx - cols : idx;
      const downIdx = row < rows - 1 ? idx + cols : idx;

      // Top normals
      const topY = topYGrid[idx]!;
      const topLeft  = vertUsed[leftIdx]  ? topYGrid[leftIdx]!  : topY;
      const topRight = vertUsed[rightIdx] ? topYGrid[rightIdx]! : topY;
      const topUp    = vertUsed[upIdx]    ? topYGrid[upIdx]!    : topY;
      const topDown  = vertUsed[downIdx]  ? topYGrid[downIdx]!  : topY;

      let tnx = -(topRight - topLeft) * invSpacing2;
      let tny = 1.0;
      let tnz = -(topDown - topUp) * invSpacing2;
      const tlen = Math.sqrt(tnx * tnx + tny * tny + tnz * tnz);
      tnx /= tlen; tny /= tlen; tnz /= tlen;

      const topOff = vi * MESH_VERTEX_STRIDE;
      topVertices[topOff]     = x;
      topVertices[topOff + 1] = z;
      topVertices[topOff + 2] = topY / heightScale;
      topVertices[topOff + 3] = moist;
      topVertices[topOff + 4] = tnx;
      topVertices[topOff + 5] = tny;
      topVertices[topOff + 6] = tnz;

      // Bottom normals (face downward)
      const bottomY = bottomYGrid[idx]!;
      const bLeft  = vertUsed[leftIdx]  ? bottomYGrid[leftIdx]!  : bottomY;
      const bRight = vertUsed[rightIdx] ? bottomYGrid[rightIdx]! : bottomY;
      const bUp    = vertUsed[upIdx]    ? bottomYGrid[upIdx]!    : bottomY;
      const bDown  = vertUsed[downIdx]  ? bottomYGrid[downIdx]!  : bottomY;

      let bnx = (bRight - bLeft) * invSpacing2;
      let bny = -1.0;
      let bnz = (bDown - bUp) * invSpacing2;
      const blen = Math.sqrt(bnx * bnx + bny * bny + bnz * bnz);
      bnx /= blen; bny /= blen; bnz /= blen;

      const botOff = vi * MESH_VERTEX_STRIDE;
      bottomVertices[botOff]     = x;
      bottomVertices[botOff + 1] = z;
      bottomVertices[botOff + 2] = bottomY / heightScale;
      bottomVertices[botOff + 3] = 0; // moisture=0 signals underside
      bottomVertices[botOff + 4] = bnx;
      bottomVertices[botOff + 5] = bny;
      bottomVertices[botOff + 6] = bnz;
    }
  }

  // ================================================================
  // Phase 7: Index buffers — derived entirely from solid quads.
  // Top + bottom surfaces share the same quad set (different winding).
  // ================================================================
  const topIndices = new Uint32Array(solidCount * 6);
  const bottomIndices = new Uint32Array(solidCount * 6);
  let topIdxCount = 0;
  let botIdxCount = 0;

  for (let qr = 0; qr < quadRows; qr++) {
    for (let qc = 0; qc < quadCols; qc++) {
      if (!solidQuad[qr * quadCols + qc]) continue;

      const g00 = qr * cols + qc;
      const v00 = gridToVert[g00]!;
      const v10 = gridToVert[g00 + 1]!;
      const v01 = gridToVert[g00 + cols]!;
      const v11 = gridToVert[g00 + cols + 1]!;

      // Top: same winding as terrain mesh
      topIndices[topIdxCount++] = v00;
      topIndices[topIdxCount++] = v01;
      topIndices[topIdxCount++] = v10;
      topIndices[topIdxCount++] = v10;
      topIndices[topIdxCount++] = v01;
      topIndices[topIdxCount++] = v11;

      // Bottom: reversed winding
      bottomIndices[botIdxCount++] = v00;
      bottomIndices[botIdxCount++] = v10;
      bottomIndices[botIdxCount++] = v01;
      bottomIndices[botIdxCount++] = v10;
      bottomIndices[botIdxCount++] = v11;
      bottomIndices[botIdxCount++] = v01;
    }
  }

  // ================================================================
  // Phase 8: Side walls — derived from boundary edges of solid quads.
  // An edge gets a wall iff: it borders a solid quad on one side and
  // either no quad or a non-solid quad on the other side.
  // This guarantees walls only exist where top+bottom surfaces exist.
  // ================================================================

  // Helper: is the quad at (qr, qc) solid?
  function isQuadSolid(qr: number, qc: number): boolean {
    if (qr < 0 || qr >= quadRows || qc < 0 || qc >= quadCols) return false;
    return solidQuad[qr * quadCols + qc] === 1;
  }

  // Count boundary edges for allocation
  let boundaryEdgeCount = 0;
  // Horizontal edges: between quad rows qr-1 and qr (the top edge of quad at qr)
  for (let qr = 0; qr < quadRows; qr++) {
    for (let qc = 0; qc < quadCols; qc++) {
      if (!isQuadSolid(qr, qc)) continue;
      // Top edge of this quad: is the quad above non-solid?
      if (!isQuadSolid(qr - 1, qc)) boundaryEdgeCount++;
      // Bottom edge
      if (!isQuadSolid(qr + 1, qc)) boundaryEdgeCount++;
      // Left edge
      if (!isQuadSolid(qr, qc - 1)) boundaryEdgeCount++;
      // Right edge
      if (!isQuadSolid(qr, qc + 1)) boundaryEdgeCount++;
    }
  }

  const maxWallVerts = boundaryEdgeCount * 4;
  const maxWallIndices = boundaryEdgeCount * 6;
  const wallVerts = new Float32Array(maxWallVerts * MESH_VERTEX_STRIDE);
  const wallIndices = new Uint32Array(maxWallIndices);
  let wallVertCount = 0;
  let wallIdxCount = 0;

  for (let qr = 0; qr < quadRows; qr++) {
    for (let qc = 0; qc < quadCols; qc++) {
      if (!isQuadSolid(qr, qc)) continue;

      const g00 = qr * cols + qc;
      const g10 = g00 + 1;
      const g01 = g00 + cols;
      const g11 = g01 + 1;

      // Top edge (g00→g10): boundary if quad above is not solid
      if (!isQuadSolid(qr - 1, qc)) {
        const outsideZ = originZ + (qr - 1) * spacing + spacing * 0.5;
        const outsideX = (positions[g00 * 2]! + positions[g10 * 2]!) * 0.5;
        const r = writeWallQuad(
          wallVerts, wallIndices, wallVertCount, wallIdxCount,
          vertCount + wallVertCount,
          positions[g10 * 2]!, positions[g10 * 2 + 1]!, topYGrid[g10]!, bottomYGrid[g10]!,
          positions[g00 * 2]!, positions[g00 * 2 + 1]!, topYGrid[g00]!, bottomYGrid[g00]!,
          outsideX, outsideZ, heightScale,
        );
        wallVertCount += r.verts;
        wallIdxCount += r.indices;
      }

      // Bottom edge (g01→g11): boundary if quad below is not solid
      if (!isQuadSolid(qr + 1, qc)) {
        const outsideZ = originZ + (qr + 2) * spacing - spacing * 0.5;
        const outsideX = (positions[g01 * 2]! + positions[g11 * 2]!) * 0.5;
        const r = writeWallQuad(
          wallVerts, wallIndices, wallVertCount, wallIdxCount,
          vertCount + wallVertCount,
          positions[g01 * 2]!, positions[g01 * 2 + 1]!, topYGrid[g01]!, bottomYGrid[g01]!,
          positions[g11 * 2]!, positions[g11 * 2 + 1]!, topYGrid[g11]!, bottomYGrid[g11]!,
          outsideX, outsideZ, heightScale,
        );
        wallVertCount += r.verts;
        wallIdxCount += r.indices;
      }

      // Left edge (g00→g01): boundary if quad left is not solid
      if (!isQuadSolid(qr, qc - 1)) {
        const outsideX = originX + (qc - 1) * spacing + spacing * 0.5;
        const outsideZ = (positions[g00 * 2 + 1]! + positions[g01 * 2 + 1]!) * 0.5;
        const r = writeWallQuad(
          wallVerts, wallIndices, wallVertCount, wallIdxCount,
          vertCount + wallVertCount,
          positions[g00 * 2]!, positions[g00 * 2 + 1]!, topYGrid[g00]!, bottomYGrid[g00]!,
          positions[g01 * 2]!, positions[g01 * 2 + 1]!, topYGrid[g01]!, bottomYGrid[g01]!,
          outsideX, outsideZ, heightScale,
        );
        wallVertCount += r.verts;
        wallIdxCount += r.indices;
      }

      // Right edge (g10→g11): boundary if quad right is not solid
      if (!isQuadSolid(qr, qc + 1)) {
        const outsideX = originX + (qc + 2) * spacing - spacing * 0.5;
        const outsideZ = (positions[g10 * 2 + 1]! + positions[g11 * 2 + 1]!) * 0.5;
        const r = writeWallQuad(
          wallVerts, wallIndices, wallVertCount, wallIdxCount,
          vertCount + wallVertCount,
          positions[g11 * 2]!, positions[g11 * 2 + 1]!, topYGrid[g11]!, bottomYGrid[g11]!,
          positions[g10 * 2]!, positions[g10 * 2 + 1]!, topYGrid[g10]!, bottomYGrid[g10]!,
          outsideX, outsideZ, heightScale,
        );
        wallVertCount += r.verts;
        wallIdxCount += r.indices;
      }
    }
  }

  // ================================================================
  // Phase 9: Combine underside (bottom surface + walls) into one mesh
  // ================================================================
  const totalUnderVerts = vertCount + wallVertCount;
  const totalUnderIndices = botIdxCount + wallIdxCount;
  const combinedUnderVerts = new Float32Array(totalUnderVerts * MESH_VERTEX_STRIDE);
  combinedUnderVerts.set(bottomVertices.subarray(0, vertCount * MESH_VERTEX_STRIDE));
  combinedUnderVerts.set(
    wallVerts.subarray(0, wallVertCount * MESH_VERTEX_STRIDE),
    vertCount * MESH_VERTEX_STRIDE,
  );

  const combinedUnderIndices = new Uint32Array(totalUnderIndices);
  combinedUnderIndices.set(bottomIndices.subarray(0, botIdxCount));
  combinedUnderIndices.set(wallIndices.subarray(0, wallIdxCount), botIdxCount);

  return {
    top: {
      vertices: topVertices.subarray(0, vertCount * MESH_VERTEX_STRIDE),
      indices: topIndices.subarray(0, topIdxCount),
      vertexCount: vertCount,
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
