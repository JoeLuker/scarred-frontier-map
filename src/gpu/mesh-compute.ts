import { WorldGenConfig } from '../core/types';
import { createTerrainNoiseWGSL } from './terrain-noise.wgsl';

/**
 * GPU compute pipeline for mesh vertex elevation+moisture sampling.
 * Replaces CPU sampleTerrain() calls in buildTerrainMesh().
 * Shares noise functions with TerrainCompute via terrain-noise.wgsl.ts.
 */

function createMeshShader(): string {
  return createTerrainNoiseWGSL() + /* wgsl */ `

struct MeshConfig {
  // TerrainParams fields (same layout)
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
  _tp_pad: u32,
  // Mesh-specific fields
  vertex_count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}

@group(0) @binding(0) var<uniform> config: MeshConfig;
@group(0) @binding(1) var<storage, read> positions: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> results: array<vec2f>;

fn get_terrain_params() -> TerrainParams {
  return TerrainParams(
    config.seed, config.water_level, config.mountain_level, config.vegetation_level,
    config.river_density, config.ruggedness, config.force_no_river, config.continent_scale,
    config.temperature, config.ridge_sharpness, config.plateau_factor, config.coast_complexity,
    config.erosion, config.valley_depth, config.chaos, 0u,
  );
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= config.vertex_count) { return; }

  let pos = positions[idx];
  let tp = get_terrain_params();
  let field = sample_terrain_field(pos.x, pos.y, tp);

  results[idx] = vec2f(field.elevation, field.moisture);
}
`;
}

// MeshConfig: 16 TerrainParams + 4 mesh-specific = 20 × 4 = 80 bytes
const CONFIG_BUFFER_SIZE = 80;

export class MeshCompute {
  private device: GPUDevice;
  private pipeline: GPUComputePipeline;
  private configBuffer: GPUBuffer;
  private posBuffer: GPUBuffer;
  private resultBuffer: GPUBuffer;
  private readbackBuffer: GPUBuffer;
  private bindGroupLayout: GPUBindGroupLayout;
  private bindGroup: GPUBindGroup;
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
    this.maxVertices = maxVertices;
  }

  static create(device: GPUDevice, maxVertices: number): MeshCompute {
    const shaderModule = device.createShaderModule({ code: createMeshShader() });

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
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

    // positions: vec2<f32> per vertex = 8 bytes
    const posBuffer = device.createBuffer({
      size: maxVertices * 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // results: vec2<f32> per vertex (elevation, moisture) = 8 bytes
    const resultBuffer = device.createBuffer({
      size: maxVertices * 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const readbackBuffer = device.createBuffer({
      size: maxVertices * 8,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    const bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: configBuffer } },
        { binding: 1, resource: { buffer: posBuffer } },
        { binding: 2, resource: { buffer: resultBuffer } },
      ],
    });

    return new MeshCompute(
      device, pipeline, configBuffer, posBuffer, resultBuffer,
      readbackBuffer, bindGroupLayout, bindGroup, maxVertices,
    );
  }

  /**
   * Sample elevation and moisture at vertex positions via GPU compute.
   * @param positions Flat array of [posX, posZ, posX, posZ, ...] pairs
   * @param vertexCount Number of vertices
   * @param config World generation config
   * @returns Per-vertex elevation and moisture arrays
   */
  async sample(
    positions: Float32Array,
    vertexCount: number,
    config: WorldGenConfig,
  ): Promise<{ elevations: Float32Array; moistures: Float32Array }> {
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
        size: this.maxVertices * 8,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      this.readbackBuffer = this.device.createBuffer({
        size: this.maxVertices * 8,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });

      this.bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.configBuffer } },
          { binding: 1, resource: { buffer: this.posBuffer } },
          { binding: 2, resource: { buffer: this.resultBuffer } },
        ],
      });
    }

    // Upload positions
    this.device.queue.writeBuffer(this.posBuffer, 0, positions, 0, vertexCount * 2);

    // Upload config (same layout as TerrainParams + mesh-specific)
    const configData = new ArrayBuffer(CONFIG_BUFFER_SIZE);
    const i32View = new Int32Array(configData);
    const f32View = new Float32Array(configData);
    const u32View = new Uint32Array(configData);

    i32View[0] = config.seed;
    f32View[1] = config.waterLevel;
    f32View[2] = config.mountainLevel;
    f32View[3] = config.vegetationLevel;
    f32View[4] = config.riverDensity;
    f32View[5] = config.ruggedness;
    u32View[6] = 0; // force_no_river = false (mesh samples rivers for flat river beds)
    f32View[7] = config.continentScale;
    f32View[8] = config.temperature;
    f32View[9] = config.ridgeSharpness;
    f32View[10] = config.plateauFactor;
    f32View[11] = config.coastComplexity;
    f32View[12] = config.erosion;
    f32View[13] = config.valleyDepth;
    f32View[14] = config.chaos;
    u32View[15] = 0; // _tp_pad
    u32View[16] = vertexCount;
    u32View[17] = 0; // _pad0
    u32View[18] = 0; // _pad1
    u32View[19] = 0; // _pad2

    this.device.queue.writeBuffer(this.configBuffer, 0, configData);

    // Dispatch compute
    const workgroups = Math.ceil(vertexCount / 64);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(workgroups);
    pass.end();

    const byteCount = vertexCount * 8;
    encoder.copyBufferToBuffer(this.resultBuffer, 0, this.readbackBuffer, 0, byteCount);
    this.device.queue.submit([encoder.finish()]);

    // Read back
    await this.readbackBuffer.mapAsync(GPUMapMode.READ, 0, byteCount);
    const range = this.readbackBuffer.getMappedRange(0, byteCount);
    const data = new Float32Array(range);

    const elevations = new Float32Array(vertexCount);
    const moistures = new Float32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
      elevations[i] = data[i * 2]!;
      moistures[i] = data[i * 2 + 1]!;
    }

    this.readbackBuffer.unmap();
    return { elevations, moistures };
  }

  destroy(): void {
    this.configBuffer.destroy();
    this.posBuffer.destroy();
    this.resultBuffer.destroy();
    this.readbackBuffer.destroy();
  }
}
