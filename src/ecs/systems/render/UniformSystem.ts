import type { Scene } from '../../../gpu/scene';
import type { WorldGenConfig } from '../../../core/types';
import { WORLD, MESH, TERRAIN, getTerrainRenderParams } from '../../../core/constants';

/** Terrain color palette — 11 vec4f entries (8 base + 3 mutation). */
const TERRAIN_COLORS = new Float32Array([
  0.15, 0.35, 0.60, 1.0,  // 0: WATER
  0.70, 0.65, 0.45, 1.0,  // 1: DESERT
  0.45, 0.55, 0.35, 1.0,  // 2: PLAIN
  0.20, 0.42, 0.18, 1.0,  // 3: FOREST
  0.30, 0.40, 0.25, 1.0,  // 4: MARSH
  0.55, 0.50, 0.42, 1.0,  // 5: HILL
  0.60, 0.58, 0.55, 1.0,  // 6: MOUNTAIN
  0.85, 0.88, 0.92, 1.0,  // 7: SNOW
  0.30, 0.10, 0.05, 1.0,  // 8: MAGMA
  0.50, 0.65, 0.80, 1.0,  // 9: CRYSTAL
  0.40, 0.55, 0.65, 1.0,  // 10: FLOATING
]);

export interface CameraState {
  readonly viewProj: Float32Array;
  readonly eyePos: readonly [number, number, number];
}

/**
 * Writes the 368-byte frame uniform buffer every frame.
 * Reads camera state + world config, produces the uniform data the shader expects.
 */
export class UniformSystem {
  private scene: Scene;
  private time = 0;

  private constructor(scene: Scene) {
    this.scene = scene;
  }

  static create(scene: Scene): UniformSystem {
    return new UniformSystem(scene);
  }

  execute(camera: CameraState, config: WorldGenConfig, dt: number): void {
    this.time += dt;

    const params = getTerrainRenderParams(config);
    const mountainThreshold = TERRAIN.MOUNTAIN_THRESHOLD_BASE - config.mountainLevel * TERRAIN.MOUNTAIN_THRESHOLD_RANGE;
    const hillThreshold = mountainThreshold - TERRAIN.HILL_OFFSET;

    this.scene.updateFrameUniforms(
      camera.viewProj,
      params.heightScale,
      WORLD.HEX_SIZE,
      params.seaLevel,
      mountainThreshold,
      hillThreshold,
      WORLD.GRID_RADIUS,
      TERRAIN.MOISTURE_DESERT,
      TERRAIN.MOISTURE_FOREST,
      TERRAIN.MOISTURE_MARSH,
      MESH.HEX_GRID_OPACITY,
      TERRAIN_COLORS,
      camera.eyePos,
      this.time,
    );
  }
}
