import { buildClipmapRings, type ClipmapConfig, type ClipmapRing } from '../../../gpu/clipmap';
import { TerrainMesh } from '../../../gpu/terrain-mesh';
import { Scene } from '../../../gpu/scene';
import { OBJECT_FLAGS } from '../../../gpu/types';
import type { Material } from '../../../gpu/scene';

/**
 * Manages clipmap LOD rings. Rebuilds ring meshes when the camera moves
 * far enough to change the snapped grid center. Each ring is registered
 * as a separate scene object sharing the terrain material.
 */
export class ClipmapSystem {
  private lastCenterX = NaN;
  private lastCenterZ = NaN;
  private ringMeshes: TerrainMesh[] = [];
  private config: ClipmapConfig;
  private device: GPUDevice;
  private scene: Scene;
  private material: Material;
  private sampleElevation: (x: number, z: number) => number;
  private sampleMoisture: (x: number, z: number) => number;

  constructor(
    device: GPUDevice,
    scene: Scene,
    material: Material,
    config: ClipmapConfig,
    sampleElevation: (x: number, z: number) => number,
    sampleMoisture: (x: number, z: number) => number,
  ) {
    this.device = device;
    this.scene = scene;
    this.material = material;
    this.config = config;
    this.sampleElevation = sampleElevation;
    this.sampleMoisture = sampleMoisture;

    // Pre-create GPU buffers for each ring
    for (let i = 0; i < config.rings; i++) {
      this.ringMeshes.push(TerrainMesh.create(device, 50000));
    }
  }

  /**
   * Check if camera has moved enough to trigger a rebuild, and if so,
   * regenerate all clipmap rings and upload to GPU.
   */
  execute(cameraTargetX: number, cameraTargetZ: number): void {
    const { baseSpacing } = this.config;

    // Snap to base grid alignment
    const snappedX = Math.round(cameraTargetX / baseSpacing) * baseSpacing;
    const snappedZ = Math.round(cameraTargetZ / baseSpacing) * baseSpacing;

    // Only rebuild when snapped center actually changes
    if (snappedX === this.lastCenterX && snappedZ === this.lastCenterZ) return;

    this.lastCenterX = snappedX;
    this.lastCenterZ = snappedZ;

    const rings = buildClipmapRings(
      this.config,
      snappedX,
      snappedZ,
      this.sampleElevation,
      this.sampleMoisture,
    );

    for (let i = 0; i < rings.length; i++) {
      const ring = rings[i]!;
      const mesh = this.ringMeshes[i]!;
      mesh.upload(ring);

      const objectId = `clipmap-ring-${i}`;

      // Update or create scene object
      const existing = this.scene.getObject(objectId);
      if (existing) {
        existing.mesh = mesh;
        existing.drawCount = ring.indexCount;
      } else {
        this.scene.addObject(objectId, {
          material: this.material,
          mesh,
          flags: OBJECT_FLAGS.IS_TERRAIN,
          stencilRef: 1,
          renderOrder: 1,
        });
      }
    }
  }

  /** Remove all clipmap scene objects. */
  removeFromScene(): void {
    for (let i = 0; i < this.config.rings; i++) {
      this.scene.removeObject(`clipmap-ring-${i}`);
    }
  }

  destroy(): void {
    this.removeFromScene();
    for (const mesh of this.ringMeshes) {
      mesh.destroy();
    }
    this.ringMeshes.length = 0;
  }
}
