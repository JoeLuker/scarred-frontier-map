/**
 * Generic marching squares isoband extraction on a rectangular grid.
 *
 * Given a binary solid mask and a continuous scalar field, extracts
 * the isoband boundary at threshold 0.5:
 *   - Edge crossings: interpolated positions where the field crosses 0.5
 *   - Cell cases: 16 standard + 2 saddle variants per grid cell
 *   - Vertex index assignment: compact numbering for grid corners + edge crossings
 *
 * Zero domain dependencies — pure algorithms operating on typed arrays.
 *
 * Local vertex IDs per cell:
 *   0 = TL (g00)      1 = TR (g10)
 *   3 = BL (g01)      2 = BR (g11)
 *   4 = E_top          5 = E_right
 *   7 = E_left         6 = E_bottom
 */

// ============================================================
// Triangulation lookup tables
// ============================================================

/**
 * Triangle lists per case (CCW winding for +Y upward normals).
 * Cases 5, 10 are ambiguous saddle points; index 16/17 = connected variant.
 */
export const MS_TRIS: readonly (readonly number[])[] = [
  [],                                     // 0: empty
  [0, 7, 4],                             // 1: TL only
  [1, 4, 5],                             // 2: TR only
  [0, 7, 5, 0, 5, 1],                    // 3: TL+TR
  [2, 5, 6],                             // 4: BR only
  [0, 7, 4, 2, 5, 6],                    // 5: TL+BR disconnected
  [1, 4, 6, 1, 6, 2],                    // 6: TR+BR
  [0, 7, 6, 0, 6, 2, 0, 2, 1],          // 7: TL+TR+BR
  [3, 6, 7],                             // 8: BL only
  [0, 3, 6, 0, 6, 4],                    // 9: TL+BL
  [3, 6, 7, 1, 4, 5],                    // 10: TR+BL disconnected
  [0, 3, 6, 0, 6, 5, 0, 5, 1],          // 11: TL+TR+BL
  [3, 2, 5, 3, 5, 7],                    // 12: BR+BL
  [0, 3, 2, 0, 2, 5, 0, 5, 4],          // 13: TL+BR+BL
  [3, 2, 1, 3, 1, 4, 3, 4, 7],          // 14: TR+BR+BL
  [0, 3, 2, 0, 2, 1],                    // 15: all solid
  [0, 7, 6, 0, 6, 2, 0, 2, 5, 0, 5, 4], // 16: TL+BR connected saddle
  [3, 6, 5, 3, 5, 1, 3, 1, 4, 3, 4, 7], // 17: TR+BL connected saddle
];

/**
 * Contour segments per case: pairs of edge-crossing IDs (4-7).
 * Each pair generates one wall quad connecting top and bottom surfaces.
 */
export const MS_WALLS: readonly (readonly number[])[] = [
  [],           // 0
  [4, 7],       // 1
  [4, 5],       // 2
  [7, 5],       // 3
  [5, 6],       // 4
  [4, 7, 5, 6], // 5 disc
  [4, 6],       // 6
  [7, 6],       // 7
  [7, 6],       // 8
  [4, 6],       // 9
  [4, 5, 7, 6], // 10 disc
  [5, 6],       // 11
  [7, 5],       // 12
  [4, 5],       // 13
  [4, 7],       // 14
  [],           // 15
  [4, 5, 7, 6], // 16 (5 conn)
  [4, 7, 5, 6], // 17 (10 conn)
];

// ============================================================
// Result interface
// ============================================================

export interface IsobandResult {
  /** Grid vertex index → compact mesh vertex index (-1 if unused). */
  readonly gridToVert: Int32Array;
  /** Horizontal edge index → mesh vertex index (-1 if no crossing). */
  readonly hEdgeToVert: Int32Array;
  /** Vertical edge index → mesh vertex index (-1 if no crossing). */
  readonly vEdgeToVert: Int32Array;
  /** Interpolation parameter (0-1) per horizontal edge crossing. */
  readonly hCrossT: Float32Array;
  /** Interpolation parameter (0-1) per vertical edge crossing. */
  readonly vCrossT: Float32Array;
  /** Which grid vertices are used in the triangulation. */
  readonly vertUsed: Uint8Array;
  /** Case index (0-17) per grid cell. */
  readonly cellCases: Uint8Array;

  readonly numGridCorners: number;
  readonly totalMeshVerts: number;
  readonly totalTriIndices: number;
  readonly totalContourSegments: number;
}

// ============================================================
// Extraction
// ============================================================

/**
 * Extract isoband from a 2D scalar field on a rectangular grid.
 *
 * @param solid   Binary classification per vertex (0 or 1).
 * @param field   Continuous scalar field per vertex (used for boundary interpolation).
 * @param cols    Grid columns.
 * @param rows    Grid rows.
 * @returns Isoband result, or null if no non-empty cells.
 */
export function extractIsoband(
  solid: Uint8Array,
  field: Float32Array,
  cols: number,
  rows: number,
): IsobandResult | null {
  const totalVerts = cols * rows;
  const quadCols = cols - 1;
  const quadRows = rows - 1;
  const hEdgeCols = quadCols;
  const hEdgeTotal = rows * hEdgeCols;
  const vEdgeTotal = quadRows * cols;

  // --- Edge crossings: interpolate where field = 0.5 ---

  const hCrossT = new Float32Array(hEdgeTotal);
  const hHasCross = new Uint8Array(hEdgeTotal);
  const vCrossT = new Float32Array(vEdgeTotal);
  const vHasCross = new Uint8Array(vEdgeTotal);

  // Horizontal edges
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < hEdgeCols; col++) {
      const eIdx = row * hEdgeCols + col;
      const i0 = row * cols + col;
      const i1 = i0 + 1;
      if (solid[i0] === solid[i1]) continue;

      // When solid differs, we MUST create a crossing. If the field values
      // are too close to interpolate (e.g. both 1.0 at a cull boundary),
      // use midpoint as safe fallback.
      const n0 = field[i0]!;
      const n1 = field[i1]!;
      const denom = n1 - n0;
      hCrossT[eIdx] = Math.abs(denom) < 1e-7
        ? 0.5
        : Math.max(0, Math.min(1, (0.5 - n0) / denom));
      hHasCross[eIdx] = 1;
    }
  }

  // Vertical edges
  for (let row = 0; row < quadRows; row++) {
    for (let col = 0; col < cols; col++) {
      const eIdx = row * cols + col;
      const i0 = row * cols + col;
      const i1 = i0 + cols;
      if (solid[i0] === solid[i1]) continue;

      const n0 = field[i0]!;
      const n1 = field[i1]!;
      const denom = n1 - n0;
      vCrossT[eIdx] = Math.abs(denom) < 1e-7
        ? 0.5
        : Math.max(0, Math.min(1, (0.5 - n0) / denom));
      vHasCross[eIdx] = 1;
    }
  }

  // --- Cell case classification ---

  const cellCases = new Uint8Array(quadCols * quadRows);
  let totalTriIndices = 0;
  let totalContourSegments = 0;
  let numNonEmptyCells = 0;

  for (let qr = 0; qr < quadRows; qr++) {
    for (let qc = 0; qc < quadCols; qc++) {
      const g00 = qr * cols + qc;
      const c = (solid[g00] ? 1 : 0)
              | (solid[g00 + 1] ? 2 : 0)
              | (solid[g00 + cols + 1] ? 4 : 0)
              | (solid[g00 + cols] ? 8 : 0);

      // Saddle disambiguation: if center noise average > 0.5, connect diagonals
      let caseIdx = c;
      if (c === 5 || c === 10) {
        const avg = (field[g00]! + field[g00 + 1]!
                   + field[g00 + cols]! + field[g00 + cols + 1]!) * 0.25;
        if (avg > 0.5) caseIdx = c === 5 ? 16 : 17;
      }

      cellCases[qr * quadCols + qc] = caseIdx;
      if (caseIdx !== 0) {
        numNonEmptyCells++;
        totalTriIndices += MS_TRIS[caseIdx]!.length;
        totalContourSegments += MS_WALLS[caseIdx]!.length >> 1;
      }
    }
  }

  if (numNonEmptyCells === 0) return null;

  // --- Mark used grid corners + assign vertex indices ---

  const vertUsed = new Uint8Array(totalVerts);

  for (let qr = 0; qr < quadRows; qr++) {
    for (let qc = 0; qc < quadCols; qc++) {
      const caseIdx = cellCases[qr * quadCols + qc]!;
      if (caseIdx === 0) continue;
      const g00 = qr * cols + qc;
      const tris = MS_TRIS[caseIdx]!;
      for (let i = 0; i < tris.length; i++) {
        const vid = tris[i]!;
        if (vid < 4) {
          const gi = vid === 0 ? g00 : vid === 1 ? g00 + 1 : vid === 2 ? g00 + cols + 1 : g00 + cols;
          vertUsed[gi] = 1;
        }
      }
    }
  }

  const gridToVert = new Int32Array(totalVerts);
  gridToVert.fill(-1);
  let numGridCorners = 0;
  for (let i = 0; i < totalVerts; i++) {
    if (vertUsed[i]) gridToVert[i] = numGridCorners++;
  }

  // Edge crossing indices follow grid corners
  const hEdgeToVert = new Int32Array(hEdgeTotal);
  hEdgeToVert.fill(-1);
  const vEdgeToVert = new Int32Array(vEdgeTotal);
  vEdgeToVert.fill(-1);

  let numEdgeVerts = 0;
  for (let i = 0; i < hEdgeTotal; i++) {
    if (hHasCross[i]) hEdgeToVert[i] = numGridCorners + numEdgeVerts++;
  }
  for (let i = 0; i < vEdgeTotal; i++) {
    if (vHasCross[i]) vEdgeToVert[i] = numGridCorners + numEdgeVerts++;
  }

  return {
    gridToVert,
    hEdgeToVert,
    vEdgeToVert,
    hCrossT,
    vCrossT,
    vertUsed,
    cellCases,
    numGridCorners,
    totalMeshVerts: numGridCorners + numEdgeVerts,
    totalTriIndices,
    totalContourSegments,
  };
}

// ============================================================
// Vertex resolution
// ============================================================

/**
 * Map a cell-local vertex ID (0-7) to a global mesh vertex index.
 *
 * @param iso    Isoband result from extractIsoband().
 * @param qr     Cell row.
 * @param qc     Cell column.
 * @param localId  0-3 = grid corners (TL,TR,BR,BL), 4-7 = edge crossings (top,right,bottom,left).
 * @param cols   Grid columns.
 */
export function resolveVert(
  iso: IsobandResult,
  qr: number, qc: number,
  localId: number,
  cols: number,
): number {
  const hEdgeCols = cols - 1;
  const g00 = qr * cols + qc;

  if (localId === 0) return iso.gridToVert[g00]!;
  if (localId === 1) return iso.gridToVert[g00 + 1]!;
  if (localId === 2) return iso.gridToVert[g00 + cols + 1]!;
  if (localId === 3) return iso.gridToVert[g00 + cols]!;
  if (localId === 4) return iso.hEdgeToVert[qr * hEdgeCols + qc]!;            // E_top
  if (localId === 5) return iso.vEdgeToVert[qr * cols + qc + 1]!;             // E_right
  if (localId === 6) return iso.hEdgeToVert[(qr + 1) * hEdgeCols + qc]!;      // E_bottom
  /* localId === 7 */ return iso.vEdgeToVert[qr * cols + qc]!;                 // E_left
}

/**
 * Get the edge array index and interpolation parameter for a cell-local edge crossing ID.
 *
 * @returns {edgeIdx, t, isHorizontal} — index into the crossing arrays + interpolation param.
 */
export function getCrossingInfo(
  iso: IsobandResult,
  qr: number, qc: number,
  localId: number,
  cols: number,
): { edgeIdx: number; t: number; isHorizontal: boolean } {
  const hEdgeCols = cols - 1;
  if (localId === 4) {
    const edgeIdx = qr * hEdgeCols + qc;
    return { edgeIdx, t: iso.hCrossT[edgeIdx]!, isHorizontal: true };
  }
  if (localId === 5) {
    const edgeIdx = qr * cols + qc + 1;
    return { edgeIdx, t: iso.vCrossT[edgeIdx]!, isHorizontal: false };
  }
  if (localId === 6) {
    const edgeIdx = (qr + 1) * hEdgeCols + qc;
    return { edgeIdx, t: iso.hCrossT[edgeIdx]!, isHorizontal: true };
  }
  // localId === 7
  const edgeIdx = qr * cols + qc;
  return { edgeIdx, t: iso.vCrossT[edgeIdx]!, isHorizontal: false };
}

/**
 * Get the two grid vertex indices for an edge crossing.
 *
 * @param localId  4=E_top, 5=E_right, 6=E_bottom, 7=E_left
 * @returns [i0, i1] — the two grid vertex indices the edge connects.
 */
export function getEdgeEndpoints(
  qr: number, qc: number,
  localId: number,
  cols: number,
): [number, number] {
  const g00 = qr * cols + qc;
  if (localId === 4) return [g00, g00 + 1];                     // top: TL → TR
  if (localId === 5) return [g00 + 1, g00 + cols + 1];          // right: TR → BR
  if (localId === 6) return [g00 + cols, g00 + cols + 1];       // bottom: BL → BR
  /* 7 */            return [g00, g00 + cols];                   // left: TL → BL
}
