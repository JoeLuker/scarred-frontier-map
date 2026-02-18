import { TERRAIN } from '../core/config';

/**
 * Shared WGSL noise functions and terrain field sampling.
 * Single source of truth for terrain generation — used by both
 * TerrainCompute (hex biome classification) and MeshCompute (vertex elevation+moisture).
 *
 * Defines:
 * - TerrainParams struct (WorldGenConfig fields relevant to terrain sampling)
 * - TerrainFieldSample result struct
 * - Noise primitives: hash, smooth_noise, fbm2/3/4
 * - sample_terrain_field(x, z, params) — full elevation+moisture pipeline
 *
 * Constants are baked from src/core/config.ts at module load time.
 */

export function createTerrainNoiseWGSL(): string {
  return /* wgsl */ `
// ============================================================
// Shared Terrain Noise — single implementation of terrain field sampling
// Constants baked from src/core/config.ts at init time.
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
const COAST_NOISE_SCALE: f32 = ${TERRAIN.COAST_NOISE_SCALE};
const DOMAIN_WARP_SCALE: f32 = ${TERRAIN.DOMAIN_WARP_SCALE};
const DOMAIN_WARP_MAX: f32 = ${TERRAIN.DOMAIN_WARP_MAX};
const WARP_COORD_OFFSET: f32 = ${TERRAIN.WARP_COORD_OFFSET};
const CONT_FREQ_BASE: f32 = ${TERRAIN.CONT_FREQ_BASE};
const CONT_FREQ_RANGE: f32 = ${TERRAIN.CONT_FREQ_RANGE};
const RIDGE_EXP_BASE: f32 = ${TERRAIN.RIDGE_EXP_BASE};
const RIDGE_EXP_RANGE: f32 = ${TERRAIN.RIDGE_EXP_RANGE};
const EROSION_RIDGE_FACTOR: f32 = ${TERRAIN.EROSION_RIDGE_FACTOR};
const EROSION_DETAIL_FACTOR: f32 = ${TERRAIN.EROSION_DETAIL_FACTOR};
const COAST_AMPLITUDE: f32 = ${TERRAIN.COAST_AMPLITUDE};
const COAST_MIN_SEA_LEVEL: f32 = ${TERRAIN.COAST_MIN_SEA_LEVEL};
const PLATEAU_BANDS_MIN: f32 = ${TERRAIN.PLATEAU_BANDS_MIN};
const PLATEAU_BANDS_RANGE: f32 = ${TERRAIN.PLATEAU_BANDS_RANGE};
const VALLEY_EXP_BASE: f32 = ${TERRAIN.VALLEY_EXP_BASE};
const RIVER_WARP_FREQ: f32 = ${TERRAIN.RIVER_WARP_FREQ};
const RIVER_WARP_OFFSET: f32 = ${TERRAIN.RIVER_WARP_OFFSET};

// --- Terrain generation params (mirrors WorldGenConfig + force_no_river) ---

struct TerrainParams {
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
  _pad0: u32,
}

struct TerrainFieldSample {
  elevation: f32,
  moisture: f32,
  sea_level: f32,
  mountain_threshold: f32,
  hill_threshold: f32,
  is_river: bool,
}

// ============================================================
// Noise functions — exact port of src/core/noise.ts
// ============================================================

fn hash(x: i32, y: i32, seed: i32) -> u32 {
  var h = bitcast<u32>(seed) ^ (bitcast<u32>(x) * 374761393u) ^ (bitcast<u32>(y) * 668265263u);
  h = (h ^ (h >> 13u)) * 1274126177u;
  return h ^ (h >> 16u);
}

fn hash_norm(x: i32, y: i32, seed: i32) -> f32 {
  return f32(hash(x, y, seed)) / 4294967296.0;
}

fn smooth_noise(x: f32, y: f32, seed: i32) -> f32 {
  let fx = floor(x);
  let fy = floor(y);
  let ix = i32(fx);
  let iy = i32(fy);

  let bl = f32(hash(ix, iy, seed)) / 4294967296.0;
  let br = f32(hash(ix + 1i, iy, seed)) / 4294967296.0;
  let tl = f32(hash(ix, iy + 1i, seed)) / 4294967296.0;
  let tr = f32(hash(ix + 1i, iy + 1i, seed)) / 4294967296.0;

  let tx = x - fx;
  let ty = y - fy;
  let wx = tx * tx * (3.0 - 2.0 * tx);
  let wy = ty * ty * (3.0 - 2.0 * ty);

  let b = bl + wx * (br - bl);
  let t = tl + wx * (tr - tl);
  return b + wy * (t - b);
}

const FBM_SEED_STRIDE: i32 = 31;

fn fbm2(x: f32, y: f32, seed: i32) -> f32 {
  let o0 = smooth_noise(x, y, seed);
  let o1 = smooth_noise(x * 2.0, y * 2.0, seed + FBM_SEED_STRIDE) * 0.5;
  return (o0 + o1) / 1.5;
}

fn fbm3(x: f32, y: f32, seed: i32) -> f32 {
  let o0 = smooth_noise(x, y, seed);
  let o1 = smooth_noise(x * 2.0, y * 2.0, seed + FBM_SEED_STRIDE) * 0.5;
  let o2 = smooth_noise(x * 4.0, y * 4.0, seed + FBM_SEED_STRIDE * 2) * 0.25;
  return (o0 + o1 + o2) / 1.75;
}

fn fbm4(x: f32, y: f32, seed: i32) -> f32 {
  let o0 = smooth_noise(x, y, seed);
  let o1 = smooth_noise(x * 2.0, y * 2.0, seed + FBM_SEED_STRIDE) * 0.5;
  let o2 = smooth_noise(x * 4.0, y * 4.0, seed + FBM_SEED_STRIDE * 2) * 0.25;
  let o3 = smooth_noise(x * 8.0, y * 8.0, seed + FBM_SEED_STRIDE * 3) * 0.125;
  return (o0 + o1 + o2 + o3) / 1.875;
}

// ============================================================
// Terrain field sampling — full elevation+moisture pipeline
// ============================================================

fn sample_terrain_field(wx: f32, wy: f32, p: TerrainParams) -> TerrainFieldSample {
  let seed = p.seed;

  // --- 0. CHAOS DOMAIN WARP ---
  var sx = wx;
  var sy = wy;
  if (p.chaos > 0.0) {
    let warp_amount = p.chaos * DOMAIN_WARP_MAX;
    let dwx = fbm3(wx * DOMAIN_WARP_SCALE, wy * DOMAIN_WARP_SCALE, seed + 900i);
    let dwy = fbm3(wx * DOMAIN_WARP_SCALE + WARP_COORD_OFFSET, wy * DOMAIN_WARP_SCALE + WARP_COORD_OFFSET, seed + 900i);
    sx = wx + (dwx - 0.5) * warp_amount;
    sy = wy + (dwy - 0.5) * warp_amount;
  }

  // --- 1. LAYERED ELEVATION ---
  let cont_freq = CONTINENTAL_SCALE * (CONT_FREQ_BASE + p.continent_scale * CONT_FREQ_RANGE);
  let continental = fbm4(sx * cont_freq, sy * cont_freq, seed);
  let ridge_raw = fbm3(sx * RIDGE_SCALE, sy * RIDGE_SCALE, seed + 200i);
  let ridge_exp = RIDGE_EXP_BASE + p.ridge_sharpness * RIDGE_EXP_RANGE;
  let ridge = pow(1.0 - abs(2.0 * ridge_raw - 1.0), ridge_exp);
  let detail = fbm2(sx * DETAIL_SCALE, sy * DETAIL_SCALE, seed + 400i);

  let eff_ridge_weight = RIDGE_WEIGHT * (1.0 - p.erosion * EROSION_RIDGE_FACTOR);
  let eff_detail_weight = DETAIL_WEIGHT * (1.0 - p.erosion * EROSION_DETAIL_FACTOR);

  var elevation = clamp(
    continental * CONTINENTAL_WEIGHT
    + ridge * p.mountain_level * eff_ridge_weight
    + detail * p.ruggedness * eff_detail_weight,
    0.0, 1.0
  );

  // --- 2. THRESHOLDS ---
  let base_sea_level = SEA_LEVEL_MIN + p.water_level * SEA_LEVEL_RANGE;
  let mt_threshold = MOUNTAIN_THRESHOLD_BASE - p.mountain_level * MOUNTAIN_THRESHOLD_RANGE;
  let hill_threshold = mt_threshold - HILL_OFFSET;

  // --- 2b. COAST COMPLEXITY ---
  var sea_level = base_sea_level;
  if (p.coast_complexity > 0.0) {
    let coast_noise = fbm2(sx * COAST_NOISE_SCALE, sy * COAST_NOISE_SCALE, seed + 1100i) - 0.5;
    sea_level = max(COAST_MIN_SEA_LEVEL, base_sea_level + coast_noise * p.coast_complexity * COAST_AMPLITUDE);
  }

  // --- 2c. PLATEAU QUANTIZATION ---
  if (p.plateau_factor > 0.0) {
    let bands = PLATEAU_BANDS_MIN + (1.0 - p.plateau_factor) * PLATEAU_BANDS_RANGE;
    let quantized = round(elevation * bands) / bands;
    let blend = p.plateau_factor * p.plateau_factor;
    elevation = elevation * (1.0 - blend) + quantized * blend;
  }

  // --- 2d. VALLEY DEPTH ---
  let midpoint = (sea_level + mt_threshold) * 0.5;
  if (elevation > sea_level && elevation < midpoint) {
    let vrange = midpoint - sea_level;
    if (vrange > 0.0) {
      let t = (elevation - sea_level) / vrange;
      let shaped = pow(t, VALLEY_EXP_BASE + p.valley_depth);
      elevation = sea_level + shaped * vrange;
    }
  }

  // --- 3. MOISTURE ---
  let moisture_noise = fbm3(sx * MOISTURE_SCALE, sy * MOISTURE_SCALE, seed + 600i);
  let elev_range = mt_threshold - sea_level;
  var coastal_prox = 0.0;
  if (elev_range > 0.0) {
    coastal_prox = clamp(1.0 - (elevation - sea_level) / elev_range, 0.0, 1.0);
  }
  let moisture = clamp(
    moisture_noise * MOISTURE_NOISE_WEIGHT
    + coastal_prox * COASTAL_WEIGHT
    + p.vegetation_level * VEG_BIAS_WEIGHT,
    0.0, 1.0
  );

  // --- 4. RIVERS ---
  let rwx = sx * RIVER_SCALE;
  let rwy = sy * RIVER_SCALE;
  let warp_x = fbm2(rwx * RIVER_WARP_FREQ, rwy * RIVER_WARP_FREQ, seed + 800i) * RIVER_WARP_AMOUNT;
  let warp_y = fbm2(rwx * RIVER_WARP_FREQ + RIVER_WARP_OFFSET, rwy * RIVER_WARP_FREQ + RIVER_WARP_OFFSET, seed + 800i) * RIVER_WARP_AMOUNT;
  let river_noise = fbm2(rwx + warp_x, rwy + warp_y, seed + 700i);
  let river_valley = abs(river_noise - 0.5) * 2.0;
  let is_river = (p.force_no_river == 0u)
    && (river_valley < p.river_density * RIVER_SENSITIVITY)
    && (elevation > sea_level + RIVER_MIN_ELEV)
    && (elevation < mt_threshold - RIVER_HIGH_ELEV);

  // Rivers carry flat elevation
  if (is_river) {
    elevation = sea_level;
  }

  return TerrainFieldSample(elevation, moisture, sea_level, mt_threshold, hill_threshold, is_river);
}
`;
}
