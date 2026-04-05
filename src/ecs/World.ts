import { PlanarAlignment, WorldGenConfig } from '../core/types';
import { DEFAULT_WORLD_CONFIG, WORLD } from '../core/constants';
import { SimField } from './components/SimField';
import { HexStore } from './components/HexStore';
import { OverlayStore } from './components/OverlayStore';
import type { DirtyFlags, OverlayId, OverlayParams, WorldSnapshot } from './types';

const SIM_TICK_INTERVAL = 1 / 30; // 30Hz simulation
const HISTORY_LIMIT = WORLD.HISTORY_LIMIT;

/**
 * Central ECS container. Owns all component stores, drives system execution,
 * manages history snapshots, and provides the React subscription API.
 *
 * The tick loop is driven externally (rAF from React or a standalone loop).
 * World.tick(dt) advances simulation, updates derived state, and renders.
 */
export class World {
  // Component stores
  readonly simField: SimField;
  readonly hexes: HexStore;
  readonly overlays: OverlayStore;

  // Global state
  config: WorldGenConfig;
  readonly device: GPUDevice;

  // Dirty flags for system gating
  readonly dirty: DirtyFlags = {
    chemistry: false,
    hexState: false,
    fluid: false,
    mesh: false,
    elevation: false,
  };

  // Timing
  private simAccumulator = 0;

  // History (snapshot-based undo/redo)
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
  ) {
    this.device = device;
    this.simField = simField;
    this.hexes = hexes;
    this.overlays = overlays;
    this.config = config;
  }

  static async create(
    device: GPUDevice,
    config: WorldGenConfig = DEFAULT_WORLD_CONFIG,
  ): Promise<World> {
    const simField = SimField.create(device);
    const hexes = HexStore.create(WORLD.GRID_RADIUS);
    const overlays = new OverlayStore();

    const world = new World(device, simField, hexes, overlays, config);

    // Mark everything dirty for initial build
    world.dirty.chemistry = true;
    world.dirty.hexState = true;
    world.dirty.mesh = true;
    world.dirty.elevation = true;

    // Push initial snapshot
    world.pushSnapshot();

    return world;
  }

  // --- Tick ---

  tick(dt: number): void {
    // Accumulate simulation time
    this.simAccumulator += dt;
    let simStepped = false;

    while (this.simAccumulator >= SIM_TICK_INTERVAL) {
      this.simAccumulator -= SIM_TICK_INTERVAL;
      // GPU compute systems would dispatch here:
      // this.shallowWaterSystem.execute(this);
      // this.heatDiffusionSystem.execute(this);
      simStepped = true;
    }

    if (simStepped) {
      this.dirty.fluid = true;
    }

    // CPU systems
    // this.inputSystem.execute(this);
    // this.bridgeSystem.execute(this);

    if (this.dirty.chemistry) {
      // this.chemistrySystem.execute(this);
      this.dirty.chemistry = false;
      this.dirty.hexState = true;
      this.dirty.mesh = true;
    }

    // Texture upload systems
    // if (this.dirty.hexState || this.dirty.fluid) {
    //   this.textureUploadSystem.execute(this);
    //   this.dirty.hexState = false;
    //   this.dirty.fluid = false;
    // }

    // Uniform + mesh + render systems
    // this.uniformSystem.execute(this);
    // if (this.dirty.mesh) { this.meshSystem.execute(this); this.dirty.mesh = false; }
    // this.renderSystem.execute(this);
  }

  // --- Commands (state mutations, push history) ---

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
    if (ok) {
      this.dirty.chemistry = true;
      this.notify();
    }
    return ok;
  }

  modifyOverlay(id: OverlayId, changes: Partial<OverlayParams> & { q?: number; r?: number }): boolean {
    this.pushSnapshot();
    const ok = this.overlays.modify(id, changes);
    if (ok) {
      this.dirty.chemistry = true;
      this.notify();
    }
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
    // Truncate forward history on new action
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

    // Enforce history limit
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

    // Mark everything dirty
    this.dirty.chemistry = true;
    this.dirty.hexState = true;
    this.dirty.fluid = true;
    this.dirty.mesh = true;
    this.dirty.elevation = true;
  }

  get canUndo(): boolean { return this.historyIndex > 0; }
  get canRedo(): boolean { return this.historyIndex < this.history.length - 1; }

  // --- React Subscription ---

  private notify(): void {
    this.version++;
    for (const listener of this.listeners) {
      listener();
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- Cleanup ---

  destroy(): void {
    this.simField.destroy();
    this.listeners.clear();
    this.history.length = 0;
  }
}
