import { AxialCoord } from '../core/types';

/**
 * GPU texture for fluid/propagation data, mirroring HexStateTexture's coord mapping.
 *
 * Format: rgba8unorm (using R=level, G=substance type, B+A reserved)
 * Hex (q, r) → pixel (q + gridRadius, r + gridRadius)
 * Nearest-neighbor sampling gives sharp per-hex boundaries.
 */
export class FluidTexture {
  private device: GPUDevice;
  private _texture: GPUTexture;
  private _size: number;
  private gridRadius: number;
  private cpuData: Uint8Array;

  private constructor(device: GPUDevice, texture: GPUTexture, size: number, gridRadius: number) {
    this.device = device;
    this._texture = texture;
    this._size = size;
    this.gridRadius = gridRadius;
    this.cpuData = new Uint8Array(size * size * 4);
  }

  static create(device: GPUDevice, gridRadius: number): FluidTexture {
    const size = gridRadius * 2 + 1;
    const texture = device.createTexture({
      size: [size, size],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    return new FluidTexture(device, texture, size, gridRadius);
  }

  /**
   * Upload fluid simulation state to GPU.
   * levels: Float32Array (0-1 per hex), types: Uint8Array (SubstanceType per hex)
   */
  update(
    levels: Float32Array,
    types: Uint8Array,
    coords: ReadonlyArray<AxialCoord>,
  ): void {
    const data = this.cpuData;
    const size = this._size;
    const gr = this.gridRadius;

    data.fill(0);

    for (let i = 0; i < coords.length; i++) {
      const { q, r } = coords[i]!;
      const tx = q + gr;
      const ty = r + gr;
      if (tx < 0 || tx >= size || ty < 0 || ty >= size) continue;

      const off = (ty * size + tx) * 4;
      data[off] = Math.min(255, Math.round((levels[i] ?? 0) * 255));     // R = level
      data[off + 1] = types[i] ?? 0;                                       // G = substance type
      // B, A reserved for future use (flow direction, temperature, etc.)
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
