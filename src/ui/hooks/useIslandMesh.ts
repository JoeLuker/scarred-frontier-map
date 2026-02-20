import { useRef, useEffect, type RefObject } from 'react';
import { HexData, PlanarAlignment, PlanarOverlay, WorldGenConfig } from '../../core/types';
import { WORLD, getTerrainRenderParams } from '../../core/config';
import type { Scene, IslandClassify, TerrainGridData } from '../../gpu';
import { buildIslandMesh } from '../../gpu';
import type { IslandReadbackData } from '../../gpu';
import type { IslandMesh } from './useGpuResources';

/** Shared across effect invocations — guards the single staging buffer. */
const readbackState = {
  busy: false,
  pending: null as (() => void) | null,
};

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
  const cachedReadbackRef = useRef<IslandReadbackData | null>(null);
  const shapeKeyRef = useRef('');

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

    const airOverlays = planarOverlays.filter(o => o.type === PlanarAlignment.AIR);
    if (airOverlays.length === 0 || !grid) {
      islandTop.visible = false;
      islandUnder.visible = false;
      islandKeyRef.current = '';
      shapeKeyRef.current = '';
      cachedReadbackRef.current = null;
      return;
    }

    // Full key — every parameter that affects the mesh.
    const key = airOverlays.map(o =>
      `${o.id}:${o.coordinates.q},${o.coordinates.r}:${o.intensity}:${o.radius}:${o.falloff}:${o.fragmentation}:${o.lift}`
    ).sort().join('|') + `|cfg:${worldConfig.seed}:${worldConfig.verticality}:${worldConfig.waterLevel}`;

    if (key === islandKeyRef.current) {
      islandTop.visible = true;
      islandUnder.visible = true;
      return;
    }
    islandKeyRef.current = key;

    // Shape key — only parameters that affect classify output (island footprint).
    // Lift, verticality, waterLevel only affect Y computation — skip readback for those.
    const shapeKey = airOverlays.map(o =>
      `${o.id}:${o.coordinates.q},${o.coordinates.r}:${o.intensity}:${o.radius}:${o.falloff}:${o.fragmentation}`
    ).sort().join('|') + `|seed:${worldConfig.seed}`;

    const needsReadback = shapeKey !== shapeKeyRef.current;
    shapeKeyRef.current = shapeKey;

    const { seaLevel, landRange, heightScale } = getTerrainRenderParams(worldConfig);
    let cancelled = false;

    function uploadMesh(readbackData: IslandReadbackData) {
      if (cancelled) return;
      cachedReadbackRef.current = readbackData;
      const result = buildIslandMesh(
        readbackData, hexes, grid!, WORLD.HEX_SIZE,
        { seaLevel, landRange, heightScale },
      );
      if (!result) {
        islandTop!.visible = false;
        islandUnder!.visible = false;
      } else {
        topMesh.upload(result.top);
        underMesh.upload(result.underside);
        islandTop!.visible = true;
        islandUnder!.visible = true;
      }
    }

    if (!needsReadback && cachedReadbackRef.current) {
      // Shape unchanged — just rebuild Y positions from cached readback.
      uploadMesh(cachedReadbackRef.current);
      return;
    }

    // Shape changed — need fresh readback from classify output.
    function doReadback() {
      if (cancelled) return;
      if (readbackState.busy) {
        readbackState.pending = doReadback;
        return;
      }
      readbackState.busy = true;
      readbackState.pending = null;

      ic.readback().then(data => {
        readbackState.busy = false;
        uploadMesh(data);
        // Drain pending (another effect queued while we were busy).
        if (readbackState.pending) {
          const fn = readbackState.pending;
          readbackState.pending = null;
          fn();
        }
      }).catch(() => {
        readbackState.busy = false;
        if (readbackState.pending) {
          const fn = readbackState.pending;
          readbackState.pending = null;
          fn();
        }
      });
    }

    doReadback();

    return () => { cancelled = true; };
  }, [planarOverlays, worldConfig, hexes]);
}
