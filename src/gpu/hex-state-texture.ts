import { HexData, PlanarAlignment } from '../core/types';
import { getSectorID } from '../core/geometry';
import { WORLD } from '../core/config';

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

// Pre-computed encoded byte values: round(id * 255 / 7)
// Shader decodes: plane_type = u32(round(hex_state.g * 7.0))
const PLANE_TYPE_ENCODED: readonly number[] = [0, 36, 73, 109, 146, 182, 218, 255];

/**
 * GPU texture encoding per-hex game state:
 *   R = explored (255 = explored, 0 = fog)
 *   G = plane type (0-7 encoded as 0-255, decoded via round(g * 7))
 *   B = planar intensity (0.0-1.0 → 0-255)
 *   A = sector boundary (255 if any neighbor belongs to a different sector, 0 otherwise)
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

      // R = explored flag
      data[off] = hex.isExplored ? 255 : 0;

      // G = plane type, B = intensity (encode for ALL planar influences)
      if (hex.planarInfluences.length > 0) {
        const planeId = PLANE_TYPE_ID[hex.planarAlignment] ?? 0;
        data[off + 1] = PLANE_TYPE_ENCODED[planeId] ?? 0;
        data[off + 2] = Math.min(255, Math.round(hex.planarIntensity * 255));
      }

      // A = sector boundary: mark if any neighbor belongs to a different sector
      const sector = getSectorID(q, r, sectorSpacing);
      for (const [dq, dr] of NEIGHBORS) {
        const ns = getSectorID(q + dq, r + dr, sectorSpacing);
        if (ns.q !== sector.q || ns.r !== sector.r) {
          data[off + 3] = 255;
          break;
        }
      }
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
