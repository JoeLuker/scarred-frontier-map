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
  _pad1: array<vec4f, 1>,          // 240-255
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var hex_state_tex: texture_2d<f32>;

// ============================================================
// Vertex shader
// ============================================================

struct VertexIn {
  @location(0) pos_xz: vec2f,
  @location(1) elevation: f32,
  @location(2) moisture: f32,
  @location(3) terrain_id: f32,
}

struct VertexOut {
  @builtin(position) clip_pos: vec4f,
  @location(0) world_pos: vec3f,
  @location(1) elevation: f32,
  @location(2) moisture: f32,
  @location(3) terrain_id: f32,
}

// Karst terrain profile: flat valleys, steep cliff walls, tower peaks
fn karst_height(h: f32) -> f32 {
  let cliff = smoothstep(0.12, 0.28, h);
  let peak = pow(h, 0.65);
  return cliff * peak;
}

@vertex
fn vs_main(in: VertexIn) -> VertexOut {
  let sea = u.sea_level;
  let land_range = 1.0 - sea;

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
  out.terrain_id = in.terrain_id;
  return out;
}

// ============================================================
// Fragment shader
// ============================================================

const PI: f32 = 3.14159265359;
const SQRT3: f32 = 1.7320508075688772;

// Hex grid SDF: distance from world position to nearest hex edge
fn hex_edge_distance(wx: f32, wz: f32, hex_size: f32) -> f32 {
  // Convert pixel → fractional axial
  let inv_sqrt3 = 1.0 / SQRT3;
  let fq = (inv_sqrt3 * wx / hex_size) - (wz / (3.0 * hex_size));
  let fr = (2.0 / 3.0) * wz / hex_size;

  // Cube coords (fractional)
  let fx = fq;
  let fz = fr;
  let fy = -fx - fz;

  // Round to nearest hex center
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

  // Distance from fractional to rounded (in cube space)
  let diff_x = abs(fx - rx);
  let diff_y = abs(fy - ry);
  let diff_z = abs(fz - rz);

  // Max of cube diffs gives distance to hex edge (0 = center, 0.5 = edge)
  return max(diff_x, max(diff_y, diff_z));
}

// Look up hex state texture by world position
fn sample_hex_state(wx: f32, wz: f32, hex_size: f32, grid_radius: f32) -> vec4f {
  // World → axial hex coords
  let inv_sqrt3 = 1.0 / SQRT3;
  let fq = (inv_sqrt3 * wx / hex_size) - (wz / (3.0 * hex_size));
  let fr = (2.0 / 3.0) * wz / hex_size;

  // Round
  let fx = fq;
  let fz = fr;
  let fy = -fx - fz;
  var rq = round(fx);
  var rr = round(fz);
  let ry = round(fy);
  let dx = abs(rq - fx);
  let dy = abs(ry - fy);
  let dz = abs(rr - fz);
  if (dx > dy && dx > dz) {
    rq = -ry - rr;
  } else if (dy <= dz) {
    rr = -rq - ry;
  }

  // Map axial (q, r) to texture UV: center at (gridRadius, gridRadius)
  let tex_size = grid_radius * 2.0 + 1.0;
  let tx = (rq + grid_radius) / tex_size;
  let tz = (rr + grid_radius) / tex_size;

  // Out of bounds → unexplored, no tint
  if (tx < 0.0 || tx > 1.0 || tz < 0.0 || tz > 1.0) {
    return vec4f(0.0, 0.0, 0.0, 0.0);
  }

  let tex_coord = vec2i(i32(rq + grid_radius), i32(rr + grid_radius));
  return textureLoad(hex_state_tex, tex_coord, 0);
}

// Biome color from elevation/moisture/slope
fn biome_color(elevation: f32, moisture: f32, slope: f32, terrain_id: f32) -> vec3f {
  let sea = u.sea_level;

  // --- Water ---
  if (elevation < sea) {
    let depth = (sea - elevation) / max(sea, 0.001);
    let shallow = u.terrain_colors[0].rgb; // Water color
    let deep = shallow * 0.4;
    return mix(shallow, deep, smoothstep(0.0, 1.0, depth));
  }

  // --- Land biome blending ---
  let m = moisture;
  let mDesert = u.moisture_desert;
  let mForest = u.moisture_forest;
  let mMarsh = u.moisture_marsh;
  let trans = 0.06; // Transition zone width

  let desert_col = u.terrain_colors[1].rgb;  // Desert
  let plain_col  = u.terrain_colors[2].rgb;  // Plain
  let forest_col = u.terrain_colors[3].rgb;  // Forest
  let marsh_col  = u.terrain_colors[4].rgb;  // Marsh
  let hill_col   = u.terrain_colors[5].rgb;  // Hill
  let mtn_col    = u.terrain_colors[6].rgb;  // Mountain

  // Moisture axis blending (smooth transitions)
  let desert_w = 1.0 - smoothstep(mDesert - trans, mDesert + trans, m);
  let marsh_w  = smoothstep(mMarsh - trans, mMarsh + trans, m);
  let forest_w = smoothstep(mForest - trans, mForest + trans, m) * (1.0 - marsh_w);
  let plain_w  = max(0.0, 1.0 - desert_w - forest_w - marsh_w);

  var base = desert_col * desert_w + plain_col * plain_w + forest_col * forest_w + marsh_col * marsh_w;

  // Elevation axis: blend toward hill/mountain colors at higher elevations
  let land_range = 1.0 - sea;
  let norm_elev = select(0.0, (elevation - sea) / land_range, land_range > 0.0);

  let hill_t = smoothstep(u.hill_threshold - 0.05, u.hill_threshold + 0.05, elevation);
  let mtn_t  = smoothstep(u.mountain_threshold - 0.05, u.mountain_threshold + 0.05, elevation);

  base = mix(base, hill_col, hill_t * (1.0 - mtn_t));
  base = mix(base, mtn_col, mtn_t);

  // Slope darkening (cliff faces)
  let slope_darken = mix(1.0, 0.35, smoothstep(0.3, 0.8, slope));
  base *= slope_darken;

  // Subtle altitude brightness variation
  base *= (0.85 + norm_elev * 0.15);

  return base;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  // --- Surface normal via screen-space derivatives ---
  let ddx_pos = dpdx(in.world_pos);
  let ddy_pos = dpdy(in.world_pos);
  let normal = normalize(cross(ddx_pos, ddy_pos));
  let slope = 1.0 - abs(normal.y);

  // --- Biome color ---
  var color = biome_color(in.elevation, in.moisture, slope, in.terrain_id);

  // --- Hex grid overlay (SDF) ---
  let edge_dist = hex_edge_distance(in.world_pos.x, in.world_pos.z, u.hex_size);
  // edge_dist: 0 at center, ~0.5 at edge
  let edge_aa = fwidth(edge_dist);
  let grid_line = smoothstep(0.5 - edge_aa * 2.0, 0.5, edge_dist);
  color = mix(color, color * 0.3, grid_line * u.hex_grid_opacity);

  // --- Hex state (fog of war + planar tint) ---
  let hex_state = sample_hex_state(in.world_pos.x, in.world_pos.z, u.hex_size, u.grid_radius);
  let explored = hex_state.r;
  let tint_color = hex_state.gba;
  let has_tint = step(0.01, tint_color.r + tint_color.g + tint_color.b);

  // Planar tint blending (weighted average with base)
  if (has_tint > 0.5) {
    let tint_weight = 0.3;
    color = mix(color, tint_color, tint_weight);
  }

  // Fog of war: unexplored hexes get white tint
  if (explored < 0.5) {
    color = mix(color, vec3f(1.0), u.fog_mix);
  }

  // --- World edge fade ---
  let world_dist2 = in.world_pos.x * in.world_pos.x + in.world_pos.z * in.world_pos.z;
  let world_radius = u.grid_radius * u.hex_size * SQRT3;
  let edge_fade = smoothstep(world_radius * world_radius, (world_radius - 200.0) * (world_radius - 200.0), world_dist2);
  color *= edge_fade;

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
            { shaderLocation: 3, offset: 16, format: 'float32' },    // terrain_id
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
    // But vec4f alignment in WGSL requires 16-byte alignment.
    // array<vec4f, 8> starts at byte 112 = float offset 28
    data.set(terrainColors.subarray(0, 32), 28);

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
