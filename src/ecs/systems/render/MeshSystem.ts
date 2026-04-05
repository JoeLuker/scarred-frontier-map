import type { WorldGenConfig } from '../../../core/types';
import type { TerrainMesh, MeshCompute, TerrainGridData } from '../../../gpu';
import { WORLD, MESH } from '../../../core/constants';
import type { SimField } from '../../components/SimField';
import type { Scene } from '../../../gpu/scene';
import { buildTerrainMesh } from '../../../gpu';

/**
 * Rebuilds the terrain mesh when elevation changes.
 * Wraps the existing buildTerrainMesh pipeline (MeshCompute GPU pass).
 */
export class MeshSystem {
  private meshCompute: MeshCompute;
  private terrainMesh: TerrainMesh;
  private simField: SimField;
  private scene: Scene;
  private lastConfig: WorldGenConfig | null = null;
  private _grid: TerrainGridData | null = null;

  private constructor(
    meshCompute: MeshCompute,
    terrainMesh: TerrainMesh,
    simField: SimField,
    scene: Scene,
  ) {
    this.meshCompute = meshCompute;
    this.terrainMesh = terrainMesh;
    this.simField = simField;
    this.scene = scene;
  }

  static create(
    meshCompute: MeshCompute,
    terrainMesh: TerrainMesh,
    simField: SimField,
    scene: Scene,
  ): MeshSystem {
    return new MeshSystem(meshCompute, terrainMesh, simField, scene);
  }

  get grid(): TerrainGridData | null { return this._grid; }

  async execute(config: WorldGenConfig): Promise<void> {
    const result = await buildTerrainMesh(
      this.meshCompute,
      config,
      WORLD.GRID_RADIUS,
      WORLD.HEX_SIZE,
      MESH.VERTEX_SPACING,
    );

    this.terrainMesh.upload(result.mesh);
    this._grid = result.grid;
    this.lastConfig = config;

    // Upload elevation data to sim field from mesh grid
    if (result.grid) {
      this.simField.uploadElevation(result.grid.elevations);
      this.simField.uploadMoisture(result.grid.moistures);
    }
  }
}
