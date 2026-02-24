import { MESH_VERTEX_BYTE_STRIDE, ISLAND_VERTEX_BYTE_STRIDE, TORNADO_VERTEX_BYTE_STRIDE } from './types';
import type { Material } from './scene';

const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus-stencil8';

const TERRAIN_VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: MESH_VERTEX_BYTE_STRIDE,
  stepMode: 'vertex' as const,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x2' as const },   // pos_xz
    { shaderLocation: 1, offset: 8, format: 'float32' as const },     // elevation
    { shaderLocation: 2, offset: 12, format: 'float32' as const },    // moisture
    { shaderLocation: 3, offset: 16, format: 'float32x3' as const },  // normal
  ],
};

/** Terrain pipeline: depth write, stencil write (always → replace). */
export function createTerrainMaterial(
  device: GPUDevice,
  shader: GPUShaderModule,
  format: GPUTextureFormat,
  g0: GPUBindGroupLayout,
  g1: GPUBindGroupLayout,
): Material {
  const layout = device.createPipelineLayout({ bindGroupLayouts: [g0, g1] });
  const pipeline = device.createRenderPipeline({
    layout,
    vertex: {
      module: shader,
      entryPoint: 'vs_main',
      buffers: [TERRAIN_VERTEX_LAYOUT],
    },
    fragment: {
      module: shader,
      entryPoint: 'fs_main',
      targets: [{ format }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: {
      depthWriteEnabled: true,
      depthCompare: 'less',
      format: DEPTH_FORMAT,
      stencilFront: { compare: 'always', passOp: 'replace', failOp: 'keep', depthFailOp: 'keep' },
      stencilBack: { compare: 'always', passOp: 'replace', failOp: 'keep', depthFailOp: 'keep' },
      stencilReadMask: 0xFF,
      stencilWriteMask: 0xFF,
    },
  });
  return { id: 'terrain', pipeline, usesObjectGroup: true };
}

/** Sea pipeline: stencil test == 0 (only draws where terrain didn't render). */
export function createSeaMaterial(
  device: GPUDevice,
  shader: GPUShaderModule,
  format: GPUTextureFormat,
  g0: GPUBindGroupLayout,
  g1: GPUBindGroupLayout,
): Material {
  const layout = device.createPipelineLayout({ bindGroupLayouts: [g0, g1] });
  const pipeline = device.createRenderPipeline({
    layout,
    vertex: {
      module: shader,
      entryPoint: 'vs_main',
      buffers: [TERRAIN_VERTEX_LAYOUT],
    },
    fragment: {
      module: shader,
      entryPoint: 'fs_main',
      targets: [{ format }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: {
      depthWriteEnabled: true,
      depthCompare: 'less',
      format: DEPTH_FORMAT,
      stencilFront: { compare: 'equal', passOp: 'keep', failOp: 'keep', depthFailOp: 'keep' },
      stencilBack: { compare: 'equal', passOp: 'keep', failOp: 'keep', depthFailOp: 'keep' },
      stencilReadMask: 0xFF,
      stencilWriteMask: 0x00,
    },
  });
  return { id: 'sea', pipeline, usesObjectGroup: true };
}

// --- Island mesh vertex layout (8 floats, 32 bytes) ---
// pos_xz(2) + world_y(1) + elevation(1) + moisture(1) + normal(3)

const ISLAND_VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: ISLAND_VERTEX_BYTE_STRIDE,
  stepMode: 'vertex' as const,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x2' as const },   // pos_xz
    { shaderLocation: 1, offset: 8, format: 'float32' as const },     // world_y
    { shaderLocation: 2, offset: 12, format: 'float32' as const },    // elevation
    { shaderLocation: 3, offset: 16, format: 'float32' as const },    // moisture
    { shaderLocation: 4, offset: 20, format: 'float32x3' as const },  // normal
  ],
};

/** Island pipeline: dedicated mesh with pre-baked Y, depth write, stencil replace, no backface cull. */
export function createIslandMaterial(
  device: GPUDevice,
  shader: GPUShaderModule,
  format: GPUTextureFormat,
  g0: GPUBindGroupLayout,
  g1: GPUBindGroupLayout,
): Material {
  const layout = device.createPipelineLayout({ bindGroupLayouts: [g0, g1] });
  const pipeline = device.createRenderPipeline({
    layout,
    vertex: {
      module: shader,
      entryPoint: 'vs_island',
      buffers: [ISLAND_VERTEX_LAYOUT],
    },
    fragment: {
      module: shader,
      entryPoint: 'fs_main',
      targets: [{ format }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: {
      depthWriteEnabled: true,
      depthCompare: 'less',
      format: DEPTH_FORMAT,
      stencilFront: { compare: 'always', passOp: 'replace', failOp: 'keep', depthFailOp: 'keep' },
      stencilBack: { compare: 'always', passOp: 'replace', failOp: 'keep', depthFailOp: 'keep' },
      stencilReadMask: 0xFF,
      stencilWriteMask: 0xFF,
    },
  });
  return { id: 'island', pipeline, usesObjectGroup: true };
}

// --- Tornado mesh vertex layout (8 floats, 32 bytes) ---
// center_xz(2) + world_y(1) + local_angle(1) + local_radius(1) + height_frac(1) + twist_speed(1) + opacity_base(1)

const TORNADO_VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: TORNADO_VERTEX_BYTE_STRIDE,
  stepMode: 'vertex' as const,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x2' as const },   // center_xz
    { shaderLocation: 1, offset: 8, format: 'float32' as const },     // world_y
    { shaderLocation: 2, offset: 12, format: 'float32' as const },    // local_angle
    { shaderLocation: 3, offset: 16, format: 'float32' as const },    // local_radius
    { shaderLocation: 4, offset: 20, format: 'float32' as const },    // height_frac
    { shaderLocation: 5, offset: 24, format: 'float32' as const },    // twist_speed
    { shaderLocation: 6, offset: 28, format: 'float32' as const },    // opacity_base
  ],
};

/** Tornado pipeline: alpha-blended funnel, depth read (no write), stencil write, no backface cull. */
export function createTornadoMaterial(
  device: GPUDevice,
  shader: GPUShaderModule,
  format: GPUTextureFormat,
  g0: GPUBindGroupLayout,
  g1: GPUBindGroupLayout,
): Material {
  const layout = device.createPipelineLayout({ bindGroupLayouts: [g0, g1] });
  const pipeline = device.createRenderPipeline({
    layout,
    vertex: {
      module: shader,
      entryPoint: 'vs_tornado',
      buffers: [TORNADO_VERTEX_LAYOUT],
    },
    fragment: {
      module: shader,
      entryPoint: 'fs_tornado',
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
        writeMask: GPUColorWrite.ALL,
      }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: {
      depthWriteEnabled: false,
      depthCompare: 'less',
      format: DEPTH_FORMAT,
      stencilFront: { compare: 'always', passOp: 'replace', failOp: 'keep', depthFailOp: 'keep' },
      stencilBack: { compare: 'always', passOp: 'replace', failOp: 'keep', depthFailOp: 'keep' },
      stencilReadMask: 0xFF,
      stencilWriteMask: 0xFF,
    },
  });
  return { id: 'tornado', pipeline, usesObjectGroup: true };
}

// createLavaMaterial removed — lava pools now rendered by terrain pipeline
// (vs_main clamps terrain to lava level, fs_main Fire branch renders lava material).

/** Plume pipeline: alpha-blended volcanic smoke, depth read (no write), stencil write, no backface cull. */
export function createPlumeMaterial(
  device: GPUDevice,
  shader: GPUShaderModule,
  format: GPUTextureFormat,
  g0: GPUBindGroupLayout,
  g1: GPUBindGroupLayout,
): Material {
  const layout = device.createPipelineLayout({ bindGroupLayouts: [g0, g1] });
  const pipeline = device.createRenderPipeline({
    layout,
    vertex: {
      module: shader,
      entryPoint: 'vs_plume',
      buffers: [TORNADO_VERTEX_LAYOUT],
    },
    fragment: {
      module: shader,
      entryPoint: 'fs_plume',
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
        writeMask: GPUColorWrite.ALL,
      }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: {
      depthWriteEnabled: false,
      depthCompare: 'less',
      format: DEPTH_FORMAT,
      stencilFront: { compare: 'always', passOp: 'replace', failOp: 'keep', depthFailOp: 'keep' },
      stencilBack: { compare: 'always', passOp: 'replace', failOp: 'keep', depthFailOp: 'keep' },
      stencilReadMask: 0xFF,
      stencilWriteMask: 0xFF,
    },
  });
  return { id: 'plume', pipeline, usesObjectGroup: true };
}

/** Sky pipeline: fullscreen triangle, no vertex buffers, no group 1. */
export function createSkyMaterial(
  device: GPUDevice,
  shader: GPUShaderModule,
  format: GPUTextureFormat,
  g0: GPUBindGroupLayout,
): Material {
  const layout = device.createPipelineLayout({ bindGroupLayouts: [g0] });
  const pipeline = device.createRenderPipeline({
    layout,
    vertex: {
      module: shader,
      entryPoint: 'vs_sky',
    },
    fragment: {
      module: shader,
      entryPoint: 'fs_sky',
      targets: [{ format }],
    },
    primitive: { topology: 'triangle-list' },
    depthStencil: {
      depthWriteEnabled: false,
      depthCompare: 'always',
      format: DEPTH_FORMAT,
      stencilFront: { compare: 'always', passOp: 'keep', failOp: 'keep', depthFailOp: 'keep' },
      stencilBack: { compare: 'always', passOp: 'keep', failOp: 'keep', depthFailOp: 'keep' },
      stencilWriteMask: 0x00,
    },
  });
  return { id: 'sky', pipeline, usesObjectGroup: false };
}
