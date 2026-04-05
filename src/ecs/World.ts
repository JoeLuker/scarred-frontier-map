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
  private terrainMesh: TerrainMesh;
  private meshCompute: MeshCompute;

  // Systems
  private shallowWater: ShallowWaterCompute;
  private sourceInjection: SourceInjectionCompute;
  private uniformSystem: UniformSystem;
  private renderSystem: RenderSystem;

  // Telemetry
  readonly telemetry: Telemetry;

  // Camera
  readonly camera = {
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
  ) {
    this.device = device;
    this.simField = simField;
    this.hexes = hexes;
    this.overlays = overlays;
    this.config = config;
    this.scene = scene;
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
    const shader = device.createShaderModule({ code: createTerrainShader() });
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
      uniformSystem, renderSystem, telemetry,
    );

    // Generate initial terrain mesh
    await world.buildMesh(config);

    // Push initial snapshot
    world.pushSnapshot();

    console.log(`World initialized: ${hexes.hexCount} hexes, sim ${simField.config.width}×${simField.config.height}, mesh ready`);

    return world;
  }

  // --- Mesh building ---

  private async buildMesh(config: WorldGenConfig): Promise<void> {
    const result = await buildTerrainMesh(
      this.meshCompute, config,
      WORLD.GRID_RADIUS, WORLD.HEX_SIZE, MESH.VERTEX_SPACING,
    );
    this.terrainMesh.upload(result.mesh);

    // Upload elevation + moisture to sim field
    if (result.grid) {
      this.simField.uploadElevation(result.grid.elevations);
      this.simField.uploadMoisture(result.grid.moistures);
    }
  }

  // --- Tick ---

  tick(dt: number): void {
    const frameStart = this.telemetry.beginFrame();
    this.time += dt;

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
      const aspect = (this.scene as any).context?.canvas?.width / (this.scene as any).context?.canvas?.height || 1;
      const viewProj = getViewProjection(this.camera, CAMERA.FOV, aspect, CAMERA.NEAR, CAMERA.FAR);
      const eyePos = getEyePosition(this.camera);
      this.uniformSystem.execute(
        { viewProj, eyePos: eyePos as [number, number, number] },
        this.config,
        dt,
      );
    });

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
