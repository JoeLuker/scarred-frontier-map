import { useRef, useEffect, type RefObject } from 'react';
import { HexData, PlanarAlignment, PlanarOverlay, WorldGenConfig } from '../../core/types';
import { WORLD, getTerrainRenderParams } from '../../core/config';
import type { Scene, IslandCompute, TerrainMesh, TerrainGridData } from '../../gpu';
import { buildIslandMesh } from '../../gpu';

export function useIslandMesh(
  planarOverlays: PlanarOverlay[],
  worldConfig: WorldGenConfig,
  hexes: HexData[],
  sceneRef: RefObject<Scene | null>,
  islandComputeRef: RefObject<IslandCompute | null>,
  islandTopMeshRef: RefObject<TerrainMesh | null>,
  islandUnderMeshRef: RefObject<TerrainMesh | null>,
  terrainGridRef: RefObject<TerrainGridData | null>,
) {
  const islandKeyRef = useRef('');

  useEffect(() => {
    const scene = sceneRef.current;
    const ic = islandComputeRef.current;
    const topMesh = islandTopMeshRef.current;
    const underMesh = islandUnderMeshRef.current;
    const grid = terrainGridRef.current;
    if (!scene || !ic || !topMesh || !underMesh) return;

    const islandTop = scene.getObject('island-top');
    const islandUnder = scene.getObject('island-under');
    if (!islandTop || !islandUnder) return;

    // Check if Air overlays are present
    const airOverlays = planarOverlays.filter(o => o.type === PlanarAlignment.AIR);
    const hasAir = airOverlays.length > 0;

    if (!hasAir || !grid) {
      islandTop.visible = false;
      islandUnder.visible = false;
      islandKeyRef.current = '';
      return;
    }

    // Serialize Air overlay state to detect changes
    const key = airOverlays.map(o =>
      `${o.id}:${o.coordinates.q},${o.coordinates.r}:${o.intensity}:${o.radius}:${o.falloff}:${o.fragmentation}:${o.lift}`
    ).sort().join('|') + `|cfg:${worldConfig.seed}`;

    if (key === islandKeyRef.current) {
      islandTop.visible = true;
      islandUnder.visible = true;
      return;
    }
    islandKeyRef.current = key;

    const cfg = worldConfig;
    const { seaLevel, landRange, heightScale } = getTerrainRenderParams(cfg);
    let cancelled = false;

    requestIdleCallback(() => {
      if (cancelled) return;
      ic.classify(
        grid.positions,
        grid.cols * grid.rows,
        WORLD.HEX_SIZE,
        WORLD.GRID_RADIUS,
        heightScale,
        seaLevel,
      ).then(classifyData => {
        if (cancelled) return;
        const result = buildIslandMesh(classifyData, grid, { seaLevel, landRange, heightScale });
        if (!result) {
          islandTop.visible = false;
          islandUnder.visible = false;
          return;
        }
        topMesh.upload(result.top);
        underMesh.upload(result.underside);
        islandTop.visible = true;
        islandUnder.visible = true;
        console.log(`Island mesh: top ${result.top.vertexCount}v/${result.top.indexCount / 3}t, under ${result.underside.vertexCount}v/${result.underside.indexCount / 3}t`);
      });
    });

    return () => { cancelled = true; };
  }, [planarOverlays, worldConfig, hexes]);
}
