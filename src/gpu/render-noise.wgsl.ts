/**
 * Shared WGSL functions for render-time noise and hex lookup.
 * Single source of truth for: hash2, gradient_noise (aliased as value_noise),
 * fbm3, pixel_to_hex, lookup_hex_state, and packed channel decode.
 *
 * Used by terrain-renderer.ts (vertex+fragment).
 * INTENTIONALLY DIFFERENT from terrain-noise.wgsl.ts (which mirrors core/noise.ts
 * for deterministic terrain generation). These use fast vec2->float hashing for
 * real-time visual detail.
 *
 * Does NOT declare @group/@binding for hex_state_tex — consumers must declare it
 * in their own preamble before including this module (same pattern as
 * terrain-noise.wgsl.ts referencing `params`).
 */

import { PLANAR } from '../core/config';

export function createRenderNoiseWGSL(): string {
  return /* wgsl */ `
// ============================================================
// Shared render-time noise + hex utilities
// (single source of truth — terrain-renderer.ts)
// ============================================================

const SQRT3: f32 = 1.7320508075688772;

// ── Planar displacement constants (from config.ts PLANAR) ───

const FIRE_CONTRAST_CENTER: f32 = ${PLANAR.FIRE.CONTRAST_CENTER};
const FIRE_CONTRAST_SCALE: f32 = ${PLANAR.FIRE.CONTRAST_SCALE};
const FIRE_JAG_FREQ: f32 = ${PLANAR.FIRE.JAG_FREQ};
const FIRE_JAG_AMP: f32 = ${PLANAR.FIRE.JAG_AMP};

const WATER_FLOOD_NORM: f32 = ${PLANAR.WATER.FLOOD_NORM};
const WATER_FLATTEN_FACTOR: f32 = ${PLANAR.WATER.FLATTEN_FACTOR};

const EARTH_NOISE_FREQ: f32 = ${PLANAR.EARTH.NOISE_FREQ};
const EARTH_UPLIFT_AMP: f32 = ${PLANAR.EARTH.UPLIFT_AMP};
const EARTH_QUANTIZE_BANDS: f32 = ${PLANAR.EARTH.QUANTIZE_BANDS}.0;

const AIR_BASE_FREQ: f32 = ${PLANAR.AIR.BASE_FREQ};
const AIR_FRAG_EXPONENT: f32 = ${PLANAR.AIR.FRAG_EXPONENT};
const AIR_DETAIL_FREQ_MUL: f32 = ${PLANAR.AIR.DETAIL_FREQ_MUL};
const AIR_CHUNK_BLEND_FBM: f32 = ${PLANAR.AIR.CHUNK_BLEND_FBM};
const AIR_CHUNK_BLEND_DETAIL: f32 = ${PLANAR.AIR.CHUNK_BLEND_DETAIL};
const AIR_COVERAGE_THRESHOLD: f32 = ${PLANAR.AIR.COVERAGE_THRESHOLD};
const AIR_EDGE_ONSET: f32 = ${PLANAR.AIR.EDGE_ONSET};
const AIR_THRESHOLD_HIGH: f32 = ${PLANAR.AIR.THRESHOLD_HIGH};
const AIR_SMOOTHSTEP_WIDTH: f32 = ${PLANAR.AIR.SMOOTHSTEP_WIDTH};
const AIR_ALT_VARIATION_FREQ: f32 = ${PLANAR.AIR.ALT_VARIATION_FREQ};
const AIR_MAX_LIFT_FRACTION: f32 = ${PLANAR.AIR.MAX_LIFT_FRACTION};
const AIR_SMOOTH_MEDIAN: f32 = ${PLANAR.AIR.SMOOTH_MEDIAN};
const AIR_SMOOTH_FACTOR: f32 = ${PLANAR.AIR.SMOOTH_FACTOR};
const AIR_UNDERSIDE_THICKNESS: f32 = ${PLANAR.AIR.UNDERSIDE_THICKNESS};
const AIR_UNDERSIDE_STALACTITE: f32 = ${PLANAR.AIR.UNDERSIDE_STALACTITE};
const AIR_UNDERSIDE_MAX_DIST: f32 = ${PLANAR.AIR.UNDERSIDE_MAX_DIST}.0;

const POSITIVE_NOISE_FREQ: f32 = ${PLANAR.POSITIVE.NOISE_FREQ};
const POSITIVE_UPLIFT_AMP: f32 = ${PLANAR.POSITIVE.UPLIFT_AMP};

const NEGATIVE_PEAK_SINK: f32 = ${PLANAR.NEGATIVE.PEAK_SINK};
const NEGATIVE_BASE_SINK: f32 = ${PLANAR.NEGATIVE.BASE_SINK};

const SCAR_NOISE_FREQ: f32 = ${PLANAR.SCAR.NOISE_FREQ};
const SCAR_DISPLACEMENT_AMP: f32 = ${PLANAR.SCAR.DISPLACEMENT_AMP};

// ── Hash / noise ────────────────────────────────────────────

// PCG hash — O'Neill (2014). Strong mixing with no lattice correlation.
fn pcg(n: u32) -> u32 {
  var h = n * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return (h >> 22u) ^ h;
}

fn hash2(p: vec2f) -> f32 {
  let n = pcg(bitcast<u32>(p.x) ^ pcg(bitcast<u32>(p.y)));
  return f32(n) / 4294967295.0;
}

fn hash2v(p: vec2f) -> vec2f {
  let n1 = pcg(bitcast<u32>(p.x) ^ pcg(bitcast<u32>(p.y)));
  let n2 = pcg(n1);
  return vec2f(f32(n1), f32(n2)) / 4294967295.0;
}

// Gradient noise (Perlin-style): dot-product of pseudo-random gradient vectors
// with offset vectors, eliminating the lattice alignment artifacts of value noise.
// Quintic hermite (C2 continuous) for smooth curvature — no visible grid lines.
// Output remapped from [-0.5, 0.5] to [0, 1] for drop-in compatibility.
fn gradient_noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0); // quintic hermite (C2)

  // Convert hash to angle, derive gradient vector via trig
  let a = hash2(i) * 6.2831853;
  let b = hash2(i + vec2f(1.0, 0.0)) * 6.2831853;
  let c = hash2(i + vec2f(0.0, 1.0)) * 6.2831853;
  let d = hash2(i + vec2f(1.0, 1.0)) * 6.2831853;

  // Dot product of gradient with offset from each corner
  let va = dot(vec2f(cos(a), sin(a)), f);
  let vb = dot(vec2f(cos(b), sin(b)), f - vec2f(1.0, 0.0));
  let vc = dot(vec2f(cos(c), sin(c)), f - vec2f(0.0, 1.0));
  let vd = dot(vec2f(cos(d), sin(d)), f - vec2f(1.0, 1.0));

  return mix(mix(va, vb, u.x), mix(vc, vd, u.x), u.y) * 0.5 + 0.5;
}

// Backward-compatible alias — all existing callers use this name.
fn value_noise(p: vec2f) -> f32 {
  return gradient_noise(p);
}

fn fbm3(p: vec2f) -> f32 {
  var val = 0.0;
  var amp = 0.5;
  var pos = p;
  for (var i = 0; i < 3; i++) {
    val += amp * gradient_noise(pos);
    pos *= 2.03;
    amp *= 0.5;
  }
  return val;
}

// Domain-warped fBM: f(p + fbm(p)) for organic, non-repeating patterns.
fn warped_fbm3(p: vec2f) -> f32 {
  let warp = vec2f(
    fbm3(p * 0.7 + vec2f(1.7, 9.2)),
    fbm3(p * 0.7 + vec2f(8.3, 2.8))
  );
  return fbm3(p + warp * 0.8);
}

// Voronoi: vec2f(F1, F2) — distance to nearest / second-nearest cell.
// F1 = cellular pattern, F2-F1 = edge/vein pattern.
fn voronoi(p: vec2f) -> vec2f {
  let ip = floor(p);
  let fp = fract(p);
  var d1 = 8.0;
  var d2 = 8.0;
  for (var j: i32 = -1; j <= 1; j++) {
    for (var k: i32 = -1; k <= 1; k++) {
      let b = vec2f(f32(k), f32(j));
      let cell_pt = hash2v(ip + b);
      let diff = b + cell_pt - fp;
      let d = dot(diff, diff);
      if (d < d1) {
        d2 = d1;
        d1 = d;
      } else if (d < d2) {
        d2 = d;
      }
    }
  }
  return vec2f(sqrt(d1), sqrt(d2));
}

// ── Hex coordinate conversion (pointy-top) ─────────────────

struct HexInfo {
  qr: vec2f,       // rounded axial (q, r)
  edge_dist: f32,  // 0 = center, 0.5 = edge (pointy-top hex SDF in pixel space)
}

fn pixel_to_hex(wx: f32, wz: f32, hex_size: f32) -> HexInfo {
  // Pixel -> fractional axial (pointy-top)
  let inv_sqrt3 = 1.0 / SQRT3;
  let fq = (inv_sqrt3 * wx / hex_size) - (wz / (3.0 * hex_size));
  let fr = (2.0 / 3.0) * wz / hex_size;

  // Cube coords (fractional)
  let fx = fq;
  let fz = fr;
  let fy = -fx - fz;

  // Round to nearest hex center (cube-coordinate rounding)
  var rx = round(fx);
  var ry = round(fy);
  var rz = round(fz);
  let dx = abs(rx - fx);
  let dy = abs(ry - fy);
  let dz = abs(rz - fz);
  if (dx > dy && dx > dz) {
    rx = -ry - rz;
  } else if (dy > dz) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }

  // Edge distance: pointy-top hex SDF in pixel space (0 = center, 0.5 = edge).
  let center_x = hex_size * SQRT3 * (rx + rz * 0.5);
  let center_z = hex_size * 1.5 * rz;
  let lx = abs(wx - center_x);
  let lz = abs(wz - center_z);
  let edge = max(lx, 0.5 * lx + (SQRT3 / 2.0) * lz) / (SQRT3 * hex_size);

  return HexInfo(vec2f(rx, rz), edge);
}

// Simplified wrapper returning just axial coords (no edge distance).
fn pixel_to_hex_qr(wx: f32, wz: f32, hex_size: f32) -> vec2f {
  return pixel_to_hex(wx, wz, hex_size).qr;
}

// ── Hex state texture lookup ────────────────────────────────

fn lookup_hex_state(hex_qr: vec2f, grid_radius: f32) -> vec4f {
  let rq = hex_qr.x;
  let rr = hex_qr.y;
  let tex_size = grid_radius * 2.0 + 1.0;
  let tx = (rq + grid_radius) / tex_size;
  let tz = (rr + grid_radius) / tex_size;

  if (tx < 0.0 || tx > 1.0 || tz < 0.0 || tz > 1.0) {
    return vec4f(0.0, 0.0, 0.0, 0.0);
  }

  let tex_coord = vec2i(i32(rq + grid_radius), i32(rr + grid_radius));
  return textureLoad(hex_state_tex, tex_coord, 0);
}

// ── Packed channel decode ───────────────────────────────────

struct PackedG {
  plane_type: u32,
  fragmentation: f32,
}

fn decode_packed_g(g_value: f32) -> PackedG {
  let g_byte = u32(round(g_value * 255.0));
  return PackedG(g_byte >> 5u, f32(g_byte & 0x1Fu) / 31.0);
}

struct PackedA {
  terrain_id: u32,
  sector_boundary: bool,
}

fn decode_packed_a(a_value: f32) -> PackedA {
  let a_byte = u32(round(a_value * 255.0));
  return PackedA(
    a_byte >> 4u,
    (a_byte & 1u) > 0u,
  );
}

`;
}
