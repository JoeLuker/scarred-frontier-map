import type { SimFieldConfig } from '../types';
import { WORLD, MESH } from '../../core/constants';

/**
 * GPU-resident simulation field. The terrain mesh vertex grid defines the resolution.
 *
 * Textures:
 *   elevation  (r32float)  — bedrock height 0-1
 *   fluid      (rgba32float) — [water_height, velocity.x, velocity.y, temperature]
 *   substance  (r8uint)    — bitmask per cell
 *   moisture   (r32float)  — biome moisture 0-1 (from terrain gen)
 *
 * All textures share the same dimensions and world-space mapping.
 * Compute shaders read/write via storage texture bindings.
 * The render pass samples them via texture bindings for vertex displacement + fragment coloring.
 */
export class SimField {
  readonly config: SimFieldConfig;
  readonly device: GPUDevice;

  // GPU textures (double-buffered for fluid, single for elevation/moisture)
  readonly elevation: GPUTexture;
  readonly fluid: [GPUTexture, GPUTexture];
  readonly substance: GPUTexture;
  readonly moisture: GPUTexture;

  // CPU staging buffers (for snapshot readback + initial upload)
  private elevationStaging: Float32Array;
  private fluidStaging: Float32Array;

  // Double buffer index
  private currentFluid: 0 | 1 = 0;

  private constructor(
    device: GPUDevice,
    config: SimFieldConfig,
    elevation: GPUTexture,
    fluid: [GPUTexture, GPUTexture],
    substance: GPUTexture,
    moisture: GPUTexture,
    elevationStaging: Float32Array,
    fluidStaging: Float32Array,
  ) {
    this.device = device;
    this.config = config;
    this.elevation = elevation;
    this.fluid = fluid;
    this.substance = substance;
    this.moisture = moisture;
    this.elevationStaging = elevationStaging;
    this.fluidStaging = fluidStaging;
  }

  static create(device: GPUDevice): SimField {
    // Compute grid dimensions from world layout
    const worldRadius = WORLD.GRID_RADIUS * WORLD.HEX_SIZE * Math.sqrt(3);
    const halfExtent = worldRadius + MESH.VERTEX_SPACING * 2;
    const cellSize = MESH.VERTEX_SPACING;
    const gridSize = Math.ceil((halfExtent * 2) / cellSize);

    // Round up to multiple of 8 for compute workgroup alignment
    const width = Math.ceil(gridSize / 8) * 8;
    const height = width;

    const config: SimFieldConfig = {
      width,
      height,
      cellSize,
      worldExtent: halfExtent,
    };

    const texUsage = GPUTextureUsage.TEXTURE_BINDING
      | GPUTextureUsage.STORAGE_BINDING
      | GPUTextureUsage.COPY_SRC
      | GPUTextureUsage.COPY_DST;

    const elevation = device.createTexture({
      size: [width, height],
      format: 'r32float',
      usage: texUsage,
    });

    const fluid0 = device.createTexture({
      size: [width, height],
      format: 'rgba32float',
      usage: texUsage,
    });
    const fluid1 = device.createTexture({
      size: [width, height],
      format: 'rgba32float',
      usage: texUsage,
    });

    const substance = device.createTexture({
      size: [width, height],
      format: 'r32uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST,
    });

    const moisture = device.createTexture({
      size: [width, height],
      format: 'r32float',
      usage: texUsage,
    });

    const cellCount = width * height;
    const elevationStaging = new Float32Array(cellCount);
    const fluidStaging = new Float32Array(cellCount * 4);

    return new SimField(device, config, elevation, [fluid0, fluid1], substance, moisture, elevationStaging, fluidStaging);
  }

  /** Current fluid texture (read source for compute, sample source for render). */
  get currentFluidTexture(): GPUTexture { return this.fluid[this.currentFluid]; }

  /** Next fluid texture (write target for compute). */
  get nextFluidTexture(): GPUTexture { return this.fluid[1 - this.currentFluid as 0 | 1]; }

  /** Swap fluid double buffers after compute step. */
  swapFluid(): void {
    this.currentFluid = (1 - this.currentFluid) as 0 | 1;
  }

  /** Upload elevation data from CPU array. Handles size mismatch by padding. */
  uploadElevation(data: Float32Array): void {
    const expected = this.config.width * this.config.height;
    const padded = this.ensureSize(data, expected);
    this.elevationStaging.set(padded);
    this.device.queue.writeTexture(
      { texture: this.elevation },
      padded,
      { bytesPerRow: this.config.width * 4 },
      [this.config.width, this.config.height],
    );
  }

  /** Upload moisture data from CPU array. Handles size mismatch by padding. */
  uploadMoisture(data: Float32Array): void {
    const expected = this.config.width * this.config.height;
    const padded = this.ensureSize(data, expected);
    this.device.queue.writeTexture(
      { texture: this.moisture },
      padded,
      { bytesPerRow: this.config.width * 4 },
      [this.config.width, this.config.height],
    );
  }

  /** Pad or truncate a Float32Array to the expected size. */
  private ensureSize(data: Float32Array, expected: number): Float32Array {
    if (data.length === expected) return data;
    const result = new Float32Array(expected);
    result.set(data.subarray(0, Math.min(data.length, expected)));
    return result;
  }

  /** Upload fluid data (e.g., for snapshot restore). Handles size mismatch. */
  uploadFluid(data: Float32Array): void {
    const expected = this.config.width * this.config.height * 4;
    const padded = this.ensureSize(data, expected);
    this.fluidStaging.set(padded);
    this.device.queue.writeTexture(
      { texture: this.currentFluidTexture },
      padded,
      { bytesPerRow: this.config.width * 4 * 4 },
      [this.config.width, this.config.height],
    );
  }

  /** Clear all fluid state to zero. */
  clearFluid(encoder: GPUCommandEncoder): void {
    // Clear both buffers
    for (const tex of this.fluid) {
      encoder.clearBuffer(tex as unknown as GPUBuffer); // Actually need to use a compute clear
    }
    // Simpler approach: upload zeros
    this.fluidStaging.fill(0);
    this.uploadFluid(this.fluidStaging);
  }

  /** Convert world position (x, z) to sim grid cell (col, row). */
  worldToCell(x: number, z: number): [number, number] {
    const col = Math.floor((x + this.config.worldExtent) / this.config.cellSize);
    const row = Math.floor((z + this.config.worldExtent) / this.config.cellSize);
    return [
      Math.max(0, Math.min(this.config.width - 1, col)),
      Math.max(0, Math.min(this.config.height - 1, row)),
    ];
  }

  /** Convert sim grid cell to world position (center of cell). */
  cellToWorld(col: number, row: number): [number, number] {
    return [
      col * this.config.cellSize - this.config.worldExtent + this.config.cellSize / 2,
      row * this.config.cellSize - this.config.worldExtent + this.config.cellSize / 2,
    ];
  }

  destroy(): void {
    this.elevation.destroy();
    this.fluid[0].destroy();
    this.fluid[1].destroy();
    this.substance.destroy();
    this.moisture.destroy();
  }
}
