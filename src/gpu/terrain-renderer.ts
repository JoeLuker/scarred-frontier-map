import { MESH_VERTEX_BYTE_STRIDE } from './types';
import type { TerrainMesh } from './terrain-mesh';
import type { HexStateTexture } from './hex-state-texture';

// --- WGSL Shader ---

function createTerrainShader(): string {
  return /* wgsl */ `

// ============================================================
// Uniform buffer (256 bytes)
// ============================================================

struct Uniforms {
  view_proj: mat4x4f,              // 0-63
  height_scale: f32,               // 64
  hex_size: f32,                   // 68
  sea_level: f32,                  // 72
  mountain_threshold: f32,         // 76
  hill_threshold: f32,             // 80
  grid_radius: f32,                // 84
  moisture_desert: f32,            // 88
  moisture_forest: f32,            // 92
  moisture_marsh: f32,             // 96
  hex_grid_opacity: f32,           // 100
  fog_mix: f32,                    // 104
  _pad0: f32,                      // 108
  terrain_colors: array<vec4f, 8>, // 112-239
  eye_pos: vec3f,                  // 240-251
  _pad1: f32,                      // 252-255
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var hex_state_tex: texture_2d<f32>;

// ============================================================
// LAYER 1: Geometry (Vertex Shader)
// Pure heightfield: elevation → displaced Y, smooth normals.
// No hex awareness. Rivers have elevation = seaLevel (flat by data, not override).
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

// Karst terrain profile: flat valleys, steep cliff walls, tower peaks
// PARALLEL IMPLEMENTATION: Must match terrain-mesh.ts karstHeight() (CPU-side normal computation).
fn karst_height(h: f32) -> f32 {
  let cliff = smoothstep(0.12, 0.28, h);
  let peak = pow(h, 0.65);
  return cliff * peak;
}

@vertex
fn vs_main(in: VertexIn) -> VertexOut {
  let sea = u.sea_level;
  let land_range = 1.0 - sea;

  // Pure elevation-based displacement. Rivers have elevation = seaLevel,
  // so normElev = 0 → karstHeight(0) = 0 → no displacement. No terrain type needed.
  var y: f32 = 0.0;
  if (in.elevation >= sea && land_range > 0.0) {
    let norm_elev = (in.elevation - sea) / land_range;
    y = karst_height(norm_elev) * u.height_scale;
  }

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
// Fragment shader utilities
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
// Hash / noise utilities (GPU fragment shader)
// INTENTIONALLY DIFFERENT from terrain-compute.ts noise (which mirrors core/noise.ts).
// These use a fast vec2→float hash for real-time visual detail (rock texture, snow,
// per-hex variation). The compute shader uses integer lattice hashing for deterministic
// terrain generation. The two noise systems serve different purposes and don't need to match.
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
// Layer 3 (Hex Tile Identity): pixel_to_hex → texture lookup → terrain type
// Layer 2 (Surface Material): tile base color + noise/rock/snow/lighting
// Layer 4 (Game State): planar effects, fog of war
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
  let is_water = hex_terrain_id == 0u || in.elevation < sea;

  // Curvature approximation — must be in uniform control flow (before any
  // non-uniform branching) since dpdx/dpdy require all quad invocations active.
  let ddx_e = dpdx(in.elevation);
  let ddy_e = dpdy(in.elevation);
  let curvature = clamp((dpdx(ddx_e) + dpdy(ddy_e)) * 200.0, -1.0, 1.0);

  // ═══════════════════════════════════════════════════════════════
  // LAYER 2: Surface Material
  // Base color from discrete terrain type (sharp hex boundaries) +
  // continuous noise/slope/altitude effects (sub-hex visual richness).
  // ═══════════════════════════════════════════════════════════════

  var color: vec3f;

  if (is_water) {
    color = water_base_color(in.elevation, in.world_pos.xz);

    // Water specular + Fresnel
    let wn1 = (value_noise(in.world_pos.xz * 0.03) - 0.5) * 0.3;
    let wn2 = (value_noise(in.world_pos.xz * 0.07 + vec2f(50.0, 80.0)) - 0.5) * 0.15;
    let water_normal = normalize(vec3f(wn1, 1.0, wn2));

    let reflect_dir = reflect(-sun_dir, water_normal);
    let spec = pow(max(dot(reflect_dir, view_dir), 0.0), 64.0);
    color += SUN_COLOR * spec * 0.6;

    let NdotV = max(dot(water_normal, view_dir), 0.0);
    let fresnel = pow(1.0 - NdotV, 3.0) * 0.4;
    color = mix(color, SKY_COLOR * 0.8, fresnel);
  } else {
    // --- Tile base from canonical terrain color (sharp per-hex) ---
    color = u.terrain_colors[hex_terrain_id].rgb;

    // Per-hex subtle variation (each tile visually distinct)
    let hex_hash = hash2(hex.qr * 0.73 + vec2f(17.3, 31.7));
    color *= (0.92 + hex_hash * 0.16);

    // Subtle moisture modulation within the tile
    let moisture_shift = (in.moisture - 0.5) * 0.12;
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
    let rock_blend = smoothstep(0.2, 0.55, slope);
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

    let snow_line = 0.72;
    let snow_base = smoothstep(snow_line, 0.92, norm_elev);
    let snow_slip = 1.0 - smoothstep(0.3, 0.6, slope);
    let snow_fine = value_noise(in.world_pos.xz * 0.15) * 0.12;
    let snow_coarse = (fbm3(in.world_pos.xz * 0.02) - 0.5) * 0.2;
    let snow_t = clamp(snow_base * snow_slip + snow_fine * snow_base + snow_coarse * snow_base, 0.0, 1.0);
    let snow_color = vec3f(0.90, 0.93, 0.97) + vec3f(snow_fine * 0.08);
    color = mix(color, snow_color, snow_t);

    // Material roughness: wet lowlands get specular, dry highlands are matte
    let roughness = mix(0.3, 0.95, smoothstep(0.0, 0.5, norm_elev));
    let half_vec = normalize(sun_dir + view_dir);
    let NdotH = max(dot(normal, half_vec), 0.0);
    let spec_power = mix(32.0, 4.0, roughness);
    let land_spec = pow(NdotH, spec_power) * (1.0 - roughness) * 0.25;
    color += SUN_COLOR * land_spec;
  }

  // --- Directional lighting (Wrapped Lambert) ---
  let NdotL = dot(normal, sun_dir);
  let wrapped = saturate((NdotL + 0.15) / 1.15);
  let light = mix(SKY_COLOR * 0.35, SUN_COLOR, wrapped);
  let is_water_f = select(0.0, 1.0, is_water);
  let light_strength = mix(1.0, 0.5, is_water_f);
  color *= mix(vec3f(0.65), light, light_strength);

  // --- Rim / backlight on ridgelines ---
  if (!is_water) {
    let rim = pow(1.0 - max(dot(normal, view_dir), 0.0), 4.0);
    let rim_sun = max(dot(-view_dir, sun_dir), 0.0);
    color += rim * rim_sun * SUN_COLOR * 0.15;
  }

  // ═══════════════════════════════════════════════════════════════
  // LAYER 4: Per-Hex Game State
  // Planar effects and fog of war. Only modifies existing color.
  // Reads from the same hex_state texture already looked up in Layer 3.
  // ═══════════════════════════════════════════════════════════════

  let explored = hex_state.r;
  let plane_type = u32(round(hex_state.g * 255.0));
  let p_intensity = hex_state.b;

  // Per-plane visual effects (only for hexes with active planar influence)
  if (plane_type > 0u) {
    let pi = p_intensity;
    if (plane_type == 1u) {
      // FIRE: Orange emissive glow + red saturation boost + heat shimmer
      color += vec3f(1.0, 0.4, 0.1) * pi * 0.4;
      let fire_lum = dot(color, vec3f(0.299, 0.587, 0.114));
      color.r = mix(fire_lum, color.r, 1.0 + pi * 0.5);
      let shimmer = sin(in.world_pos.x * 0.1 + in.world_pos.z * 0.08) * pi * 0.05;
      color += vec3f(shimmer, shimmer * 0.5, 0.0);
    } else if (plane_type == 2u) {
      // WATER: Darken + blue/green saturation + wet specular sheen
      color *= (1.0 - pi * 0.3);
      let w_lum = dot(color, vec3f(0.299, 0.587, 0.114));
      color.b = mix(w_lum, color.b, 1.0 + pi * 0.6);
      color.g = mix(w_lum, color.g, 1.0 + pi * 0.3);
      let half_v = normalize(sun_dir + view_dir);
      let sheen = pow(max(dot(normal, half_v), 0.0), 32.0) * pi * 0.3;
      color += vec3f(sheen) * vec3f(0.6, 0.8, 1.0);
    } else if (plane_type == 3u) {
      // EARTH: Warm brown tint + rocky noise amplification + mild desaturation
      let earth_lum = dot(color, vec3f(0.299, 0.587, 0.114));
      color = mix(color, vec3f(0.55, 0.35, 0.2) * earth_lum * 2.0, pi * 0.35);
      let rock_n = (value_noise(in.world_pos.xz * 0.08) - 0.5) * pi * 0.2;
      color *= (1.0 + rock_n);
      let earth_gray = dot(color, vec3f(0.299, 0.587, 0.114));
      color = mix(color, vec3f(earth_gray), pi * 0.2);
    } else if (plane_type == 4u) {
      // AIR: Ethereal brightening + desaturation toward cool white-blue
      color *= (1.0 + pi * 0.3);
      let air_lum = dot(color, vec3f(0.299, 0.587, 0.114));
      color = mix(color, vec3f(0.85, 0.9, 1.0) * air_lum * 1.2, pi * 0.45);
    } else if (plane_type == 5u) {
      // POSITIVE: Golden additive glow + brightness boost
      color += vec3f(1.0, 0.85, 0.3) * pi * 0.25;
      color *= (1.0 + pi * 0.2);
    } else if (plane_type == 6u) {
      // NEGATIVE: Strong darkening + heavy desaturation toward purple-grey
      color *= (1.0 - pi * 0.5);
      let neg_lum = dot(color, vec3f(0.299, 0.587, 0.114));
      color = mix(color, vec3f(0.4, 0.3, 0.5) * neg_lum * 1.5, pi * 0.6);
    } else if (plane_type == 7u) {
      // SCAR: Noise-driven channel distortion + partial color inversion
      let scar_n = value_noise(in.world_pos.xz * 0.06 + vec2f(42.0, 17.0));
      let distort = (scar_n - 0.5) * pi * 0.4;
      color = vec3f(
        color.r + distort * color.b,
        color.g - distort * 0.5,
        color.b + distort * color.r
      );
      let inv = 1.0 - color;
      color = mix(color, inv, pi * 0.25);
    }
  }

  // Fog-of-war: desaturation + darken
  if (explored < 0.5) {
    let lum = dot(color, vec3f(0.299, 0.587, 0.114));
    let fog_grey = vec3f(lum) * 0.4;
    color = mix(color, fog_grey, u.fog_mix);
  }

  // ═══════════════════════════════════════════════════════════════
  // LAYER 5: Post-Processing
  // Grid overlay, atmospheric scattering, tone mapping.
  // Read-only of all prior layers.
  // ═══════════════════════════════════════════════════════════════

  // Hex grid overlay (SDF from hex.edge_dist computed in Layer 3)
  let edge_dist = hex.edge_dist;
  let edge_aa = fwidth(edge_dist);
  var grid_line = smoothstep(0.5 - edge_aa * 2.0, 0.5, edge_dist);
  var grid_opacity = u.hex_grid_opacity;

  // Sector boundary borders (thicker lines between tiled hex groups)
  if (ring_boundary) {
    grid_line = max(grid_line, smoothstep(0.45 - edge_aa * 3.0, 0.45, edge_dist));
    grid_opacity = max(grid_opacity, 0.35);
  }

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

  // World edge fade
  let world_dist2 = in.world_pos.x * in.world_pos.x + in.world_pos.z * in.world_pos.z;
  let world_radius = u.grid_radius * u.hex_size * SQRT3;
  let edge_fade = smoothstep(world_radius * world_radius, (world_radius - 200.0) * (world_radius - 200.0), world_dist2);
  color *= edge_fade;

  // ACES filmic tone mapping
  color = aces_tonemap(color * 0.95);

  return vec4f(clamp(color, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;
}

// --- Uniform buffer layout (256 bytes) ---
const UNIFORM_SIZE = 256;
const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';

export class TerrainRenderer {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private pipeline: GPURenderPipeline;
  private uniformBuffer: GPUBuffer;
  private bindGroupLayout: GPUBindGroupLayout;
  private bindGroup: GPUBindGroup | null = null;
  private format: GPUTextureFormat;

  private depthTexture: GPUTexture | null = null;

  private currentMesh: TerrainMesh | null = null;
  private currentHexState: HexStateTexture | null = null;

  // Dummy 1x1 texture for when no hex state is set
  private dummyTexture: GPUTexture;

  private constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    pipeline: GPURenderPipeline,
    uniformBuffer: GPUBuffer,
    bindGroupLayout: GPUBindGroupLayout,
    format: GPUTextureFormat,
    dummyTexture: GPUTexture,
  ) {
    this.device = device;
    this.context = context;
    this.pipeline = pipeline;
    this.uniformBuffer = uniformBuffer;
    this.bindGroupLayout = bindGroupLayout;
    this.format = format;
    this.dummyTexture = dummyTexture;
  }

  static create(device: GPUDevice, canvas: HTMLCanvasElement): TerrainRenderer {
    const format = navigator.gpu.getPreferredCanvasFormat();
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('Failed to get WebGPU canvas context');

    context.configure({ device, format, alphaMode: 'opaque' });

    const shaderModule = device.createShaderModule({ code: createTerrainShader() });

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
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
      ],
    });

    const pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
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
        cullMode: 'none', // terrain viewed from any angle
      },
      depthStencil: {
        depthWriteEnabled: true,
        depthCompare: 'less',
        format: DEPTH_FORMAT,
      },
    });

    // Create a 1x1 dummy texture for initial bind group
    const dummyTexture = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: dummyTexture },
      new Uint8Array([0, 0, 0, 0]),
      { bytesPerRow: 4 },
      [1, 1],
    );

    return new TerrainRenderer(
      device, context, pipeline, uniformBuffer, bindGroupLayout, format, dummyTexture,
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
    fogMix: number,
    terrainColors: Float32Array, // 8 × 4 = 32 floats (rgba per terrain type)
    eyePos: readonly [number, number, number],
  ): void {
    const data = new Float32Array(UNIFORM_SIZE / 4); // 64 floats

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
    data[26] = fogMix;
    data[27] = 0; // pad

    // terrainColors: 8 × vec4f = 32 floats at offset 28
    // array<vec4f, 8> starts at byte 112 = float offset 28
    data.set(terrainColors.subarray(0, 32), 28);

    // eye_pos: vec3f at byte 240 = float offset 60
    data[60] = eyePos[0];
    data[61] = eyePos[1];
    data[62] = eyePos[2];

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
    const texture = this.currentHexState?.texture ?? this.dummyTexture;
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: texture.createView() },
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
      },
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.currentMesh.vertexBuffer);
    pass.setIndexBuffer(this.currentMesh.indexBuffer, 'uint32');
    pass.drawIndexed(this.currentMesh.indexCount);
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
    this.depthTexture?.destroy();
    this.dummyTexture.destroy();
  }
}
