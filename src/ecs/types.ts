import { PlanarAlignment, WorldGenConfig } from '../core/types';

// --- Simulation Field ---

export interface SimFieldConfig {
  readonly width: number;      // grid cells in X
  readonly height: number;     // grid cells in Z
  readonly cellSize: number;   // world-space size per cell (px)
  readonly worldExtent: number; // half-extent in world space
}

// --- Overlay Entity ---

export interface OverlayParams {
  readonly radius: number;
  readonly intensity: number;
  readonly falloff: number;
  readonly fragmentation: number;
  readonly lift: number;
}

export type OverlayId = number; // packed: (slot << 8) | generation

// --- Dirty Flags ---

export interface DirtyFlags {
  chemistry: boolean;    // overlays changed → recompute planar state
  hexState: boolean;     // hex SoA changed → re-upload hex state texture
  fluid: boolean;        // sim field changed → re-upload fluid texture
  mesh: boolean;         // terrain/config changed → rebuild meshes
  elevation: boolean;    // bedrock changed → re-upload elevation texture
}

// --- System Protocol ---

export interface System {
  readonly name: string;
  execute(world: WorldInterface): void;
}

export interface AsyncSystem {
  readonly name: string;
  execute(world: WorldInterface): Promise<void>;
}

// Minimal interface exposed to systems (avoids circular imports)
export interface WorldInterface {
  readonly simField: SimFieldConfig;
  readonly config: WorldGenConfig;
  readonly dirty: DirtyFlags;
  readonly version: number;
  readonly device: GPUDevice;
  readonly hexCount: number;
  readonly dt: number;           // frame delta in seconds
  readonly simDt: number;        // simulation delta (accumulated, fixed step)
}

// --- History Snapshot ---

export interface WorldSnapshot {
  readonly elevation: Float32Array;     // copy of elevation texture data
  readonly fluid: Float32Array;         // copy of fluid texture data
  readonly overlayData: Uint8Array;     // serialized overlay store
  readonly config: WorldGenConfig;
}
