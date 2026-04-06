/**
 * Procedural normal-map detail for terrain surfaces.
 * Computes per-pixel normal perturbations from noise to simulate
 * sub-polygon surface texture (rock grain, grass bumps, sand ripples, etc.).
 *
 * Uses value_noise() from render-noise.wgsl.ts (must be included before this module).
 * Max 6 noise samples per fragment for performance.
 */

export function createTerrainNormalsWGSL(): string {
  return /* wgsl */ `

// ============================================================
// Procedural normal detail (micro bump mapping)
// ============================================================

// Compute normal offset from a noise "micro heightfield" via finite differences.
// Returns a tangent-space offset (dx, 0, dz) to add to the geometry normal.
fn noise_normal(world_xz: vec2f, freq: f32, amp: f32) -> vec3f {
  let eps = 0.5 / freq;
  let h_center = value_noise(world_xz * freq);
  let h_right  = value_noise((world_xz + vec2f(eps, 0.0)) * freq);
  let h_up     = value_noise((world_xz + vec2f(0.0, eps)) * freq);
  let dx = (h_right - h_center) * amp;
  let dz = (h_up - h_center) * amp;
  return vec3f(-dx, 0.0, -dz);
}

// Per-pixel normal perturbation based on terrain type, slope, elevation, and distance.
// Terrain IDs: 0=Water, 1=Desert, 2=Plain, 3=Forest, 4=Marsh, 5=Hill, 6=Mountain,
//              7=Settlement, 8=Magma, 9=Crystal, 10=Floating
fn terrain_normal_detail(
  world_xz: vec2f,
  terrain_id: u32,
  slope: f32,
  norm_elev: f32,
  view_dist: f32,
) -> vec3f {

  // Distance fade: suppress detail at far zoom to prevent aliasing/shimmer
  let detail_fade = 1.0 - smoothstep(2000.0, 5000.0, view_dist);
  if (detail_fade < 0.001) {
    return vec3f(0.0);
  }

  var detail = vec3f(0.0);

  switch terrain_id {
    // Rock / Mountain / Hill — jagged, multi-octave cracks
    // 3 samples: large boulders + medium rocks (slope-weighted) + fine grain (slope-weighted)
    case 5u, 6u: {
      let n1 = noise_normal(world_xz, 0.08, 0.15);
      let n2 = noise_normal(world_xz, 0.2, 0.3);
      let n3 = noise_normal(world_xz, 0.5, 0.15);
      detail = n1 + n2 * slope + n3 * slope;
    }

    // Magma — sharp solidified flow lines, 2 samples
    case 8u: {
      let n1 = noise_normal(world_xz, 0.12, 0.3);
      let n2 = noise_normal(world_xz, 0.2, 0.2);
      detail = n1 + n2 * slope;
    }

    // Desert — medium-frequency dune ripples, 2 samples
    case 1u: {
      let n1 = noise_normal(world_xz, 0.06, 0.15);
      let n2 = noise_normal(world_xz, 0.12, 0.1);
      detail = n1 + n2;
    }

    // Plain / Grass — gentle rolling bumps, 1 sample
    case 2u: {
      detail = noise_normal(world_xz, 0.05, 0.15);
    }

    // Forest — medium rolling with undergrowth, 2 samples
    case 3u: {
      let n1 = noise_normal(world_xz, 0.06, 0.12);
      let n2 = noise_normal(world_xz, 0.15, 0.08);
      detail = n1 + n2;
    }

    // Marsh / Mud — lumpy medium frequency, 2 samples
    case 4u: {
      let n1 = noise_normal(world_xz, 0.08, 0.2);
      let n2 = noise_normal(world_xz, 0.15, 0.1);
      detail = n1 + n2;
    }

    // Crystal — sharp faceted look, 2 samples
    case 9u: {
      let n1 = noise_normal(world_xz, 0.15, 0.35);
      let n2 = noise_normal(world_xz, 0.4, 0.15);
      detail = n1 + n2 * slope;
    }

    // Floating — wind-worn smooth with occasional ridges, 1 sample
    case 10u: {
      detail = noise_normal(world_xz, 0.04, 0.1);
    }

    // Water / Settlement — minimal or no micro detail
    default: {
      detail = noise_normal(world_xz, 0.03, 0.05);
    }
  }

  return detail * detail_fade;
}

`;
}
