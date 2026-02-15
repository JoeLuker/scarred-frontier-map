import { BIOME } from '../core/config';
import { WorldGenConfig } from '../core/types';
import { terrainFromId, elementFromId, flavorFromId } from './types';

// --- Terrain result from GPU readback ---

export interface GpuTerrainResult {
  readonly terrainId: number;
  readonly elementId: number;
  readonly flavorId: number;
  readonly elevation: number;
}

// --- Generate WGSL shader with constants baked in from config.ts ---

function createTerrainShader(): string {
  return /* wgsl */ `
// ============================================================
// Terrain Compute Shader — mirrors src/core/biome.ts + noise.ts
// Constants baked from src/core/config.ts at init time.
// ============================================================

// --- Biome constants (from config.ts BIOME object) ---
const CONTINENTAL_SCALE: f32 = ${BIOME.CONTINENTAL_SCALE};
const RIDGE_SCALE: f32 = ${BIOME.RIDGE_SCALE};
const DETAIL_SCALE: f32 = ${BIOME.DETAIL_SCALE};
const CONTINENTAL_WEIGHT: f32 = ${BIOME.CONTINENTAL_WEIGHT};
const RIDGE_WEIGHT: f32 = ${BIOME.RIDGE_WEIGHT};
const DETAIL_WEIGHT: f32 = ${BIOME.DETAIL_WEIGHT};
const SEA_LEVEL_MIN: f32 = ${BIOME.SEA_LEVEL_MIN};
const SEA_LEVEL_RANGE: f32 = ${BIOME.SEA_LEVEL_RANGE};
const MOUNTAIN_THRESHOLD_BASE: f32 = ${BIOME.MOUNTAIN_THRESHOLD_BASE};
const MOUNTAIN_THRESHOLD_RANGE: f32 = ${BIOME.MOUNTAIN_THRESHOLD_RANGE};
const HILL_OFFSET: f32 = ${BIOME.HILL_OFFSET};
const MOISTURE_SCALE: f32 = ${BIOME.MOISTURE_SCALE};
const MOISTURE_NOISE_WEIGHT: f32 = ${BIOME.MOISTURE_NOISE_WEIGHT};
const COASTAL_WEIGHT: f32 = ${BIOME.COASTAL_WEIGHT};
const VEG_BIAS_WEIGHT: f32 = ${BIOME.VEG_BIAS_WEIGHT};
const RIVER_SCALE: f32 = ${BIOME.RIVER_SCALE};
const RIVER_WARP_AMOUNT: f32 = ${BIOME.RIVER_WARP_AMOUNT};
const RIVER_SENSITIVITY: f32 = ${BIOME.RIVER_SENSITIVITY};
const RIVER_MIN_ELEV: f32 = ${BIOME.RIVER_MIN_ELEV};
const RIVER_HIGH_ELEV: f32 = ${BIOME.RIVER_HIGH_ELEV};
const MOISTURE_DESERT: f32 = ${BIOME.MOISTURE_DESERT};
const MOISTURE_MARSH: f32 = ${BIOME.MOISTURE_MARSH};
const MOISTURE_FOREST: f32 = ${BIOME.MOISTURE_FOREST};

// Settlement / element constants
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

struct Config {
  seed: i32,
  water_level: f32,
  mountain_level: f32,
  vegetation_level: f32,
  river_density: f32,
  ruggedness: f32,
  force_no_river: u32,
  hex_count: u32,
}

struct HexResult {
  terrain: u32,
  element: u32,
  flavor: u32,
  elevation_bits: u32, // f32 elevation stored as bitcast<u32>
}

@group(0) @binding(0) var<uniform> config: Config;
@group(0) @binding(1) var<storage, read> coords: array<vec2i>;
@group(0) @binding(2) var<storage, read_write> results: array<HexResult>;

// ============================================================
// Noise functions — exact port of src/core/noise.ts
// ============================================================

fn hash(x: i32, y: i32, seed: i32) -> u32 {
  var h = bitcast<u32>(seed) ^ (bitcast<u32>(x) * 374761393u) ^ (bitcast<u32>(y) * 668265263u);
  h = (h ^ (h >> 13u)) * 1274126177u;
  return h ^ (h >> 16u);
}

fn smooth_noise(x: f32, y: f32, seed: i32) -> f32 {
  let fx = floor(x);
  let fy = floor(y);
  let ix = i32(fx);
  let iy = i32(fy);

  let bl = f32(hash(ix, iy, seed) % 1000u) / 1000.0;
  let br = f32(hash(ix + 1i, iy, seed) % 1000u) / 1000.0;
  let tl = f32(hash(ix, iy + 1i, seed) % 1000u) / 1000.0;
  let tr = f32(hash(ix + 1i, iy + 1i, seed) % 1000u) / 1000.0;

  let tx = x - fx;
  let ty = y - fy;
  let wx = tx * tx * (3.0 - 2.0 * tx);
  let wy = ty * ty * (3.0 - 2.0 * ty);

  let b = bl + wx * (br - bl);
  let t = tl + wx * (tr - tl);
  return b + wy * (t - b);
}

fn fbm2(x: f32, y: f32, seed: i32) -> f32 {
  let o0 = smooth_noise(x, y, seed);
  let o1 = smooth_noise(x * 2.0, y * 2.0, seed) * 0.5;
  return (o0 + o1) / 1.5;
}

fn fbm3(x: f32, y: f32, seed: i32) -> f32 {
  let o0 = smooth_noise(x, y, seed);
  let o1 = smooth_noise(x * 2.0, y * 2.0, seed) * 0.5;
  let o2 = smooth_noise(x * 4.0, y * 4.0, seed) * 0.25;
  return (o0 + o1 + o2) / 1.75;
}

fn fbm4(x: f32, y: f32, seed: i32) -> f32 {
  let o0 = smooth_noise(x, y, seed);
  let o1 = smooth_noise(x * 2.0, y * 2.0, seed) * 0.5;
  let o2 = smooth_noise(x * 4.0, y * 4.0, seed) * 0.25;
  let o3 = smooth_noise(x * 8.0, y * 8.0, seed) * 0.125;
  return (o0 + o1 + o2 + o3) / 1.875;
}

// ============================================================
// Element & Settlement — exact port of biome.ts helpers
// ============================================================

fn calculate_element(terrain: u32, q: i32, r: i32, seed: i32) -> u32 {
  let val = f32(hash(q, r, seed + HASH_ELEMENT) % 1000u) / 1000.0;

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
  let chaos = f32(hash(q, r, seed + HASH_SETTLEMENT_CHAOS) % 100u) / 100.0;
  score += chaos * SETTLEMENT_CHAOS_WEIGHT;
  return score;
}

// ============================================================
// Main compute kernel — exact port of getBiomeAt
// ============================================================

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= config.hex_count) { return; }

  let coord = coords[idx];
  let q = coord.x;
  let r = coord.y;
  let qf = f32(q);
  let rf = f32(r);
  let seed = config.seed;

  // --- 1. LAYERED ELEVATION ---
  let continental = fbm4(qf * CONTINENTAL_SCALE, rf * CONTINENTAL_SCALE, seed);
  let ridge_raw = fbm3(qf * RIDGE_SCALE, rf * RIDGE_SCALE, seed + 200i);
  let ridge = 1.0 - abs(2.0 * ridge_raw - 1.0);
  let detail = fbm2(qf * DETAIL_SCALE, rf * DETAIL_SCALE, seed + 400i);

  let elevation = clamp(
    continental * CONTINENTAL_WEIGHT
    + ridge * config.mountain_level * RIDGE_WEIGHT
    + detail * config.ruggedness * DETAIL_WEIGHT,
    0.0, 1.0
  );

  // --- 2. THRESHOLDS ---
  let sea_level = SEA_LEVEL_MIN + config.water_level * SEA_LEVEL_RANGE;
  let mt_threshold = MOUNTAIN_THRESHOLD_BASE - config.mountain_level * MOUNTAIN_THRESHOLD_RANGE;
  let hill_threshold = mt_threshold - HILL_OFFSET;

  // --- 3. MOISTURE (elevation-aware) ---
  let moisture_noise = fbm3(qf * MOISTURE_SCALE, rf * MOISTURE_SCALE, seed + 600i);
  let elev_range = mt_threshold - sea_level;
  var coastal_prox = 0.0;
  if (elev_range > 0.0) {
    coastal_prox = clamp(1.0 - (elevation - sea_level) / elev_range, 0.0, 1.0);
  }
  let moisture = clamp(
    moisture_noise * MOISTURE_NOISE_WEIGHT
    + coastal_prox * COASTAL_WEIGHT
    + config.vegetation_level * VEG_BIAS_WEIGHT,
    0.0, 1.0
  );

  // --- 4. RIVERS ---
  let rwx = qf * RIVER_SCALE;
  let rwy = rf * RIVER_SCALE;
  let warp_x = fbm2(rwx * 0.5, rwy * 0.5, seed + 800i) * RIVER_WARP_AMOUNT;
  let warp_y = fbm2(rwx * 0.5 + 5.0, rwy * 0.5 + 5.0, seed + 800i) * RIVER_WARP_AMOUNT;
  let river_noise = fbm2(rwx + warp_x, rwy + warp_y, seed + 700i);
  let river_valley = abs(river_noise - 0.5) * 2.0;
  let is_river = (config.force_no_river == 0u)
    && (river_valley < config.river_density * RIVER_SENSITIVITY)
    && (elevation > sea_level + RIVER_MIN_ELEV)
    && (elevation < mt_threshold - RIVER_HIGH_ELEV);

  // --- 5. BIOME SELECTION ---
  var terrain = T_PLAIN;
  var flavor = F_WILDERNESS;

  if (elevation < sea_level) {
    terrain = T_WATER;
    if (elevation < sea_level * 0.5) { flavor = F_DEEP_OCEAN; }
    else { flavor = F_SHALLOW_SEA; }
  } else if (elevation > mt_threshold) {
    terrain = T_MOUNTAIN;
    if (moisture > 0.5) { flavor = F_SNOW_PEAK; }
    else { flavor = F_BARE_PEAK; }
  } else if (is_river) {
    terrain = T_WATER;
    flavor = F_RIVER;
  } else if (elevation > hill_threshold) {
    terrain = T_HILL;
    if (moisture > MOISTURE_FOREST) { flavor = F_WOODED_HILLS; }
    else { flavor = F_ROCKY_BLUFFS; }
  } else {
    if (moisture < MOISTURE_DESERT) {
      terrain = T_DESERT;
      if (moisture < MOISTURE_DESERT * 0.5) { flavor = F_BARREN_WASTE; }
      else { flavor = F_ARID_SCRUB; }
    } else if (moisture > MOISTURE_MARSH) {
      terrain = T_MARSH;
      if (moisture > (1.0 + MOISTURE_MARSH) * 0.5) { flavor = F_DEEP_SWAMP; }
      else { flavor = F_WETLAND; }
    } else if (moisture > MOISTURE_FOREST) {
      terrain = T_FOREST;
      if (moisture > (MOISTURE_FOREST + MOISTURE_MARSH) * 0.5) { flavor = F_DENSE_FOREST; }
      else { flavor = F_LIGHT_WOOD; }
    } else {
      terrain = T_PLAIN;
      if (moisture > (MOISTURE_DESERT + MOISTURE_FOREST) * 0.5) { flavor = F_GRASSLAND; }
      else { flavor = F_DRY_PLAINS; }
    }
  }

  // --- 6. ELEMENT & SETTLEMENT ---
  let element = calculate_element(terrain, q, r, seed);
  let sroll = f32(hash(q, r, seed + HASH_SETTLEMENT_ROLL) % 100u) / 100.0;

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

    // Config: seed(i32) + 5 floats + force_no_river(u32) + hex_count(u32) = 32 bytes
    const configBuffer = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Coords: vec2<i32> per hex = 8 bytes each
    const coordBuffer = device.createBuffer({
      size: maxHexes * 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Results: 4 × u32 per hex = 16 bytes each
    const resultBuffer = device.createBuffer({
      size: maxHexes * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    // Readback buffer (mappable)
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

    // Grow buffers if needed
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

      // Recreate bind group with new buffers
      this.bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.configBuffer } },
          { binding: 1, resource: { buffer: this.coordBuffer } },
          { binding: 2, resource: { buffer: this.resultBuffer } },
        ],
      });
    }

    // Upload coordinate data
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
   * Returns one GpuTerrainResult per hex (same order as setCoords).
   */
  async generate(
    worldConfig: WorldGenConfig,
    hexCount: number,
    forceNoRiver: boolean = false,
  ): Promise<GpuTerrainResult[]> {
    // Upload config
    const configData = new ArrayBuffer(32);
    const i32View = new Int32Array(configData);
    const f32View = new Float32Array(configData);
    const u32View = new Uint32Array(configData);

    i32View[0] = worldConfig.seed;                 // seed (i32)
    f32View[1] = worldConfig.waterLevel;            // water_level
    f32View[2] = worldConfig.mountainLevel;         // mountain_level
    f32View[3] = worldConfig.vegetationLevel;       // vegetation_level
    f32View[4] = worldConfig.riverDensity;          // river_density
    f32View[5] = worldConfig.ruggedness;            // ruggedness
    u32View[6] = forceNoRiver ? 1 : 0;             // force_no_river
    u32View[7] = hexCount;                          // hex_count

    this.device.queue.writeBuffer(this.configBuffer, 0, configData);

    // Dispatch compute
    const workgroups = Math.ceil(hexCount / 64);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(workgroups);
    pass.end();

    // Copy results to readback buffer
    encoder.copyBufferToBuffer(
      this.resultBuffer, 0,
      this.readbackBuffer, 0,
      hexCount * 16,
    );
    this.device.queue.submit([encoder.finish()]);

    // Read back
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
        elevation: elevView.getFloat32((i * 4 + 3) * 4, true), // little-endian
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

// Re-export the ID→value conversion utilities
export { terrainFromId, elementFromId, flavorFromId };
