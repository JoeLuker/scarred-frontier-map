import { TERRAIN, BIOME, WORLD } from '../core/config';
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
// Terrain Compute Shader — mirrors src/core/terrain.ts + biome.ts
// Constants baked from src/core/config.ts at init time.
// Samples noise in world-space (pixel) coordinates via hex_to_pixel.
// ============================================================

// --- Terrain field constants (from config.ts TERRAIN object, world-space) ---
const CONTINENTAL_SCALE: f32 = ${TERRAIN.CONTINENTAL_SCALE};
const RIDGE_SCALE: f32 = ${TERRAIN.RIDGE_SCALE};
const DETAIL_SCALE: f32 = ${TERRAIN.DETAIL_SCALE};
const CONTINENTAL_WEIGHT: f32 = ${TERRAIN.CONTINENTAL_WEIGHT};
const RIDGE_WEIGHT: f32 = ${TERRAIN.RIDGE_WEIGHT};
const DETAIL_WEIGHT: f32 = ${TERRAIN.DETAIL_WEIGHT};
const SEA_LEVEL_MIN: f32 = ${TERRAIN.SEA_LEVEL_MIN};
const SEA_LEVEL_RANGE: f32 = ${TERRAIN.SEA_LEVEL_RANGE};
const MOUNTAIN_THRESHOLD_BASE: f32 = ${TERRAIN.MOUNTAIN_THRESHOLD_BASE};
const MOUNTAIN_THRESHOLD_RANGE: f32 = ${TERRAIN.MOUNTAIN_THRESHOLD_RANGE};
const HILL_OFFSET: f32 = ${TERRAIN.HILL_OFFSET};
const MOISTURE_SCALE: f32 = ${TERRAIN.MOISTURE_SCALE};
const MOISTURE_NOISE_WEIGHT: f32 = ${TERRAIN.MOISTURE_NOISE_WEIGHT};
const COASTAL_WEIGHT: f32 = ${TERRAIN.COASTAL_WEIGHT};
const VEG_BIAS_WEIGHT: f32 = ${TERRAIN.VEG_BIAS_WEIGHT};
const RIVER_SCALE: f32 = ${TERRAIN.RIVER_SCALE};
const RIVER_WARP_AMOUNT: f32 = ${TERRAIN.RIVER_WARP_AMOUNT};
const RIVER_SENSITIVITY: f32 = ${TERRAIN.RIVER_SENSITIVITY};
const RIVER_MIN_ELEV: f32 = ${TERRAIN.RIVER_MIN_ELEV};
const RIVER_HIGH_ELEV: f32 = ${TERRAIN.RIVER_HIGH_ELEV};
const MOISTURE_DESERT: f32 = ${TERRAIN.MOISTURE_DESERT};
const MOISTURE_MARSH: f32 = ${TERRAIN.MOISTURE_MARSH};
const MOISTURE_FOREST: f32 = ${TERRAIN.MOISTURE_FOREST};
const COAST_NOISE_SCALE: f32 = ${TERRAIN.COAST_NOISE_SCALE};
const DOMAIN_WARP_SCALE: f32 = ${TERRAIN.DOMAIN_WARP_SCALE};
const DOMAIN_WARP_MAX: f32 = ${TERRAIN.DOMAIN_WARP_MAX};

// --- Per-hex constants (from config.ts BIOME object) ---
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
  hex_size: f32,
  continent_scale: f32,
  temperature: f32,
  ridge_sharpness: f32,
  plateau_factor: f32,
  coast_complexity: f32,
  erosion: f32,
  valley_depth: f32,
  chaos: f32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
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
// Hex → World-space conversion (pointy-top axial hex layout)
// ============================================================

fn hex_to_pixel(q: i32, r: i32, hex_size: f32) -> vec2f {
  let qf = f32(q);
  let rf = f32(r);
  return vec2f(hex_size * 1.7320508 * (qf + rf * 0.5), hex_size * 1.5 * rf);
}

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
// Main compute kernel — samples terrain in world-space
// ============================================================

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= config.hex_count) { return; }

  let coord = coords[idx];
  let q = coord.x;
  let r = coord.y;
  let seed = config.seed;

  // Convert hex coords to world-space pixel coords
  let wp = hex_to_pixel(q, r, config.hex_size);

  // --- 0. CHAOS DOMAIN WARP ---
  var sx = wp.x;
  var sy = wp.y;
  if (config.chaos > 0.0) {
    let warp_amount = config.chaos * DOMAIN_WARP_MAX;
    let wx = fbm3(wp.x * DOMAIN_WARP_SCALE, wp.y * DOMAIN_WARP_SCALE, seed + 900i);
    let wy = fbm3(wp.x * DOMAIN_WARP_SCALE + 7.0, wp.y * DOMAIN_WARP_SCALE + 7.0, seed + 900i);
    sx = wp.x + (wx - 0.5) * warp_amount;
    sy = wp.y + (wy - 0.5) * warp_amount;
  }

  // --- 1. LAYERED ELEVATION (world-space sampling) ---
  let cont_freq = CONTINENTAL_SCALE * (0.25 + config.continent_scale * 1.5);
  let continental = fbm4(sx * cont_freq, sy * cont_freq, seed);
  let ridge_raw = fbm3(sx * RIDGE_SCALE, sy * RIDGE_SCALE, seed + 200i);
  let ridge_exp = 0.3 + config.ridge_sharpness * 1.4;
  let ridge = pow(1.0 - abs(2.0 * ridge_raw - 1.0), ridge_exp);
  let detail = fbm2(sx * DETAIL_SCALE, sy * DETAIL_SCALE, seed + 400i);

  // Erosion: suppress ridge and detail weights
  let eff_ridge_weight = RIDGE_WEIGHT * (1.0 - config.erosion * 0.5);
  let eff_detail_weight = DETAIL_WEIGHT * (1.0 - config.erosion * 0.9);

  var elevation = clamp(
    continental * CONTINENTAL_WEIGHT
    + ridge * config.mountain_level * eff_ridge_weight
    + detail * config.ruggedness * eff_detail_weight,
    0.0, 1.0
  );

  // --- 2. THRESHOLDS ---
  let base_sea_level = SEA_LEVEL_MIN + config.water_level * SEA_LEVEL_RANGE;
  let mt_threshold = MOUNTAIN_THRESHOLD_BASE - config.mountain_level * MOUNTAIN_THRESHOLD_RANGE;
  let hill_threshold = mt_threshold - HILL_OFFSET;

  // --- 2b. COAST COMPLEXITY ---
  var sea_level = base_sea_level;
  if (config.coast_complexity > 0.0) {
    let coast_noise = fbm2(sx * COAST_NOISE_SCALE, sy * COAST_NOISE_SCALE, seed + 1100i) - 0.5;
    sea_level = max(0.01, base_sea_level + coast_noise * config.coast_complexity * 0.1);
  }

  // --- 2c. PLATEAU QUANTIZATION ---
  if (config.plateau_factor > 0.0) {
    let bands = 3.0 + (1.0 - config.plateau_factor) * 20.0;
    let quantized = round(elevation * bands) / bands;
    let blend = config.plateau_factor * config.plateau_factor;
    elevation = elevation * (1.0 - blend) + quantized * blend;
  }

  // --- 2d. VALLEY DEPTH ---
  let midpoint = (sea_level + mt_threshold) * 0.5;
  if (elevation > sea_level && elevation < midpoint) {
    let vrange = midpoint - sea_level;
    if (vrange > 0.0) {
      let t = (elevation - sea_level) / vrange;
      let shaped = pow(t, 0.5 + config.valley_depth);
      elevation = sea_level + shaped * vrange;
    }
  }

  // --- 3. MOISTURE (elevation-aware, world-space sampling) ---
  let moisture_noise = fbm3(sx * MOISTURE_SCALE, sy * MOISTURE_SCALE, seed + 600i);
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

  // --- 4. RIVERS (world-space sampling) ---
  let rwx = sx * RIVER_SCALE;
  let rwy = sy * RIVER_SCALE;
  let warp_x = fbm2(rwx * 0.5, rwy * 0.5, seed + 800i) * RIVER_WARP_AMOUNT;
  let warp_y = fbm2(rwx * 0.5 + 5.0, rwy * 0.5 + 5.0, seed + 800i) * RIVER_WARP_AMOUNT;
  let river_noise = fbm2(rwx + warp_x, rwy + warp_y, seed + 700i);
  let river_valley = abs(river_noise - 0.5) * 2.0;
  let is_river = (config.force_no_river == 0u)
    && (river_valley < config.river_density * RIVER_SENSITIVITY)
    && (elevation > sea_level + RIVER_MIN_ELEV)
    && (elevation < mt_threshold - RIVER_HIGH_ELEV);

  // --- 5. BIOME SELECTION with temperature shift ---
  let temp_shift = config.temperature - 0.5;
  let desert_threshold = MOISTURE_DESERT + temp_shift * 0.3;
  let forest_threshold = MOISTURE_FOREST + temp_shift * 0.2;
  let marsh_threshold = MOISTURE_MARSH - temp_shift * 0.2;

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

  // --- 6. ELEMENT & SETTLEMENT (per-hex, uses integer coords) ---
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

// Config buffer: 17 active fields + 3 padding = 20 × 4 = 80 bytes (16-byte aligned)
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
  private generating = false;

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
    // Prevent overlapping mapAsync calls
    if (this.generating) return [];
    this.generating = true;
    try {
      return await this._generate(worldConfig, hexCount, forceNoRiver);
    } finally {
      this.generating = false;
    }
  }

  private async _generate(
    worldConfig: WorldGenConfig,
    hexCount: number,
    forceNoRiver: boolean,
  ): Promise<GpuTerrainResult[]> {
    // Upload config (80 bytes: 17 fields + 3 padding)
    const configData = new ArrayBuffer(CONFIG_BUFFER_SIZE);
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
    f32View[8] = WORLD.HEX_SIZE;                    // hex_size
    f32View[9] = worldConfig.continentScale;        // continent_scale
    f32View[10] = worldConfig.temperature;          // temperature
    f32View[11] = worldConfig.ridgeSharpness;       // ridge_sharpness
    f32View[12] = worldConfig.plateauFactor;        // plateau_factor
    f32View[13] = worldConfig.coastComplexity;      // coast_complexity
    f32View[14] = worldConfig.erosion;              // erosion
    f32View[15] = worldConfig.valleyDepth;          // valley_depth
    f32View[16] = worldConfig.chaos;                // chaos
    // [17], [18], [19] = padding (zeroed by ArrayBuffer)

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
