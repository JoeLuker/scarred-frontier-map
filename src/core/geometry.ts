import { AxialCoord, PixelCoord } from './types';

// --- Coordinate Systems ---

/**
 * Converts Axial Coordinates (Pointy Top) to Pixel Coordinates.
 */
export const hexToPixel = (q: number, r: number, hexSize: number): PixelCoord => {
  const x = hexSize * Math.sqrt(3) * (q + r / 2);
  const y = hexSize * (3 / 2) * r;
  return { x, y };
};

/**
 * Converts Pixel Coordinates to Axial Coordinates (Pointy Top).
 */
export const pixelToHex = (x: number, y: number, hexSize: number): AxialCoord => {
  const q = (Math.sqrt(3) / 3 * x - 1 / 3 * y) / hexSize;
  const r = (2 / 3 * y) / hexSize;
  return axialRound(q, r);
};

// --- Sector Geometry (Flat Top Layout) ---

/**
 * Determines the center coordinate of a Sector based on its Grid ID (sq, sr).
 * Maps the Sector Grid (Flat Top) to the Tile Grid (Pointy Top).
 */
export const getSectorCenter = (sq: number, sr: number, spacing: number): AxialCoord => {
  return {
    q: (sq - sr) * spacing,
    r: (sq + 2 * sr) * spacing,
  };
};

/**
 * Maps any Hex (q,r) to its owning Sector ID (sq, sr).
 */
export const getSectorID = (q: number, r: number, spacing: number): AxialCoord => {
  const sqRaw = (2 * q + r) / (3 * spacing);
  const srRaw = (r - q) / (3 * spacing);
  return axialRound(sqRaw, srRaw);
};

/**
 * Returns the geometric radius (center to corner) for sector tessellation.
 */
export const getSectorRadius = (hexSize: number, spacing: number): number => {
  return spacing * Math.sqrt(3) * hexSize;
};

// --- Math Helpers ---

/**
 * Standard cube-coordinate rounding for hex grids.
 * Converts axial (q, r) to cube (q, -q-r, r), rounds each component,
 * then fixes the component with the largest rounding error to maintain q+y+r=0.
 */
export const axialRound = (q: number, r: number): AxialCoord => {
  const y = -q - r;

  let rq = Math.round(q);
  let ry = Math.round(y);
  let rr = Math.round(r);

  const dq = Math.abs(rq - q);
  const dy = Math.abs(ry - y);
  const dr = Math.abs(rr - r);

  if (dq > dy && dq > dr) {
    rq = -ry - rr;
  } else if (dy > dr) {
    // ry = -rq - rr; (don't need ry for output)
  } else {
    rr = -rq - ry;
  }

  return { q: rq, r: rr };
};

export const getHexDistance = (a: AxialCoord, b: AxialCoord): number => {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
};

export const range = (start: number, end: number): number[] =>
  Array.from({ length: end - start + 1 }, (_, i) => start + i);

export const hexLine = (start: AxialCoord, end: AxialCoord): AxialCoord[] => {
  const dist = getHexDistance(start, end);
  if (dist === 0) return [];

  return range(1, Math.floor(dist) - 1).map(i => {
    const t = (1.0 / dist) * i;
    const q = start.q + (end.q - start.q) * t;
    const r = start.r + (end.r - start.r) * t;
    return axialRound(q, r);
  });
};
