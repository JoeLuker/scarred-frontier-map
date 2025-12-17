
import { MAP_CONFIG } from '../constants';

// --- Shared Types ---
export interface AxialCoord { q: number; r: number; }
export interface PixelCoord { x: number; y: number; }

// --- Coordinate Systems ---

/**
 * Converts Axial Coordinates (Pointy Top) to Pixel Coordinates.
 * Used for placing hexes on the canvas.
 */
export const hexToPixel = (q: number, r: number): PixelCoord => {
    // Pointy Top Geometry
    // x = size * sqrt(3) * (q + r/2)
    // y = size * 3/2 * r
    const x = MAP_CONFIG.HEX_SIZE * Math.sqrt(3) * (q + r/2);
    const y = MAP_CONFIG.HEX_SIZE * (3 / 2 * r);
    return { x, y };
};

/**
 * Converts Pixel Coordinates to Axial Coordinates (Pointy Top).
 * Used for hit-testing clicks.
 */
export const pixelToHex = (x: number, y: number): AxialCoord => {
    // Pointy Top Geometry Inverse
    const q = (Math.sqrt(3)/3 * x - 1/3 * y) / MAP_CONFIG.HEX_SIZE;
    const r = (2/3 * y) / MAP_CONFIG.HEX_SIZE;
    return axialRound(q, r);
};

// --- Sector Geometry (Flat Top Layout) ---

/**
 * Determines the center coordinate of a Sector based on its Grid ID (sq, sr).
 * Maps the Sector Grid (Flat Top, axes at 30° and 90°) to the Tile Grid (Pointy Top, axes at 0° and 60°).
 * 
 * Flat Top Axis 1 (SQ) -> Maps to Vector(1, 1) in Tile Grid (Angle 30°)
 * Flat Top Axis 2 (SR) -> Maps to Vector(-1, 2) in Tile Grid (Angle 90°)
 */
export const getSectorCenter = (sq: number, sr: number): AxialCoord => {
    const s = MAP_CONFIG.SECTOR_SPACING;
    
    // Matrix transform:
    // Q = SQ * 1 + SR * -1
    // R = SQ * 1 + SR * 2
    
    return { 
        q: (sq - sr) * s, 
        r: (sq + 2 * sr) * s
    };
};

/**
 * Maps any Hex (q,r) to its owning Sector ID (sq, sr).
 * Inverses the Flat Top layout transform.
 */
export const getSectorID = (q: number, r: number): AxialCoord => {
    const s = MAP_CONFIG.SECTOR_SPACING;
    
    // Inverse Matrix (Determinant 3):
    // SQ = (2Q + R) / 3
    // SR = (R - Q) / 3
    
    const sqRaw = (2 * q + r) / (3 * s);
    const srRaw = (r - q) / (3 * s);
    
    return axialRound(sqRaw, srRaw);
};

/**
 * Returns the geometric radius (center to corner) required for Sectors to tessellate 
 * in a Flat Top configuration.
 * Distance between centers in this layout is S * 3 * hexSize (Length of vector (1,1) is 3).
 * Radius = Distance / sqrt(3) = S * sqrt(3) * hexSize.
 */
export const getSectorRadius = (): number => {
    return MAP_CONFIG.SECTOR_SPACING * Math.sqrt(3) * MAP_CONFIG.HEX_SIZE;
};

// --- Math Helpers ---

export const axialRound = (x: number, y: number): AxialCoord => {
    const xgrid = Math.round(x);
    const ygrid = Math.round(y);
    const xrem = x - xgrid;
    const yrem = y - ygrid;
    if (Math.abs(xrem) >= Math.abs(yrem)) {
      return { q: xgrid + Math.round(xrem + 0.5 * yrem), r: ygrid };
    } else {
      return { q: xgrid, r: ygrid + Math.round(yrem + 0.5 * xrem) };
    }
};

export const getHexDistance = (a: AxialCoord, b: AxialCoord): number => {
    return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
};

// Functional Range Helper
export const range = (start: number, end: number): number[] => 
    Array.from({ length: end - start + 1 }, (_, i) => start + i);

// Interpolate line between hexes
export const hexLine = (start: AxialCoord, end: AxialCoord): AxialCoord[] => {
    const dist = getHexDistance({q: start.q, r: start.r}, {q: end.q, r: end.r});
    if (dist === 0) return [];
    
    return range(1, Math.floor(dist) - 1).map(i => {
        const t = 1.0 / dist * i;
        const q = start.q + (end.q - start.q) * t;
        const r = start.r + (end.r - start.r) * t;
        return axialRound(q, r);
    });
};
