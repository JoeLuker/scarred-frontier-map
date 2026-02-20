import { useRef, useEffect, type RefObject } from 'react';
import { HexData, PlanarAlignment, PlanarOverlay, WorldGenConfig } from '../../core/types';
import { WORLD, getTerrainRenderParams } from '../../core/config';
import type { Scene, IslandClassify, TerrainGridData } from '../../gpu';
import { buildIslandMesh } from '../../gpu';
import type { IslandMesh } from './useGpuResources';

export function useIslandMesh(
  planarOverlays: PlanarOverlay[],
  worldConfig: WorldGenConfig,
  hexes: HexData[],
  sceneRef: RefObject<Scene | null>,
  islandClassifyRef: RefObject<IslandClassify | null>,
  islandTopMeshRef: RefObject<IslandMesh | null>,
  islandUnderMeshRef: RefObject<IslandMesh | null>,
  terrainGridRef: RefObject<TerrainGridData | null>,
) {
  const islandKeyRef = useRef('');

  useEffect(() => {
    const scene = sceneRef.current;
    const ic = islandClassifyRef.current;
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
    ).sort().join('|') + `|cfg:${worldConfig.seed}:${worldConfig.verticality}:${worldConfig.waterLevel}`;

    if (key === islandKeyRef.current) {
      islandTop.visible = true;
      islandUnder.visible = true;
      return;
    }
    islandKeyRef.current = key;

    const { seaLevel, landRange, heightScale } = getTerrainRenderParams(worldConfig);
    let cancelled = false;

    requestIdleCallback(() => {
      if (cancelled) return;
      ic.readback().then(readbackData => {
        if (cancelled) return;
        const result = buildIslandMesh(
          readbackData, hexes, grid, WORLD.HEX_SIZE,
          { seaLevel, landRange, heightScale },
        );
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
