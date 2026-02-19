// --- WGSL Shader (terrain) ---

export function createTerrainShader(): string {
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

// Per-object configuration (scene graph — identity model for terrain/sea)
struct ObjectConfig {
  model: mat4x4f,   // 64 bytes — world transform
  flags: u32,       // 4 bytes  — bit 0: IS_TERRAIN, bit 1: IS_SEA, bit 2: IS_ISLAND_LAYER, bit 3: IS_ISLAND_UNDERSIDE
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,       // total: 80 bytes (16-byte aligned)
}

@group(1) @binding(0) var<uniform> obj: ObjectConfig;

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
  @location(4) island_mask: f32,
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

  // Island underside: elevation field stores normalized world Y directly.
  // Skip displacement_curve and all planar displacement — geometry is pre-baked.
  if ((obj.flags & 8u) != 0u) {
    let y = in.elevation * hs;
    let local = vec4f(in.pos_xz.x, y, in.pos_xz.y, 1.0);
    let world = (obj.model * local).xyz;
    let clip = u.view_proj * vec4f(world, 1.0);
    var out: VertexOut;
    out.clip_pos = clip;
    out.world_pos = world;
    out.elevation = in.elevation;
    out.moisture = in.moisture;
    out.smooth_normal = in.normal;
    out.island_mask = 1.0;
    return out;
  }

  // Base elevation displacement. Rivers have elevation = seaLevel,
  // so normElev = 0 → displacement_curve(0) = 0 → no displacement.
  let norm_elev = clamp((in.elevation - sea) / land_range, 0.0, 1.0);
  var y: f32 = 0.0;
  if (in.elevation >= sea) {
    y = displacement_curve(norm_elev) * hs;
  }

  // Island layer mask: 0 = discard in fragment, 1 = keep.
  // Default 0 for island layer (discard unless Air branch overrides), 1 for everything else.
  var island_mask: f32 = select(1.0, 0.0, (obj.flags & 4u) != 0u);

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
    // AIR: dual-layer rendering via obj.flags.
    // Both layers: smooth ground base. Island layer lifts uniformly;
    // fragment shader discards non-floating fragments.
    // Decode R channel: high nibble = lift param, low nibble = fragmentation
    let r_byte = u32(round(vt_state.r * 255.0));
    let frag = f32(r_byte & 0xFu) / 15.0;
    let lift_param = f32(r_byte >> 4u) / 15.0;

    let base_freq = 0.003 * pow(8.0, frag);
    let detail_freq = base_freq * 3.75;
    let chunk = fbm3(in.pos_xz * base_freq) * 0.7 + value_noise(in.pos_xz * detail_freq) * 0.3;
    let lift_t = saturate((vt_pi - 0.3) / 0.5);
    let threshold = mix(0.75, 0.15, lift_t);
    let is_floating = smoothstep(threshold - 0.1, threshold + 0.1, chunk);

    let is_island_layer = (obj.flags & 4u) != 0u;

    // Both layers: smooth terrain toward median
    let median_y = displacement_curve(0.35) * hs;
    let smooth_t = saturate(vt_pi / 0.4);

    if (is_island_layer) {
      // Stronger smoothing for islands — flattens terrain for clean floating surfaces
      y = mix(y, median_y, smooth_t * 0.6);
      // Pass floating mask to fragment for discard (avoids expensive noise recompute)
      island_mask = is_floating;
      // Per-chunk altitude variation: noise frequency below chunk frequency
      // so each chunk gets a roughly uniform altitude offset.
      let chunk_alt = value_noise(in.pos_xz * base_freq * 0.3);
      let alt_mul = 0.7 + chunk_alt * 0.6; // 0.7x to 1.3x per-chunk
      // Lift slider controls height
      let lift = mix(0.005, 0.12, lift_param) * lift_t * hs * alt_mul;
      y += lift;
    } else {
      // Ground: gentle smoothing
      y = mix(y, median_y, smooth_t * 0.3);
      // Terrain ripped away where islands were torn out.
      // Pulls terrain toward below-sea-level, creating visible craters.
      let gouge_target = -0.008 * hs;
      let gouge_factor = is_floating * lift_t * mix(0.4, 0.9, lift_param);
      y = mix(y, gouge_target, gouge_factor);
    }

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

  let local = vec4f(in.pos_xz.x, y, in.pos_xz.y, 1.0);
  let world = (obj.model * local).xyz;
  let clip = u.view_proj * vec4f(world, 1.0);

  var out: VertexOut;
  out.clip_pos = clip;
  out.world_pos = world;
  out.elevation = in.elevation;
  out.moisture = in.moisture;
  out.smooth_normal = in.normal;
  out.island_mask = island_mask;
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

fn get_planar_material(plane_type: u32, intensity: f32, wp: vec3f, elev: f32, sea: f32, packed_r: f32) -> PlanarMaterial {
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
    // ── AIR: Floating islands (dual-layer) ──
    // Ground layer: wind-scoured surfaces + crater marks where islands lifted.
    // Island layer: ethereal sky-stone material with glow.
    let lift_t = saturate((pi - 0.3) / 0.5);
    let is_island_layer = (obj.flags & 4u) != 0u;

    if (is_island_layer) {
      // Island layer: subtle cool tint, preserves terrain identity
      let cn = value_noise(wn * 0.02 + vec2f(5.0, 11.0)) - 0.5;
      pm.normal_offset = vec3f(cn * 0.1, 0.1, cn * 0.08) * pi;

      let tint = vec3f(0.6, 0.68, 0.78);
      pm.replace_color = tint;
      pm.replace_strength = pi * 0.35;
      pm.emission = vec3f(0.15, 0.25, 0.45) * lift_t * 0.08;
      pm.roughness_mod = -0.2 * pi;
      pm.snow_line_shift = -0.15 * pi;
      pm.ambient_mod = 1.0 + 0.2 * pi;
      pm.shadow_mod = mix(1.0, 0.7, pi);
      pm.specular_mod = 1.0 + 0.4 * pi;
    } else {
      // Ground layer: subtle wind-worn desaturation + crater marks
      let a1 = (value_noise(wn * 0.05 + vec2f(3.0, 7.0)) - 0.5);
      pm.normal_offset = vec3f(a1 * 0.2, value_noise(wn * 0.03) * 0.3, a1 * 0.15) * pi;

      // Decode packed R: high nibble = lift, low nibble = fragmentation
      let pm_r_byte = u32(round(packed_r * 255.0));
      let frag = f32(pm_r_byte & 0xFu) / 15.0;

      // Recompute chunk noise for crater marks (ground layer only)
      let fs_base_freq = 0.003 * pow(8.0, frag);
      let fs_detail_freq = fs_base_freq * 3.75;
      let chunk = fbm3(wn * fs_base_freq) * 0.7 + value_noise(wn * fs_detail_freq) * 0.3;
      let threshold = mix(0.75, 0.15, lift_t);
      let is_floating = smoothstep(threshold - 0.1, threshold + 0.1, chunk);

      // Crater areas: exposed brown soil/dirt where terrain was ripped out
      let gouge = is_floating * lift_t;
      let windswept = vec3f(0.50, 0.46, 0.40);
      let soil = vec3f(0.38, 0.28, 0.16);
      let surface = mix(windswept, soil, gouge);
      pm.replace_color = surface;
      pm.replace_strength = mix(pi * 0.15, 0.9, gouge);
      pm.roughness_mod = mix(0.0, 0.5, gouge) * pi;
      pm.snow_line_shift = mix(-0.1, 0.6, gouge) * pi;
      pm.moisture_mod = mix(0.0, -0.4, gouge) * pi;
      pm.ambient_mod = mix(1.0 + 0.1 * pi, 0.75, gouge);
      pm.shadow_mod = mix(1.0, 0.6, gouge);
      pm.specular_mod = mix(1.0, 0.2, gouge);
    }

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
  let p_frag = hex_state.r;
  let pm = get_planar_material(plane_type, p_intensity, in.world_pos, in.elevation, sea, p_frag);

  // Curvature approximation — must be in uniform control flow (before any
  // non-uniform branching) since dpdx/dpdy require all quad invocations active.
  let ddx_e = dpdx(in.elevation);
  let ddy_e = dpdy(in.elevation);
  let curvature = clamp((dpdx(ddx_e) + dpdy(ddy_e)) * 200.0, -1.0, 1.0);

  // Hex distance from grid center — used for ocean fallback and grid fade.
  // Placed after derivative computation to keep dpdx/dpdy in uniform control flow.
  let hex_dist = max(max(abs(hex.qr.x), abs(hex.qr.y)), abs(hex.qr.x + hex.qr.y));
  let is_beyond_grid = hex_dist > u.grid_radius;

  // Island layer: discard non-floating fragments via vertex-interpolated mask.
  // island_mask = 0 for island-layer verts in non-Air hexes or non-floating areas.
  if (in.island_mask < 0.1) { discard; }

  // ═══════════════════════════════════════════════════════════════
  // Island underside: rocky material with simplified lighting.
  // Early return — no biome, no hex grid, no snow.
  // ═══════════════════════════════════════════════════════════════
  if ((obj.flags & 8u) != 0u) {
    let rock_n = value_noise(in.world_pos.xz * 0.08);
    let strata = value_noise(in.world_pos.xz * vec2f(0.3, 0.02));
    let detail = value_noise(in.world_pos.xz * 0.25);
    let base_rock = vec3f(0.30, 0.26, 0.22);
    let light_rock = vec3f(0.42, 0.38, 0.32);
    var color = mix(base_rock, light_rock, rock_n * 0.6 + strata * 0.3);
    color *= (0.85 + detail * 0.3);

    // Simple lighting with vertex normal
    let N = normalize(in.smooth_normal);
    let NdotL = dot(N, normalize(SUN_DIR));
    let wrapped = saturate((NdotL + 0.4) / 1.4);
    let lit = color * mix(vec3f(0.08, 0.10, 0.14), SUN_COLOR * 0.55, wrapped);

    // Atmospheric fog (same as terrain)
    let view_dist = length(in.world_pos - u.eye_pos);
    let view_to_frag = normalize(in.world_pos - u.eye_pos);
    let fog_amount = 1.0 - exp(-view_dist * FOG_DENSITY);
    let sun_alignment = max(dot(view_to_frag, normalize(SUN_DIR)), 0.0);
    let rayleigh_color = mix(
      vec3f(0.35, 0.45, 0.7),
      vec3f(0.7, 0.6, 0.45),
      sun_alignment * sun_alignment
    );
    let mie = pow(sun_alignment, 8.0) * 0.3;
    let scatter_color = mix(rayleigh_color, SUN_COLOR, mie);
    var final_color = mix(lit, scatter_color, fog_amount);

    final_color = aces_tonemap(final_color * 0.95);
    return vec4f(clamp(final_color, vec3f(0.0), vec3f(1.0)), 1.0);
  }

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

export function invertMat4(m: Float32Array): Float32Array {
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

