import { PlanarAlignment } from '../../../core/types';
import { WORLD } from '../../../core/constants';
import { getSectorID } from '../../../core/geometry';
import { encodeR, encodeRLift, encodeG, encodeB, encodeA } from '../../../gpu/hex-state-codec';
import { HexStore } from '../../components/HexStore';

// 6 axial neighbor offsets
const NEIGHBORS: readonly [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1],
];

/**
 * Uploads hex-level state to the hex-state GPU texture for shader display.
 * Same RGBA8 encoding as v1's HexStateTexture.update().
 *
 * Channel layout:
 *   R = lift (Fire/Water) or radius (others)
 *   G = plane_type (3 bits) | fragmentation (5 bits)
 *   B = planar intensity
 *   A = terrain_id (4 bits) | sector_boundary (1 bit)
 */
export class TextureUploadSystem {
  readonly name = 'TextureUploadSystem';

  private readonly textureSize: number;
  private readonly gridRadius: number;
  private readonly cpuData: Uint8Array;
  private readonly sectorSpacing: number;

  private texture: GPUTexture | null = null;

  constructor(gridRadius: number = WORLD.GRID_RADIUS) {
    this.gridRadius = gridRadius;
    this.textureSize = gridRadius * 2 + 1;
    this.cpuData = new Uint8Array(this.textureSize * this.textureSize * 4);
    this.sectorSpacing = WORLD.RING_WIDTH;
  }

  /** Create or retrieve the GPU texture. */
  getOrCreateTexture(device: GPUDevice): GPUTexture {
    if (!this.texture) {
      this.texture = device.createTexture({
        size: [this.textureSize, this.textureSize],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
    }
    return this.texture;
  }

  execute(device: GPUDevice, hexes: HexStore): void {
    const data = this.cpuData;
    const size = this.textureSize;
    const gr = this.gridRadius;

    data.fill(0);

    for (let i = 0; i < hexes.hexCount; i++) {
      const q = hexes.coordQ[i]!;
      const r = hexes.coordR[i]!;
      const tx = q + gr;
      const ty = r + gr;

      if (tx < 0 || tx >= size || ty < 0 || ty >= size) continue;

      const off = (ty * size + tx) * 4;

      const planeId = hexes.planarAlignment[i]!;
      const isFireOrWater = planeId === PlanarAlignment.FIRE || planeId === PlanarAlignment.WATER;

      // R = plane-dependent
      data[off] = isFireOrWater
        ? encodeRLift(hexes.planarLift[i]!)
        : encodeR(hexes.planarRadius[i]!);

      // G = plane_type (3 bits high) + fragmentation (5 bits low)
      // B = intensity
      if (hexes.planarIntensity[i]! > 0) {
        data[off + 1] = encodeG(planeId, hexes.planarFragmentation[i]!);
        data[off + 2] = encodeB(hexes.planarIntensity[i]!);
      }

      // A = terrain_id (high nibble) + sector boundary (bit 0)
      const terrainId = hexes.terrainType[i]!;
      let isBoundary = false;
      const sector = getSectorID(q, r, this.sectorSpacing);
      for (const [dq, dr] of NEIGHBORS) {
        const ns = getSectorID(q + dq, r + dr, this.sectorSpacing);
        if (ns.q !== sector.q || ns.r !== sector.r) {
          isBoundary = true;
          break;
        }
      }
      data[off + 3] = encodeA(terrainId, isBoundary);
    }

    const texture = this.getOrCreateTexture(device);
    device.queue.writeTexture(
      { texture },
      data,
      { bytesPerRow: size * 4 },
      [size, size],
    );
  }

  get hexStateTexture(): GPUTexture | null {
    return this.texture;
  }

  destroy(): void {
    this.texture?.destroy();
    this.texture = null;
  }
}
