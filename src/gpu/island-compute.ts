/**
 * GPU compute pipeline for classifying terrain vertices as floating island chunks.
 * Uses shared render-time noise functions from render-noise.wgsl.ts
 * — NOT the terrain-noise.wgsl.ts functions used for biome generation.
 * Also reads hex_state_tex to get per-vertex planar type and intensity.
 */

import { createRenderNoiseWGSL } from './render-noise.wgsl';

function createIslandClassifyShader(): string {
  return /* wgsl */ `

struct IslandConfig {
  hex_size: f32,
  grid_radius: f32,
  height_scale: f32,
  sea_level: f32,
  vertex_count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}

@group(0) @binding(0) var<uniform> config: IslandConfig;
@group(0) @binding(1) var<storage, read> positions: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> results: array<vec4f>;
@group(0) @binding(3) var hex_state_tex: texture_2d<f32>;

` + createRenderNoiseWGSL() + `

// ============================================================
// Compute kernel: per-vertex island classification
// ============================================================

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= config.vertex_count) { return; }

  let pos = positions[idx];

  // Look up hex state at this vertex position
  let hex_qr = pixel_to_hex_qr(pos.x, pos.y, config.hex_size);
  let hex_state = lookup_hex_state(hex_qr, config.grid_radius);
  let packed_g = decode_packed_g(hex_state.g);
  let plane_type = packed_g.plane_type;
  let planar_intensity = hex_state.b;

  // Only Air plane (type 4) creates floating islands
  if (plane_type != 4u) {
    results[idx] = vec4f(0.0, 0.0, planar_intensity, 0.0);
    return;
  }

  let frag = packed_g.fragmentation;
  let lift_param = hex_state.r;  // R channel is raw lift (unorm 0-1)

  let base_freq = AIR_BASE_FREQ * pow(AIR_FRAG_EXPONENT, frag);
  let detail_freq = base_freq * AIR_DETAIL_FREQ_MUL;

  // Chunk noise — same as vertex shader Air branch
  let chunk = fbm3(pos * base_freq) * AIR_CHUNK_BLEND_FBM + value_noise(pos * detail_freq) * AIR_CHUNK_BLEND_DETAIL;
  let edge_onset = saturate(planar_intensity / AIR_EDGE_ONSET);
  let threshold = mix(AIR_THRESHOLD_HIGH, AIR_COVERAGE_THRESHOLD, edge_onset);
  let is_floating = smoothstep(threshold - AIR_SMOOTHSTEP_WIDTH, threshold + AIR_SMOOTHSTEP_WIDTH, chunk);

  // Per-chunk lift variation: fixed frequency decoupled from fragmentation
  // so each chunk gets a roughly uniform altitude offset.
  let chunk_alt = value_noise(pos * AIR_ALT_VARIATION_FREQ);
  let alt_mul = 0.8 + chunk_alt * 0.4; // 0.8x to 1.2x per-chunk

  // Lift height: slider value directly controls height.
  // 0.15 = max lift as fraction of heightScale.
  let lift_height = lift_param * AIR_MAX_LIFT_FRACTION * config.height_scale * alt_mul;

  results[idx] = vec4f(is_floating, lift_height, planar_intensity, 0.0);
}
`;
}

// IslandConfig: 4 f32 + 4 u32 = 8 × 4 = 32 bytes
const CONFIG_BUFFER_SIZE = 32;

export class IslandCompute {
  private device: GPUDevice;
  private pipeline: GPUComputePipeline;
  private configBuffer: GPUBuffer;
  private posBuffer: GPUBuffer;
  private resultBuffer: GPUBuffer;
  private readbackBuffer: GPUBuffer;
  private bindGroupLayout: GPUBindGroupLayout;
  private bindGroup: GPUBindGroup;
  private hexStateTexture: GPUTexture;
  private maxVertices: number;

  private constructor(
    device: GPUDevice,
    pipeline: GPUComputePipeline,
    configBuffer: GPUBuffer,
    posBuffer: GPUBuffer,
    resultBuffer: GPUBuffer,
    readbackBuffer: GPUBuffer,
    bindGroupLayout: GPUBindGroupLayout,
    bindGroup: GPUBindGroup,
    hexStateTexture: GPUTexture,
    maxVertices: number,
  ) {
    this.device = device;
    this.pipeline = pipeline;
    this.configBuffer = configBuffer;
    this.posBuffer = posBuffer;
    this.resultBuffer = resultBuffer;
    this.readbackBuffer = readbackBuffer;
    this.bindGroupLayout = bindGroupLayout;
    this.bindGroup = bindGroup;
    this.hexStateTexture = hexStateTexture;
    this.maxVertices = maxVertices;
  }

  static create(device: GPUDevice, hexStateTexture: GPUTexture, maxVertices: number): IslandCompute {
    const shaderModule = device.createShaderModule({ code: createIslandClassifyShader() });

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d' } },
      ],
    });

    const pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      compute: { module: shaderModule, entryPoint: 'main' },
    });

    const configBuffer = device.createBuffer({
      size: CONFIG_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const posBuffer = device.createBuffer({
      size: maxVertices * 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // results: vec4f per vertex = 16 bytes
    const resultBuffer = device.createBuffer({
      size: maxVertices * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const readbackBuffer = device.createBuffer({
      size: maxVertices * 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    const bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: configBuffer } },
        { binding: 1, resource: { buffer: posBuffer } },
        { binding: 2, resource: { buffer: resultBuffer } },
        { binding: 3, resource: hexStateTexture.createView() },
      ],
    });

    return new IslandCompute(
      device, pipeline, configBuffer, posBuffer, resultBuffer,
      readbackBuffer, bindGroupLayout, bindGroup, hexStateTexture, maxVertices,
    );
  }

  updateHexState(texture: GPUTexture): void {
    this.hexStateTexture = texture;
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.configBuffer } },
        { binding: 1, resource: { buffer: this.posBuffer } },
        { binding: 2, resource: { buffer: this.resultBuffer } },
        { binding: 3, resource: texture.createView() },
      ],
    });
  }

  async classify(
    positions: Float32Array,
    vertexCount: number,
    hexSize: number,
    gridRadius: number,
    heightScale: number,
    seaLevel: number,
  ): Promise<Float32Array> {
    // Grow buffers if needed
    if (vertexCount > this.maxVertices) {
      this.posBuffer.destroy();
      this.resultBuffer.destroy();
      this.readbackBuffer.destroy();

      this.maxVertices = Math.ceil(vertexCount * 1.5);

      this.posBuffer = this.device.createBuffer({
        size: this.maxVertices * 8,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.resultBuffer = this.device.createBuffer({
        size: this.maxVertices * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      this.readbackBuffer = this.device.createBuffer({
        size: this.maxVertices * 16,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });

      this.bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.configBuffer } },
          { binding: 1, resource: { buffer: this.posBuffer } },
          { binding: 2, resource: { buffer: this.resultBuffer } },
          { binding: 3, resource: this.hexStateTexture.createView() },
        ],
      });
    }

    // Upload positions
    this.device.queue.writeBuffer(this.posBuffer, 0, positions, 0, vertexCount * 2);

    // Upload config
    const configData = new ArrayBuffer(CONFIG_BUFFER_SIZE);
    const f32 = new Float32Array(configData);
    const u32 = new Uint32Array(configData);
    f32[0] = hexSize;
    f32[1] = gridRadius;
    f32[2] = heightScale;
    f32[3] = seaLevel;
    u32[4] = vertexCount;
    u32[5] = 0;
    u32[6] = 0;
    u32[7] = 0;
    this.device.queue.writeBuffer(this.configBuffer, 0, configData);

    // Dispatch
    const workgroups = Math.ceil(vertexCount / 64);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(workgroups);
    pass.end();

    const byteCount = vertexCount * 16;
    encoder.copyBufferToBuffer(this.resultBuffer, 0, this.readbackBuffer, 0, byteCount);
    this.device.queue.submit([encoder.finish()]);

    // Read back
    await this.readbackBuffer.mapAsync(GPUMapMode.READ, 0, byteCount);
    const range = this.readbackBuffer.getMappedRange(0, byteCount);
    const result = new Float32Array(vertexCount * 4);
    result.set(new Float32Array(range));
    this.readbackBuffer.unmap();

    return result;
  }

  destroy(): void {
    this.configBuffer.destroy();
    this.posBuffer.destroy();
    this.resultBuffer.destroy();
    this.readbackBuffer.destroy();
  }
}
