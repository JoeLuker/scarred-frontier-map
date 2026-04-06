import { PlanarAlignment, WorldGenConfig } from '../core/types';
import { DEFAULT_WORLD_CONFIG, WORLD, MESH } from '../core/constants';
import { SimField } from './components/SimField';
import { HexStore } from './components/HexStore';
import { OverlayStore } from './components/OverlayStore';
import type { DirtyFlags, OverlayId, OverlayParams, WorldSnapshot } from './types';

// GPU pipeline
import {
  Scene,
  createTerrainShader,
  createTerrainMaterial,
  createSeaMaterial,
  createSkyMaterial,
  TerrainMesh,
  buildTerrainMesh,
  MeshCompute,
  OBJECT_FLAGS,
} from '../gpu';

// Systems
import { ShallowWaterCompute } from './systems/gpu/ShallowWaterCompute';
import { SourceInjectionCompute } from './systems/gpu/SourceInjectionCompute';
import { UniformSystem, type CameraState } from './systems/render/UniformSystem';
import { RenderSystem } from './systems/render/RenderSystem';
import { getViewProjection, getEyePosition } from '../core/camera';
import { CAMERA } from '../core/constants';
import { Telemetry, type TelemetrySnapshot } from './telemetry/Telemetry';
import { ClipmapSystem } from './systems/render/ClipmapSystem';
import type { TerrainGridData } from '../gpu';

const SIM_TICK_INTERVAL = 1 / 30;
const HISTORY_LIMIT = WORLD.HISTORY_LIMIT;

export class World {
  // Component stores
  readonly simField: SimField;
  readonly hexes: HexStore;
  readonly overlays: OverlayStore;

  // Global state
  config: WorldGenConfig;
  readonly device: GPUDevice;

  // GPU pipeline
  private scene: Scene;
  private canvas: HTMLCanvasElement;
  private terrainMesh: TerrainMesh;
  private meshCompute: MeshCompute;

  // Systems
  private shallowWater: ShallowWaterCompute;
  private sourceInjection: SourceInjectionCompute;
  private uniformSystem: UniformSystem;
  private renderSystem: RenderSystem;

  // Clipmap LOD
  private clipmapSystem: ClipmapSystem | null = null;
  private terrainGrid: TerrainGridData | null = null;

  // Telemetry
  readonly telemetry: Telemetry;

  // Camera
  readonly camera: { azimuth: number; elevation: number; distance: number; targetX: number; targetZ: number } = {
    azimuth: CAMERA.DEFAULT_AZIMUTH,
    elevation: CAMERA.DEFAULT_ELEVATION,
    distance: CAMERA.DEFAULT_DISTANCE,
    targetX: 0,
    targetZ: 0,
  };

  // Dirty flags
  readonly dirty: DirtyFlags = {
    chemistry: false,
    hexState: false,
    fluid: false,
    mesh: false,
    elevation: false,
  };

  // Timing
  private simAccumulator = 0;
  private time = 0;

  // History
  private history: WorldSnapshot[] = [];
  private historyIndex = -1;

  // React subscription
  version = 0;
  private listeners: Set<() => void> = new Set();

  private constructor(
    device: GPUDevice,
    simField: SimField,
    hexes: HexStore,
    overlays: OverlayStore,
    config: WorldGenConfig,
    scene: Scene,
    terrainMesh: TerrainMesh,
    meshCompute: MeshCompute,
    shallowWater: ShallowWaterCompute,
    sourceInjection: SourceInjectionCompute,
    uniformSystem: UniformSystem,
    renderSystem: RenderSystem,
    telemetry: Telemetry,
    canvas: HTMLCanvasElement,
  ) {
    this.device = device;
    this.simField = simField;
    this.hexes = hexes;
    this.overlays = overlays;
    this.config = config;
    this.scene = scene;
    this.canvas = canvas;
    this.terrainMesh = terrainMesh;
    this.meshCompute = meshCompute;
    this.shallowWater = shallowWater;
    this.sourceInjection = sourceInjection;
    this.uniformSystem = uniformSystem;
    this.renderSystem = renderSystem;
    this.telemetry = telemetry;
  }

  static async create(
    device: GPUDevice,
    canvas: HTMLCanvasElement,
    config: WorldGenConfig = DEFAULT_WORLD_CONFIG,
  ): Promise<World> {
    // Component stores
    const simField = SimField.create(device);
    const hexes = HexStore.create(WORLD.GRID_RADIUS);
    const overlays = new OverlayStore();

    // Scene + materials
    const scene = Scene.create(device, canvas);
    const shaderCode = createTerrainShader();
    const shader = device.createShaderModule({ code: shaderCode });

    // Check shader compilation
    const info = await shader.getCompilationInfo();
    for (const msg of info.messages) {
      const level = msg.type === 'error' ? 'error' : msg.type === 'warning' ? 'warn' : 'log';
      console[level](`[WGSL ${msg.type}] line ${msg.lineNum}: ${msg.message}`);
    }

    const terrainMat = createTerrainMaterial(device, shader, scene.format, scene.group0Layout, scene.group1Layout);
    const seaMat = createSeaMaterial(device, shader, scene.format, scene.group0Layout, scene.group1Layout);
    const skyMat = createSkyMaterial(device, shader, scene.format, scene.group0Layout);

    // Terrain mesh
    const terrainMesh = TerrainMesh.create(device, 250000);
    const meshCompute = MeshCompute.create(device, 250000);

    // Sea quad
    const SEA_EXTENT = 100000;
    const seaVerts = new Float32Array([
      -SEA_EXTENT, -SEA_EXTENT, 0, 0, 0, 1, 0,
       SEA_EXTENT, -SEA_EXTENT, 0, 0, 0, 1, 0,
      -SEA_EXTENT,  SEA_EXTENT, 0, 0, 0, 1, 0,
      -SEA_EXTENT,  SEA_EXTENT, 0, 0, 0, 1, 0,
       SEA_EXTENT, -SEA_EXTENT, 0, 0, 0, 1, 0,
       SEA_EXTENT,  SEA_EXTENT, 0, 0, 0, 1, 0,
    ]);
    const seaBuffer = device.createBuffer({
      size: seaVerts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(seaBuffer, 0, seaVerts);

    // Register scene objects
    scene.addObject('sky', { material: skyMat, drawCount: 3, renderOrder: 0 });
    scene.addObject('terrain', {
      material: terrainMat,
      mesh: terrainMesh,
      flags: OBJECT_FLAGS.IS_TERRAIN,
      stencilRef: 1,
      renderOrder: 1,
    });
    scene.addObject('sea', {
      material: seaMat,
      mesh: { vertexBuffer: seaBuffer, vertexCount: 6 },
      flags: OBJECT_FLAGS.IS_SEA,
      stencilRef: 0,
      renderOrder: 4,
    });

    // GPU compute systems
    const shallowWater = ShallowWaterCompute.create(device, simField);
    const sourceInjection = SourceInjectionCompute.create(device, simField);

    // Render systems
    const uniformSystem = UniformSystem.create(scene);
    const renderSystem = RenderSystem.create(device, scene, simField);

    // Telemetry
    const telemetry = Telemetry.create(device);

    const world = new World(
      device, simField, hexes, overlays, config,
      scene, terrainMesh, meshCompute,
      shallowWater, sourceInjection,
      uniformSystem, renderSystem, telemetry, canvas,
    );

    // Generate initial terrain mesh + clipmap LOD
    await world.buildMesh(config);
    world.initClipmapSystem(terrainMat);

    // Push initial snapshot
    world.pushSnapshot();

    console.log(`World initialized: ${hexes.hexCount} hexes, sim ${simField.config.width}×${simField.config.height}, mesh ${terrainMesh.vertexCount} verts / ${terrainMesh.indexCount} indices, canvas ${canvas.width}×${canvas.height}`);

    return world;
  }

  // --- Mesh building ---

  private async buildMesh(config: WorldGenConfig): Promise<void> {
    const result = await buildTerrainMesh(
      this.meshCompute, config,
      WORLD.GRID_RADIUS, WORLD.HEX_SIZE, MESH.VERTEX_SPACING,
    );
    this.terrainMesh.upload(result.mesh);
    this.terrainGrid = result.grid;

    // Upload elevation + moisture to sim field
    if (result.grid) {
      this.simField.uploadElevation(result.grid.elevations);
      this.simField.uploadMoisture(result.grid.moistures);
    }
  }

  /** Build clipmap LOD after terrain grid data is available. */
  private initClipmapSystem(terrainMat: any): void {
    if (!this.terrainGrid) return;

    const grid = this.terrainGrid;
    const worldRadius = WORLD.GRID_RADIUS * WORLD.HEX_SIZE * Math.sqrt(3);

    // Sampling callbacks: bilinear lookup into the terrain grid
    const sampleGrid = (x: number, z: number, data: Float32Array): number => {
      const col = (x - grid.originX) / grid.spacing;
      const row = (z - grid.originZ) / grid.spacing;
      const c0 = Math.max(0, Math.min(grid.cols - 1, Math.floor(col)));
      const r0 = Math.max(0, Math.min(grid.rows - 1, Math.floor(row)));
      return data[r0 * grid.cols + c0] ?? 0;
    };

    this.clipmapSystem = new ClipmapSystem(
      this.device,
      this.scene,
      terrainMat,
      {
        rings: 5,
        baseSpacing: MESH.VERTEX_SPACING,
        baseExtent: 512,
        worldRadius,
      },
      (x, z) => sampleGrid(x, z, grid.elevations),
      (x, z) => sampleGrid(x, z, grid.moistures),
    );

    // Hide the old uniform terrain mesh — clipmap replaces it
    const terrainObj = this.scene.getObject('terrain');
    if (terrainObj) terrainObj.visible = false;
  }

  // --- Tick ---

  tick(dt: number): void {
    const frameStart = this.telemetry.beginFrame();
    this.time += dt;

    // Canvas resize (match display size to pixel size)
    const dpr = window.devicePixelRatio || 1;
    const displayW = this.canvas.clientWidth;
    const displayH = this.canvas.clientHeight;
    const pixW = Math.round(displayW * dpr);
    const pixH = Math.round(displayH * dpr);
    if (this.canvas.width !== pixW || this.canvas.height !== pixH) {
      this.canvas.width = pixW;
      this.canvas.height = pixH;
    }

    // Simulation (measured)
    this.telemetry.measureSim(() => {
      let ticks = 0;
      this.simAccumulator += dt;
      while (this.simAccumulator >= SIM_TICK_INTERVAL) {
        this.simAccumulator -= SIM_TICK_INTERVAL;

        const encoder = this.device.createCommandEncoder();

        // Source injection
        this.sourceInjection.dispatch(encoder, this.simField, this.overlays, WORLD.HEX_SIZE);

        // Swap to write target, run shallow water, swap back
        this.simField.swapFluid();
        this.shallowWater.dispatch(encoder, this.simField, SIM_TICK_INTERVAL);
        this.simField.swapFluid();

        this.device.queue.submit([encoder.finish()]);

        this.dirty.fluid = true;
        ticks++;
      }
      return ticks;
    });

    // Uniforms (measured)
    this.telemetry.measureUniform(() => {
      const aspect = this.canvas.width / (this.canvas.height || 1);
      const viewProj = getViewProjection(this.camera, CAMERA.FOV, aspect, CAMERA.NEAR, CAMERA.FAR);
      const eyePos = getEyePosition(this.camera);
      this.uniformSystem.execute(
        { viewProj, eyePos: eyePos as [number, number, number] },
        this.config,
        dt,
      );
    });

    // Clipmap LOD update (only rebuilds when camera moves enough)
    this.clipmapSystem?.execute(this.camera.targetX, this.camera.targetZ);

    // Render (measured)
    this.telemetry.measureRender(() => {
      this.renderSystem.execute();
    });

    this.telemetry.endFrame(frameStart);
  }

  /** Get current telemetry snapshot for UI display. */
  getTelemetry(): TelemetrySnapshot {
    return this.telemetry.snapshot();
  }

  // --- Commands ---

  addOverlay(alignment: PlanarAlignment, q: number, r: number, params?: Partial<OverlayParams>): OverlayId {
    this.pushSnapshot();
    const id = this.overlays.add(alignment, q, r, params);
    this.dirty.chemistry = true;
    this.notify();
    return id;
  }

  removeOverlay(id: OverlayId): boolean {
    this.pushSnapshot();
    const ok = this.overlays.remove(id);
    if (ok) { this.dirty.chemistry = true; this.notify(); }
    return ok;
  }

  modifyOverlay(id: OverlayId, changes: Partial<OverlayParams> & { q?: number; r?: number }): boolean {
    this.pushSnapshot();
    const ok = this.overlays.modify(id, changes);
    if (ok) { this.dirty.chemistry = true; this.notify(); }
    return ok;
  }

  updateHexNote(index: number, note: string): void {
    if (index < 0 || index >= this.hexes.hexCount) return;
    this.pushSnapshot();
    this.hexes.notes[index] = note;
    this.notify();
  }

  // --- History ---

  private pushSnapshot(): void {
    if (this.historyIndex < this.history.length - 1) {
      this.history.length = this.historyIndex + 1;
    }

    const snapshot: WorldSnapshot = {
      elevation: this.simField['elevationStaging'].slice(),
      fluid: this.simField['fluidStaging'].slice(),
      overlayData: this.overlays.snapshot(),
      config: { ...this.config },
    };

    this.history.push(snapshot);
    this.historyIndex = this.history.length - 1;

    if (this.history.length > HISTORY_LIMIT) {
      this.history.shift();
      this.historyIndex--;
    }
  }

  undo(): boolean {
    if (this.historyIndex <= 0) return false;
    this.historyIndex--;
    this.restoreSnapshot(this.history[this.historyIndex]!);
    this.notify();
    return true;
  }

  redo(): boolean {
    if (this.historyIndex >= this.history.length - 1) return false;
    this.historyIndex++;
    this.restoreSnapshot(this.history[this.historyIndex]!);
    this.notify();
    return true;
  }

  private restoreSnapshot(snap: WorldSnapshot): void {
    this.simField.uploadElevation(snap.elevation);
    this.simField.uploadFluid(snap.fluid);
    this.overlays.restore(snap.overlayData);
    this.config = { ...snap.config };
    this.dirty.chemistry = true;
    this.dirty.hexState = true;
    this.dirty.fluid = true;
    this.dirty.mesh = true;
    this.dirty.elevation = true;
  }

  get canUndo(): boolean { return this.historyIndex > 0; }
  get canRedo(): boolean { return this.historyIndex < this.history.length - 1; }

  // --- React ---

  private notify(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- Cleanup ---

  destroy(): void {
    this.clipmapSystem?.destroy();
    this.telemetry.destroy();
    this.simField.destroy();
    this.shallowWater.destroy();
    this.sourceInjection.destroy();
    this.scene.destroy();
    this.terrainMesh.destroy();
    this.meshCompute.destroy();
    this.listeners.clear();
    this.history.length = 0;
  }
}
