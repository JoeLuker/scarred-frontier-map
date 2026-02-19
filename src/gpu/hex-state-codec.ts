/**
 * Hex state RGBA8 packing codec — single source of truth for encode/decode.
 *
 * Channel layout:
 *   R = packed: lift (high nibble, bits 7-4) + fragmentation (low nibble, bits 3-0)
 *   G = plane type (0-7 stored as direct byte value)
 *   B = planar intensity (0.0-1.0 → 0-255)
 *   A = packed: terrain_id (high nibble, bits 7-4) + sector boundary (bit 0)
 *
 * Used by hex-state-texture.ts (encode) and WGSL shaders (decode via render-noise.wgsl.ts).
 */

// --- R channel: lift + fragmentation ---

export interface PackedR {
  readonly lift: number;          // 0.0-1.0 (4-bit precision, 16 levels)
  readonly fragmentation: number; // 0.0-1.0 (4-bit precision, 16 levels)
}

export function encodeR(lift: number, fragmentation: number): number {
  const liftNibble = Math.min(15, Math.round(lift * 15));
  const fragNibble = Math.min(15, Math.round(fragmentation * 15));
  return (liftNibble << 4) | fragNibble;
}

export function decodeR(byte: number): PackedR {
  return {
    lift: (byte >> 4) / 15,
    fragmentation: (byte & 0xF) / 15,
  };
}

// --- G channel: plane type ---

export function encodeG(planeTypeId: number): number {
  return planeTypeId;
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
