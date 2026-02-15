import { WORLD, RENDER } from '../core/config';
import { INSTANCE_BYTE_STRIDE, INSTANCE_STRIDE } from './types';

// --- WGSL Shader (constants baked from config.ts at init time) ---

function createHexShader(): string {
  return /* wgsl */ `
// Baked render constants
const ISO_TILT: f32 = ${RENDER.ISO_TILT};
const SIDE_DARKEN: f32 = ${RENDER.SIDE_DARKEN};
const BEVEL_INNER: f32 = ${RENDER.BEVEL_INNER};
const BEVEL_OUTER: f32 = ${RENDER.BEVEL_OUTER};
const BEVEL_STRENGTH: f32 = ${RENDER.BEVEL_STRENGTH};
const FOG_WHITE_MIX: f32 = ${RENDER.FOG_WHITE_MIX};

struct Camera {
  offset: vec2f,       // camera world-space offset (camX, camY)
  zoom: f32,
  height_scale: f32,   // max height offset in world units
  viewport: vec2f,     // canvas logical width, height
  hex_size: f32,
  height_depth: f32,   // depth buffer offset per unit height
}

@group(0) @binding(0) var<uniform> camera: Camera;

struct VertexOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec3f,
  @location(1) local: vec2f,      // local hex position (for edge/bevel)
  @location(2) face_type: f32,    // 0 = top face, 1 = side face
  @location(3) explored: f32,     // 1 = explored, 0 = fog
}

const PI: f32 = 3.14159265359;

fn hex_corner(i: u32) -> vec2f {
  let angle = PI / 180.0 * f32(60u * i + 30u);
  return vec2f(cos(angle), sin(angle));
}

// 36 vertices per hex:
//   0-17:  top face (6 triangles × 3, triangle fan)
//   18-23: side face 0 (edge 5→0, right side)
//   24-29: side face 1 (edge 0→1, bottom-right)
//   30-35: side face 2 (edge 1→2, bottom-left)

@vertex
fn vs_main(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
  // Per-instance data (8 floats)
  @location(0) inst_pos: vec2f,
  @location(1) inst_color: vec3f,
  @location(2) inst_scale: f32,
  @location(3) inst_height: f32,
  @location(4) inst_explored: f32,
) -> VertexOut {
  // Power curve: exaggerate peaks, flatten lowlands
  let height_px = pow(inst_height, 1.5) * camera.height_scale;

  var local: vec2f;
  var face: f32 = 0.0;
  var elevated: bool = true;

  if (vi < 18u) {
    // --- TOP FACE: triangle fan ---
    let tri = vi / 3u;
    let vert = vi % 3u;
    if (vert == 0u) {
      local = vec2f(0.0, 0.0); // center
    } else if (vert == 1u) {
      local = hex_corner(tri);
    } else {
      local = hex_corner((tri + 1u) % 6u);
    }
    face = 0.0;
    elevated = true;
  } else {
    // --- SIDE FACES: 3 edges × 2 triangles × 3 vertices ---
    let side_vi = vi - 18u;
    let edge_idx = side_vi / 6u;
    let tv = side_vi % 6u;

    // Edge corner pairs (bottom-visible edges of pointy-top hex)
    var ca: vec2f;
    var cb: vec2f;
    if (edge_idx == 0u) {
      ca = hex_corner(5u); cb = hex_corner(0u); // right
    } else if (edge_idx == 1u) {
      ca = hex_corner(0u); cb = hex_corner(1u); // bottom-right
    } else {
      ca = hex_corner(1u); cb = hex_corner(2u); // bottom-left
    }

    // Quad: top_a(0) base_a(1) base_b(2) | top_a(3) base_b(4) top_b(5)
    if (tv == 0u) {
      local = ca; elevated = true;
    } else if (tv == 1u) {
      local = ca; elevated = false;
    } else if (tv == 2u) {
      local = cb; elevated = false;
    } else if (tv == 3u) {
      local = ca; elevated = true;
    } else if (tv == 4u) {
      local = cb; elevated = false;
    } else {
      local = cb; elevated = true;
    }
    face = 1.0;
  }

  // World position: scale hex, offset by instance position
  var world = local * camera.hex_size * inst_scale + inst_pos;

  // Save ground-plane Y for depth sorting (before foreshortening)
  let ground_y = world.y;

  // Isometric: foreshorten ground-plane Y
  world.y *= ISO_TILT;

  // 2.5D height: shift elevated vertices upward (not foreshortened — goes straight up)
  if (elevated) {
    world.y -= height_px;
  }

  // Camera transform → clip space (camera offset Y also foreshortened)
  let view = vec2f(
    (world.x + camera.offset.x) * camera.zoom,
    (world.y + camera.offset.y * ISO_TILT) * camera.zoom,
  );
  let clip = vec2f(
    view.x / (camera.viewport.x * 0.5),
    -view.y / (camera.viewport.y * 0.5),
  );

  // Depth: based on ground-plane Y (before foreshortening) for correct sorting
  let ground_view_y = (ground_y + camera.offset.y) * camera.zoom;
  let ground_clip_y = -ground_view_y / (camera.viewport.y * 0.5);
  var depth = 0.5 + ground_clip_y * 0.45;
  if (elevated) {
    depth -= inst_height * camera.height_depth;
  }
  depth = clamp(depth, 0.001, 0.999);

  var out: VertexOut;
  out.pos = vec4f(clip, depth, 1.0);
  out.color = inst_color;
  out.local = local;
  out.face_type = face;
  out.explored = inst_explored;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  var color = in.color;
  let dist = length(in.local); // 0 at center, ~1 at edge

  if (in.face_type > 0.5) {
    // --- SIDE FACE: flat darkening for cliff illusion ---
    color *= SIDE_DARKEN;
  } else {
    // --- TOP FACE ---

    // Bevel highlight ring (explored hexes only)
    if (in.explored > 0.5) {
      let bevel = smoothstep(BEVEL_INNER, BEVEL_OUTER, dist)
                * (1.0 - smoothstep(BEVEL_OUTER, 1.0, dist));
      color += vec3f(bevel * BEVEL_STRENGTH);
    }

    // Edge darkening (creates visual gap between hexes)
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
const VERTICES_PER_HEX = 36; // 18 top + 18 side (3 edges × 6)

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

  // Depth buffer (lazily created / resized)
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

    // Camera uniform: offset(2f) + zoom(1f) + height_scale(1f) + viewport(2f) + hex_size(1f) + height_depth(1f) = 32 bytes
    const cameraBuffer = device.createBuffer({
      size: 32,
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

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    });

    const pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
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

    // Instance buffer sized for maxHexes
    const instanceBuffer = device.createBuffer({
      size: maxHexes * INSTANCE_BYTE_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    return new HexRenderer(
      device, context, pipeline, cameraBuffer, cameraBindGroup,
      instanceBuffer, maxHexes, format,
    );
  }

  /** Ensure depth texture matches the current color texture size. */
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

  /** Upload camera state to GPU. Call once per frame before render(). */
  updateCamera(camX: number, camY: number, zoom: number, viewW: number, viewH: number): void {
    const data = new Float32Array([
      camX, camY,                             // offset
      zoom,                                   // zoom
      WORLD.HEX_SIZE * RENDER.HEIGHT_SCALE,   // height_scale (world units)
      viewW, viewH,                           // viewport
      WORLD.HEX_SIZE,                         // hex_size
      RENDER.HEIGHT_DEPTH_FACTOR,             // height_depth
    ]);
    this.device.queue.writeBuffer(this.cameraBuffer, 0, data);
  }

  /**
   * Upload instance data. `data` is a Float32Array of
   * [x, y, r, g, b, scale, height, explored] per hex.
   * Length must be a multiple of INSTANCE_STRIDE (8).
   */
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

  /** Render one frame. */
  render(): void {
    if (this.instanceCount === 0) return;

    const colorTexture = this.context.getCurrentTexture();
    const depthTexture = this.ensureDepthTexture(colorTexture.width, colorTexture.height);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: colorTexture.createView(),
        clearValue: { r: 0.008, g: 0.024, b: 0.039, a: 1.0 }, // #020a0f slate-950
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

  /** Resize the canvas context after DPR/viewport changes. */
  reconfigure(): void {
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'opaque',
    });
    // Depth texture will be recreated lazily in render()
  }

  destroy(): void {
    this.cameraBuffer.destroy();
    this.instanceBuffer.destroy();
    this.depthTexture?.destroy();
  }
}
