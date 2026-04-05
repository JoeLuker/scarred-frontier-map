import { TERRAIN, BIOME, WORLD } from '../core/constants';
import { WorldGenConfig, AxialCoord } from '../core/types';
import { terrainFromId, elementFromId, flavorFromId } from './types';
import { createTerrainNoiseWGSL } from './terrain-noise.wgsl';
import type { TerrainProvider, TerrainResult } from '../core/types';

// --- Terrain result from GPU readback ---

export interface GpuTerrainResult {
  readonly terrainId: number;
  readonly elementId: number;
  readonly flavorId: number;
  readonly elevation: number;
}

// --- Generate WGSL shader: shared noise + hex-specific biome classification ---

function createTerrainShader(): string {
  return createTerrainNoiseWGSL() + /* wgsl */ `

// --- Per-hex biome constants (from config.ts BIOME object) ---
const SETTLEMENT_BASE_SCORE: f32 = ${BIOME.SETTLEMENT_BASE_SCORE};
const SETTLEMENT_PLAIN_BONUS: f32 = ${BIOME.SETTLEMENT_PLAIN_BONUS};
const SETTLEMENT_HILL_BONUS: f32 = ${BIOME.SETTLEMENT_HILL_BONUS};
const SETTLEMENT_DESERT_PENALTY: f32 = ${BIOME.SETTLEMENT_DESERT_PENALTY};
const SETTLEMENT_CHAOS_WEIGHT: f32 = ${BIOME.SETTLEMENT_CHAOS_WEIGHT};
const SETTLEMENT_ROLL_THRESHOLD: f32 = ${BIOME.SETTLEMENT_ROLL_THRESHOLD};
const SETTLEMENT_SCORE_THRESHOLD: f32 = ${BIOME.SETTLEMENT_SCORE_THRESHOLD};
const MOUNTAIN_SECRET: f32 = ${BIOME.MOUNTAIN_SECRET};
const MOUNTAIN_DIFFICULT: f32 = ${BIOME.MOUNTAIN_DIFFICULT};
const MOUNTAIN_RESOURCE: f32 = ${BIOME.MOUNTAIN_RESOURCE};
const FOREST_HUNTING: f32 = ${BIOME.FOREST_HUNTING};
const FOREST_SECRET: f32 = ${BIOME.FOREST_SECRET};
const GLOBAL_FEATURE: f32 = ${BIOME.GLOBAL_FEATURE};
const GLOBAL_RESOURCE: f32 = ${BIOME.GLOBAL_RESOURCE};
const HASH_SETTLEMENT_CHAOS: i32 = ${BIOME.HASH_SETTLEMENT_CHAOS};
const HASH_ELEMENT: i32 = ${BIOME.HASH_ELEMENT};
const HASH_SETTLEMENT_ROLL: i32 = ${BIOME.HASH_SETTLEMENT_ROLL};

// --- Temperature-driven biome threshold shifts (Whittaker-style, from config.ts TERRAIN) ---
const TEMP_DESERT_SHIFT: f32 = ${TERRAIN.TEMP_DESERT_SHIFT};
const TEMP_FOREST_SHIFT: f32 = ${TERRAIN.TEMP_FOREST_SHIFT};
const ELEVATION_LAPSE_RATE: f32 = ${TERRAIN.ELEVATION_LAPSE_RATE};
const MOISTURE_DESERT: f32 = ${TERRAIN.MOISTURE_DESERT};
const MOISTURE_FOREST: f32 = ${TERRAIN.MOISTURE_FOREST};
const MOISTURE_MARSH: f32 = ${TERRAIN.MOISTURE_MARSH};
const DEEP_OCEAN_RATIO: f32 = ${TERRAIN.DEEP_OCEAN_RATIO};
const SNOW_MOISTURE: f32 = ${TERRAIN.SNOW_MOISTURE};

// Terrain type IDs (must match src/gpu/types.ts TERRAIN_ORDER)
const T_WATER: u32 = 0u;
const T_DESERT: u32 = 1u;
const T_PLAIN: u32 = 2u;
const T_FOREST: u32 = 3u;
const T_MARSH: u32 = 4u;
const T_HILL: u32 = 5u;
const T_MOUNTAIN: u32 = 6u;
const T_SETTLEMENT: u32 = 7u;

// Element type IDs (must match src/gpu/types.ts ELEMENT_ORDER)
const E_STANDARD: u32 = 0u;
const E_FEATURE: u32 = 1u;
const E_RESOURCE: u32 = 2u;
const E_DIFFICULT: u32 = 3u;
const E_SECRET: u32 = 4u;
const E_HUNTING: u32 = 5u;

// Flavor IDs (must match src/gpu/types.ts FLAVOR_TABLE)
const F_DEEP_OCEAN: u32 = 0u;
const F_SHALLOW_SEA: u32 = 1u;
const F_RIVER: u32 = 2u;
const F_BARE_PEAK: u32 = 3u;
const F_SNOW_PEAK: u32 = 4u;
const F_ROCKY_BLUFFS: u32 = 5u;
const F_WOODED_HILLS: u32 = 6u;
const F_BARREN_WASTE: u32 = 7u;
const F_ARID_SCRUB: u32 = 8u;
const F_DEEP_SWAMP: u32 = 9u;
const F_WETLAND: u32 = 10u;
const F_DENSE_FOREST: u32 = 11u;
const F_LIGHT_WOOD: u32 = 12u;
const F_GRASSLAND: u32 = 13u;
const F_DRY_PLAINS: u32 = 14u;
const F_WILDERNESS: u32 = 15u;

// --- Buffers ---

struct HexConfig {
  // TerrainParams fields (same layout)
  seed: i32,
  water_level: f32,
  mountain_level: f32,
  vegetation_level: f32,
  river_density: f32,
  ruggedness: f32,
  force_no_river: u32,
  continent_scale: f32,
  temperature: f32,
  ridge_sharpness: f32,
  plateau_factor: f32,
  coast_complexity: f32,
  erosion: f32,
  valley_depth: f32,
  chaos: f32,
  _tp_pad: u32,
  // Hex-specific fields
  hex_count: u32,
  hex_size: f32,
  _pad0: u32,
  _pad1: u32,
}

struct HexResult {
  terrain: u32,
  element: u32,
  flavor: u32,
  elevation_bits: u32,
}

@group(0) @binding(0) var<uniform> config: HexConfig;
@group(0) @binding(1) var<storage, read> coords: array<vec2i>;
@group(0) @binding(2) var<storage, read_write> results: array<HexResult>;

// ============================================================
// Hex → World-space conversion (pointy-top axial hex layout)
// ============================================================

fn hex_to_pixel(q: i32, r: i32, hex_size: f32) -> vec2f {
  let qf = f32(q);
  let rf = f32(r);
  return vec2f(hex_size * 1.7320508075688772 * (qf + rf * 0.5), hex_size * 1.5 * rf);
}

// ============================================================
// Element & Settlement — per-hex classification
// ============================================================

fn calculate_element(terrain: u32, q: i32, r: i32, seed: i32) -> u32 {
  let val = f32(hash(q, r, seed + HASH_ELEMENT)) / 4294967296.0;

  if (terrain == T_MOUNTAIN) {
    if (val > MOUNTAIN_SECRET) { return E_SECRET; }
    if (val > MOUNTAIN_DIFFICULT) { return E_DIFFICULT; }
    if (val > MOUNTAIN_RESOURCE) { return E_RESOURCE; }
  }
  if (terrain == T_FOREST) {
    if (val > FOREST_HUNTING) { return E_HUNTING; }
    if (val > FOREST_SECRET) { return E_SECRET; }
  }
  if (val > GLOBAL_FEATURE) { return E_FEATURE; }
  if (val > GLOBAL_RESOURCE) { return E_RESOURCE; }

  return E_STANDARD;
}

fn calculate_settlement_score(terrain: u32, q: i32, r: i32, seed: i32) -> f32 {
  if (terrain == T_WATER || terrain == T_MOUNTAIN) { return 0.0; }
  var score = SETTLEMENT_BASE_SCORE;
  if (terrain == T_PLAIN) { score += SETTLEMENT_PLAIN_BONUS; }
  if (terrain == T_HILL) { score += SETTLEMENT_HILL_BONUS; }
  if (terrain == T_DESERT) { score -= SETTLEMENT_DESERT_PENALTY; }
  let chaos = f32(hash(q, r, seed + HASH_SETTLEMENT_CHAOS)) / 4294967296.0;
  score += chaos * SETTLEMENT_CHAOS_WEIGHT;
  return score;
}

fn get_terrain_params() -> TerrainParams {
  return TerrainParams(
    config.seed, config.water_level, config.mountain_level, config.vegetation_level,
    config.river_density, config.ruggedness, config.force_no_river, config.continent_scale,
    config.temperature, config.ridge_sharpness, config.plateau_factor, config.coast_complexity,
    config.erosion, config.valley_depth, config.chaos, 0u,
  );
}

// ============================================================
// Main compute kernel
// ============================================================

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= config.hex_count) { return; }

  let coord = coords[idx];
  let q = coord.x;
  let r = coord.y;
  let seed = config.seed;

  let wp = hex_to_pixel(q, r, config.hex_size);

  // Sample continuous terrain field
  let tp = get_terrain_params();
  let field = sample_terrain_field(wp.x, wp.y, tp);
  var elevation = field.elevation;
  let moisture = field.moisture;
  let sea_level = field.sea_level;
  let mt_threshold = field.mountain_threshold;
  let hill_threshold = field.hill_threshold;
  let is_river = field.is_river;

  // --- BIOME SELECTION with Whittaker-style elevation-dependent temperature ---
  // Higher elevation → colder local temperature → shifts biome thresholds.
  // Forests retreat from high elevations, tundra/bare terrain takes over.
  let land_range = 1.0 - sea_level;
  var norm_elev = 0.0;
  if (elevation > sea_level && land_range > 0.0) {
    norm_elev = (elevation - sea_level) / land_range;
  }
  let local_temp = config.temperature - norm_elev * ELEVATION_LAPSE_RATE;
  let temp_shift = local_temp - 0.5;
  let desert_threshold = MOISTURE_DESERT + temp_shift * TEMP_DESERT_SHIFT;
  let forest_threshold = MOISTURE_FOREST + temp_shift * TEMP_FOREST_SHIFT;
  let marsh_threshold = MOISTURE_MARSH - temp_shift * TEMP_FOREST_SHIFT;

  var terrain = T_PLAIN;
  var flavor = F_WILDERNESS;

  if (elevation < sea_level) {
    terrain = T_WATER;
    if (elevation < sea_level * DEEP_OCEAN_RATIO) { flavor = F_DEEP_OCEAN; }
    else { flavor = F_SHALLOW_SEA; }
  } else if (elevation > mt_threshold) {
    terrain = T_MOUNTAIN;
    if (moisture > SNOW_MOISTURE) { flavor = F_SNOW_PEAK; }
    else { flavor = F_BARE_PEAK; }
  } else if (is_river) {
    terrain = T_WATER;
    flavor = F_RIVER;
  } else if (elevation > hill_threshold) {
    terrain = T_HILL;
    if (moisture > forest_threshold) { flavor = F_WOODED_HILLS; }
    else { flavor = F_ROCKY_BLUFFS; }
  } else {
    if (moisture < desert_threshold) {
      terrain = T_DESERT;
      if (moisture < desert_threshold * 0.5) { flavor = F_BARREN_WASTE; }
      else { flavor = F_ARID_SCRUB; }
    } else if (moisture > marsh_threshold) {
      terrain = T_MARSH;
      if (moisture > (1.0 + marsh_threshold) * 0.5) { flavor = F_DEEP_SWAMP; }
      else { flavor = F_WETLAND; }
    } else if (moisture > forest_threshold) {
      terrain = T_FOREST;
      if (moisture > (forest_threshold + marsh_threshold) * 0.5) { flavor = F_DENSE_FOREST; }
      else { flavor = F_LIGHT_WOOD; }
    } else {
      terrain = T_PLAIN;
      if (moisture > (desert_threshold + forest_threshold) * 0.5) { flavor = F_GRASSLAND; }
      else { flavor = F_DRY_PLAINS; }
    }
  }

  // --- ELEMENT & SETTLEMENT ---
  let element = calculate_element(terrain, q, r, seed);
  let sroll = f32(hash(q, r, seed + HASH_SETTLEMENT_ROLL)) / 4294967296.0;

  var final_terrain = terrain;
  if (element == E_FEATURE && sroll > SETTLEMENT_ROLL_THRESHOLD) {
    let sscore = calculate_settlement_score(terrain, q, r, seed);
    if (sscore > SETTLEMENT_SCORE_THRESHOLD) {
      final_terrain = T_SETTLEMENT;
    }
  }

  results[idx] = HexResult(final_terrain, element, flavor, bitcast<u32>(elevation));
}
`;
}

// --- Compute pipeline ---

// HexConfig buffer: 16 TerrainParams fields + 4 hex-specific = 20 × 4 = 80 bytes
const CONFIG_BUFFER_SIZE = 80;

export class TerrainCompute {
  private device: GPUDevice;
  private pipeline: GPUComputePipeline;
  private configBuffer: GPUBuffer;
  private coordBuffer: GPUBuffer;
  private resultBuffer: GPUBuffer;
  private readbackBuffer: GPUBuffer;
  private bindGroupLayout: GPUBindGroupLayout;
  private bindGroup: GPUBindGroup;
  private hexCount: number;
  private _pending: Promise<GpuTerrainResult[]> | null = null;

  private constructor(
    device: GPUDevice,
    pipeline: GPUComputePipeline,
    configBuffer: GPUBuffer,
    coordBuffer: GPUBuffer,
    resultBuffer: GPUBuffer,
    readbackBuffer: GPUBuffer,
    bindGroupLayout: GPUBindGroupLayout,
    bindGroup: GPUBindGroup,
    hexCount: number,
  ) {
    this.device = device;
    this.pipeline = pipeline;
    this.configBuffer = configBuffer;
    this.coordBuffer = coordBuffer;
    this.resultBuffer = resultBuffer;
    this.readbackBuffer = readbackBuffer;
    this.bindGroupLayout = bindGroupLayout;
    this.bindGroup = bindGroup;
    this.hexCount = hexCount;
  }

  static create(device: GPUDevice, maxHexes: number): TerrainCompute {
    const shaderModule = device.createShaderModule({ code: createTerrainShader() });

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });

    const pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      compute: { module: shaderModule, entryPoint: 'main' },
    });

    const configBuffer = device.createBuffer({
      size: CONFIG_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const coordBuffer = device.createBuffer({
      size: maxHexes * 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const resultBuffer = device.createBuffer({
      size: maxHexes * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const readbackBuffer = device.createBuffer({
      size: maxHexes * 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    const bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: configBuffer } },
        { binding: 1, resource: { buffer: coordBuffer } },
        { binding: 2, resource: { buffer: resultBuffer } },
      ],
    });

    return new TerrainCompute(
      device, pipeline, configBuffer, coordBuffer, resultBuffer,
      readbackBuffer, bindGroupLayout, bindGroup, maxHexes,
    );
  }

  /** Upload hex coordinates. Call once after world generation (hex positions don't change). */
  setCoords(coords: ReadonlyArray<{ readonly q: number; readonly r: number }>): void {
    const count = coords.length;

    if (count > this.hexCount) {
      this.coordBuffer.destroy();
      this.resultBuffer.destroy();
      this.readbackBuffer.destroy();

      this.hexCount = Math.ceil(count * 1.5);

      this.coordBuffer = this.device.createBuffer({
        size: this.hexCount * 8,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.resultBuffer = this.device.createBuffer({
        size: this.hexCount * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      this.readbackBuffer = this.device.createBuffer({
        size: this.hexCount * 16,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });

      this.bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.configBuffer } },
          { binding: 1, resource: { buffer: this.coordBuffer } },
          { binding: 2, resource: { buffer: this.resultBuffer } },
        ],
      });
    }

    const data = new Int32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const c = coords[i]!;
      data[i * 2] = c.q;
      data[i * 2 + 1] = c.r;
    }
    this.device.queue.writeBuffer(this.coordBuffer, 0, data);
  }

  /**
   * Dispatch compute and read back results.
   * Serializes concurrent calls: if a generate is in flight, awaits it first.
   */
  async generate(
    worldConfig: WorldGenConfig,
    hexCount: number,
    forceNoRiver: boolean = false,
  ): Promise<GpuTerrainResult[]> {
    // Serialize: wait for any pending generate to finish
    if (this._pending) {
      await this._pending;
    }
    const promise = this._generate(worldConfig, hexCount, forceNoRiver);
    this._pending = promise;
    try {
      return await promise;
    } finally {
      if (this._pending === promise) {
        this._pending = null;
      }
    }
  }

  private async _generate(
    worldConfig: WorldGenConfig,
    hexCount: number,
    forceNoRiver: boolean,
  ): Promise<GpuTerrainResult[]> {
    // Upload config (80 bytes: 16 TerrainParams fields + 4 hex-specific)
    const configData = new ArrayBuffer(CONFIG_BUFFER_SIZE);
    const i32View = new Int32Array(configData);
    const f32View = new Float32Array(configData);
    const u32View = new Uint32Array(configData);

    // TerrainParams layout (first 16 fields)
    i32View[0] = worldConfig.seed;
    f32View[1] = worldConfig.waterLevel;
    f32View[2] = worldConfig.mountainLevel;
    f32View[3] = worldConfig.vegetationLevel;
    f32View[4] = worldConfig.riverDensity;
    f32View[5] = worldConfig.ruggedness;
    u32View[6] = forceNoRiver ? 1 : 0;
    f32View[7] = worldConfig.continentScale;
    f32View[8] = worldConfig.temperature;
    f32View[9] = worldConfig.ridgeSharpness;
    f32View[10] = worldConfig.plateauFactor;
    f32View[11] = worldConfig.coastComplexity;
    f32View[12] = worldConfig.erosion;
    f32View[13] = worldConfig.valleyDepth;
    f32View[14] = worldConfig.chaos;
    u32View[15] = 0; // _tp_pad

    // Hex-specific fields
    u32View[16] = hexCount;
    f32View[17] = WORLD.HEX_SIZE;
    u32View[18] = 0; // _pad0
    u32View[19] = 0; // _pad1

    this.device.queue.writeBuffer(this.configBuffer, 0, configData);

    const workgroups = Math.ceil(hexCount / 64);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(workgroups);
    pass.end();

    encoder.copyBufferToBuffer(
      this.resultBuffer, 0,
      this.readbackBuffer, 0,
      hexCount * 16,
    );
    this.device.queue.submit([encoder.finish()]);

    await this.readbackBuffer.mapAsync(GPUMapMode.READ, 0, hexCount * 16);
    const range = this.readbackBuffer.getMappedRange(0, hexCount * 16);
    const mapped = new Uint32Array(range);
    const elevView = new DataView(range);

    const results: GpuTerrainResult[] = new Array(hexCount);
    for (let i = 0; i < hexCount; i++) {
      results[i] = {
        terrainId: mapped[i * 4]!,
        elementId: mapped[i * 4 + 1]!,
        flavorId: mapped[i * 4 + 2]!,
        elevation: elevView.getFloat32((i * 4 + 3) * 4, true),
      };
    }

    this.readbackBuffer.unmap();
    return results;
  }

  destroy(): void {
    this.configBuffer.destroy();
    this.coordBuffer.destroy();
    this.resultBuffer.destroy();
    this.readbackBuffer.destroy();
  }
}

// --- GpuTerrainProvider: adapts TerrainCompute to TerrainProvider interface ---

export class GpuTerrainProvider implements TerrainProvider {
  private compute: TerrainCompute;

  private constructor(compute: TerrainCompute) {
    this.compute = compute;
  }

  static create(device: GPUDevice, maxHexes: number): GpuTerrainProvider {
    return new GpuTerrainProvider(TerrainCompute.create(device, maxHexes));
  }

  setCoords(coords: ReadonlyArray<AxialCoord>): void {
    this.compute.setCoords(coords);
  }

  async generate(config: WorldGenConfig, hexCount: number, forceNoRiver?: boolean): Promise<TerrainResult[]> {
    const gpuResults = await this.compute.generate(config, hexCount, forceNoRiver ?? false);
    return gpuResults.map(r => ({
      terrain: terrainFromId(r.terrainId),
      element: elementFromId(r.elementId),
      elevation: r.elevation,
      description: flavorFromId(r.flavorId),
      hasRiver: r.flavorId === 2, // F_RIVER
    }));
  }

  destroy(): void {
    this.compute.destroy();
  }
}

// Re-export the ID→value conversion utilities
export { terrainFromId, elementFromId, flavorFromId };
