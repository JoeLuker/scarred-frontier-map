import { MESH_VERTEX_BYTE_STRIDE } from './types';
import type { TerrainMesh } from './terrain-mesh';
import type { HexStateTexture } from './hex-state-texture';

// --- WGSL Shader (terrain) ---

function createShader(): string {
  return /* wgsl */ `

// ============================================================
// Uniform buffer (368 bytes)
// ============================================================

struct Uniforms {
  view_proj: mat4x4f,               // 0-63
  height_scale: f32,                // 64
  hex_size: f32,                    // 68
  sea_level: f32,                   // 72
  mountain_threshold: f32,          // 76
  hill_threshold: f32,              // 80
  grid_radius: f32,                 // 84
  moisture_desert: f32,             // 88
  moisture_forest: f32,             // 92
  moisture_marsh: f32,              // 96
  hex_grid_opacity: f32,            // 100
  _pad0: f32,                       // 104
  _pad1: f32,                       // 108
  terrain_colors: array<vec4f, 11>, // 112-287 (8 base + 3 mutation-only)
  eye_pos: vec3f,                   // 288-299
  _pad2: f32,                       // 300-303
  inv_view_proj: mat4x4f,           // 304-367
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var hex_state_tex: texture_2d<f32>;

// ============================================================
// LAYER 1: Geometry (Vertex Shader)
// Heightfield displacement + per-plane vertex displacement via texture lookup.
// Planar displacement samples hex_state_tex per-vertex — zero mesh rebuilds.
// Rivers have elevation = seaLevel (flat by data, not override).
// ============================================================

struct VertexIn {
  @location(0) pos_xz: vec2f,
  @location(1) elevation: f32,
  @location(2) moisture: f32,
  @location(3) normal: vec3f,
}

struct VertexOut {
  @builtin(position) clip_pos: vec4f,
  @location(0) world_pos: vec3f,
  @location(1) elevation: f32,
  @location(2) moisture: f32,
  @location(3) smooth_normal: vec3f,
}

// Terrain displacement: cubic ease-in compresses low/mid elevations.
// MUST match terrain-mesh.ts displacementCurve() (CPU-side normal computation).
fn displacement_curve(h: f32) -> f32 {
  return h * h * h;
}

@vertex
fn vs_main(in: VertexIn) -> VertexOut {
  let sea = u.sea_level;
  let land_range = max(1.0 - sea, 0.001);
  let hs = u.height_scale;

  // Base elevation displacement. Rivers have elevation = seaLevel,
  // so normElev = 0 → displacement_curve(0) = 0 → no displacement.
  let norm_elev = clamp((in.elevation - sea) / land_range, 0.0, 1.0);
  var y: f32 = 0.0;
  if (in.elevation >= sea) {
    y = displacement_curve(norm_elev) * hs;
  }

  // Planar vertex displacement — terrain-aware reshaping via hex_state_tex.
  // Each plane reshapes terrain with geological purpose, not random noise.
  // Zero mesh rebuilds: hex_state_tex updates are a cheap CPU texture write.
  let vt_hex = pixel_to_hex(in.pos_xz.x, in.pos_xz.y, u.hex_size);
  let vt_state = lookup_hex_state(vt_hex.qr, u.grid_radius);
  let vt_plane = u32(round(vt_state.g * 255.0));
  let vt_pi = vt_state.b;

  if (vt_plane == 1u) {
    // FIRE: amplify terrain contrast — valleys deepen into lava channels,
    // ridges sharpen into volcanic peaks. Noise adds jagged texture.
    let contrast = (norm_elev - 0.35) * 0.02; // positive above 0.35, negative below
    let jag = (value_noise(in.pos_xz * 0.12) - 0.5) * 0.008;
    y += (contrast + jag) * vt_pi * hs;

  } else if (vt_plane == 2u) {
    // WATER: flatten toward flood level — terrain pulled toward a plane
    // just above sea. Low areas rise slightly, high areas are pulled down.
    let flood_norm = 0.08; // just above sea
    let flood_y = displacement_curve(flood_norm) * hs;
    y = mix(y, flood_y, vt_pi * 0.6);

  } else if (vt_plane == 3u) {
    // EARTH: tectonic uplift — strong blocky displacement.
    // Quantized noise gives plate-like stepped terraces.
    let n = value_noise(in.pos_xz * 0.05);
    let block = floor(n * 4.0) / 4.0;
    y += block * vt_pi * 0.015 * hs;

  } else if (vt_plane == 4u) {
    // AIR: erosion/smoothing — reduce extreme heights, gentle curves.
    // Pull everything toward the median elevation.
    let median_y = displacement_curve(0.35) * hs;
    y = mix(y, median_y, vt_pi * 0.3);
    y += value_noise(in.pos_xz * 0.025) * vt_pi * 0.003 * hs;

  } else if (vt_plane == 5u) {
    // POSITIVE: gentle growth uplift
    y += value_noise(in.pos_xz * 0.04) * vt_pi * 0.005 * hs;

  } else if (vt_plane == 6u) {
    // NEGATIVE: sinkhole — terrain depresses, especially peaks (entropy).
    let sink = norm_elev * 0.02 + 0.005; // peaks sink more
    y -= sink * vt_pi * hs;

  } else if (vt_plane == 7u) {
    // SCAR: chaotic — some areas violently up, others down.
    let n = (value_noise(in.pos_xz * 0.06) - 0.5) * 2.0;
    y += n * vt_pi * 0.012 * hs;
  }

  // Edge taper: smoothly lower terrain toward sea level near grid boundary.
  // Prevents cliff at the world edge — terrain meets ocean naturally.
  let vt_hex_dist = max(max(abs(vt_hex.qr.x), abs(vt_hex.qr.y)), abs(vt_hex.qr.x + vt_hex.qr.y));
  let edge_fade = smoothstep(u.grid_radius - 3.0, u.grid_radius, vt_hex_dist);
  y *= (1.0 - edge_fade);

  let world = vec3f(in.pos_xz.x, y, in.pos_xz.y);
  let clip = u.view_proj * vec4f(world, 1.0);

  var out: VertexOut;
  out.clip_pos = clip;
  out.world_pos = world;
  out.elevation = in.elevation;
  out.moisture = in.moisture;
  out.smooth_normal = in.normal;
  return out;
}

// ============================================================
// Shader utilities (used by both vertex and fragment stages)
// ============================================================

const PI: f32 = 3.14159265359;
const SQRT3: f32 = 1.7320508075688772;

// ============================================================
// Unified pixel → hex conversion (single source of truth)
// Returns rounded axial coords AND edge distance for SDF grid.
// Mirrors src/core/geometry.ts pixelToHex (pointy-top layout).
// ============================================================

struct HexInfo {
  qr: vec2f,       // rounded axial (q, r)
  edge_dist: f32,  // 0 = center, 0.5 = edge (pointy-top hex SDF in pixel space)
}

fn pixel_to_hex(wx: f32, wz: f32, hex_size: f32) -> HexInfo {
  // Pixel → fractional axial (pointy-top)
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
  // The cube-space Chebyshev metric max(|dx|,|dy|,|dz|) traces a FLAT-TOP hex,
  // but our tiles are pointy-top. Compute the actual distance to the pointy-top
  // hex edge using the pixel-space offset from the hex center.
  let center_x = hex_size * SQRT3 * (rx + rz * 0.5);
  let center_z = hex_size * 1.5 * rz;
  let lx = abs(wx - center_x);
  let lz = abs(wz - center_z);
  // Pointy-top SDF: max of right-edge projection and diagonal-edge projection.
  // Apothem (center-to-edge) = hex_size * √3/2, so normalizing by hex_size * √3
  // gives the 0–0.5 range matching the old convention.
  let edge = max(lx, 0.5 * lx + (SQRT3 / 2.0) * lz) / (SQRT3 * hex_size);

  return HexInfo(vec2f(rx, rz), edge);
}

// Look up hex state texture by axial coords
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

// ============================================================
// Hash / noise utilities (render shader — vertex + fragment)
// INTENTIONALLY DIFFERENT from terrain-compute.ts noise (which mirrors core/noise.ts).
// These use a fast vec2→float hash for real-time visual detail (rock texture, snow,
// per-hex variation, planar displacement). The compute shader uses integer lattice
// hashing for deterministic terrain generation. The two systems don't need to match.
// ============================================================

fn hash2(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn value_noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f); // smoothstep hermite
  let a = hash2(i);
  let b = hash2(i + vec2f(1.0, 0.0));
  let c = hash2(i + vec2f(0.0, 1.0));
  let d = hash2(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm3(p: vec2f) -> f32 {
  var val = 0.0;
  var amp = 0.5;
  var pos = p;
  for (var i = 0; i < 3; i++) {
    val += amp * value_noise(pos);
    pos *= 2.03;
    amp *= 0.5;
  }
  return val;
}

// ============================================================
// Lighting constants
// ============================================================

const SUN_DIR: vec3f = vec3f(0.4, 0.55, 0.5);  // lower sun = longer shadows
const SUN_COLOR: vec3f = vec3f(1.0, 0.95, 0.85);  // warm sunlight
const SKY_COLOR: vec3f = vec3f(0.55, 0.65, 0.85);  // cool ambient
const ROCK_COLOR: vec3f = vec3f(0.42, 0.38, 0.35);  // exposed cliff rock
const FOG_DENSITY: f32 = 0.00003;

// ============================================================
// Planar material system — terrain transformation, not cosmetic tinting.
// Each plane REPLACES the terrain material at high intensity.
// Elevation-aware: lava pools in valleys, basalt on peaks, etc.
// Identity return (plane_type == 0) has zero cost.
// ============================================================

struct PlanarMaterial {
  normal_offset: vec3f,
  replace_color: vec3f,    // target surface color (blended via replace_strength)
  emission: vec3f,
  replace_strength: f32,   // 0 = no change, 1 = full material replacement
  roughness_mod: f32,
  snow_line_shift: f32,
  rock_blend_mod: f32,
  moisture_mod: f32,
  ambient_mod: f32,
  shadow_mod: f32,
  specular_mod: f32,
}

fn get_planar_material(plane_type: u32, intensity: f32, wp: vec3f, elev: f32, sea: f32) -> PlanarMaterial {
  var pm: PlanarMaterial;
  pm.normal_offset = vec3f(0.0);
  pm.replace_color = vec3f(0.5);
  pm.emission = vec3f(0.0);
  pm.replace_strength = 0.0;
  pm.roughness_mod = 0.0;
  pm.snow_line_shift = 0.0;
  pm.rock_blend_mod = 0.0;
  pm.moisture_mod = 0.0;
  pm.ambient_mod = 1.0;
  pm.shadow_mod = 1.0;
  pm.specular_mod = 1.0;

  if (plane_type == 0u) { return pm; }

  let pi = intensity;
  let wn = wp.xz;
  let land_range = max(1.0 - sea, 0.001);
  let norm_elev = clamp((elev - sea) / land_range, 0.0, 1.0);
  let is_low = 1.0 - smoothstep(0.0, 0.35, norm_elev);  // 1 in valleys, 0 on peaks
  let is_high = smoothstep(0.4, 0.8, norm_elev);          // 0 in valleys, 1 on peaks

  if (plane_type == 1u) {
    // ── FIRE: Volcanic transformation ──
    // Valleys become lava channels, highlands become basalt/obsidian.
    // Cracks glow with molten rock. Snow is annihilated.
    let n1 = (value_noise(wn * 0.15) - 0.5) * 2.0;
    let n2 = (value_noise(wn * 0.3 + vec2f(7.0, 13.0)) - 0.5) * 2.0;
    pm.normal_offset = vec3f(n1, 0.0, n2) * pi * 0.5;

    // Valleys: dark lava rock. Peaks: lighter basalt with oxidation
    let lava_rock = vec3f(0.12, 0.06, 0.03);
    let basalt = vec3f(0.32, 0.25, 0.22);
    let obsidian_n = value_noise(wn * 0.08);
    let surface = mix(lava_rock, basalt, is_high) * (0.7 + obsidian_n * 0.6);
    pm.replace_color = surface;
    pm.replace_strength = pi * 0.85;

    // Lava glow in cracks — stronger in valleys where lava pools
    let crack = smoothstep(0.38, 0.5, value_noise(wn * 0.2));
    let lava_glow = vec3f(1.5, 0.4, 0.05) * crack * (0.4 + is_low * 0.6);
    // Broad volcanic heat haze
    let heat = vec3f(0.8, 0.25, 0.05) * is_low * 0.3;
    pm.emission = (lava_glow + heat) * pi;

    pm.roughness_mod = -0.3 * pi;     // glassy lava
    pm.snow_line_shift = 1.0 * pi;    // melt ALL snow
    pm.rock_blend_mod = 0.6 * pi;     // everything is rock
    pm.ambient_mod = 1.0 + 0.3 * pi;  // self-lit volcanic glow
    pm.shadow_mod = mix(1.0, 0.6, pi);
    pm.specular_mod = 1.0 + 0.8 * pi; // glassy lava reflections

  } else if (plane_type == 2u) {
    // ── WATER: Flooding ──
    // Low areas become standing water. High areas get wet/muddy.
    // Terrain is saturated and darkened.
    let w1 = (value_noise(wn * 0.04) - 0.5);
    let w2 = (value_noise(wn * 0.06 + vec2f(20.0, 40.0)) - 0.5);
    pm.normal_offset = vec3f(w1 * is_low, 0.0, w2 * is_low) * pi * 0.2;

    // Valleys: actual water surface. Highlands: wet mud/dark earth
    let water_surface = vec3f(0.08, 0.18, 0.35);
    let wet_mud = vec3f(0.25, 0.22, 0.15);
    let depth_n = value_noise(wn * 0.012) * 0.15;
    let surface = mix(wet_mud, water_surface + depth_n, is_low);
    pm.replace_color = surface;
    pm.replace_strength = pi * 0.8;

    pm.roughness_mod = mix(-0.2, -0.5, is_low) * pi; // pools are mirror-smooth
    pm.snow_line_shift = -0.15 * pi;
    pm.moisture_mod = 0.5 * pi;
    pm.ambient_mod = mix(1.0, 0.8, pi);   // darker overall
    pm.specular_mod = 1.0 + 2.0 * is_low * pi; // wet sheen in pools

  } else if (plane_type == 3u) {
    // ── EARTH: Tectonic uplift ──
    // Raw stone pushes through. Cracked plates, crystal veins, monolithic.
    let e1 = (value_noise(wn * 0.07) - 0.5) * 2.0;
    let e2 = (value_noise(wn * 0.09 + vec2f(5.0, 9.0)) - 0.5) * 2.0;
    pm.normal_offset = vec3f(e1, 0.0, e2) * pi * 0.35;

    // Granite base with crystal vein highlights
    let granite = vec3f(0.45, 0.40, 0.36);
    let crystal = vec3f(0.6, 0.55, 0.45);
    let strata = value_noise(wn * 0.04);
    let vein = smoothstep(0.6, 0.7, value_noise(wn * 0.12 + vec2f(3.0, 7.0)));
    let surface = mix(granite, crystal, vein) * (0.7 + strata * 0.6);
    pm.replace_color = surface;
    pm.replace_strength = pi * 0.75;

    pm.roughness_mod = 0.35 * pi;      // rough stone
    pm.rock_blend_mod = 0.8 * pi;      // everything is stone
    pm.moisture_mod = -0.3 * pi;        // desiccated
    pm.ambient_mod = mix(1.0, 0.85, pi);
    pm.shadow_mod = 1.0 + 0.25 * pi;   // deep crack shadows
    pm.specular_mod = mix(1.0, 0.4, pi);

  } else if (plane_type == 4u) {
    // ── AIR: Wind erosion / ethereal ──
    // Terrain is scoured smooth. Bleached, wind-worn surfaces.
    // High areas are cloud-white, low areas are sandy dust.
    let a1 = (value_noise(wn * 0.05 + vec2f(3.0, 7.0)) - 0.5);
    pm.normal_offset = vec3f(a1 * 0.2, value_noise(wn * 0.03) * 0.3, a1 * 0.15) * pi;

    let dust = vec3f(0.72, 0.68, 0.58);     // wind-scoured lowland
    let cloud_white = vec3f(0.88, 0.90, 0.95); // ethereal highland
    let surface = mix(dust, cloud_white, is_high);
    pm.replace_color = surface;
    pm.replace_strength = pi * 0.6;

    pm.roughness_mod = -0.25 * pi;     // wind-polished
    pm.snow_line_shift = -0.2 * pi;    // wind deposits snow lower
    pm.ambient_mod = 1.0 + 0.35 * pi;  // bright open sky
    pm.shadow_mod = mix(1.0, 0.6, pi); // soft diffuse shadows
    pm.specular_mod = 1.0 + 0.3 * pi;

  } else if (plane_type == 5u) {
    // ── POSITIVE: Life / radiance ──
    // Lush overgrowth in valleys, crystalline golden formations on peaks.
    let c1 = (value_noise(wn * 0.12) - 0.5) * 2.0;
    let c2 = (value_noise(wn * 0.18 + vec2f(11.0, 23.0)) - 0.5) * 2.0;
    pm.normal_offset = vec3f(floor(c1 * 3.0) / 3.0, 0.0, floor(c2 * 3.0) / 3.0) * pi * 0.25;

    let lush_green = vec3f(0.18, 0.45, 0.12);
    let golden_crystal = vec3f(0.75, 0.65, 0.30);
    let surface = mix(lush_green, golden_crystal, is_high);
    pm.replace_color = surface;
    pm.replace_strength = pi * 0.6;

    // Warm golden glow, stronger on peaks (exposed crystal)
    pm.emission = vec3f(0.8, 0.65, 0.2) * (0.1 + is_high * 0.3) * pi;

    pm.moisture_mod = 0.4 * pi;         // lush
    pm.ambient_mod = 1.0 + 0.25 * pi;
    pm.shadow_mod = mix(1.0, 0.75, pi);
    pm.specular_mod = 1.0 + 0.6 * is_high * pi; // crystal highlights

  } else if (plane_type == 6u) {
    // ── NEGATIVE: Entropy / void ──
    // Terrain decays. Color drains to ash-grey. Deep areas glow with void energy.
    let d1 = (value_noise(wn * 0.08 + vec2f(3.0, 5.0)) - 0.5) * 2.0;
    let d2 = (value_noise(wn * 0.1 + vec2f(17.0, 31.0)) - 0.5) * 2.0;
    pm.normal_offset = vec3f(d1 * 0.3, -abs(d1) * 0.5, d2 * 0.3) * pi;

    let ash = vec3f(0.28, 0.25, 0.27);
    let void_purple = vec3f(0.15, 0.08, 0.22);
    let decay = value_noise(wn * 0.06) * 0.3;
    let surface = mix(void_purple, ash, is_high) + decay;
    pm.replace_color = surface;
    pm.replace_strength = pi * 0.8;

    // Void glow in depressions — faint, eerie
    pm.emission = vec3f(0.25, 0.1, 0.5) * is_low * pi * 0.2;

    pm.roughness_mod = 0.3 * pi;        // crumbling
    pm.rock_blend_mod = 0.3 * pi;
    pm.ambient_mod = mix(1.0, 0.5, pi); // very dark
    pm.shadow_mod = 1.0 + 0.4 * pi;     // deep shadows
    pm.specular_mod = mix(1.0, 0.2, pi);

  } else if (plane_type == 7u) {
    // ── SCAR: Reality fracture ──
    // Terrain color inverts, geometry is chaotic, emissions flicker.
    let s1 = value_noise(wn * 0.06 + vec2f(42.0, 17.0));
    let s2 = value_noise(wn * 0.15 + vec2f(13.0, 29.0));
    let s3 = fbm3(wn * 0.04);
    let chaos = (s1 - 0.5) * 2.0;
    pm.normal_offset = vec3f(chaos, s2 - 0.5, (s3 - 0.5) * 2.0) * pi * 0.45;

    // Scar replaces with inverted/shifted colors — handled specially in fragment
    // using the existing color. replace_color is a fallback midtone.
    pm.replace_color = vec3f(0.5 - chaos * 0.2, 0.3 + s2 * 0.3, 0.4 + s3 * 0.3);
    pm.replace_strength = pi * 0.5;

    // Flickering void/energy emission
    let flicker = smoothstep(0.5, 0.65, s2);
    pm.emission = vec3f(0.7, 0.3, 1.0) * flicker * pi * 0.35;

    pm.roughness_mod = (s3 - 0.5) * pi * 0.5;
    pm.ambient_mod = mix(1.0, 0.6 + s1 * 0.6, pi);
    pm.shadow_mod = mix(1.0, 0.5 + s2 * 0.8, pi);
    pm.specular_mod = mix(1.0, s3 * 2.5, pi);
  }

  return pm;
}

// ============================================================
// Water color helper
// ============================================================

fn water_base_color(elevation: f32, world_xz: vec2f) -> vec3f {
  let sea = u.sea_level;
  let depth = max(0.0, sea - elevation) / max(sea, 0.001);
  let shallow_col = u.terrain_colors[0].rgb * 1.1;
  let mid_col = u.terrain_colors[0].rgb * 0.6;
  let deep_col = vec3f(0.03, 0.07, 0.15);
  let shore_t = smoothstep(0.0, 0.12, depth);
  let deep_t = smoothstep(0.12, 0.7, depth);
  var water = mix(shallow_col, mid_col, shore_t);
  water = mix(water, deep_col, deep_t);
  let wn = value_noise(world_xz * 0.015) * 0.06;
  water += vec3f(wn * 0.3, wn * 0.5, wn);
  return water;
}

// ============================================================
// ACES filmic tone mapping
// ============================================================

fn aces_tonemap(x: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return saturate((x * (a * x + vec3f(b))) / (x * (c * x + vec3f(d)) + vec3f(e)));
}

// ============================================================
// Main fragment shader — layered architecture
//
// Layer 3 (Hex Tile Identity): pixel_to_hex → texture lookup → terrain type + planar decode
// Layer 2 (Surface Material): planar-modified base color + noise/rock/snow
// Lighting: planar-perturbed normals, modified ambient/shadow/specular + emission
// Layer 5 (Post-Processing): grid overlay, atmosphere, tone mapping
// ============================================================

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let sun_dir = normalize(SUN_DIR);
  let sea = u.sea_level;
  let view_dir = normalize(u.eye_pos - in.world_pos);
  let normal = normalize(in.smooth_normal);
  let slope = 1.0 - abs(normal.y);

  // ═══════════════════════════════════════════════════════════════
  // LAYER 3: Hex Tile Identity
  // Resolve which hex this fragment belongs to and read per-hex state.
  // All per-hex decisions flow from this single texture lookup.
  // ═══════════════════════════════════════════════════════════════

  let hex = pixel_to_hex(in.world_pos.x, in.world_pos.z, u.hex_size);
  let hex_state = lookup_hex_state(hex.qr, u.grid_radius);
  let a_byte = u32(round(hex_state.a * 255.0));
  let hex_terrain_id = a_byte >> 4u;
  let ring_boundary = (a_byte & 1u) > 0u;
  var is_water = hex_terrain_id == 0u;

  // Planar overlay decode — evaluated before material for deep integration
  let plane_type = u32(round(hex_state.g * 255.0));
  let p_intensity = hex_state.b;
  let pm = get_planar_material(plane_type, p_intensity, in.world_pos, in.elevation, sea);

  // Curvature approximation — must be in uniform control flow (before any
  // non-uniform branching) since dpdx/dpdy require all quad invocations active.
  let ddx_e = dpdx(in.elevation);
  let ddy_e = dpdy(in.elevation);
  let curvature = clamp((dpdx(ddx_e) + dpdy(ddy_e)) * 200.0, -1.0, 1.0);

  // Hex distance from grid center — used for ocean fallback and grid fade.
  // Placed after derivative computation to keep dpdx/dpdy in uniform control flow.
  let hex_dist = max(max(abs(hex.qr.x), abs(hex.qr.y)), abs(hex.qr.x + hex.qr.y));
  let is_beyond_grid = hex_dist > u.grid_radius;

  // Beyond the hex grid: force water rendering (deep ocean).
  // The sea quad mesh goes through this same shader — no separate sea pipeline.
  if (is_beyond_grid) {
    is_water = true;
  }

  // ═══════════════════════════════════════════════════════════════
  // LAYER 2: Surface Material
  // Base color from discrete terrain type (sharp hex boundaries) +
  // continuous noise/slope/altitude effects (sub-hex visual richness).
  // ═══════════════════════════════════════════════════════════════

  var color: vec3f;

  if (is_water) {
    // Blend elevation toward 0 near grid edge so terrain water color
    // smoothly deepens to match the sea quad (which has elevation=0).
    let edge_blend = smoothstep(u.grid_radius - 3.0, u.grid_radius + 0.5, hex_dist);
    let water_elev = mix(in.elevation, 0.0, edge_blend);
    color = water_base_color(water_elev, in.world_pos.xz);

    // Water specular + Fresnel
    let wn1 = (value_noise(in.world_pos.xz * 0.03) - 0.5) * 0.3;
    let wn2 = (value_noise(in.world_pos.xz * 0.07 + vec2f(50.0, 80.0)) - 0.5) * 0.15;
    let water_normal = normalize(vec3f(wn1, 1.0, wn2));

    let reflect_dir = reflect(-sun_dir, water_normal);
    let spec = pow(max(dot(reflect_dir, view_dir), 0.0), 64.0);
    color += SUN_COLOR * spec * 0.6 * pm.specular_mod;

    let NdotV = max(dot(water_normal, view_dir), 0.0);
    let fresnel = pow(1.0 - NdotV, 3.0) * 0.4;
    color = mix(color, SKY_COLOR * 0.8, fresnel);

    // Planar material replacement (water surface)
    color = mix(color, pm.replace_color, pm.replace_strength);
  } else {
    // --- Tile base from canonical terrain color (sharp per-hex) ---
    color = u.terrain_colors[hex_terrain_id].rgb;

    // Per-hex subtle variation (each tile visually distinct)
    let hex_hash = hash2(hex.qr * 0.73 + vec2f(17.3, 31.7));
    color *= (0.92 + hex_hash * 0.16);

    // Subtle moisture modulation within the tile
    let moisture_shift = (in.moisture + pm.moisture_mod - 0.5) * 0.12;
    color *= (1.0 + moisture_shift);

    // Forest/marsh canopy darkening
    if (hex_terrain_id == 3u || hex_terrain_id == 4u) {
      let canopy = value_noise(in.world_pos.xz * 0.08) * 0.15;
      color *= (1.0 - canopy);
      color.g += (value_noise(in.world_pos.xz * 0.12) - 0.5) * 0.06;
    }

    // Multi-frequency noise (visual richness without changing biome identity)
    let low_noise  = (fbm3(in.world_pos.xz * 0.003) - 0.5) * 0.20;
    let mid_noise  = (value_noise(in.world_pos.xz * 0.02) - 0.5) * 0.12;
    let high_noise = (value_noise(in.world_pos.xz * 0.12) - 0.5) * 0.06;
    color *= (1.0 + low_noise + mid_noise + high_noise);
    // Low-freq hue shift
    color.r *= (1.0 + low_noise * 0.4);
    color.b *= (1.0 - low_noise * 0.25);

    // Noise-textured rock on cliffs
    let rock_strata = fbm3(in.world_pos.xz * 0.05);
    let rock_grain = value_noise(in.world_pos.xz * 0.2);
    let textured_rock = ROCK_COLOR * (0.8 + rock_strata * 0.3 + rock_grain * 0.1);
    let rock_blend = clamp(smoothstep(0.2, 0.55, slope) + pm.rock_blend_mod, 0.0, 1.0);
    color = mix(color, textured_rock, rock_blend * 0.85);

    // Curvature accent (derivatives computed above in uniform control flow)
    let ridge_light = max(0.0, curvature) * 0.35;
    let valley_dark = max(0.0, -curvature) * 0.4;
    color *= (1.0 + ridge_light - valley_dark);

    // Altitude desaturation + textured snow
    let land_range = 1.0 - sea;
    let norm_elev = select(0.0, (in.elevation - sea) / land_range, land_range > 0.0);

    let gray = dot(color, vec3f(0.299, 0.587, 0.114));
    let altitude_desat = smoothstep(0.4, 0.85, norm_elev) * 0.35;
    color = mix(color, vec3f(gray) * vec3f(0.92, 0.94, 1.0), altitude_desat);

    let snow_line = 0.72 + pm.snow_line_shift;
    let snow_base = smoothstep(snow_line, 0.92, norm_elev);
    let snow_slip = 1.0 - smoothstep(0.3, 0.6, slope);
    let snow_fine = value_noise(in.world_pos.xz * 0.15) * 0.12;
    let snow_coarse = (fbm3(in.world_pos.xz * 0.02) - 0.5) * 0.2;
    let snow_t = clamp(snow_base * snow_slip + snow_fine * snow_base + snow_coarse * snow_base, 0.0, 1.0);
    let snow_color = vec3f(0.90, 0.93, 0.97) + vec3f(snow_fine * 0.08);
    color = mix(color, snow_color, snow_t);

    // Planar material replacement (before lighting)
    color = mix(color, pm.replace_color, pm.replace_strength);

    // Material roughness: wet lowlands get specular, dry highlands are matte
    let roughness = clamp(mix(0.3, 0.95, smoothstep(0.0, 0.5, norm_elev)) + pm.roughness_mod, 0.05, 1.0);
    let half_vec = normalize(sun_dir + view_dir);
    let land_n = normalize(normal + pm.normal_offset);
    let NdotH = max(dot(land_n, half_vec), 0.0);
    let spec_power = mix(32.0, 4.0, roughness);
    let land_spec = pow(NdotH, spec_power) * (1.0 - roughness) * 0.25 * pm.specular_mod;
    color += SUN_COLOR * land_spec;
  }

  // --- Normal perturbation from planar effects ---
  let perturbed_normal = normalize(normal + pm.normal_offset);

  // --- Directional lighting (Wrapped Lambert with planar modifiers) ---
  let NdotL = dot(perturbed_normal, sun_dir);
  let wrapped = saturate((NdotL + 0.15) / 1.15);
  let light = mix(SKY_COLOR * 0.35 * pm.ambient_mod, SUN_COLOR * pm.shadow_mod, wrapped);
  let is_water_f = select(0.0, 1.0, is_water);
  let light_strength = mix(1.0, 0.5, is_water_f);
  color *= mix(vec3f(0.65), light, light_strength);

  // --- Rim / backlight on ridgelines ---
  if (!is_water) {
    let rim = pow(1.0 - max(dot(perturbed_normal, view_dir), 0.0), 4.0);
    let rim_sun = max(dot(-view_dir, sun_dir), 0.0);
    color += rim * rim_sun * SUN_COLOR * 0.15;
  }

  // --- Planar emission (self-illumination after lighting) ---
  color += pm.emission;

  // ═══════════════════════════════════════════════════════════════
  // LAYER 5: Post-Processing
  // Grid overlay, atmospheric scattering, tone mapping.
  // Read-only of all prior layers.
  // ═══════════════════════════════════════════════════════════════

  // Hex grid overlay (SDF from hex.edge_dist computed in Layer 3)
  // Fades out over the last 2 hex rings so terrain→ocean transition is seamless.
  let edge_dist = hex.edge_dist;
  let edge_aa = fwidth(edge_dist);
  var grid_line = smoothstep(0.5 - edge_aa * 2.0, 0.5, edge_dist);
  var grid_opacity = u.hex_grid_opacity;

  // Sector boundary borders (thicker lines between tiled hex groups)
  if (ring_boundary && u.hex_grid_opacity > 0.0) {
    grid_line = max(grid_line, smoothstep(0.45 - edge_aa * 3.0, 0.45, edge_dist));
    grid_opacity = max(grid_opacity, 0.35);
  }

  // Fade grid near world edge — no grid on open ocean
  let grid_edge_fade = 1.0 - smoothstep(u.grid_radius - 2.0, u.grid_radius, hex_dist);
  grid_opacity *= grid_edge_fade;

  color = mix(color, color * 0.3, grid_line * grid_opacity);

  // Atmospheric scattering (replaces flat fog)
  let view_dist = length(in.world_pos - u.eye_pos);
  let view_to_frag = normalize(in.world_pos - u.eye_pos);
  let fog_amount = 1.0 - exp(-view_dist * FOG_DENSITY);

  // Mie-like forward scattering (bright halo toward sun)
  let sun_alignment = max(dot(view_to_frag, sun_dir), 0.0);
  let mie = pow(sun_alignment, 8.0) * 0.3;

  // Rayleigh: blue at distance, warm near sun direction
  let rayleigh_color = mix(
    vec3f(0.35, 0.45, 0.7),
    vec3f(0.7, 0.6, 0.45),
    sun_alignment * sun_alignment
  );
  let scatter_color = mix(rayleigh_color, SUN_COLOR, mie);
  color = mix(color, scatter_color, fog_amount);

  // ACES filmic tone mapping
  color = aces_tonemap(color * 0.95);

  return vec4f(clamp(color, vec3f(0.0), vec3f(1.0)), 1.0);
}

// ============================================================
// Sky dome — fullscreen triangle with procedural sky
// Same Rayleigh+Mie scattering as terrain Layer 5 for seamless horizon blend.
// Ray direction computed per-fragment (not interpolated from vertices)
// because perspective unprojection is nonlinear.
// ============================================================

struct SkyVaryings {
  @builtin(position) clip_pos: vec4f,
  @location(0) ndc: vec2f,
}

@vertex
fn vs_sky(@builtin(vertex_index) vi: u32) -> SkyVaryings {
  // Fullscreen triangle: 3 verts covering entire clip space
  let x = select(-1.0, 3.0, vi == 1u);
  let y = select(-1.0, 3.0, vi == 2u);

  var out: SkyVaryings;
  out.clip_pos = vec4f(x, y, 1.0, 1.0);
  out.ndc = vec2f(x, y); // interpolates linearly since w=1
  return out;
}

struct SkyFragOut {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
}

@fragment
fn fs_sky(in: SkyVaryings) -> SkyFragOut {
  // Compute ray direction per-fragment from NDC
  let world_far = u.inv_view_proj * vec4f(in.ndc, 1.0, 1.0);
  let world_near = u.inv_view_proj * vec4f(in.ndc, 0.0, 1.0);
  let ray = normalize((world_far.xyz / world_far.w) - (world_near.xyz / world_near.w));

  let sun_dir = normalize(SUN_DIR);

  // Atmospheric scatter color — identical to terrain Layer 5 fog.
  // This is what distant terrain/sea converges to, so the sky must match at horizon.
  let sun_alignment = max(dot(ray, sun_dir), 0.0);
  let rayleigh_color = mix(
    vec3f(0.35, 0.45, 0.7),
    vec3f(0.7, 0.6, 0.45),
    sun_alignment * sun_alignment
  );
  let mie = pow(sun_alignment, 8.0) * 0.3;
  let scatter_color = mix(rayleigh_color, SUN_COLOR, mie);

  // Gradient: scatter_color at horizon → zenith blue above.
  // Clamp ray.y to 0 — below horizon holds scatter_color (sea covers it).
  let zenith = vec3f(0.15, 0.25, 0.55);
  let t = pow(max(ray.y, 0.0), 0.45);
  var sky = mix(scatter_color, zenith, t);

  // Sun disc
  let sun_disc = smoothstep(0.9995, 0.99975, sun_alignment);
  sky += SUN_COLOR * sun_disc * 3.0;

  sky = aces_tonemap(sky * 0.95);

  var out: SkyFragOut;
  out.color = vec4f(clamp(sky, vec3f(0.0), vec3f(1.0)), 1.0);
  out.depth = 1.0; // far plane — behind all terrain
  return out;
}

`;
}

// --- 4x4 matrix inverse (cofactor expansion) ---

function invertMat4(m: Float32Array): Float32Array {
  const out = new Float32Array(16);
  const m00 = m[0]!, m01 = m[1]!, m02 = m[2]!, m03 = m[3]!;
  const m10 = m[4]!, m11 = m[5]!, m12 = m[6]!, m13 = m[7]!;
  const m20 = m[8]!, m21 = m[9]!, m22 = m[10]!, m23 = m[11]!;
  const m30 = m[12]!, m31 = m[13]!, m32 = m[14]!, m33 = m[15]!;

  const b00 = m00 * m11 - m01 * m10;
  const b01 = m00 * m12 - m02 * m10;
  const b02 = m00 * m13 - m03 * m10;
  const b03 = m01 * m12 - m02 * m11;
  const b04 = m01 * m13 - m03 * m11;
  const b05 = m02 * m13 - m03 * m12;
  const b06 = m20 * m31 - m21 * m30;
  const b07 = m20 * m32 - m22 * m30;
  const b08 = m20 * m33 - m23 * m30;
  const b09 = m21 * m32 - m22 * m31;
  const b10 = m21 * m33 - m23 * m31;
  const b11 = m22 * m33 - m23 * m32;

  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-10) return out; // degenerate — return zeros

  const invDet = 1.0 / det;
  out[0]  = ( m11 * b11 - m12 * b10 + m13 * b09) * invDet;
  out[1]  = (-m01 * b11 + m02 * b10 - m03 * b09) * invDet;
  out[2]  = ( m31 * b05 - m32 * b04 + m33 * b03) * invDet;
  out[3]  = (-m21 * b05 + m22 * b04 - m23 * b03) * invDet;
  out[4]  = (-m10 * b11 + m12 * b08 - m13 * b07) * invDet;
  out[5]  = ( m00 * b11 - m02 * b08 + m03 * b07) * invDet;
  out[6]  = (-m30 * b05 + m32 * b02 - m33 * b01) * invDet;
  out[7]  = ( m20 * b05 - m22 * b02 + m23 * b01) * invDet;
  out[8]  = ( m10 * b10 - m11 * b08 + m13 * b06) * invDet;
  out[9]  = (-m00 * b10 + m01 * b08 - m03 * b06) * invDet;
  out[10] = ( m30 * b04 - m31 * b02 + m33 * b00) * invDet;
  out[11] = (-m20 * b04 + m21 * b02 - m23 * b00) * invDet;
  out[12] = (-m10 * b09 + m11 * b07 - m12 * b06) * invDet;
  out[13] = ( m00 * b09 - m01 * b07 + m02 * b06) * invDet;
  out[14] = (-m30 * b03 + m31 * b01 - m32 * b00) * invDet;
  out[15] = ( m20 * b03 - m21 * b01 + m22 * b00) * invDet;

  return out;
}

// --- Uniform buffer layout ---
// 304 (original) + 64 (inv_view_proj mat4x4f) = 368
const UNIFORM_SIZE = 368;
const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus-stencil8';

export class TerrainRenderer {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private pipeline: GPURenderPipeline;
  private skyPipeline: GPURenderPipeline;
  private seaPipeline: GPURenderPipeline;
  private uniformBuffer: GPUBuffer;
  private bindGroupLayout: GPUBindGroupLayout;
  private bindGroup: GPUBindGroup | null = null;
  private format: GPUTextureFormat;

  private depthTexture: GPUTexture | null = null;

  private currentMesh: TerrainMesh | null = null;
  private currentHexState: HexStateTexture | null = null;

  // Sea quad drawn through the terrain pipeline — same shader, no z-fighting
  private seaVertexBuffer: GPUBuffer;

  // Dummy texture for initial bind group
  private dummyHexTexture: GPUTexture;

  private constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    pipeline: GPURenderPipeline,
    skyPipeline: GPURenderPipeline,
    seaPipeline: GPURenderPipeline,
    uniformBuffer: GPUBuffer,
    bindGroupLayout: GPUBindGroupLayout,
    format: GPUTextureFormat,
    seaVertexBuffer: GPUBuffer,
    dummyHexTexture: GPUTexture,
  ) {
    this.device = device;
    this.context = context;
    this.pipeline = pipeline;
    this.skyPipeline = skyPipeline;
    this.seaPipeline = seaPipeline;
    this.uniformBuffer = uniformBuffer;
    this.bindGroupLayout = bindGroupLayout;
    this.format = format;
    this.seaVertexBuffer = seaVertexBuffer;
    this.dummyHexTexture = dummyHexTexture;
  }

  static create(device: GPUDevice, canvas: HTMLCanvasElement): TerrainRenderer {
    const format = navigator.gpu.getPreferredCanvasFormat();
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('Failed to get WebGPU canvas context');

    context.configure({ device, format, alphaMode: 'opaque' });

    const shaderModule = device.createShaderModule({ code: createShader() });

    const uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });

    const pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: MESH_VERTEX_BYTE_STRIDE,
          stepMode: 'vertex',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },   // pos_xz
            { shaderLocation: 1, offset: 8, format: 'float32' },     // elevation
            { shaderLocation: 2, offset: 12, format: 'float32' },    // moisture
            { shaderLocation: 3, offset: 16, format: 'float32x3' },  // normal
          ],
        }],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format }],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',
      },
      depthStencil: {
        depthWriteEnabled: true,
        depthCompare: 'less',
        format: DEPTH_FORMAT,
        // Write stencil=1 wherever terrain renders — sea pipeline reads this
        stencilFront: { compare: 'always', passOp: 'replace', failOp: 'keep', depthFailOp: 'keep' },
        stencilBack: { compare: 'always', passOp: 'replace', failOp: 'keep', depthFailOp: 'keep' },
        stencilReadMask: 0xFF,
        stencilWriteMask: 0xFF,
      },
    });

    // --- Sky pipeline (draws behind everything) ---
    const skyPipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_sky',
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_sky',
        targets: [{ format }],
      },
      primitive: {
        topology: 'triangle-list',
      },
      depthStencil: {
        depthWriteEnabled: false,
        depthCompare: 'always',
        format: DEPTH_FORMAT,
        stencilFront: { compare: 'always', passOp: 'keep', failOp: 'keep', depthFailOp: 'keep' },
        stencilBack: { compare: 'always', passOp: 'keep', failOp: 'keep', depthFailOp: 'keep' },
        stencilWriteMask: 0x00,
      },
    });

    // --- Sea pipeline (stencil-masked — only draws where terrain didn't render) ---
    const seaPipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: MESH_VERTEX_BYTE_STRIDE,
          stepMode: 'vertex',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32' },
            { shaderLocation: 2, offset: 12, format: 'float32' },
            { shaderLocation: 3, offset: 16, format: 'float32x3' },
          ],
        }],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format }],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',
      },
      depthStencil: {
        depthWriteEnabled: true,
        depthCompare: 'less',
        format: DEPTH_FORMAT,
        // Only draw where stencil == 0 (no terrain rendered)
        stencilFront: { compare: 'equal', passOp: 'keep', failOp: 'keep', depthFailOp: 'keep' },
        stencilBack: { compare: 'equal', passOp: 'keep', failOp: 'keep', depthFailOp: 'keep' },
        stencilReadMask: 0xFF,
        stencilWriteMask: 0x00,
      },
    });

    // --- Sea quad vertex buffer ---
    // Large quad at Y=0 extending far beyond the grid. Stencil-masked so it only
    // renders where terrain mesh didn't draw — zero overlap, zero z-fighting.
    // 6 verts × 7 floats (pos_xz, elevation, moisture, normal_xyz) = 168 bytes.
    const SEA_EXTENT = 100000; // huge — atmospheric scattering fades to sky
    const seaVerts = new Float32Array([
      // Triangle 1: (-e,-e), (e,-e), (-e,e)
      -SEA_EXTENT, -SEA_EXTENT, 0, 0, 0, 1, 0,
       SEA_EXTENT, -SEA_EXTENT, 0, 0, 0, 1, 0,
      -SEA_EXTENT,  SEA_EXTENT, 0, 0, 0, 1, 0,
      // Triangle 2: (-e,e), (e,-e), (e,e)
      -SEA_EXTENT,  SEA_EXTENT, 0, 0, 0, 1, 0,
       SEA_EXTENT, -SEA_EXTENT, 0, 0, 0, 1, 0,
       SEA_EXTENT,  SEA_EXTENT, 0, 0, 0, 1, 0,
    ]);
    const seaVertexBuffer = device.createBuffer({
      size: seaVerts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(seaVertexBuffer, 0, seaVerts);

    // --- Dummy texture ---
    const dummyHexTexture = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: dummyHexTexture },
      new Uint8Array([0, 0, 0, 0]),
      { bytesPerRow: 4 },
      [1, 1],
    );

    return new TerrainRenderer(
      device, context, pipeline, skyPipeline, seaPipeline, uniformBuffer,
      bindGroupLayout, format, seaVertexBuffer, dummyHexTexture,
    );
  }

  /** Update the uniform buffer. Call once per frame before render(). */
  updateUniforms(
    viewProj: Float32Array,
    heightScale: number,
    hexSize: number,
    seaLevel: number,
    mountainThreshold: number,
    hillThreshold: number,
    gridRadius: number,
    moistureDesert: number,
    moistureForest: number,
    moistureMarsh: number,
    hexGridOpacity: number,
    terrainColors: Float32Array, // 11 × 4 = 44 floats (rgba per terrain type)
    eyePos: readonly [number, number, number],
  ): void {
    const data = new Float32Array(UNIFORM_SIZE / 4); // 92 floats

    // viewProj: 16 floats at offset 0
    data.set(viewProj, 0);

    // Scalar params
    data[16] = heightScale;
    data[17] = hexSize;
    data[18] = seaLevel;
    data[19] = mountainThreshold;
    data[20] = hillThreshold;
    data[21] = gridRadius;
    data[22] = moistureDesert;
    data[23] = moistureForest;
    data[24] = moistureMarsh;
    data[25] = hexGridOpacity;
    data[26] = 0; // pad
    data[27] = 0; // pad

    // terrainColors: 11 × vec4f = 44 floats at offset 28
    data.set(terrainColors.subarray(0, 44), 28);

    // eye_pos: vec3f at byte 288 = float offset 72
    data[72] = eyePos[0];
    data[73] = eyePos[1];
    data[74] = eyePos[2];
    data[75] = 0; // pad

    // inv_view_proj: mat4x4f at byte 304 = float offset 76
    const invViewProj = invertMat4(viewProj);
    data.set(invViewProj, 76);

    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }

  setMesh(mesh: TerrainMesh): void {
    this.currentMesh = mesh;
    this.rebuildBindGroup();
  }

  setHexState(hexState: HexStateTexture): void {
    this.currentHexState = hexState;
    this.rebuildBindGroup();
  }

  private rebuildBindGroup(): void {
    const hexTexture = this.currentHexState?.texture ?? this.dummyHexTexture;

    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: hexTexture.createView() },
      ],
    });
  }

  private ensureDepthTexture(width: number, height: number): GPUTexture {
    if (this.depthTexture && this.depthTexture.width === width && this.depthTexture.height === height) {
      return this.depthTexture;
    }
    this.depthTexture?.destroy();
    this.depthTexture = this.device.createTexture({
      size: [width, height],
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    return this.depthTexture;
  }

  render(): void {
    if (!this.currentMesh || this.currentMesh.indexCount === 0 || !this.bindGroup) return;

    const colorTexture = this.context.getCurrentTexture();
    const depthTexture = this.ensureDepthTexture(colorTexture.width, colorTexture.height);

    const encoder = this.device.createCommandEncoder();

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: colorTexture.createView(),
        clearValue: { r: 0.008, g: 0.024, b: 0.039, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        stencilClearValue: 0,
        stencilLoadOp: 'clear',
        stencilStoreOp: 'discard',
      },
    });

    // 1. Sky (behind everything — depthCompare: always, no depth write)
    pass.setPipeline(this.skyPipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);

    // 2. Terrain mesh (writes stencil=1 everywhere it renders)
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setStencilReference(1);
    pass.setVertexBuffer(0, this.currentMesh.vertexBuffer);
    pass.setIndexBuffer(this.currentMesh.indexBuffer, 'uint32');
    pass.drawIndexed(this.currentMesh.indexCount);

    // 3. Sea quad (stencil-masked — only fills gaps where terrain didn't render)
    pass.setPipeline(this.seaPipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setStencilReference(0);
    pass.setVertexBuffer(0, this.seaVertexBuffer);
    pass.draw(6);

    pass.end();

    this.device.queue.submit([encoder.finish()]);
  }

  reconfigure(): void {
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'opaque',
    });
  }

  destroy(): void {
    this.uniformBuffer.destroy();
    this.seaVertexBuffer.destroy();
    this.depthTexture?.destroy();
    this.dummyHexTexture.destroy();
  }
}
