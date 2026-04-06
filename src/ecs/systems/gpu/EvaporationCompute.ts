import type { SimField } from '../../components/SimField';
import { SIM } from '../../../core/constants';

const WORKGROUP_SIZE = 8;

const SHADER = /* wgsl */ `
struct Uniforms {
  grid_width: u32,
  grid_height: u32,
  dt: f32,
  evaporation_rate: f32,
  cooling_rate: f32,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var fluid_in: texture_2d<f32>;
@group(0) @binding(2) var fluid_out: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if u32(x) >= u.grid_width || u32(y) >= u.grid_height {
    return;
  }

  let pos = vec2i(x, y);
  let fluid = textureLoad(fluid_in, pos, 0);

  let water = max(fluid.r - u.evaporation_rate * u.dt, 0.0);
  let temp = max(fluid.a - u.cooling_rate * u.dt, 0.0);

  textureStore(fluid_out, pos, vec4f(water, fluid.g, fluid.b, temp));
}
`;

export class EvaporationCompute {
  private readonly pipeline: GPUComputePipeline;
  private readonly uniformBuffer: GPUBuffer;
  private readonly bindGroupLayout: GPUBindGroupLayout;

  private constructor(
    pipeline: GPUComputePipeline,
    uniformBuffer: GPUBuffer,
    bindGroupLayout: GPUBindGroupLayout,
  ) {
    this.pipeline = pipeline;
    this.uniformBuffer = uniformBuffer;
    this.bindGroupLayout = bindGroupLayout;
  }

  static create(device: GPUDevice, _simField: SimField): EvaporationCompute {
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba32float' } },
      ],
    });

    const shaderModule = device.createShaderModule({ code: SHADER });

    const pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      compute: { module: shaderModule, entryPoint: 'main' },
    });

    // 5 fields: width(u32), height(u32), dt(f32), evap(f32), cooling(f32) = 20 bytes, pad to 32
    const uniformBuffer = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    return new EvaporationCompute(pipeline, uniformBuffer, bindGroupLayout);
  }

  dispatch(encoder: GPUCommandEncoder, simField: SimField, dt: number): void {
    const { width, height } = simField.config;

    const data = new ArrayBuffer(32);
    const u32 = new Uint32Array(data, 0, 2);
    const f32 = new Float32Array(data, 8, 3);
    u32[0] = width;
    u32[1] = height;
    f32[0] = dt;
    f32[1] = SIM.EVAPORATION_RATE;
    f32[2] = SIM.COOLING_RATE;
    simField.device.queue.writeBuffer(this.uniformBuffer, 0, data);

    const bindGroup = simField.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: simField.currentFluidTexture.createView() },
        { binding: 2, resource: simField.nextFluidTexture.createView() },
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
  }
}
