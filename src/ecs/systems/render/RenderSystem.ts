import type { Scene } from '../../../gpu/scene';
import type { SimField } from '../../components/SimField';

/**
 * Binds sim field textures to the scene's group 0, then issues a draw call.
 * Texture references are stable — only needs to rebind when the SimField
 * swaps double-buffered fluid textures.
 */
export class RenderSystem {
  private scene: Scene;
  private simField: SimField;
  private lastFluidTexture: GPUTexture | null = null;

  private constructor(scene: Scene, simField: SimField) {
    this.scene = scene;
    this.simField = simField;
  }

  static create(device: GPUDevice, scene: Scene, simField: SimField): RenderSystem {
    const sys = new RenderSystem(scene, simField);

    // Bind stable textures once
    scene.setElevationTexture(simField.elevation);
    scene.setMoistureTexture(simField.moisture);
    scene.setSimFluidTexture(simField.currentFluidTexture);
    sys.lastFluidTexture = simField.currentFluidTexture;

    return sys;
  }

  execute(): void {
    // Rebind fluid texture if double buffer swapped
    const currentFluid = this.simField.currentFluidTexture;
    if (currentFluid !== this.lastFluidTexture) {
      this.scene.setSimFluidTexture(currentFluid);
      this.lastFluidTexture = currentFluid;
    }

    this.scene.render();
  }
}
