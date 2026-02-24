/**
 * Hex state RGBA8 packing codec — single source of truth for encode/decode.
 *
 * Channel layout:
 *   R = plane-dependent data:
 *       Air:   overlay radius (0-71 hex range → 0-255, for island noise frequency scaling)
 *       Fire:  lift (0.0-1.0 → 0-255, lava level threshold for VS terrain clamping)
 *       Water: lift (0.0-1.0 → 0-255, flood level threshold for VS terrain clamping)
 *       Other: overlay radius (default)
 *   G = packed: plane_type (3 bits high, bits 7-5) + fragmentation (5 bits low, bits 4-0)
 *   B = planar intensity (0.0-1.0 → 0-255)
 *   A = packed: terrain_id (high nibble, bits 7-4) + sector boundary (bit 0)
 *
 * Used by hex-state-texture.ts (encode) and WGSL shaders (decode via render-noise.wgsl.ts).
 */

// --- R channel: plane-dependent (radius OR lift) ---

const MAX_RADIUS = 71; // GRID_RADIUS(66) + 5

/** Encode overlay radius in R channel (Air, default) */
export function encodeR(radius: number): number {
  return Math.min(255, Math.round(radius * (255 / MAX_RADIUS)));
}

/** Encode lift (0-1) in R channel (Fire — lava level threshold) */
export function encodeRLift(lift: number): number {
  return Math.min(255, Math.round(lift * 255));
}

// --- G channel: plane_type (3 bits high) + fragmentation (5 bits low) ---

export function encodeG(planeTypeId: number, fragmentation: number): number {
  const fragBits = Math.min(31, Math.round(fragmentation * 31));
  return (planeTypeId << 5) | fragBits;
}

// --- B channel: planar intensity ---

export function encodeB(intensity: number): number {
  return Math.min(255, Math.round(intensity * 255));
}

// --- A channel: terrain_id + sector boundary ---

export interface PackedA {
  readonly terrainId: number;
  readonly sectorBoundary: boolean;
}

export function encodeA(terrainId: number, sectorBoundary: boolean): number {
  return (terrainId << 4) | (sectorBoundary ? 1 : 0);
}

export function decodeA(byte: number): PackedA {
  return {
    terrainId: byte >> 4,
    sectorBoundary: (byte & 1) !== 0,
  };
}
