import type { SimField } from '../../components/SimField';
import { SIM } from '../../../core/constants';

const WORKGROUP_SIZE = 8;

const SHADER = /* wgsl */ `
struct Uniforms {
  grid_width: u32,
  grid_height: u32,
  dt: f32,
  gravity: f32,
  viscosity: f32,
  evaporation_rate: f32,
  cooling_rate: f32,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var fluid_in: texture_2d<f32>;
@group(0) @binding(2) var fluid_out: texture_storage_2d<rgba32float, write>;
@group(0) @binding(3) var elevation_tex: texture_2d<f32>;

fn load_fluid(pos: vec2i) -> vec4f {
  return textureLoad(fluid_in, pos, 0);
}

fn load_elevation(pos: vec2i) -> f32 {
  return textureLoad(elevation_tex, pos, 0).r;
}

fn in_bounds(pos: vec2i) -> bool {
  return pos.x >= 0 && pos.y >= 0
    && u32(pos.x) < u.grid_width && u32(pos.y) < u.grid_height;
}

@compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if !in_bounds(vec2i(x, y)) {
    return;
  }

  let center = vec2i(x, y);
  let fluid = load_fluid(center);
  let water = fluid.r;
  let temp = fluid.a;
  let elev = load_elevation(center);
  let eff_height = elev + water;

  // Pipe model: compute outflow to 4 cardinal neighbors
  let offsets = array<vec2i, 4>(
    vec2i(1, 0), vec2i(-1, 0), vec2i(0, 1), vec2i(0, -1)
  );

  var total_outflow: f32 = 0.0;
  var outflows: array<f32, 4>;
  var inflow: f32 = 0.0;
  var flow_dir: vec2f = vec2f(0.0, 0.0);

  // Pass 1: compute raw outflows
  for (var i = 0u; i < 4u; i++) {
    let nb = center + offsets[i];
    if !in_bounds(nb) {
      outflows[i] = 0.0;
      continue;
    }
    let nb_fluid = load_fluid(nb);
    let nb_eff = load_elevation(nb) + nb_fluid.r;
    let diff = eff_height - nb_eff;
    if diff > 0.0 {
      outflows[i] = diff * u.gravity * u.dt;
    } else {
      outflows[i] = 0.0;
    }
    total_outflow += outflows[i];
  }

  // Cap outflow to available water (mass conservation)
  var scale: f32 = 1.0;
  if total_outflow > water && total_outflow > 0.0 {
    scale = water / total_outflow;
  }

  var net_out: f32 = 0.0;
  for (var i = 0u; i < 4u; i++) {
    outflows[i] *= scale;
    net_out += outflows[i];

    // Accumulate flow direction for velocity
    let dir = vec2f(f32(offsets[i].x), f32(offsets[i].y));
    flow_dir -= dir * outflows[i];
  }

  // Pass 2: compute inflow from neighbors flowing toward us
  for (var i = 0u; i < 4u; i++) {
    let nb = center + offsets[i];
    if !in_bounds(nb) {
      continue;
    }
    let nb_fluid = load_fluid(nb);
    let nb_water = nb_fluid.r;
    let nb_elev = load_elevation(nb);
    let nb_eff = nb_elev + nb_water;
    let diff = nb_eff - eff_height;
    if diff > 0.0 {
      var nb_outflow = diff * u.gravity * u.dt;
      // Estimate neighbor's total outflow for scaling (approximate)
      nb_outflow = min(nb_outflow, nb_water * 0.25);
      inflow += nb_outflow;
      let dir = vec2f(f32(offsets[i].x), f32(offsets[i].y));
      flow_dir += dir * nb_outflow;
    }
  }

  // New water height
  var new_water = water - net_out + inflow;
  new_water = max(new_water, 0.0);

  // Velocity from flow direction, with viscosity damping
  var vel = vec2f(fluid.g, fluid.b);
  if new_water > 0.001 {
    vel = mix(flow_dir / max(new_water, 0.01), vel, u.viscosity);
  } else {
    vel = vec2f(0.0, 0.0);
  }

  // Evaporation + cooling
  new_water = max(new_water - u.evaporation_rate * u.dt, 0.0);
  let new_temp = max(temp - u.cooling_rate * u.dt, 0.0);

  textureStore(fluid_out, center, vec4f(new_water, vel.x, vel.y, new_temp));
}
`;

export class ShallowWaterCompute {
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

  static create(device: GPUDevice, _simField: SimField): ShallowWaterCompute {
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba32float' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      ],
    });

    const shaderModule = device.createShaderModule({ code: SHADER });

    const pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      compute: { module: shaderModule, entryPoint: 'main' },
    });

    // Uniforms: grid_width(u32), grid_height(u32), dt(f32), gravity(f32), viscosity(f32), evap(f32), cooling(f32)
    // = 7 * 4 = 28 bytes, pad to 32
    const uniformBuffer = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    return new ShallowWaterCompute(pipeline, uniformBuffer, bindGroupLayout);
  }

  dispatch(encoder: GPUCommandEncoder, simField: SimField, dt: number): void {
    const { width, height } = simField.config;

    // Write uniforms
    const data = new ArrayBuffer(32);
    const u32 = new Uint32Array(data, 0, 2);
    const f32 = new Float32Array(data, 8, 5);
    u32[0] = width;
    u32[1] = height;
    f32[0] = dt;
    f32[1] = SIM.GRAVITY;
    f32[2] = SIM.WATER_VISCOSITY;
    f32[3] = SIM.EVAPORATION_RATE;
    f32[4] = SIM.COOLING_RATE;
    simField.device.queue.writeBuffer(this.uniformBuffer, 0, data);

    const bindGroup = simField.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: simField.currentFluidTexture.createView() },
        { binding: 2, resource: simField.nextFluidTexture.createView() },
        { binding: 3, resource: simField.elevation.createView() },
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
