import { MESH_VERTEX_STRIDE } from './types';

export interface ClipmapConfig {
  readonly rings: number;
  readonly baseSpacing: number;
  readonly baseExtent: number;
  readonly worldRadius: number;
}

export interface ClipmapRing {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly spacing: number;
  readonly level: number;
}

/**
 * Build concentric LOD rings around a center point. Each ring doubles the cell
 * spacing of the previous ring and covers double the extent. The innermost ring
 * is a full grid; outer rings are donuts (inner area excluded).
 *
 * Transition rows: the outermost row of each ring (except the last) has every
 * other vertex snapped to the coarser grid to prevent T-junction cracks.
 */
export function buildClipmapRings(
  config: ClipmapConfig,
  centerX: number,
  centerZ: number,
  sampleElevation: (x: number, z: number) => number,
  sampleMoisture: (x: number, z: number) => number,
): ClipmapRing[] {
  const { rings: ringCount, baseSpacing, baseExtent, worldRadius } = config;
  const cullRadius2 = worldRadius * worldRadius;
  const result: ClipmapRing[] = [];

  for (let level = 0; level < ringCount; level++) {
    const spacing = baseSpacing * (1 << level);
    const extent = baseExtent * (1 << level);

    // Inner exclusion zone: area covered by the previous (finer) ring
    const innerExtent = level > 0 ? baseExtent * (1 << (level - 1)) : 0;

    // Snap center to this ring's grid alignment
    const snappedCX = Math.round(centerX / spacing) * spacing;
    const snappedCZ = Math.round(centerZ / spacing) * spacing;

    // Grid bounds
    const halfCols = Math.ceil(extent / spacing);
    const cols = halfCols * 2 + 1;
    const rows = cols;

    // Determine which grid cells are inside this ring (outside inner, inside extent, inside world)
    const totalCells = cols * rows;
    const gridToVert = new Int32Array(totalCells);
    gridToVert.fill(-1);
    let vertCount = 0;

    // Outer boundary row flags for transition vertices
    const isOuterRow = new Uint8Array(totalCells);

    for (let row = 0; row < rows; row++) {
      const gz = (row - halfCols) * spacing + snappedCZ;
      for (let col = 0; col < cols; col++) {
        const gx = (col - halfCols) * spacing + snappedCX;

        // World radius culling
        if (gx * gx + gz * gz > cullRadius2) continue;

        // Inner exclusion (donut hole) — strict inequality so boundary belongs to finer ring
        const dx = Math.abs(gx - snappedCX);
        const dz = Math.abs(gz - snappedCZ);
        if (innerExtent > 0 && dx < innerExtent && dz < innerExtent) continue;

        // Mark outer boundary rows (for transition averaging)
        if (row === 0 || row === rows - 1 || col === 0 || col === cols - 1) {
          isOuterRow[row * cols + col] = 1;
        }

        gridToVert[row * cols + col] = vertCount++;
      }
    }

    if (vertCount === 0) {
      result.push({
        vertices: new Float32Array(0),
        indices: new Uint32Array(0),
        vertexCount: 0,
        indexCount: 0,
        spacing,
        level,
      });
      continue;
    }

    // Sample elevation and moisture, build vertex data
    const vertexData = new Float32Array(vertCount * MESH_VERTEX_STRIDE);
    let vIdx = 0;

    // Store per-grid-cell elevation for normal computation
    const elevations = new Float32Array(totalCells);
    const positions = new Float32Array(totalCells * 2);

    for (let row = 0; row < rows; row++) {
      const gz = (row - halfCols) * spacing + snappedCZ;
      for (let col = 0; col < cols; col++) {
        const gx = (col - halfCols) * spacing + snappedCX;
        const cellIdx = row * cols + col;
        positions[cellIdx * 2] = gx;
        positions[cellIdx * 2 + 1] = gz;
        elevations[cellIdx] = sampleElevation(gx, gz);
      }
    }

    // Transition row averaging: for the outermost ring of vertices in ring N
    // (where N < ringCount-1), every other vertex's elevation is averaged from
    // its two coarser-grid neighbors to prevent T-junction cracks.
    if (level < ringCount - 1) {
      const coarserSpacing = spacing * 2;
      for (let row = 0; row < rows; row++) {
        const gz = (row - halfCols) * spacing + snappedCZ;
        for (let col = 0; col < cols; col++) {
          const cellIdx = row * cols + col;
          if (!isOuterRow[cellIdx]) continue;
          if (gridToVert[cellIdx]! < 0) continue;

          const gx = (col - halfCols) * spacing + snappedCX;

          // Check if this vertex falls between coarser grid lines
          const onCoarserX = Math.abs(gx - Math.round(gx / coarserSpacing) * coarserSpacing) < spacing * 0.1;
          const onCoarserZ = Math.abs(gz - Math.round(gz / coarserSpacing) * coarserSpacing) < spacing * 0.1;

          if (!onCoarserX && onCoarserZ) {
            // Interpolate X neighbors on the coarser grid
            const leftX = gx - spacing;
            const rightX = gx + spacing;
            const eLeft = sampleElevation(leftX, gz);
            const eRight = sampleElevation(rightX, gz);
            elevations[cellIdx] = (eLeft + eRight) * 0.5;
          } else if (onCoarserX && !onCoarserZ) {
            // Interpolate Z neighbors on the coarser grid
            const upZ = gz - spacing;
            const downZ = gz + spacing;
            const eUp = sampleElevation(gx, upZ);
            const eDown = sampleElevation(gx, downZ);
            elevations[cellIdx] = (eUp + eDown) * 0.5;
          } else if (!onCoarserX && !onCoarserZ) {
            // Corner case: average all four coarser neighbors
            const leftX = gx - spacing;
            const rightX = gx + spacing;
            const upZ = gz - spacing;
            const downZ = gz + spacing;
            elevations[cellIdx] = (
              sampleElevation(leftX, upZ) +
              sampleElevation(rightX, upZ) +
              sampleElevation(leftX, downZ) +
              sampleElevation(rightX, downZ)
            ) * 0.25;
          }
        }
      }
    }

    // Write vertex data with normals
    const invSpacing2 = 1 / (2 * spacing);
    for (let row = 0; row < rows; row++) {
      const gz = (row - halfCols) * spacing + snappedCZ;
      for (let col = 0; col < cols; col++) {
        const cellIdx = row * cols + col;
        if (gridToVert[cellIdx]! < 0) continue;

        const gx = (col - halfCols) * spacing + snappedCX;
        const elev = elevations[cellIdx]!;
        const moisture = sampleMoisture(gx, gz);

        // Central-difference normals from elevation grid
        const leftElev = col > 0 ? elevations[cellIdx - 1]! : elev;
        const rightElev = col < cols - 1 ? elevations[cellIdx + 1]! : elev;
        const upElev = row > 0 ? elevations[cellIdx - cols]! : elev;
        const downElev = row < rows - 1 ? elevations[cellIdx + cols]! : elev;

        const dydx = (rightElev - leftElev) * invSpacing2;
        const dydz = (downElev - upElev) * invSpacing2;
        let nx = -dydx;
        let ny = 1;
        let nz = -dydz;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx /= len;
        ny /= len;
        nz /= len;

        const off = vIdx * MESH_VERTEX_STRIDE;
        vertexData[off] = gx;
        vertexData[off + 1] = gz;
        vertexData[off + 2] = elev;
        vertexData[off + 3] = moisture;
        vertexData[off + 4] = nx;
        vertexData[off + 5] = ny;
        vertexData[off + 6] = nz;
        vIdx++;
      }
    }

    // Build index buffer
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

    result.push({
      vertices: vertexData.subarray(0, vertCount * MESH_VERTEX_STRIDE),
      indices: indexData.subarray(0, idxCount),
      vertexCount: vertCount,
      indexCount: idxCount,
      spacing,
      level,
    });
  }

  return result;
}
