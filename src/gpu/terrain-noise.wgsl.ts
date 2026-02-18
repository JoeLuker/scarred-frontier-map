import { TERRAIN } from '../core/config';

/**
 * Shared WGSL noise functions and terrain field sampling.
 * Single source of truth for terrain generation — used by both
 * TerrainCompute (hex biome classification) and MeshCompute (vertex elevation+moisture).
 *
 * Defines:
 * - TerrainParams struct (WorldGenConfig fields relevant to terrain sampling)
 * - TerrainFieldSample result struct
 * - NoiseDeriv struct (value + analytical partial derivatives)
 * - Noise primitives: hash, smooth_noise, smooth_noise_d (with derivatives)
 * - Simple fBM: fbm2, fbm3 (for moisture, rivers, coast)
 * - IQ derivative-feedback fBM (Quilez) — heterogeneous continental shapes
 * - Swiss turbulence (de Carpentier) — sharp ridges with smooth valleys
 * - Double domain warp — nested warping for tectonic distortion
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

// Noise value with analytical partial derivatives
struct NoiseDeriv {
  val: f32,
  dx: f32,
  dy: f32,
}

// ============================================================
// Noise primitives
// ============================================================

fn hash(x: i32, y: i32, seed: i32) -> u32 {
  var h = bitcast<u32>(seed) ^ (bitcast<u32>(x) * 374761393u) ^ (bitcast<u32>(y) * 668265263u);
  h = (h ^ (h >> 13u)) * 1274126177u;
  return h ^ (h >> 16u);
}

fn hash_norm(x: i32, y: i32, seed: i32) -> f32 {
  return f32(hash(x, y, seed)) / 4294967296.0;
}

// Value noise with cubic hermite interpolation
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

// Value noise with analytical partial derivatives (hermite interpolation).
// Returns NoiseDeriv where .dx/.dy are partial derivatives w.r.t. input coords.
fn smooth_noise_d(x: f32, y: f32, seed: i32) -> NoiseDeriv {
  let fx = floor(x);
  let fy = floor(y);
  let ix = i32(fx);
  let iy = i32(fy);

  // Corner values
  let a = f32(hash(ix, iy, seed)) / 4294967296.0;
  let b = f32(hash(ix + 1i, iy, seed)) / 4294967296.0;
  let c = f32(hash(ix, iy + 1i, seed)) / 4294967296.0;
  let d = f32(hash(ix + 1i, iy + 1i, seed)) / 4294967296.0;

  let tx = x - fx;
  let ty = y - fy;

  // Hermite interpolation weights: w(t) = t²(3 - 2t)
  let wx = tx * tx * (3.0 - 2.0 * tx);
  let wy = ty * ty * (3.0 - 2.0 * ty);

  // Hermite derivatives: dw/dt = 6t(1-t)
  let dwx = 6.0 * tx * (1.0 - tx);
  let dwy = 6.0 * ty * (1.0 - ty);

  // Bilinear coefficients: f = a + k1*wx + k2*wy + k3*wx*wy
  let k1 = b - a;
  let k2 = c - a;
  let k3 = a - b - c + d;

  return NoiseDeriv(
    a + k1 * wx + k2 * wy + k3 * wx * wy,
    dwx * (k1 + k3 * wy),
    dwy * (k2 + k3 * wx),
  );
}

// ============================================================
// Simple fBM (used for moisture, rivers, coast — no derivatives needed)
// ============================================================

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

// ============================================================
// Advanced noise functions
// ============================================================

// IQ derivative-feedback fBM (Inigo Quilez).
// Accumulates noise derivatives and suppresses fine octaves where terrain is
// already steep. Produces heterogeneous landmasses: flat interiors with full
// detail, steep continental edges with smooth falloff.
// Returns NoiseDeriv: .val is the fBM value, .dx/.dy are the accumulated
// gradient (useful for wind-shadow moisture and slope-dependent effects).
fn iq_fbm(
  x: f32, y: f32, seed: i32,
  octaves: i32, lacunarity: f32, gain: f32,
) -> NoiseDeriv {
  var sum = 0.0;
  var sum_d = vec2f(0.0);
  var amp = 1.0;
  var freq = 1.0;
  var eff_max = 0.0;

  for (var i = 0i; i < octaves; i++) {
    let n = smooth_noise_d(x * freq, y * freq, seed + i * FBM_SEED_STRIDE);
    sum_d += vec2f(n.dx, n.dy);
    // Suppression factor: steep areas get less fine detail
    let suppress = 1.0 / (1.0 + dot(sum_d, sum_d));
    sum += amp * suppress * n.val;
    // Track effective amplitude so normalization preserves [0,1] range.
    // Without this, the suppression compresses values toward zero,
    // pushing most terrain below sea level.
    eff_max += amp * suppress;
    amp *= gain;
    freq *= lacunarity;
  }

  let inv = 1.0 / max(eff_max, 0.001);
  return NoiseDeriv(sum * inv, sum_d.x * inv, sum_d.y * inv);
}

// Swiss turbulence (de Carpentier / Jordan).
// Ridged noise with derivative-driven coordinate warping. Each octave's
// gradient accumulates and warps subsequent octaves toward ridge lines.
// Valleys get reduced amplitude (smooth), ridges accumulate sharp detail.
// warp: controls how aggressively coordinates are pulled toward ridges (0.0-1.0).
fn swiss_turbulence(
  x: f32, y: f32, seed: i32,
  octaves: i32, lacunarity: f32, gain: f32, warp: f32,
) -> f32 {
  var sum = 0.0;
  var sum_d = vec2f(0.0);
  var amp = 1.0;
  var freq = 1.0;
  var max_amp = 0.0;

  for (var i = 0i; i < octaves; i++) {
    // Warp coordinates by accumulated derivative (pulls toward ridge lines)
    let px = x * freq + sum_d.x * warp;
    let py = y * freq + sum_d.y * warp;

    let n = smooth_noise_d(px, py, seed + i * FBM_SEED_STRIDE);

    // Ridge transform: peak at noise = 0.5, valleys at 0 and 1
    let r = 1.0 - abs(2.0 * n.val - 1.0);
    sum += amp * r * r;
    max_amp += amp;

    // Derivative accumulation with ridge weighting (de Carpentier's formulation)
    // -r pulls coordinates toward ridges; amplitude weighting maintains octave balance
    sum_d += vec2f(n.dx, n.dy) * amp * -r;

    // Amplitude modulation: valleys (low running sum) suppress fine detail
    amp *= gain * clamp(sum, 0.0, 1.0);
    freq *= lacunarity;
  }

  return sum / max(max_amp, 0.001);
}

// Double domain warp: nested coordinate warping for tectonic-like distortion.
// Inner warp creates broad deformation, outer warp adds secondary folding.
// More organic than single-pass warp — produces curving, layered landforms.
fn double_warp(x: f32, y: f32, seed: i32, scale: f32, strength: f32) -> vec2f {
  // Inner warp field
  let inner_x = fbm3(x * scale, y * scale, seed + 900i);
  let inner_y = fbm3(x * scale + WARP_COORD_OFFSET, y * scale + WARP_COORD_OFFSET, seed + 900i);

  // Apply inner warp at half strength
  let mx = x + (inner_x - 0.5) * strength * 0.5;
  let my = y + (inner_y - 0.5) * strength * 0.5;

  // Outer warp field (higher frequency for secondary detail)
  let outer_x = fbm3(mx * scale * 1.5, my * scale * 1.5, seed + 950i);
  let outer_y = fbm3(mx * scale * 1.5 + WARP_COORD_OFFSET, my * scale * 1.5 + WARP_COORD_OFFSET, seed + 950i);

  return vec2f(
    x + (outer_x - 0.5) * strength,
    y + (outer_y - 0.5) * strength,
  );
}

// ============================================================
// Terrain field sampling — full elevation+moisture pipeline
// ============================================================

fn sample_terrain_field(wx: f32, wy: f32, p: TerrainParams) -> TerrainFieldSample {
  let seed = p.seed;

  // --- 0. DOMAIN WARP (double warp for organic tectonic distortion) ---
  var sx = wx;
  var sy = wy;
  if (p.chaos > 0.0) {
    let warped = double_warp(wx, wy, seed, DOMAIN_WARP_SCALE, p.chaos * DOMAIN_WARP_MAX);
    sx = warped.x;
    sy = warped.y;
  }

  // --- 1. LAYERED ELEVATION ---
  // Continental: IQ fBM — derivative feedback creates heterogeneous landmasses
  // Returns NoiseDeriv: .val for elevation, .dx/.dy for wind-shadow moisture
  let cont_freq = CONTINENTAL_SCALE * (CONT_FREQ_BASE + p.continent_scale * CONT_FREQ_RANGE);
  let continental_n = iq_fbm(sx * cont_freq, sy * cont_freq, seed, 6, 2.0, 0.5);
  let continental = continental_n.val;

  // Ridges: Swiss turbulence — sharp convergent ridges with smooth valleys
  let warp_str = 0.3 + p.ridge_sharpness * 0.7;
  let ridge = swiss_turbulence(sx * RIDGE_SCALE, sy * RIDGE_SCALE, seed + 200i, 5, 2.2, 0.5, warp_str);

  // Detail: simple fBM for local roughness
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

  // Wind-shadow (orographic precipitation): windward slopes get more moisture,
  // leeward slopes get less (rain shadow). Wind blows west-to-east (+X direction).
  // The continental gradient tells us terrain slope direction. Projecting onto
  // wind direction: positive = windward (upslope), negative = leeward (downslope).
  let wind_dir = vec2f(1.0, 0.0);
  let terrain_gradient = vec2f(continental_n.dx, continental_n.dy) * cont_freq;
  let windward = dot(terrain_gradient, wind_dir);
  let wind_shadow = clamp(windward * 2.0, -0.15, 0.15);

  let moisture = clamp(
    moisture_noise * MOISTURE_NOISE_WEIGHT
    + coastal_prox * COASTAL_WEIGHT
    + p.vegetation_level * VEG_BIAS_WEIGHT
    + wind_shadow,
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
