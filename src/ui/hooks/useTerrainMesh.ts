import { useEffect, type RefObject } from 'react';
import { WorldGenConfig } from '../../core/types';
import { WORLD, MESH } from '../../core/config';
import type { TerrainMesh, MeshCompute, TerrainGridData } from '../../gpu';
import { buildTerrainMesh } from '../../gpu';

export function useTerrainMesh(
  worldConfig: WorldGenConfig,
  meshRef: RefObject<TerrainMesh | null>,
  meshComputeRef: RefObject<MeshCompute | null>,
  terrainGridRef: RefObject<TerrainGridData | null>,
  meshConfigRef: RefObject<WorldGenConfig | null>,
) {
  useEffect(() => {
    const mesh = meshRef.current;
    const mc = meshComputeRef.current;
    if (!mesh || !mc) return;

    // Skip if config hasn't changed (same reference = same config)
    if (meshConfigRef.current === worldConfig) return;
    meshConfigRef.current = worldConfig;

    // Build mesh asynchronously (GPU compute for elevation+moisture)
    const cfg = worldConfig;
    let cancelled = false;
    requestIdleCallback(() => {
      buildTerrainMesh(mc, cfg, WORLD.GRID_RADIUS, WORLD.HEX_SIZE, MESH.VERTEX_SPACING).then(result => {
        if (cancelled) return;
        mesh.upload(result.mesh);
        terrainGridRef.current = result.grid;
        console.log(`Terrain mesh: ${result.mesh.vertexCount} verts, ${result.mesh.indexCount / 3} tris`);
      });
    });
    return () => { cancelled = true; };
  }, [worldConfig]);
}
