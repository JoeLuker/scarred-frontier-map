import { invertMat4 } from './terrain-renderer';

// --- Constants ---

const UNIFORM_SIZE = 368;
const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus-stencil8';
const OBJECT_UNIFORM_SLOT = 256; // minUniformBufferOffsetAlignment
const OBJECT_CONFIG_SIZE = 80;   // mat4x4f + u32 + 3×u32 padding
const MAX_OBJECT_SLOTS = 16;
const IDENTITY_4X4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

// --- Interfaces ---

export interface SceneMesh {
  readonly vertexBuffer: GPUBuffer;
  readonly vertexCount: number;
  readonly indexBuffer?: GPUBuffer;
  readonly indexCount?: number;
}

export interface Material {
  readonly id: string;
  readonly pipeline: GPURenderPipeline;
  readonly usesObjectGroup: boolean; // false = sky (no group 1)
}

export interface SceneObject {
  readonly id: string;
  material: Material;
  mesh: SceneMesh | null; // null = no vertex buffer (sky)
  drawCount: number;      // used when mesh is null
  transform: Float32Array; // 4×4 column-major model matrix
  flags: number;
  stencilRef: number;
  renderOrder: number;
  visible: boolean;
}

// --- Scene ---

export class Scene {
  private device: GPUDevice;
  private context: GPUCanvasContext;

  readonly format: GPUTextureFormat;
  readonly group0Layout: GPUBindGroupLayout;
  readonly group1Layout: GPUBindGroupLayout;

  // Per-frame shared resources
  private frameUniformBuffer: GPUBuffer;
  private group0BindGroup: GPUBindGroup | null = null;

  // Per-object dynamic uniforms
  private objectUniformBuffer: GPUBuffer;
  private objectBindGroup: GPUBindGroup;
  private objectStagingBuffer: ArrayBuffer;
  private objectStagingF32: Float32Array;
  private objectStagingU32: Uint32Array;

  // Object registry
  private objects = new Map<string, SceneObject>();

  // Depth/stencil
  private depthTexture: GPUTexture | null = null;

  // Texture references (for group 0 rebuild)
  private hexStateTexture: GPUTexture | null = null;
  private islandTexture: GPUTexture | null = null;
  private dummyHexTexture: GPUTexture;
  private dummyIslandTexture: GPUTexture;

  private constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    group0Layout: GPUBindGroupLayout,
    group1Layout: GPUBindGroupLayout,
    frameUniformBuffer: GPUBuffer,
    objectUniformBuffer: GPUBuffer,
    objectBindGroup: GPUBindGroup,
    dummyHexTexture: GPUTexture,
    dummyIslandTexture: GPUTexture,
  ) {
    this.device = device;
    this.context = context;
    this.format = format;
    this.group0Layout = group0Layout;
    this.group1Layout = group1Layout;
    this.frameUniformBuffer = frameUniformBuffer;
    this.objectUniformBuffer = objectUniformBuffer;
    this.objectBindGroup = objectBindGroup;
    this.dummyHexTexture = dummyHexTexture;
    this.dummyIslandTexture = dummyIslandTexture;

    this.objectStagingBuffer = new ArrayBuffer(MAX_OBJECT_SLOTS * OBJECT_UNIFORM_SLOT);
    this.objectStagingF32 = new Float32Array(this.objectStagingBuffer);
    this.objectStagingU32 = new Uint32Array(this.objectStagingBuffer);
  }

  static create(device: GPUDevice, canvas: HTMLCanvasElement): Scene {
    const format = navigator.gpu.getPreferredCanvasFormat();
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('Failed to get WebGPU canvas context');
    context.configure({ device, format, alphaMode: 'opaque' });

    // Group 0: per-frame shared (uniforms + hex state texture + island texture)
    const group0Layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
      ],
    });

    // Group 1: per-object (dynamic offset)
    const group1Layout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: OBJECT_CONFIG_SIZE },
      }],
    });

    const frameUniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const objectUniformBuffer = device.createBuffer({
      size: MAX_OBJECT_SLOTS * OBJECT_UNIFORM_SLOT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const objectBindGroup = device.createBindGroup({
      layout: group1Layout,
      entries: [{
        binding: 0,
        resource: { buffer: objectUniformBuffer, size: OBJECT_CONFIG_SIZE },
      }],
    });

    // Dummy 1×1 textures for initial group 0 bind group
    const dummyHexTexture = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: dummyHexTexture },
      new Uint8Array([0, 0, 0, 0]),
      { bytesPerRow: 4 },
      [1, 1],
    );

    const dummyIslandTexture = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: dummyIslandTexture },
      new Uint8Array([0, 0, 0, 0]),
      { bytesPerRow: 4 },
      [1, 1],
    );

    return new Scene(
      device, context, format,
      group0Layout, group1Layout,
      frameUniformBuffer, objectUniformBuffer, objectBindGroup,
      dummyHexTexture, dummyIslandTexture,
    );
  }

  // === Object management ===

  addObject(id: string, opts: {
    material: Material;
    mesh?: SceneMesh | null;
    drawCount?: number;
    transform?: Float32Array;
    flags?: number;
    stencilRef?: number;
    renderOrder?: number;
    visible?: boolean;
  }): SceneObject {
    const obj: SceneObject = {
      id,
      material: opts.material,
      mesh: opts.mesh ?? null,
      drawCount: opts.drawCount ?? 0,
      transform: opts.transform ?? new Float32Array(IDENTITY_4X4),
      flags: opts.flags ?? 0,
      stencilRef: opts.stencilRef ?? 0,
      renderOrder: opts.renderOrder ?? 0,
      visible: opts.visible ?? true,
    };
    this.objects.set(id, obj);
    return obj;
  }

  removeObject(id: string): void {
    this.objects.delete(id);
  }

  getObject(id: string): SceneObject | undefined {
    return this.objects.get(id);
  }

  // === State updates ===

  setHexStateTexture(texture: GPUTexture): void {
    this.hexStateTexture = texture;
    this.rebuildGroup0();
  }

  setIslandTexture(texture: GPUTexture): void {
    this.islandTexture = texture;
    this.rebuildGroup0();
  }

  private rebuildGroup0(): void {
    const hexTex = this.hexStateTexture ?? this.dummyHexTexture;
    const islandTex = this.islandTexture ?? this.dummyIslandTexture;
    this.group0BindGroup = this.device.createBindGroup({
      layout: this.group0Layout,
      entries: [
        { binding: 0, resource: { buffer: this.frameUniformBuffer } },
        { binding: 1, resource: hexTex.createView() },
        { binding: 2, resource: islandTex.createView() },
      ],
    });
  }

  updateFrameUniforms(
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
    terrainColors: Float32Array,
    eyePos: readonly [number, number, number],
  ): void {
    const data = new Float32Array(UNIFORM_SIZE / 4);
    data.set(viewProj, 0);
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
    data[26] = 0;
    data[27] = 0;
    data.set(terrainColors.subarray(0, 44), 28);
    data[72] = eyePos[0];
    data[73] = eyePos[1];
    data[74] = eyePos[2];
    data[75] = 0;
    data.set(invertMat4(viewProj), 76);
    this.device.queue.writeBuffer(this.frameUniformBuffer, 0, data);
  }

  // === Rendering ===

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
    if (!this.group0BindGroup) {
      this.rebuildGroup0();
    }

    // Collect visible objects sorted by renderOrder
    const sorted: SceneObject[] = [];
    for (const obj of this.objects.values()) {
      if (obj.visible) sorted.push(obj);
    }
    sorted.sort((a, b) => a.renderOrder - b.renderOrder);

    if (sorted.length === 0) return;

    // Upload per-object uniforms (transform + flags → dynamic offset slots)
    const f32 = this.objectStagingF32;
    const u32 = this.objectStagingU32;
    let slotIdx = 0;
    const slotMap = new Map<string, number>();

    for (const obj of sorted) {
      if (obj.material.usesObjectGroup) {
        const floatOff = slotIdx * (OBJECT_UNIFORM_SLOT / 4);
        f32.set(obj.transform, floatOff);
        u32[floatOff + 16] = obj.flags;
        u32[floatOff + 17] = 0;
        u32[floatOff + 18] = 0;
        u32[floatOff + 19] = 0;
        slotMap.set(obj.id, slotIdx);
        slotIdx++;
      }
    }

    if (slotIdx > 0) {
      this.device.queue.writeBuffer(
        this.objectUniformBuffer, 0,
        this.objectStagingBuffer, 0,
        slotIdx * OBJECT_UNIFORM_SLOT,
      );
    }

    // Begin render pass
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
        stencilClearValue: 0,
        stencilLoadOp: 'clear',
        stencilStoreOp: 'discard',
      },
    });

    // Draw each object (sorted by renderOrder)
    let currentPipeline: GPURenderPipeline | null = null;

    for (const obj of sorted) {
      if (obj.material.pipeline !== currentPipeline) {
        pass.setPipeline(obj.material.pipeline);
        currentPipeline = obj.material.pipeline;
      }

      pass.setBindGroup(0, this.group0BindGroup!);

      if (obj.material.usesObjectGroup) {
        const slot = slotMap.get(obj.id)!;
        pass.setBindGroup(1, this.objectBindGroup, [slot * OBJECT_UNIFORM_SLOT]);
      }

      pass.setStencilReference(obj.stencilRef);

      if (obj.mesh) {
        pass.setVertexBuffer(0, obj.mesh.vertexBuffer);
        if (obj.mesh.indexBuffer != null && obj.mesh.indexCount != null && obj.mesh.indexCount > 0) {
          pass.setIndexBuffer(obj.mesh.indexBuffer, 'uint32');
          pass.drawIndexed(obj.mesh.indexCount);
        } else {
          pass.draw(obj.mesh.vertexCount);
        }
      } else {
        pass.draw(obj.drawCount);
      }
    }

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
    this.frameUniformBuffer.destroy();
    this.objectUniformBuffer.destroy();
    this.depthTexture?.destroy();
    this.dummyHexTexture.destroy();
    this.dummyIslandTexture.destroy();
  }
}
