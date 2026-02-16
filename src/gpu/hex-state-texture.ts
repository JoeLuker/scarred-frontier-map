import { HexData, PlanarAlignment } from '../core/types';
import { RENDER } from '../core/config';

// Pre-computed planar tint RGB (0-255)
const PLANAR_TINT_RGB: Record<string, readonly [number, number, number]> = {
  [PlanarAlignment.FIRE]:     [239, 68, 68],
  [PlanarAlignment.WATER]:    [6, 182, 212],
  [PlanarAlignment.AIR]:      [165, 243, 252],
  [PlanarAlignment.EARTH]:    [120, 53, 15],
  [PlanarAlignment.POSITIVE]: [250, 204, 21],
  [PlanarAlignment.NEGATIVE]: [88, 28, 135],
  [PlanarAlignment.SCAR]:     [190, 24, 93],
};

/**
 * GPU texture encoding per-hex game state:
 *   R = explored (1.0 = explored, 0.0 = fog)
 *   G, B, A = planar tint color (RGB, 0 if no tint)
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
   * Encodes explored flag and planar tint for each hex.
   */
  update(hexes: HexData[]): void {
    const data = this.cpuData;
    const size = this._size;
    const gr = this.gridRadius;

    // Clear to black (unexplored, no tint)
    data.fill(0);

    for (let i = 0; i < hexes.length; i++) {
      const hex = hexes[i]!;
      const tx = hex.coordinates.q + gr;
      const ty = hex.coordinates.r + gr;

      if (tx < 0 || tx >= size || ty < 0 || ty >= size) continue;

      const off = (ty * size + tx) * 4;

      // R = explored flag
      data[off] = hex.isExplored ? 255 : 0;

      // G, B, A = planar tint color (blended if multiple influences)
      if (hex.planarInfluences.length > 0 && hex.terrain !== hex.baseTerrain) {
        // Use the mutated terrain's planar tint
        let cr = 0, cg = 0, cb = 0;
        let total = 0;
        for (const inf of hex.planarInfluences) {
          const rgb = PLANAR_TINT_RGB[inf.type];
          if (!rgb) continue;
          const eff = hex.isExplored ? inf.intensity : inf.intensity * RENDER.FOG_TINT_MULT;
          cr += rgb[0] * eff;
          cg += rgb[1] * eff;
          cb += rgb[2] * eff;
          total += eff;
        }
        if (total > 0) {
          data[off + 1] = Math.min(255, Math.round(cr / total));
          data[off + 2] = Math.min(255, Math.round(cg / total));
          data[off + 3] = Math.min(255, Math.round(cb / total));
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
