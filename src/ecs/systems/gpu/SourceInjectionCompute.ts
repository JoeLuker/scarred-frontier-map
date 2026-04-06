import type { SimField } from '../../components/SimField';
import type { OverlayStore } from '../../components/OverlayStore';
import { PlanarAlignment } from '../../../core/types';
import { WORLD } from '../../../core/constants';

const WORKGROUP_SIZE = 8;
const MAX_SOURCES = 32;

// Per-source data uploaded to GPU: 8 floats each
// [center_x, center_y, radius_sq, water_rate, temp_rate, substance_mask, _pad, _pad]
const FLOATS_PER_SOURCE = 8;

const SHADER = /* wgsl */ `
struct Uniforms {
  grid_width: u32,
  grid_height: u32,
  cell_size: f32,
  world_extent: f32,
  source_count: u32,
  dt: f32,
}

struct Source {
  center_x: f32,
  center_y: f32,
  radius_sq: f32,
  water_rate: f32,
  temp_rate: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> sources: array<Source>;
@group(0) @binding(2) var fluid_in: texture_2d<f32>;
@group(0) @binding(3) var fluid_out: texture_storage_2d<rgba32float, write>;

fn cell_to_world(col: i32, row: i32) -> vec2f {
  return vec2f(
    f32(col) * u.cell_size - u.world_extent + u.cell_size * 0.5,
    f32(row) * u.cell_size - u.world_extent + u.cell_size * 0.5,
  );
}

@compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if u32(x) >= u.grid_width || u32(y) >= u.grid_height {
    return;
  }

  let world_pos = cell_to_world(x, y);
  let fluid = textureLoad(fluid_in, vec2i(x, y), 0);
  var water = fluid.r;
  var vel = vec2f(fluid.g, fluid.b);
  var temp = fluid.a;

  for (var i = 0u; i < u.source_count; i++) {
    let s = sources[i];
    let dx = world_pos.x - s.center_x;
    let dy = world_pos.y - s.center_y;
    let dist_sq = dx * dx + dy * dy;
    if dist_sq > s.radius_sq {
      continue;
    }
    // Smooth falloff: 1 at center, 0 at edge
    let t = 1.0 - dist_sq / s.radius_sq;
    water += s.water_rate * t * u.dt;
    temp += s.temp_rate * t * u.dt;
  }

  water = max(water, 0.0);
  temp = max(temp, 0.0);

  textureStore(fluid_out, vec2i(x, y), vec4f(water, vel.x, vel.y, temp));
}
`;

export class SourceInjectionCompute {
  private readonly pipeline: GPUComputePipeline;
  private readonly uniformBuffer: GPUBuffer;
  private readonly sourceBuffer: GPUBuffer;
  private readonly bindGroupLayout: GPUBindGroupLayout;

  private constructor(
    pipeline: GPUComputePipeline,
    uniformBuffer: GPUBuffer,
    sourceBuffer: GPUBuffer,
    bindGroupLayout: GPUBindGroupLayout,
  ) {
    this.pipeline = pipeline;
    this.uniformBuffer = uniformBuffer;
    this.sourceBuffer = sourceBuffer;
    this.bindGroupLayout = bindGroupLayout;
  }

  static create(device: GPUDevice, _simField: SimField): SourceInjectionCompute {
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba32float' } },
      ],
    });

    const shaderModule = device.createShaderModule({ code: SHADER });

    const pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      compute: { module: shaderModule, entryPoint: 'main' },
    });

    // 6 uniforms: width(u32), height(u32), cellSize(f32), worldExtent(f32), sourceCount(u32), dt(f32) = 24 bytes
    const uniformBuffer = device.createBuffer({
      size: 32, // padded to 16-byte alignment
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const sourceBuffer = device.createBuffer({
      size: MAX_SOURCES * FLOATS_PER_SOURCE * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    return new SourceInjectionCompute(pipeline, uniformBuffer, sourceBuffer, bindGroupLayout);
  }

  dispatch(
    encoder: GPUCommandEncoder,
    simField: SimField,
    overlays: OverlayStore,
    hexSize: number,
  ): void {
    const { width, height, cellSize, worldExtent } = simField.config;
    const dt = 1 / 30; // fixed sim step

    // Build source array from active overlays
    const sourceData = new Float32Array(MAX_SOURCES * FLOATS_PER_SOURCE);
    let sourceCount = 0;

    for (const slot of overlays.activeSlots()) {
      if (sourceCount >= MAX_SOURCES) break;

      const alignment = overlays.type[slot]!;
      const q = overlays.coordQ[slot]!;
      const r = overlays.coordR[slot]!;
      const radius = overlays.radius[slot]! * hexSize;
      const intensity = overlays.intensity[slot]!;

      // Hex axial to world position (flat-top hex)
      const cx = hexSize * Math.sqrt(3) * (q + r / 2);
      const cy = hexSize * 1.5 * r;

      const off = sourceCount * FLOATS_PER_SOURCE;
      sourceData[off] = cx;
      sourceData[off + 1] = cy;
      sourceData[off + 2] = radius * radius;

      // Water overlay injects water, fire overlay injects temperature
      if (alignment === PlanarAlignment.WATER) {
        sourceData[off + 3] = intensity * 0.5; // water rate
        sourceData[off + 4] = 0;               // temp rate
      } else if (alignment === PlanarAlignment.FIRE) {
        sourceData[off + 3] = 0;               // water rate
        sourceData[off + 4] = intensity * 2.0; // temp rate
      } else {
        continue; // Only water and fire inject fluid
      }

      sourceCount++;
    }

    if (sourceCount === 0) return;

    // Upload uniforms
    const uniformData = new ArrayBuffer(32);
    const uU32 = new Uint32Array(uniformData);
    const uF32 = new Float32Array(uniformData);
    uU32[0] = width;
    uU32[1] = height;
    uF32[2] = cellSize;
    uF32[3] = worldExtent;
    uU32[4] = sourceCount;
    uF32[5] = dt;
    simField.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

    // Upload source data
    simField.device.queue.writeBuffer(this.sourceBuffer, 0, sourceData.buffer, 0, sourceCount * FLOATS_PER_SOURCE * 4);

    const bindGroup = simField.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.sourceBuffer } },
        { binding: 2, resource: simField.currentFluidTexture.createView() },
        { binding: 3, resource: simField.nextFluidTexture.createView() },
      ],
    });

    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(width / WORKGROUP_SIZE),
      Math.ceil(height / WORKGROUP_SIZE),
    );
    pass.end();
  }

  destroy(): void {
    this.uniformBuffer.destroy();
    this.sourceBuffer.destroy();
  }
}
