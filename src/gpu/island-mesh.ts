import { MESH_VERTEX_STRIDE } from './types';
import { computeDisplacedY } from './terrain-mesh';
import type { MeshBuffers, TerrainGridData } from './terrain-mesh';

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

/**
 * Multi-octave stalactite profile noise.
 * Returns 0-1 where peaks represent stalactite tips hanging down.
 * Squared big octave creates sharp downward protrusions.
 */
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
const BASE_THICKNESS = 0.012;    // Fraction of heightScale — max envelope depth at island center
const STALACTITE_AMP = 0.008;    // Fraction of heightScale — stalactite protrusion depth

// Must match terrain-mesh.ts displacementCurve (also in VS)
function displacementCurve(h: number): number {
  return h * h * h;
}

// Replicate VS Air island-layer smoothing: y = mix(y, median_y, pi² * 0.6)
// Intensity² ensures smooth fade at overlay boundary edges.
function applyAirSmoothing(y: number, heightScale: number, pi: number): number {
  const smoothT = pi * pi;
  const medianY = displacementCurve(0.35) * heightScale;
  return y + (medianY - y) * smoothT * 0.6;
}

/**
 * Two-pass distance transform on a grid.
 * Returns approximate distance (in grid cells) from each island vertex
 * to the nearest non-island boundary. Non-island vertices get 0.
 */
function computeDistanceField(
  isIsland: Uint8Array,
  cols: number,
  rows: number,
): Float32Array {
  const total = cols * rows;
  const dist = new Float32Array(total);
  const INF = cols + rows;

  // Initialize: island = INF, non-island = 0
  for (let i = 0; i < total; i++) {
    dist[i] = isIsland[i] ? INF : 0;
  }

  // Forward pass: top-left to bottom-right
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      if (!isIsland[idx]) continue;
      if (col > 0) dist[idx] = Math.min(dist[idx]!, dist[idx - 1]! + 1);
      if (row > 0) dist[idx] = Math.min(dist[idx]!, dist[idx - cols]! + 1);
    }
  }

  // Backward pass: bottom-right to top-left
  for (let row = rows - 1; row >= 0; row--) {
    for (let col = cols - 1; col >= 0; col--) {
      const idx = row * cols + col;
      if (!isIsland[idx]) continue;
      if (col < cols - 1) dist[idx] = Math.min(dist[idx]!, dist[idx + 1]! + 1);
      if (row < rows - 1) dist[idx] = Math.min(dist[idx]!, dist[idx + cols]! + 1);
    }
  }

  return dist;
}

/**
 * Flood-fill connected components. Returns component ID per vertex (-1 for non-island)
 * and max distance per component (for normalizing depth).
 */
function computeComponents(
  isIsland: Uint8Array,
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
    if (!isIsland[i] || componentOf[i] !== -1) continue;

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
      const neighbors = [
        col > 0 ? idx - 1 : -1,
        col < cols - 1 ? idx + 1 : -1,
        row > 0 ? idx - cols : -1,
        row < rows - 1 ? idx + cols : -1,
      ];
      for (const n of neighbors) {
        if (n >= 0 && isIsland[n] && componentOf[n] === -1) {
          componentOf[n] = id;
          queue.push(n);
        }
      }
    }

    maxDist.push(compMax);
  }

  return { componentOf, maxDist };
}

export function buildIslandMesh(
  classifyData: Float32Array,
  grid: TerrainGridData,
  params: IslandRenderParams,
): IslandMeshResult | null {
  const { positions, elevations, moistures, cols, rows, originX, originZ, spacing, cullRadius2 } = grid;
  const { seaLevel, landRange, heightScale } = params;
  const totalVerts = cols * rows;

  // --- Step 1: Classify vertices ---
  const isIsland = new Uint8Array(totalVerts);
  let islandCount = 0;
  for (let i = 0; i < totalVerts; i++) {
    const x = positions[i * 2]!;
    const z = positions[i * 2 + 1]!;
    if (x * x + z * z > cullRadius2) continue;
    if (classifyData[i * 4]! > 0.5) {
      isIsland[i] = 1;
      islandCount++;
    }
  }

  if (islandCount === 0) {
    return null;
  }

  // --- Step 2: Distance transform + connected components ---
  // Each vertex gets a normalized depth (0 at boundary, 1 at deepest interior)
  // that reflects the actual contiguous mass shape.
  const distField = computeDistanceField(isIsland, cols, rows);
  const { componentOf, maxDist } = computeComponents(isIsland, distField, cols, rows);

  // Normalized depth per vertex: 0 at edge, 1 at center of component
  const depth = new Float32Array(totalVerts);
  for (let i = 0; i < totalVerts; i++) {
    const comp = componentOf[i]!;
    if (comp < 0) continue;
    const md = maxDist[comp]!;
    depth[i] = md > 0 ? distField[i]! / md : 0;
  }

  // Per-component thickness scale: depth cannot exceed the island's width.
  // maxDist is in grid cells; world-space width ≈ 2 * maxDist * spacing.
  const maxUncappedDepth = (BASE_THICKNESS + STALACTITE_AMP) * heightScale;
  const compThicknessScale = maxDist.map(md => {
    const worldWidth = 2 * md * spacing;
    return maxUncappedDepth > 0 ? Math.min(1, worldWidth / maxUncappedDepth) : 1;
  });

  // --- Step 3: Build vertex + index arrays ---
  const gridToTop = new Int32Array(totalVerts);
  gridToTop.fill(-1);
  let topVertCount = 0;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      if (isIsland[idx]) {
        gridToTop[idx] = topVertCount++;
      }
    }
  }

  const topVertices = new Float32Array(topVertCount * MESH_VERTEX_STRIDE);
  const bottomVertices = new Float32Array(topVertCount * MESH_VERTEX_STRIDE);
  const invSpacing2 = 1 / (2 * spacing);

  // --- Step 4: Fill top and bottom vertex data ---
  const topYGrid = new Float32Array(totalVerts);
  const bottomYGrid = new Float32Array(totalVerts);

  for (let i = 0; i < totalVerts; i++) {
    if (!isIsland[i]) continue;

    const elev = elevations[i]!;
    const baseY = computeDisplacedY(elev, seaLevel, landRange, heightScale);
    const pi = classifyData[i * 4 + 2]!; // planar_intensity
    const smoothedY = applyAirSmoothing(baseY, heightScale, pi);
    const liftHeight = classifyData[i * 4 + 1]!;
    const topY = smoothedY + liftHeight;
    topYGrid[i] = topY;

    // Underside: taper envelope from component-aware distance field.
    // depth^1.5 gives steeper taper at edges, wider plateau in center.
    const d = depth[i]!;
    const envelope = d * Math.sqrt(d); // d^1.5

    // Per-component scale: cap depth so island can't be taller than it is wide
    const comp = componentOf[i]!;
    const tScale = comp >= 0 ? compThicknessScale[comp]! : 1;
    const baseThick = BASE_THICKNESS * envelope * heightScale * tScale;

    // Stalactite protrusions — modulated by envelope so they only
    // appear in the interior, not at thin edges.
    const x = positions[i * 2]!;
    const z = positions[i * 2 + 1]!;
    const stalactite = stalactiteNoise(x, z) * STALACTITE_AMP * envelope * heightScale * tScale;

    const bottomY = topY - baseThick - stalactite;
    bottomYGrid[i] = bottomY;
  }

  // Write vertex data with normals
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      const vi = gridToTop[idx]!;
      if (vi < 0) continue;

      const x = positions[idx * 2]!;
      const z = positions[idx * 2 + 1]!;
      const elev = elevations[idx]!;
      const moist = moistures[idx]!;

      // Top normals: central differences using island-neighbor elevations
      const leftIdx = col > 0 ? idx - 1 : idx;
      const rightIdx = col < cols - 1 ? idx + 1 : idx;
      const upIdx = row > 0 ? idx - cols : idx;
      const downIdx = row < rows - 1 ? idx + cols : idx;

      const topY = topYGrid[idx]!;
      const topLeft = isIsland[leftIdx] ? topYGrid[leftIdx]! : topY;
      const topRight = isIsland[rightIdx] ? topYGrid[rightIdx]! : topY;
      const topUp = isIsland[upIdx] ? topYGrid[upIdx]! : topY;
      const topDown = isIsland[downIdx] ? topYGrid[downIdx]! : topY;

      const tdydx = (topRight - topLeft) * invSpacing2;
      const tdydz = (topDown - topUp) * invSpacing2;
      let tnx = -tdydx;
      let tny = 1;
      let tnz = -tdydz;
      const tlen = Math.sqrt(tnx * tnx + tny * tny + tnz * tnz);
      tnx /= tlen; tny /= tlen; tnz /= tlen;

      const topOff = vi * MESH_VERTEX_STRIDE;
      topVertices[topOff] = x;
      topVertices[topOff + 1] = z;
      topVertices[topOff + 2] = elev;     // raw elevation — VS applies displacement + lift
      topVertices[topOff + 3] = moist;
      topVertices[topOff + 4] = tnx;
      topVertices[topOff + 5] = tny;
      topVertices[topOff + 6] = tnz;

      // Bottom normals: central differences on bottomY grid (normals face downward)
      const bottomY = bottomYGrid[idx]!;
      const bLeft = isIsland[leftIdx] ? bottomYGrid[leftIdx]! : bottomY;
      const bRight = isIsland[rightIdx] ? bottomYGrid[rightIdx]! : bottomY;
      const bUp = isIsland[upIdx] ? bottomYGrid[upIdx]! : bottomY;
      const bDown = isIsland[downIdx] ? bottomYGrid[downIdx]! : bottomY;

      const bdydx = (bRight - bLeft) * invSpacing2;
      const bdydz = (bDown - bUp) * invSpacing2;
      // Flip normal to face downward
      let bnx = bdydx;
      let bny = -1;
      let bnz = bdydz;
      const blen = Math.sqrt(bnx * bnx + bny * bny + bnz * bnz);
      bnx /= blen; bny /= blen; bnz /= blen;

      // Underside: elevation field stores normalized world Y for VS direct usage
      const bottomOff = vi * MESH_VERTEX_STRIDE;
      bottomVertices[bottomOff] = x;
      bottomVertices[bottomOff + 1] = z;
      bottomVertices[bottomOff + 2] = bottomY / heightScale;  // VS will do: y = elevation * hs
      bottomVertices[bottomOff + 3] = 0;  // moisture=0 signals "underside"
      bottomVertices[bottomOff + 4] = bnx;
      bottomVertices[bottomOff + 5] = bny;
      bottomVertices[bottomOff + 6] = bnz;
    }
  }

  // --- Step 5: Index buffers ---
  const maxQuads = (cols - 1) * (rows - 1);
  const topIndices = new Uint32Array(maxQuads * 6);
  const underIndices = new Uint32Array(maxQuads * 6 + islandCount * 24); // extra for side walls
  let topIdxCount = 0;
  let underIdxCount = 0;

  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols - 1; col++) {
      const g00 = row * cols + col;
      const g10 = g00 + 1;
      const g01 = (row + 1) * cols + col;
      const g11 = g01 + 1;

      // Only emit quads where ALL 4 vertices are island
      if (!isIsland[g00] || !isIsland[g10] || !isIsland[g01] || !isIsland[g11]) continue;

      const v00 = gridToTop[g00]!;
      const v10 = gridToTop[g10]!;
      const v01 = gridToTop[g01]!;
      const v11 = gridToTop[g11]!;

      // Top surface: CCW winding (same as terrain)
      topIndices[topIdxCount++] = v00;
      topIndices[topIdxCount++] = v01;
      topIndices[topIdxCount++] = v10;
      topIndices[topIdxCount++] = v10;
      topIndices[topIdxCount++] = v01;
      topIndices[topIdxCount++] = v11;

      // Bottom surface: CW winding (reversed) so triangles face downward
      underIndices[underIdxCount++] = v00;
      underIndices[underIdxCount++] = v10;
      underIndices[underIdxCount++] = v01;
      underIndices[underIdxCount++] = v10;
      underIndices[underIdxCount++] = v11;
      underIndices[underIdxCount++] = v01;
    }
  }

  // --- Step 6: Side walls ---
  // For each grid edge where both vertices are island but at least one adjacent
  // quad has a non-island vertex, emit a wall quad connecting top and bottom.
  // Wall vertices need their own normals (outward-facing), so we append them.

  let wallVertCount = 0;
  const maxWallVerts = islandCount * 16;
  const wallVertices = new Float32Array(maxWallVerts * MESH_VERTEX_STRIDE);

  function addWallQuad(
    aIdx: number, bIdx: number,
    outsideX: number, outsideZ: number,
  ): void {
    const ax = positions[aIdx * 2]!;
    const az = positions[aIdx * 2 + 1]!;
    const bx = positions[bIdx * 2]!;
    const bz = positions[bIdx * 2 + 1]!;

    const topAy = topYGrid[aIdx]!;
    const topBy = topYGrid[bIdx]!;
    const botAy = bottomYGrid[aIdx]!;
    const botBy = bottomYGrid[bIdx]!;

    // Edge direction
    const edx = bx - ax;
    const edz = bz - az;
    // Normal perpendicular to edge, pointing toward outside
    let nx = -edz;
    let nz = edx;
    const midX = (ax + bx) * 0.5;
    const midZ = (az + bz) * 0.5;
    if (nx * (outsideX - midX) + nz * (outsideZ - midZ) < 0) {
      nx = -nx;
      nz = -nz;
    }
    const nlen = Math.sqrt(nx * nx + nz * nz);
    if (nlen < 0.001) return;
    nx /= nlen;
    nz /= nlen;

    const baseIdx = topVertCount + wallVertCount;
    const wOff0 = wallVertCount * MESH_VERTEX_STRIDE;
    const wOff1 = (wallVertCount + 1) * MESH_VERTEX_STRIDE;
    const wOff2 = (wallVertCount + 2) * MESH_VERTEX_STRIDE;
    const wOff3 = (wallVertCount + 3) * MESH_VERTEX_STRIDE;

    // topA
    wallVertices[wOff0] = ax; wallVertices[wOff0 + 1] = az;
    wallVertices[wOff0 + 2] = topAy / heightScale;
    wallVertices[wOff0 + 3] = 0;
    wallVertices[wOff0 + 4] = nx; wallVertices[wOff0 + 5] = 0; wallVertices[wOff0 + 6] = nz;

    // topB
    wallVertices[wOff1] = bx; wallVertices[wOff1 + 1] = bz;
    wallVertices[wOff1 + 2] = topBy / heightScale;
    wallVertices[wOff1 + 3] = 0;
    wallVertices[wOff1 + 4] = nx; wallVertices[wOff1 + 5] = 0; wallVertices[wOff1 + 6] = nz;

    // botB
    wallVertices[wOff2] = bx; wallVertices[wOff2 + 1] = bz;
    wallVertices[wOff2 + 2] = botBy / heightScale;
    wallVertices[wOff2 + 3] = 0;
    wallVertices[wOff2 + 4] = nx; wallVertices[wOff2 + 5] = 0; wallVertices[wOff2 + 6] = nz;

    // botA
    wallVertices[wOff3] = ax; wallVertices[wOff3 + 1] = az;
    wallVertices[wOff3 + 2] = botAy / heightScale;
    wallVertices[wOff3 + 3] = 0;
    wallVertices[wOff3 + 4] = nx; wallVertices[wOff3 + 5] = 0; wallVertices[wOff3 + 6] = nz;

    // Two triangles: topA, topB, botB and topA, botB, botA (outward facing)
    underIndices[underIdxCount++] = baseIdx;
    underIndices[underIdxCount++] = baseIdx + 1;
    underIndices[underIdxCount++] = baseIdx + 2;
    underIndices[underIdxCount++] = baseIdx;
    underIndices[underIdxCount++] = baseIdx + 2;
    underIndices[underIdxCount++] = baseIdx + 3;

    wallVertCount += 4;
  }

  // Scan horizontal edges (row-direction: g00→g10)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols - 1; col++) {
      const g0 = row * cols + col;
      const g1 = g0 + 1;
      if (!isIsland[g0] || !isIsland[g1]) continue;

      const aboveHasGap = row === 0 ||
        !isIsland[(row - 1) * cols + col] ||
        !isIsland[(row - 1) * cols + col + 1];
      const belowHasGap = row === rows - 1 ||
        !isIsland[(row + 1) * cols + col] ||
        !isIsland[(row + 1) * cols + col + 1];

      if (aboveHasGap) {
        const outsideZ = originZ + (row - 1) * spacing;
        const outsideX = positions[g0 * 2]!;
        addWallQuad(g1, g0, outsideX, outsideZ);
      }
      if (belowHasGap) {
        const outsideZ = originZ + (row + 1) * spacing;
        const outsideX = positions[g0 * 2]!;
        addWallQuad(g0, g1, outsideX, outsideZ);
      }
    }
  }

  // Scan vertical edges (col-direction: g00→g01)
  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols; col++) {
      const g0 = row * cols + col;
      const g1 = (row + 1) * cols + col;
      if (!isIsland[g0] || !isIsland[g1]) continue;

      const leftHasGap = col === 0 ||
        !isIsland[row * cols + col - 1] ||
        !isIsland[(row + 1) * cols + col - 1];
      const rightHasGap = col === cols - 1 ||
        !isIsland[row * cols + col + 1] ||
        !isIsland[(row + 1) * cols + col + 1];

      if (leftHasGap) {
        const outsideX = originX + (col - 1) * spacing;
        const outsideZ = positions[g0 * 2 + 1]!;
        addWallQuad(g0, g1, outsideX, outsideZ);
      }
      if (rightHasGap) {
        const outsideX = originX + (col + 1) * spacing;
        const outsideZ = positions[g0 * 2 + 1]!;
        addWallQuad(g1, g0, outsideX, outsideZ);
      }
    }
  }

  // --- Combine underside + wall vertices ---
  const totalUnderVerts = topVertCount + wallVertCount;
  const combinedUnderVerts = new Float32Array(totalUnderVerts * MESH_VERTEX_STRIDE);
  combinedUnderVerts.set(bottomVertices.subarray(0, topVertCount * MESH_VERTEX_STRIDE));
  combinedUnderVerts.set(
    wallVertices.subarray(0, wallVertCount * MESH_VERTEX_STRIDE),
    topVertCount * MESH_VERTEX_STRIDE,
  );

  return {
    top: {
      vertices: topVertices.subarray(0, topVertCount * MESH_VERTEX_STRIDE),
      indices: topIndices.subarray(0, topIdxCount),
      vertexCount: topVertCount,
      indexCount: topIdxCount,
    },
    underside: {
      vertices: combinedUnderVerts,
      indices: underIndices.subarray(0, underIdxCount),
      vertexCount: totalUnderVerts,
      indexCount: underIdxCount,
    },
  };
}
