import { TerrainType } from '../../../core/types';
import { WORLD, TERRAIN } from '../../../core/constants';
import { hexToPixel } from '../../../core/geometry';
import { HexStore } from '../../components/HexStore';
import { SimField } from '../../components/SimField';
import type { WorldGenConfig } from '../../../core/types';

/**
 * Classify terrain from sampled elevation, moisture, and water values.
 * Pure function — testable independently of the GPU pipeline.
 */
export function classifyTerrain(
  elevation: number,
  moisture: number,
  waterHeight: number,
  seaLevel: number,
  mountainThreshold: number,
): TerrainType {
  if (waterHeight > 0.05 || elevation < seaLevel) return TerrainType.WATER;
  if (elevation > mountainThreshold) return TerrainType.MOUNTAIN;
  if (elevation > mountainThreshold - 0.15) return TerrainType.HILL;
  if (moisture > 0.7) return TerrainType.MARSH;
  if (moisture > 0.5) return TerrainType.FOREST;
  if (moisture < 0.3) return TerrainType.DESERT;
  return TerrainType.PLAIN;
}

/**
 * Reads sim field GPU textures back to CPU staging buffers.
 * Returns typed arrays for elevation, fluid (rgba32float), and moisture.
 */
async function readbackSimField(
  device: GPUDevice,
  simField: SimField,
): Promise<{
  elevation: Float32Array;
  fluid: Float32Array;
  moisture: Float32Array;
}> {
  const { width, height } = simField.config;

  // Elevation: r32float → 4 bytes/pixel
  const elevBytes = width * height * 4;
  const elevStaging = device.createBuffer({
    size: elevBytes,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  // Fluid: rgba32float → 16 bytes/pixel
  const fluidBytes = width * height * 16;
  const fluidStaging = device.createBuffer({
    size: fluidBytes,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  // Moisture: r32float → 4 bytes/pixel
  const moistStaging = device.createBuffer({
    size: elevBytes,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  const encoder = device.createCommandEncoder();

  // bytesPerRow must be aligned to 256 for WebGPU
  const elevBytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const fluidBytesPerRow = Math.ceil((width * 16) / 256) * 256;

  // Elevation staging buffer must fit aligned rows
  const alignedElevBytes = elevBytesPerRow * height;
  const alignedFluidBytes = fluidBytesPerRow * height;

  // Recreate staging buffers with aligned sizes
  elevStaging.destroy();
  fluidStaging.destroy();
  moistStaging.destroy();

  const elevStagingAligned = device.createBuffer({
    size: alignedElevBytes,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const fluidStagingAligned = device.createBuffer({
    size: alignedFluidBytes,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const moistStagingAligned = device.createBuffer({
    size: alignedElevBytes,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  encoder.copyTextureToBuffer(
    { texture: simField.elevation },
    { buffer: elevStagingAligned, bytesPerRow: elevBytesPerRow },
    [width, height],
  );
  encoder.copyTextureToBuffer(
    { texture: simField.currentFluidTexture },
    { buffer: fluidStagingAligned, bytesPerRow: fluidBytesPerRow },
    [width, height],
  );
  encoder.copyTextureToBuffer(
    { texture: simField.moisture },
    { buffer: moistStagingAligned, bytesPerRow: elevBytesPerRow },
    [width, height],
  );

  device.queue.submit([encoder.finish()]);

  await Promise.all([
    elevStagingAligned.mapAsync(GPUMapMode.READ),
    fluidStagingAligned.mapAsync(GPUMapMode.READ),
    moistStagingAligned.mapAsync(GPUMapMode.READ),
  ]);

  // Copy from aligned staging buffers to compact arrays
  const elevation = new Float32Array(width * height);
  const fluid = new Float32Array(width * height * 4);
  const moisture = new Float32Array(width * height);

  const elevSrc = new Float32Array(elevStagingAligned.getMappedRange());
  const fluidSrc = new Float32Array(fluidStagingAligned.getMappedRange());
  const moistSrc = new Float32Array(moistStagingAligned.getMappedRange());

  const elevRowFloats = elevBytesPerRow / 4;
  const fluidRowFloats = fluidBytesPerRow / 4;

  for (let row = 0; row < height; row++) {
    elevation.set(
      elevSrc.subarray(row * elevRowFloats, row * elevRowFloats + width),
      row * width,
    );
    fluid.set(
      fluidSrc.subarray(row * fluidRowFloats, row * fluidRowFloats + width * 4),
      row * width * 4,
    );
    moisture.set(
      moistSrc.subarray(row * elevRowFloats, row * elevRowFloats + width),
      row * width,
    );
  }

  elevStagingAligned.unmap();
  fluidStagingAligned.unmap();
  moistStagingAligned.unmap();
  elevStagingAligned.destroy();
  fluidStagingAligned.destroy();
  moistStagingAligned.destroy();

  return { elevation, fluid, moisture };
}

/**
 * Samples simulation field textures and writes derived terrain state into HexStore.
 * Async because GPU readback requires mapAsync.
 */
export class HexSampleSystem {
  readonly name = 'HexSampleSystem';

  async execute(
    device: GPUDevice,
    simField: SimField,
    hexes: HexStore,
    config: WorldGenConfig,
  ): Promise<void> {
    const { width, height } = simField.config;

    const { elevation, fluid, moisture } = await readbackSimField(device, simField);

    const seaLevel = TERRAIN.SEA_LEVEL_MIN + config.waterLevel * TERRAIN.SEA_LEVEL_RANGE;
    const mountainThreshold = TERRAIN.MOUNTAIN_THRESHOLD_BASE - config.mountainLevel * TERRAIN.MOUNTAIN_THRESHOLD_RANGE;

    for (let i = 0; i < hexes.hexCount; i++) {
      const q = hexes.coordQ[i]!;
      const r = hexes.coordR[i]!;

      // hex → world position (hexToPixel returns x,y; world uses x,z)
      const pixel = hexToPixel(q, r, WORLD.HEX_SIZE);
      const [col, row] = simField.worldToCell(pixel.x, pixel.y);

      // Sample sim field
      const cellIdx = row * width + col;
      const elev = elevation[cellIdx]!;
      const moist = moisture[cellIdx]!;

      // Fluid texture is rgba32float: [water_height, vx, vy, temperature]
      const fluidIdx = cellIdx * 4;
      const waterH = fluid[fluidIdx]!;
      const temp = fluid[fluidIdx + 3]!;

      // Write to SoA
      hexes.elevation[i] = elev;
      hexes.moisture[i] = moist;
      hexes.waterHeight[i] = waterH;
      hexes.temperature[i] = temp;
      hexes.terrainType[i] = classifyTerrain(elev, moist, waterH, seaLevel, mountainThreshold);
    }
  }
}
