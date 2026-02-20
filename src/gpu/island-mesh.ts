/**
 * CPU mesh builder for floating island geometry.
 *
 * Produces two separate meshes (top surface + underside with walls) from:
 *   - IslandClassify readback data (solid/normDist per grid vertex)
 *   - CPU hex lookup for per-hex planar params (intensity, lift, fragmentation)
 *   - Terrain grid data (positions, elevations, moistures)
 *
 * 8-float island vertex layout:
 *   [pos_x, pos_z, world_y, elevation, moisture, normal_x, normal_y, normal_z]
 *
 * world_y is pre-baked (smoothing + lift + cone), separate from elevation so the
 * fragment shader gets correct terrain elevation for biome logic (snow line, rock
 * blend, etc.) without inflated island height corrupting those calculations.
 */

import { ISLAND_VERTEX_STRIDE } from './types';
import { computeDisplacedY } from './terrain-mesh';
import type { MeshBuffers, TerrainGridData } from './terrain-mesh';
import type { IslandReadbackData } from './island-classify';
import { pixelToHex } from '../core/geometry';
import { PLANAR } from '../core/config';
import type { HexData, PlanarAlignment } from '../core/types';

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
// Uses 8-float island vertex layout.
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
  if (nx * (outsideX - midX) + nz * (outsideZ - midZ) < 0) {
    nx = -nx;
    nz = -nz;
  }
  const nlen = Math.sqrt(nx * nx + nz * nz);
  if (nlen < 0.001) return { verts: 0, indices: 0 };
  nx /= nlen;
  nz /= nlen;

  const S = ISLAND_VERTEX_STRIDE;
  const o0 = wallVertOff * S;
  const o1 = (wallVertOff + 1) * S;
  const o2 = (wallVertOff + 2) * S;
  const o3 = (wallVertOff + 3) * S;

  // topA, topB, botB, botA — elev/moisture=0 for wall faces (underside material)
  wallVerts[o0] = ax; wallVerts[o0+1] = az; wallVerts[o0+2] = topAy; wallVerts[o0+3] = 0; wallVerts[o0+4] = 0;
  wallVerts[o0+5] = nx; wallVerts[o0+6] = 0; wallVerts[o0+7] = nz;

  wallVerts[o1] = bx; wallVerts[o1+1] = bz; wallVerts[o1+2] = topBy; wallVerts[o1+3] = 0; wallVerts[o1+4] = 0;
  wallVerts[o1+5] = nx; wallVerts[o1+6] = 0; wallVerts[o1+7] = nz;

  wallVerts[o2] = bx; wallVerts[o2+1] = bz; wallVerts[o2+2] = botBy; wallVerts[o2+3] = 0; wallVerts[o2+4] = 0;
  wallVerts[o2+5] = nx; wallVerts[o2+6] = 0; wallVerts[o2+7] = nz;

  wallVerts[o3] = ax; wallVerts[o3+1] = az; wallVerts[o3+2] = botAy; wallVerts[o3+3] = 0; wallVerts[o3+4] = 0;
  wallVerts[o3+5] = nx; wallVerts[o3+6] = 0; wallVerts[o3+7] = nz;

  const b = vertBaseIdx;
  wallIndices[wallIdxOff]     = b;
  wallIndices[wallIdxOff + 1] = b + 1;
  wallIndices[wallIdxOff + 2] = b + 2;
  wallIndices[wallIdxOff + 3] = b;
  wallIndices[wallIdxOff + 4] = b + 2;
  wallIndices[wallIdxOff + 5] = b + 3;

  return { verts: 4, indices: 6 };
}

/**
 * Build island top + underside meshes from classify readback data + hex data.
 *
 * 9-phase algorithm:
 *   1. Build hex data lookup map
 *   2. Per-vertex classification from readback
 *   3. Solid quads (all 4 corners solid)
 *   4. Derive solid vertices (belong to >= 1 solid quad)
 *   5. Distance field + connected components
 *   6. Per-vertex Y computation (top + bottom)
 *   7. Write vertex buffers (8-float stride)
 *   8. Write index buffers
 *   9. Wall quads + combine into underside mesh
 */
export function buildIslandMesh(
  readback: IslandReadbackData,
  hexes: HexData[],
  grid: TerrainGridData,
  hexSize: number,
  params: IslandRenderParams,
): IslandMeshResult | null {
  const { positions, elevations, moistures, cols, rows, originX, originZ, spacing, cullRadius2 } = grid;
  const { seaLevel, landRange, heightScale } = params;
  const { solid: readbackSolid } = readback;
  const totalVerts = cols * rows;
  const quadCols = cols - 1;
  const quadRows = rows - 1;
  const totalQuads = quadCols * quadRows;

  // ================================================================
  // Phase 1: Build hex data lookup map for CPU hex queries
  // ================================================================
  const hexMap = new Map<string, { intensity: number; lift: number; frag: number }>();
  const AIR: PlanarAlignment = 'Plane of Air' as PlanarAlignment;
  for (let i = 0; i < hexes.length; i++) {
    const h = hexes[i]!;
    if (h.planarAlignment !== AIR) continue;
    const key = `${h.coordinates.q},${h.coordinates.r}`;
    hexMap.set(key, {
      intensity: h.planarIntensity,
      lift: h.planarLift,
      frag: h.planarFragmentation,
    });
  }

  // ================================================================
  // Phase 2: Per-vertex classification from readback + cull radius
  // ================================================================
  const vertIsland = new Uint8Array(totalVerts);
  const vertIntensity = new Float32Array(totalVerts);
  const vertLift = new Float32Array(totalVerts);

  for (let i = 0; i < totalVerts; i++) {
    if (!readbackSolid[i]) continue;
    const x = positions[i * 2]!;
    const z = positions[i * 2 + 1]!;
    if (x * x + z * z > cullRadius2) continue;

    // Look up hex to get per-hex Air overlay params
    const hex = pixelToHex(x, z, hexSize);
    const hexData = hexMap.get(`${hex.q},${hex.r}`);
    if (!hexData) continue;

    vertIsland[i] = 1;
    vertIntensity[i] = hexData.intensity;
    vertLift[i] = hexData.lift;
  }

  // ================================================================
  // Phase 3: Solid quads — quad is solid iff all 4 corners are island vertices
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
  // Phase 4: Derive solid vertices — only vertices belonging to >= 1 solid quad
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
  // Phase 5: Distance field + connected components for cone depth scaling
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
  // Phase 6: Per-vertex Y computation (top + bottom)
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
    const pi = vertIntensity[i]!;
    const smoothedY = applyAirSmoothing(baseY, heightScale, pi);

    // Per-chunk altitude variation (matches VS)
    const x = positions[i * 2]!;
    const z = positions[i * 2 + 1]!;
    const chunkAlt = simpleNoise(x * PLANAR.AIR.ALT_VARIATION_FREQ, z * PLANAR.AIR.ALT_VARIATION_FREQ);
    const altMul = 0.8 + chunkAlt * 0.4;
    const liftHeight = vertLift[i]! * PLANAR.AIR.MAX_LIFT_FRACTION * heightScale * altMul;
    const topY = smoothedY + liftHeight;
    topYGrid[i] = topY;

    // Cone depth from distance field
    const d = depth[i]!;
    const envelope = d; // linear cone: 0 at edge, 1 at center

    const comp = componentOf[i]!;
    const tScale = comp >= 0 ? compThicknessScale[comp]! : 1;
    const baseThick = BASE_THICKNESS * envelope * heightScale * tScale;
    const stalactite = stalactiteNoise(x, z) * STALACTITE_AMP * envelope * heightScale * tScale;

    bottomYGrid[i] = topY - baseThick - stalactite;
  }

  // ================================================================
  // Phase 7: Write vertex buffers (8-float island stride)
  // ================================================================
  const topVertices = new Float32Array(vertCount * ISLAND_VERTEX_STRIDE);
  const bottomVertices = new Float32Array(vertCount * ISLAND_VERTEX_STRIDE);
  const invSpacing2 = 1 / (2 * spacing);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      const vi = gridToVert[idx]!;
      if (vi < 0) continue;

      const x = positions[idx * 2]!;
      const z = positions[idx * 2 + 1]!;
      const elev = elevations[idx]!;
      const moist = moistures[idx]!;

      const leftIdx = col > 0 ? idx - 1 : idx;
      const rightIdx = col < cols - 1 ? idx + 1 : idx;
      const upIdx = row > 0 ? idx - cols : idx;
      const downIdx = row < rows - 1 ? idx + cols : idx;

      // Top normals from topY grid
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

      // Top: [x, z, topY, elevation, moisture, nx, ny, nz]
      const topOff = vi * ISLAND_VERTEX_STRIDE;
      topVertices[topOff]     = x;
      topVertices[topOff + 1] = z;
      topVertices[topOff + 2] = topY;
      topVertices[topOff + 3] = elev;
      topVertices[topOff + 4] = moist;
      topVertices[topOff + 5] = tnx;
      topVertices[topOff + 6] = tny;
      topVertices[topOff + 7] = tnz;

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

      // Bottom: [x, z, bottomY, 0, 0, bnx, bny, bnz] — elev/moisture=0 for underside
      const botOff = vi * ISLAND_VERTEX_STRIDE;
      bottomVertices[botOff]     = x;
      bottomVertices[botOff + 1] = z;
      bottomVertices[botOff + 2] = bottomY;
      bottomVertices[botOff + 3] = 0;
      bottomVertices[botOff + 4] = 0;
      bottomVertices[botOff + 5] = bnx;
      bottomVertices[botOff + 6] = bny;
      bottomVertices[botOff + 7] = bnz;
    }
  }

  // ================================================================
  // Phase 8: Index buffers — derived from solid quads, top=CCW, bottom=reversed
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
  // Phase 9: Wall quads (boundary edges) + combine into underside mesh
  // ================================================================

  function isQuadSolid(qr: number, qc: number): boolean {
    if (qr < 0 || qr >= quadRows || qc < 0 || qc >= quadCols) return false;
    return solidQuad[qr * quadCols + qc] === 1;
  }

  // Count boundary edges for allocation
  let boundaryEdgeCount = 0;
  for (let qr = 0; qr < quadRows; qr++) {
    for (let qc = 0; qc < quadCols; qc++) {
      if (!isQuadSolid(qr, qc)) continue;
      if (!isQuadSolid(qr - 1, qc)) boundaryEdgeCount++;
      if (!isQuadSolid(qr + 1, qc)) boundaryEdgeCount++;
      if (!isQuadSolid(qr, qc - 1)) boundaryEdgeCount++;
      if (!isQuadSolid(qr, qc + 1)) boundaryEdgeCount++;
    }
  }

  const maxWallVerts = boundaryEdgeCount * 4;
  const maxWallIndices = boundaryEdgeCount * 6;
  const wallVerts = new Float32Array(maxWallVerts * ISLAND_VERTEX_STRIDE);
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
          outsideX, outsideZ,
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
          outsideX, outsideZ,
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
          outsideX, outsideZ,
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
          outsideX, outsideZ,
        );
        wallVertCount += r.verts;
        wallIdxCount += r.indices;
      }
    }
  }

  // Combine underside (bottom surface + walls) into one mesh
  const totalUnderVerts = vertCount + wallVertCount;
  const totalUnderIndices = botIdxCount + wallIdxCount;
  const combinedUnderVerts = new Float32Array(totalUnderVerts * ISLAND_VERTEX_STRIDE);
  combinedUnderVerts.set(bottomVertices.subarray(0, vertCount * ISLAND_VERTEX_STRIDE));
  combinedUnderVerts.set(
    wallVerts.subarray(0, wallVertCount * ISLAND_VERTEX_STRIDE),
    vertCount * ISLAND_VERTEX_STRIDE,
  );

  const combinedUnderIndices = new Uint32Array(totalUnderIndices);
  combinedUnderIndices.set(bottomIndices.subarray(0, botIdxCount));
  combinedUnderIndices.set(wallIndices.subarray(0, wallIdxCount), botIdxCount);

  return {
    top: {
      vertices: topVertices.subarray(0, vertCount * ISLAND_VERTEX_STRIDE),
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
