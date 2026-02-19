/**
 * Shared WGSL functions for render-time noise and hex lookup.
 * Single source of truth for: hash2, gradient_noise (aliased as value_noise),
 * fbm3, pixel_to_hex, lookup_hex_state, and packed channel decode.
 *
 * Used by terrain-renderer.ts (vertex+fragment) and island-compute.ts (compute).
 * INTENTIONALLY DIFFERENT from terrain-noise.wgsl.ts (which mirrors core/noise.ts
 * for deterministic terrain generation). These use fast vec2->float hashing for
 * real-time visual detail.
 *
 * Does NOT declare @group/@binding for hex_state_tex — consumers must declare it
 * in their own preamble before including this module (same pattern as
 * terrain-noise.wgsl.ts referencing `params`).
 */

export function createRenderNoiseWGSL(): string {
  return /* wgsl */ `
// ============================================================
// Shared render-time noise + hex utilities
// (single source of truth — terrain-renderer.ts + island-compute.ts)
// ============================================================

const SQRT3: f32 = 1.7320508075688772;

// ── Hash / noise ────────────────────────────────────────────

fn hash2(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
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

struct PackedR {
  lift: f32,          // high nibble: 0.0-1.0
  fragmentation: f32, // low nibble: 0.0-1.0
}

fn decode_packed_r(r_value: f32) -> PackedR {
  let r_byte = u32(round(r_value * 255.0));
  return PackedR(
    f32(r_byte >> 4u) / 15.0,
    f32(r_byte & 0xFu) / 15.0,
  );
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
