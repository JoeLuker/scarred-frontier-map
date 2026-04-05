/**
 * Procedural terrain material detail functions (WGSL).
 * Each function returns a MaterialSample that modifies the base terrain color
 * with high-frequency procedural detail — color perturbation + normal perturbation.
 *
 * Uses noise functions from render-noise.wgsl.ts (value_noise, fbm3, hash2).
 * Max 3-4 noise samples per material to stay within performance budget.
 *
 * Distance-aware: material detail fades out at far zoom to avoid aliasing.
 */

export function createTerrainMaterialsWGSL(): string {
  return /* wgsl */ `

// ============================================================
// Procedural terrain material detail
// ============================================================

struct MaterialSample {
  color_mod: vec3f,
  normal_offset: vec3f,
  roughness: f32,
}

const MATERIAL_IDENTITY: MaterialSample = MaterialSample(vec3f(1.0), vec3f(0.0), 0.5);

// Distance-based detail fade: 1.0 at close range, 0.0 at far zoom.
// Prevents noise aliasing and saves GPU cycles at distance.
fn material_detail_fade(world_pos: vec3f, eye_pos: vec3f) -> f32 {
  let d = length(world_pos - eye_pos);
  return 1.0 - smoothstep(1500.0, 3500.0, d);
}

fn sample_sand(world_xz: vec2f) -> MaterialSample {
  // Rippled dune pattern at medium frequency
  let ripple = value_noise(world_xz * 0.15);
  // Fine grain texture
  let grain = value_noise(world_xz * 0.4 + vec2f(30.0, 60.0));

  let color_mod = vec3f(
    0.95 + ripple * 0.08 + grain * 0.04,
    0.94 + ripple * 0.06,
    0.90 + grain * 0.06 + ripple * 0.04,
  );

  // Normal from ripple gradient
  let eps = 0.5;
  let nx = value_noise((world_xz + vec2f(eps, 0.0)) * 0.15) - value_noise((world_xz - vec2f(eps, 0.0)) * 0.15);
  let nz = value_noise((world_xz + vec2f(0.0, eps)) * 0.15) - value_noise((world_xz - vec2f(0.0, eps)) * 0.15);

  return MaterialSample(color_mod, vec3f(nx * 0.2, 0.0, nz * 0.2), 0.85);
}

fn sample_grass(world_xz: vec2f, moisture: f32) -> MaterialSample {
  // Clump patches at low frequency
  let patch = value_noise(world_xz * 0.04);
  // Individual blade frequency
  let blade = value_noise(world_xz * 0.3);
  // Subtle color banding
  let band = value_noise(world_xz * 0.08 + vec2f(50.0, 80.0));

  var color_mod = vec3f(
    0.93 + patch * 0.10 - blade * 0.05,
    0.96 + band * 0.08 + blade * 0.04,
    0.92 + patch * 0.06,
  );
  // Drier = yellower, wetter = deeper green
  color_mod.r += (1.0 - moisture) * 0.08;
  color_mod.g -= (1.0 - moisture) * 0.05;

  // Normal from blade noise gradient
  let eps = 0.5;
  let nx = value_noise((world_xz + vec2f(eps, 0.0)) * 0.3) - value_noise((world_xz - vec2f(eps, 0.0)) * 0.3);
  let nz = value_noise((world_xz + vec2f(0.0, eps)) * 0.3) - value_noise((world_xz - vec2f(0.0, eps)) * 0.3);

  return MaterialSample(color_mod, vec3f(nx * 0.15, 0.0, nz * 0.15), 0.7);
}

fn sample_forest(world_xz: vec2f, moisture: f32) -> MaterialSample {
  // Dense canopy variation
  let canopy = value_noise(world_xz * 0.06);
  // Undergrowth detail
  let under = value_noise(world_xz * 0.25 + vec2f(15.0, 25.0));
  // Tree crown edges
  let crown = value_noise(world_xz * 0.12 + vec2f(40.0, 70.0));

  var color_mod = vec3f(
    0.90 + crown * 0.08,
    0.92 + canopy * 0.12 - under * 0.06,
    0.88 + canopy * 0.08,
  );
  color_mod.g += moisture * 0.06;

  let eps = 0.5;
  let nx = value_noise((world_xz + vec2f(eps, 0.0)) * 0.12) - value_noise((world_xz - vec2f(eps, 0.0)) * 0.12);
  let nz = value_noise((world_xz + vec2f(0.0, eps)) * 0.12) - value_noise((world_xz - vec2f(0.0, eps)) * 0.12);

  return MaterialSample(color_mod, vec3f(nx * 0.25, 0.0, nz * 0.25), 0.65);
}

fn sample_mud(world_xz: vec2f) -> MaterialSample {
  // Wet mud patches
  let wet = value_noise(world_xz * 0.07);
  // Cracked dry edges
  let crack = value_noise(world_xz * 0.2 + vec2f(20.0, 40.0));

  let color_mod = vec3f(
    0.92 + wet * 0.08 - crack * 0.06,
    0.90 + wet * 0.06,
    0.88 + crack * 0.08,
  );

  let eps = 0.5;
  let nx = value_noise((world_xz + vec2f(eps, 0.0)) * 0.2) - value_noise((world_xz - vec2f(eps, 0.0)) * 0.2);
  let nz = value_noise((world_xz + vec2f(0.0, eps)) * 0.2) - value_noise((world_xz - vec2f(0.0, eps)) * 0.2);

  return MaterialSample(color_mod, vec3f(nx * 0.2, 0.0, nz * 0.2), 0.4);
}

fn sample_rock(world_xz: vec2f, slope: f32) -> MaterialSample {
  // Stratified layers
  let strata = value_noise(world_xz * vec2f(0.05, 0.15));
  // Surface cracks and pitting
  let crack = value_noise(world_xz * 0.25 + vec2f(10.0, 30.0));

  let color_mod = vec3f(
    0.92 + strata * 0.10,
    0.90 + strata * 0.08 + crack * 0.04,
    0.88 + crack * 0.08,
  );

  // Steeper slopes = more prominent normal offset
  let slope_scale = 0.15 + slope * 0.2;
  let eps = 0.5;
  let nx = value_noise((world_xz + vec2f(eps, 0.0)) * 0.25) - value_noise((world_xz - vec2f(eps, 0.0)) * 0.25);
  let nz = value_noise((world_xz + vec2f(0.0, eps)) * 0.25) - value_noise((world_xz - vec2f(0.0, eps)) * 0.25);

  return MaterialSample(color_mod, vec3f(nx * slope_scale, 0.0, nz * slope_scale), 0.9);
}

fn sample_snow(world_xz: vec2f, slope: f32) -> MaterialSample {
  // Drift patterns
  let drift = value_noise(world_xz * 0.05);
  // Sparkle (high-freq)
  let sparkle = value_noise(world_xz * 0.4 + vec2f(70.0, 90.0));

  let color_mod = vec3f(
    0.98 + sparkle * 0.03,
    0.98 + drift * 0.02,
    0.99 + drift * 0.02,
  );

  // Very gentle normal perturbation on snow
  let eps = 0.5;
  let nx = value_noise((world_xz + vec2f(eps, 0.0)) * 0.05) - value_noise((world_xz - vec2f(eps, 0.0)) * 0.05);
  let nz = value_noise((world_xz + vec2f(0.0, eps)) * 0.05) - value_noise((world_xz - vec2f(0.0, eps)) * 0.05);

  return MaterialSample(color_mod, vec3f(nx * 0.08, 0.0, nz * 0.08), 0.3);
}

fn sample_volcanic(world_xz: vec2f, temperature: f32) -> MaterialSample {
  // Cooled basalt texture
  let basalt = value_noise(world_xz * 0.1);
  // Heat fissures
  let fissure = value_noise(world_xz * 0.3 + vec2f(5.0, 15.0));

  var color_mod = vec3f(
    0.88 + fissure * 0.10 + temperature * 0.06,
    0.85 + basalt * 0.08,
    0.82 + basalt * 0.06,
  );

  let eps = 0.5;
  let nx = value_noise((world_xz + vec2f(eps, 0.0)) * 0.3) - value_noise((world_xz - vec2f(eps, 0.0)) * 0.3);
  let nz = value_noise((world_xz + vec2f(0.0, eps)) * 0.3) - value_noise((world_xz - vec2f(0.0, eps)) * 0.3);

  return MaterialSample(color_mod, vec3f(nx * 0.3, 0.0, nz * 0.3), 0.8);
}

fn sample_crystal(world_xz: vec2f) -> MaterialSample {
  // Faceted crystal faces
  let facet = value_noise(world_xz * 0.15);
  // Prismatic shimmer
  let shimmer = value_noise(world_xz * 0.35 + vec2f(25.0, 55.0));

  let color_mod = vec3f(
    0.95 + shimmer * 0.08,
    0.93 + facet * 0.10,
    0.97 + shimmer * 0.06 + facet * 0.04,
  );

  let eps = 0.5;
  let nx = value_noise((world_xz + vec2f(eps, 0.0)) * 0.15) - value_noise((world_xz - vec2f(eps, 0.0)) * 0.15);
  let nz = value_noise((world_xz + vec2f(0.0, eps)) * 0.15) - value_noise((world_xz - vec2f(0.0, eps)) * 0.15);

  return MaterialSample(color_mod, vec3f(nx * 0.2, 0.0, nz * 0.2), 0.2);
}

// Dispatch material sampling by terrain ID.
// Returns identity (no modification) for water (0) and settlement (7).
fn sample_terrain_material(terrain_id: u32, world_xz: vec2f, slope: f32, moisture: f32) -> MaterialSample {
  if (terrain_id == 1u) { return sample_sand(world_xz); }
  if (terrain_id == 2u) { return sample_grass(world_xz, moisture); }
  if (terrain_id == 3u) { return sample_forest(world_xz, moisture); }
  if (terrain_id == 4u) { return sample_mud(world_xz); }
  if (terrain_id == 5u) { return sample_rock(world_xz, slope); }
  if (terrain_id == 6u) { return sample_rock(world_xz, slope); }
  if (terrain_id == 8u) { return sample_volcanic(world_xz, 0.8); }
  if (terrain_id == 9u) { return sample_crystal(world_xz); }
  if (terrain_id == 10u) { return sample_rock(world_xz, slope); }
  return MATERIAL_IDENTITY;
}

`;
}
