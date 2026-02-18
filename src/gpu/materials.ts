import { MESH_VERTEX_BYTE_STRIDE } from './types';
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
