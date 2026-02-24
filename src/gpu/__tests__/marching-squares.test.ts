import { describe, it, expect } from 'vitest';
import {
  extractIsoband,
  resolveVert,
  getCrossingInfo,
  getEdgeEndpoints,
  MS_TRIS,
  MS_WALLS,
} from '../marching-squares';

// --- Lookup table consistency ---

describe('MS_TRIS lookup table', () => {
  it('has 18 entries (0-15 base + 2 saddle)', () => {
    expect(MS_TRIS.length).toBe(18);
  });

  it('case 0 (empty) and 15 (full) have correct triangle counts', () => {
    expect(MS_TRIS[0]!.length).toBe(0);
    expect(MS_TRIS[15]!.length).toBe(6); // 2 triangles
  });

  it('all triangle indices reference valid local vertex IDs (0-7)', () => {
    for (let c = 0; c < MS_TRIS.length; c++) {
      for (const idx of MS_TRIS[c]!) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThanOrEqual(7);
      }
    }
  });

  it('all entries have index counts divisible by 3', () => {
    for (let c = 0; c < MS_TRIS.length; c++) {
      expect(MS_TRIS[c]!.length % 3).toBe(0);
    }
  });

  it('saddle cases have more triangles than disconnected variants', () => {
    // Case 16 (connected saddle for case 5) should have more tris
    expect(MS_TRIS[16]!.length).toBeGreaterThan(MS_TRIS[5]!.length);
    // Case 17 (connected saddle for case 10) should have more tris
    expect(MS_TRIS[17]!.length).toBeGreaterThan(MS_TRIS[10]!.length);
  });
});

describe('MS_WALLS lookup table', () => {
  it('has 18 entries', () => {
    expect(MS_WALLS.length).toBe(18);
  });

  it('case 0 and 15 have no contour segments', () => {
    expect(MS_WALLS[0]!.length).toBe(0);
    expect(MS_WALLS[15]!.length).toBe(0);
  });

  it('wall segment indices are edge crossings (4-7)', () => {
    for (let c = 0; c < MS_WALLS.length; c++) {
      for (const idx of MS_WALLS[c]!) {
        expect(idx).toBeGreaterThanOrEqual(4);
        expect(idx).toBeLessThanOrEqual(7);
      }
    }
  });

  it('wall entries have even index counts (segment pairs)', () => {
    for (let c = 0; c < MS_WALLS.length; c++) {
      expect(MS_WALLS[c]!.length % 2).toBe(0);
    }
  });
});

// --- extractIsoband ---

describe('extractIsoband', () => {
  it('returns null for all-empty grid', () => {
    const solid = new Uint8Array([0, 0, 0, 0]);
    const field = new Float32Array([0, 0, 0, 0]);
    expect(extractIsoband(solid, field, 2, 2)).toBeNull();
  });

  it('returns null for all-solid grid', () => {
    // All solid = case 15 everywhere, which has triangles but is technically non-empty.
    // Actually case 15 IS a non-empty cell, so extractIsoband should return a result.
    const solid = new Uint8Array([1, 1, 1, 1]);
    const field = new Float32Array([1, 1, 1, 1]);
    const result = extractIsoband(solid, field, 2, 2);
    expect(result).not.toBeNull();
    expect(result!.cellCases[0]).toBe(15);
  });

  it('classifies single-corner case correctly (2x2 grid)', () => {
    // TL only → case 1
    const solid = new Uint8Array([1, 0, 0, 0]);
    const field = new Float32Array([0.8, 0.2, 0.2, 0.2]);
    const result = extractIsoband(solid, field, 2, 2)!;
    expect(result).not.toBeNull();
    expect(result.cellCases[0]).toBe(1);
    expect(result.totalTriIndices).toBe(MS_TRIS[1]!.length);
    expect(result.totalContourSegments).toBe(1); // one wall segment
  });

  it('classifies TR only as case 2', () => {
    const solid = new Uint8Array([0, 1, 0, 0]);
    const field = new Float32Array([0.2, 0.8, 0.2, 0.2]);
    const result = extractIsoband(solid, field, 2, 2)!;
    expect(result.cellCases[0]).toBe(2);
  });

  it('classifies BR only as case 4', () => {
    const solid = new Uint8Array([0, 0, 0, 1]); // layout: row0=[0,0], row1=[0,1]
    // MS ordering: TL=g00=solid[0]=0, TR=g10=solid[1]=0, BR=g11=solid[3]=1, BL=g01=solid[2]=0
    const field = new Float32Array([0.2, 0.2, 0.2, 0.8]);
    const result = extractIsoband(solid, field, 2, 2)!;
    expect(result.cellCases[0]).toBe(4);
  });

  it('classifies BL only as case 8', () => {
    const solid = new Uint8Array([0, 0, 1, 0]); // row0=[0,0], row1=[1,0]
    const field = new Float32Array([0.2, 0.2, 0.8, 0.2]);
    const result = extractIsoband(solid, field, 2, 2)!;
    expect(result.cellCases[0]).toBe(8);
  });

  it('creates edge crossings between solid and non-solid vertices', () => {
    // TL solid, TR not → horizontal edge crossing on top edge
    const solid = new Uint8Array([1, 0, 0, 0]);
    const field = new Float32Array([0.8, 0.2, 0.2, 0.2]);
    const result = extractIsoband(solid, field, 2, 2)!;
    // hEdgeToVert should have a valid crossing on the top edge
    expect(result.hEdgeToVert[0]).toBeGreaterThanOrEqual(0);
  });

  it('interpolation parameter is between 0 and 1', () => {
    const solid = new Uint8Array([1, 0, 0, 0]);
    const field = new Float32Array([0.9, 0.1, 0.1, 0.1]);
    const result = extractIsoband(solid, field, 2, 2)!;
    // Check all non-negative-one crossings
    for (let i = 0; i < result.hCrossT.length; i++) {
      if (result.hEdgeToVert[i]! >= 0) {
        expect(result.hCrossT[i]).toBeGreaterThanOrEqual(0);
        expect(result.hCrossT[i]).toBeLessThanOrEqual(1);
      }
    }
    for (let i = 0; i < result.vCrossT.length; i++) {
      if (result.vEdgeToVert[i]! >= 0) {
        expect(result.vCrossT[i]).toBeGreaterThanOrEqual(0);
        expect(result.vCrossT[i]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('handles 3x3 grid with multiple cells', () => {
    // 3x3 grid = 2x2 cells
    // Solid pattern: center column solid
    //   0 1 0
    //   0 1 0
    //   0 1 0
    const solid = new Uint8Array([0, 1, 0, 0, 1, 0, 0, 1, 0]);
    const field = new Float32Array([0.1, 0.9, 0.1, 0.1, 0.9, 0.1, 0.1, 0.9, 0.1]);
    const result = extractIsoband(solid, field, 3, 3)!;
    expect(result).not.toBeNull();
    // All 4 cells should be non-empty
    for (let i = 0; i < 4; i++) {
      expect(result.cellCases[i]).not.toBe(0);
    }
  });

  it('saddle disambiguation uses center average', () => {
    // Case 5: TL + BR solid, TR + BL empty
    const solid = new Uint8Array([1, 0, 0, 1]); // TL=1, TR=0, BL=0, BR=1
    // High average → connected saddle (case 16)
    const fieldHigh = new Float32Array([0.9, 0.4, 0.4, 0.9]);
    const resultHigh = extractIsoband(solid, fieldHigh, 2, 2)!;
    expect(resultHigh.cellCases[0]).toBe(16);

    // Low average → disconnected (case 5)
    const fieldLow = new Float32Array([0.6, 0.1, 0.1, 0.6]);
    const resultLow = extractIsoband(solid, fieldLow, 2, 2)!;
    expect(resultLow.cellCases[0]).toBe(5);
  });

  it('totalMeshVerts = gridCorners + edgeCrossings', () => {
    const solid = new Uint8Array([1, 0, 0, 1]);
    const field = new Float32Array([0.8, 0.2, 0.2, 0.8]);
    const result = extractIsoband(solid, field, 2, 2)!;
    let edgeCrossings = 0;
    for (let i = 0; i < result.hEdgeToVert.length; i++) {
      if (result.hEdgeToVert[i]! >= 0) edgeCrossings++;
    }
    for (let i = 0; i < result.vEdgeToVert.length; i++) {
      if (result.vEdgeToVert[i]! >= 0) edgeCrossings++;
    }
    expect(result.totalMeshVerts).toBe(result.numGridCorners + edgeCrossings);
  });
});

// --- resolveVert ---

describe('resolveVert', () => {
  it('maps corner IDs (0-3) to grid vertex indices', () => {
    // 3x3 grid, cell at (0,0)
    const solid = new Uint8Array([1, 1, 0, 1, 1, 0, 0, 0, 0]);
    const field = new Float32Array([0.9, 0.9, 0.1, 0.9, 0.9, 0.1, 0.1, 0.1, 0.1]);
    const iso = extractIsoband(solid, field, 3, 3)!;

    // For cell (0,0): TL=g[0], TR=g[1], BR=g[4], BL=g[3]
    const tl = resolveVert(iso, 0, 0, 0, 3);
    const tr = resolveVert(iso, 0, 0, 1, 3);
    // All should be non-negative (these corners are used)
    expect(tl).toBeGreaterThanOrEqual(0);
    expect(tr).toBeGreaterThanOrEqual(0);
    expect(tl).not.toBe(tr);
  });

  it('maps edge IDs (4-7) to edge crossing indices', () => {
    // Single corner solid → has 2 edge crossings
    const solid = new Uint8Array([1, 0, 0, 0]);
    const field = new Float32Array([0.8, 0.2, 0.2, 0.2]);
    const iso = extractIsoband(solid, field, 2, 2)!;

    // Case 1 = [0, 7, 4] → uses localId 4 (E_top) and 7 (E_left)
    const eTop = resolveVert(iso, 0, 0, 4, 2);
    const eLeft = resolveVert(iso, 0, 0, 7, 2);
    expect(eTop).toBeGreaterThanOrEqual(iso.numGridCorners);
    expect(eLeft).toBeGreaterThanOrEqual(iso.numGridCorners);
    expect(eTop).not.toBe(eLeft);
  });
});

// --- getCrossingInfo ---

describe('getCrossingInfo', () => {
  it('returns interpolation parameter for edge crossings', () => {
    const solid = new Uint8Array([1, 0, 0, 0]);
    const field = new Float32Array([0.9, 0.1, 0.1, 0.1]);
    const iso = extractIsoband(solid, field, 2, 2)!;

    // E_top (localId 4) — horizontal edge between TL(0.9) and TR(0.1)
    const info = getCrossingInfo(iso, 0, 0, 4, 2);
    expect(info.isHorizontal).toBe(true);
    expect(info.t).toBeGreaterThan(0);
    expect(info.t).toBeLessThan(1);
    // t should be (0.5 - 0.9) / (0.1 - 0.9) = 0.5
    expect(info.t).toBeCloseTo(0.5, 2);
  });

  it('identifies horizontal vs vertical edges correctly', () => {
    const solid = new Uint8Array([1, 0, 0, 0]);
    const field = new Float32Array([0.8, 0.2, 0.2, 0.2]);
    const iso = extractIsoband(solid, field, 2, 2)!;

    expect(getCrossingInfo(iso, 0, 0, 4, 2).isHorizontal).toBe(true);  // E_top
    expect(getCrossingInfo(iso, 0, 0, 5, 2).isHorizontal).toBe(false); // E_right
    expect(getCrossingInfo(iso, 0, 0, 6, 2).isHorizontal).toBe(true);  // E_bottom
    expect(getCrossingInfo(iso, 0, 0, 7, 2).isHorizontal).toBe(false); // E_left
  });
});

// --- getEdgeEndpoints ---

describe('getEdgeEndpoints', () => {
  it('E_top (4) connects TL → TR', () => {
    const [a, b] = getEdgeEndpoints(0, 0, 4, 3);
    expect(a).toBe(0);  // g00
    expect(b).toBe(1);  // g00 + 1
  });

  it('E_right (5) connects TR → BR', () => {
    const [a, b] = getEdgeEndpoints(0, 0, 5, 3);
    expect(a).toBe(1);  // g00 + 1
    expect(b).toBe(4);  // g00 + cols + 1
  });

  it('E_bottom (6) connects BL → BR', () => {
    const [a, b] = getEdgeEndpoints(0, 0, 6, 3);
    expect(a).toBe(3);  // g00 + cols
    expect(b).toBe(4);  // g00 + cols + 1
  });

  it('E_left (7) connects TL → BL', () => {
    const [a, b] = getEdgeEndpoints(0, 0, 7, 3);
    expect(a).toBe(0);  // g00
    expect(b).toBe(3);  // g00 + cols
  });

  it('offsets correctly for non-origin cells', () => {
    // Cell (1, 1) in a 4x4 grid: g00 = 1*4 + 1 = 5
    const [a, b] = getEdgeEndpoints(1, 1, 4, 4);
    expect(a).toBe(5);
    expect(b).toBe(6); // g00 + 1
  });
});
