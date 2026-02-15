import { WORLD, RENDER } from '../core/config';
import { INSTANCE_BYTE_STRIDE, INSTANCE_STRIDE } from './types';

// --- WGSL Shader (constants baked from config.ts at init time) ---

function createHexShader(): string {
  return /* wgsl */ `
// Baked render constants
const SIDE_DARKEN: f32 = ${RENDER.SIDE_DARKEN};
const CLIFF_BASE: f32 = ${RENDER.CLIFF_BASE_DARKEN};
const BEVEL_INNER: f32 = ${RENDER.BEVEL_INNER};
const BEVEL_OUTER: f32 = ${RENDER.BEVEL_OUTER};
const BEVEL_STRENGTH: f32 = ${RENDER.BEVEL_STRENGTH};
const FOG_WHITE_MIX: f32 = ${RENDER.FOG_WHITE_MIX};

struct Camera {
  view_proj: mat4x4f,   // 0-63
  height_scale: f32,    // 64
  hex_size: f32,        // 68
  // 72-79 padding
}

@group(0) @binding(0) var<uniform> camera: Camera;

struct VertexOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec3f,
  @location(1) local: vec2f,      // local hex position (for edge/bevel)
  @location(2) face_type: f32,    // 0 = top face, 1 = side face
  @location(3) explored: f32,     // 1 = explored, 0 = fog
  @location(4) vert_t: f32,       // 0 = cliff base, 1 = cliff top / top face
}

const PI: f32 = 3.14159265359;

fn hex_corner(i: u32) -> vec2f {
  let angle = PI / 180.0 * f32(60u * i + 30u);
  return vec2f(cos(angle), sin(angle));
}

// Karst terrain profile: flat valleys, steep cliff walls, tower peaks
fn karst_height(h: f32) -> f32 {
  let cliff = smoothstep(0.12, 0.28, h);
  let peak = pow(h, 0.65);
  return cliff * peak;
}

// 54 vertices per hex:
//   0-17:  top face (6 triangles × 3, triangle fan)
//   18-53: 6 side faces (6 edges × 2 triangles × 3 vertices)

@vertex
fn vs_main(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
  @location(0) inst_pos: vec2f,
  @location(1) inst_color: vec3f,
  @location(2) inst_scale: f32,
  @location(3) inst_height: f32,
  @location(4) inst_explored: f32,
) -> VertexOut {
  let height_val = karst_height(inst_height) * camera.height_scale;

  var local: vec2f;
  var face: f32 = 0.0;
  var elevated: bool = true;
  var vt: f32 = 1.0;

  if (vi < 18u) {
    // --- TOP FACE: triangle fan ---
    let tri = vi / 3u;
    let vert = vi % 3u;
    if (vert == 0u) {
      local = vec2f(0.0, 0.0);
    } else if (vert == 1u) {
      local = hex_corner(tri);
    } else {
      local = hex_corner((tri + 1u) % 6u);
    }
    face = 0.0;
    elevated = true;
    vt = 1.0;
  } else {
    // --- SIDE FACES: 6 edges × 2 triangles × 3 vertices ---
    let side_vi = vi - 18u;
    let edge_idx = side_vi / 6u;
    let tv = side_vi % 6u;

    let ca = hex_corner(edge_idx);
    let cb = hex_corner((edge_idx + 1u) % 6u);

    // Quad: top_a, base_a, base_b | top_a, base_b, top_b
    if (tv == 0u) {
      local = ca; elevated = true; vt = 1.0;
    } else if (tv == 1u) {
      local = ca; elevated = false; vt = 0.0;
    } else if (tv == 2u) {
      local = cb; elevated = false; vt = 0.0;
    } else if (tv == 3u) {
      local = ca; elevated = true; vt = 1.0;
    } else if (tv == 4u) {
      local = cb; elevated = false; vt = 0.0;
    } else {
      local = cb; elevated = true; vt = 1.0;
    }
    face = 1.0;
  }

  // Hex 2D → 3D world (hex grid on XZ plane, height along Y)
  let flat = local * camera.hex_size * inst_scale + inst_pos;
  var world = vec3f(flat.x, 0.0, flat.y);

  if (elevated) {
    world.y = height_val;
  }

  // Project to clip space via view-projection matrix
  let clip = camera.view_proj * vec4f(world, 1.0);

  var out: VertexOut;
  out.pos = clip;
  out.color = inst_color;
  out.local = local;
  out.face_type = face;
  out.explored = inst_explored;
  out.vert_t = vt;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  var color = in.color;
  let dist = length(in.local);

  if (in.face_type > 0.5) {
    // --- CLIFF FACE: vertical gradient ---
    let cliff_shade = mix(CLIFF_BASE, SIDE_DARKEN, in.vert_t);
    color *= cliff_shade;
  } else {
    // --- TOP FACE ---

    // Bevel highlight ring (explored hexes only)
    if (in.explored > 0.5) {
      let bevel = smoothstep(BEVEL_INNER, BEVEL_OUTER, dist)
                * (1.0 - smoothstep(BEVEL_OUTER, 1.0, dist));
      color += vec3f(bevel * BEVEL_STRENGTH);
    }

    // Edge darkening
    let edge = smoothstep(0.88, 1.0, dist);
    color *= (1.0 - edge * 0.4);

    // Fog overlay for unexplored hexes
    if (in.explored < 0.5) {
      color = mix(color, vec3f(1.0), FOG_WHITE_MIX);
    }
  }

  return vec4f(clamp(color, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;
}

// --- Hex Renderer ---

const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';
const VERTICES_PER_HEX = 54; // 18 top + 36 side (6 edges × 6)

export class HexRenderer {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private pipeline: GPURenderPipeline;
  private cameraBuffer: GPUBuffer;
  private cameraBindGroup: GPUBindGroup;
  private instanceBuffer: GPUBuffer;
  private instanceCapacity: number;
  private instanceCount = 0;
  private format: GPUTextureFormat;

  private depthTexture: GPUTexture | null = null;

  private constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    pipeline: GPURenderPipeline,
    cameraBuffer: GPUBuffer,
    cameraBindGroup: GPUBindGroup,
    instanceBuffer: GPUBuffer,
    instanceCapacity: number,
    format: GPUTextureFormat,
  ) {
    this.device = device;
    this.context = context;
    this.pipeline = pipeline;
    this.cameraBuffer = cameraBuffer;
    this.cameraBindGroup = cameraBindGroup;
    this.instanceBuffer = instanceBuffer;
    this.instanceCapacity = instanceCapacity;
    this.format = format;
  }

  static create(device: GPUDevice, canvas: HTMLCanvasElement, maxHexes: number): HexRenderer {
    const format = navigator.gpu.getPreferredCanvasFormat();

    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('Failed to get WebGPU canvas context');

    context.configure({ device, format, alphaMode: 'opaque' });

    const shaderModule = device.createShaderModule({ code: createHexShader() });

    // Camera uniform: mat4x4f(64) + f32(4) + f32(4) + padding(8) = 80 bytes
    const cameraBuffer = device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      }],
    });

    const cameraBindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: cameraBuffer } }],
    });

    const pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: INSTANCE_BYTE_STRIDE,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },   // pos
            { shaderLocation: 1, offset: 8, format: 'float32x3' },   // color
            { shaderLocation: 2, offset: 20, format: 'float32' },    // scale
            { shaderLocation: 3, offset: 24, format: 'float32' },    // height
            { shaderLocation: 4, offset: 28, format: 'float32' },    // explored
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
      },
      depthStencil: {
        depthWriteEnabled: true,
        depthCompare: 'less',
        format: DEPTH_FORMAT,
      },
    });

    const instanceBuffer = device.createBuffer({
      size: maxHexes * INSTANCE_BYTE_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    return new HexRenderer(
      device, context, pipeline, cameraBuffer, cameraBindGroup,
      instanceBuffer, maxHexes, format,
    );
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

  /** Upload view-projection matrix + constants. Call once per frame before render(). */
  updateCamera(viewProj: Float32Array): void {
    const data = new Float32Array(20); // 80 bytes
    data.set(viewProj);                // 0-63: mat4x4
    data[16] = WORLD.HEX_SIZE * RENDER.HEIGHT_SCALE; // 64: height_scale
    data[17] = WORLD.HEX_SIZE;                        // 68: hex_size
    // [18], [19] = padding
    this.device.queue.writeBuffer(this.cameraBuffer, 0, data);
  }

  updateInstances(data: Float32Array): void {
    const count = data.length / INSTANCE_STRIDE;
    if (count > this.instanceCapacity) {
      this.instanceBuffer.destroy();
      this.instanceCapacity = Math.ceil(count * 1.5);
      this.instanceBuffer = this.device.createBuffer({
        size: this.instanceCapacity * INSTANCE_BYTE_STRIDE,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    this.instanceCount = count;
    if (count > 0) {
      this.device.queue.writeBuffer(this.instanceBuffer, 0, data);
    }
  }

  render(): void {
    if (this.instanceCount === 0) return;

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
    pass.setBindGroup(0, this.cameraBindGroup);
    pass.setVertexBuffer(0, this.instanceBuffer);
    pass.draw(VERTICES_PER_HEX, this.instanceCount, 0, 0);
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
    this.cameraBuffer.destroy();
    this.instanceBuffer.destroy();
    this.depthTexture?.destroy();
  }
}
