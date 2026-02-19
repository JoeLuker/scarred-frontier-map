import { HexData, PlanarAlignment } from '../core/types';
import { getSectorID } from '../core/geometry';
import { WORLD } from '../core/config';
import { TERRAIN_TYPE_TO_ID } from './types';

// Plane type → integer ID (0-7)
const PLANE_TYPE_ID: Record<string, number> = {
  [PlanarAlignment.MATERIAL]:  0,
  [PlanarAlignment.FIRE]:      1,
  [PlanarAlignment.WATER]:     2,
  [PlanarAlignment.EARTH]:     3,
  [PlanarAlignment.AIR]:       4,
  [PlanarAlignment.POSITIVE]:  5,
  [PlanarAlignment.NEGATIVE]:  6,
  [PlanarAlignment.SCAR]:      7,
};

// Plane type stored as direct byte value (0-7).
// Shader decodes: plane_type = u32(round(hex_state.g * 255.0))

/**
 * GPU texture encoding per-hex game state:
 *   R = packed: lift (high nibble, bits 7-4) + fragmentation (low nibble, bits 3-0)
 *       Shader decodes: r_byte = round(r * 255), frag = (r_byte & 0xF) / 15, lift = (r_byte >> 4) / 15
 *   G = plane type (0-7 stored as direct byte, decoded via round(g * 255))
 *   B = planar intensity (0.0-1.0 → 0-255)
 *   A = packed: terrain_id (bits 7-4) + sector boundary (bit 0)
 *       Shader decodes: terrain_id = byte >> 4, sector_boundary = byte & 1
 *
 * Texture size: (gridRadius * 2 + 1) squared.
 * Hex (q, r) maps to pixel (q + gridRadius, r + gridRadius).
 * Nearest-neighbor sampling gives sharp per-hex boundaries.
 */
export class HexStateTexture {
  private device: GPUDevice;
  private _texture: GPUTexture;
  private _size: number; // gridRadius * 2 + 1
  private gridRadius: number;
  private cpuData: Uint8Array;

  private constructor(device: GPUDevice, texture: GPUTexture, size: number, gridRadius: number) {
    this.device = device;
    this._texture = texture;
    this._size = size;
    this.gridRadius = gridRadius;
    this.cpuData = new Uint8Array(size * size * 4);
  }

  static create(device: GPUDevice, gridRadius: number): HexStateTexture {
    const size = gridRadius * 2 + 1;
    const texture = device.createTexture({
      size: [size, size],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    return new HexStateTexture(device, texture, size, gridRadius);
  }

  /**
   * Update texture from hex data array.
   * Encodes explored flag, plane type, intensity, and sector boundary for each hex.
   */
  update(hexes: HexData[]): void {
    const data = this.cpuData;
    const size = this._size;
    const gr = this.gridRadius;
    const sectorSpacing = WORLD.RING_WIDTH;

    // Clear to black (unexplored, no plane, no boundary)
    data.fill(0);

    // 6 axial neighbor offsets
    const NEIGHBORS: readonly [number, number][] = [
      [1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1],
    ];

    for (let i = 0; i < hexes.length; i++) {
      const hex = hexes[i]!;
      const q = hex.coordinates.q;
      const r = hex.coordinates.r;
      const tx = q + gr;
      const ty = r + gr;

      if (tx < 0 || tx >= size || ty < 0 || ty >= size) continue;

      const off = (ty * size + tx) * 4;

      // R = packed: lift (high nibble) + fragmentation (low nibble)
      const fragNibble = Math.min(15, Math.round(hex.planarFragmentation * 15));
      const liftNibble = Math.min(15, Math.round(hex.planarLift * 15));
      data[off] = (liftNibble << 4) | fragNibble;

      // G = plane type, B = intensity (encode for ALL planar influences)
      if (hex.planarInfluences.length > 0) {
        const planeId = PLANE_TYPE_ID[hex.planarAlignment] ?? 0;
        data[off + 1] = planeId;
        data[off + 2] = Math.min(255, Math.round(hex.planarIntensity * 255));
      }

      // A = packed: terrain_id (high nibble) + sector boundary (bit 0)
      // Use current terrain (includes planar mutations like Forest→Magma).
      // IDs 0-7 are base types, 8-10 are mutation-only (Magma, Crystal, Floating).
      const terrainId = TERRAIN_TYPE_TO_ID[hex.terrain] ?? 0;
      let sectorBoundary = 0;
      const sector = getSectorID(q, r, sectorSpacing);
      for (const [dq, dr] of NEIGHBORS) {
        const ns = getSectorID(q + dq, r + dr, sectorSpacing);
        if (ns.q !== sector.q || ns.r !== sector.r) {
          sectorBoundary = 1;
          break;
        }
      }
      data[off + 3] = terrainId * 16 + sectorBoundary;
    }

    this.device.queue.writeTexture(
      { texture: this._texture },
      data,
      { bytesPerRow: size * 4 },
      [size, size],
    );
  }

  get texture(): GPUTexture { return this._texture; }
  get size(): number { return this._size; }

  destroy(): void {
    this._texture.destroy();
  }
}
