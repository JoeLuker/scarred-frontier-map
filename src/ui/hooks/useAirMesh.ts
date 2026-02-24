/**
 * Air overlay mesh hook — builds floating island + tornado meshes.
 *
 * Consumes the generic useOverlayMesh pipeline with Air-specific:
 *   - IslandClassify GPU readback
 *   - Island mesh builder (top + underside via marching squares)
 *   - Tornado mesh builder (concentric shells per overlay)
 *   - Cache keys tuned to island-affecting parameters
 */

import { useMemo, type RefObject } from 'react';
import { HexData, PlanarAlignment, PlanarOverlay, WorldGenConfig } from '../../core/types';
import { WORLD, PLANAR, getTerrainRenderParams } from '../../core/config';
import { hexToPixel } from '../../core/geometry';
import type { Scene, IslandClassify, TerrainGridData } from '../../gpu';
import { buildIslandMesh, buildTornadoMesh } from '../../gpu';
import type { TornadoDescriptor, IslandReadbackData } from '../../gpu';
import type { OverlayMesh } from './useGpuResources';
import { useOverlayMesh, type OverlayMeshConfig } from './useOverlayMesh';

/**
 * For each Air overlay, compute a TornadoDescriptor by scanning the actual
 * island solid footprint in the readback data. The tornado radius is derived
 * from the real island extent — not from overlay.radius — so it scales with
 * intensity, falloff, fragmentation, and every other parameter that shapes
 * the island.
 */
function buildTornadoDescriptors(
  overlays: PlanarOverlay[],
  grid: TerrainGridData,
  readback: IslandReadbackData,
  bottomYGrid: Float32Array,
): TornadoDescriptor[] {
  const result: TornadoDescriptor[] = [];
  const { positions, cols, rows, spacing } = grid;

  const originX = positions[0]!;
  const originZ = positions[1]!;

  for (const overlay of overlays) {
    const px = hexToPixel(overlay.coordinates.q, overlay.coordinates.r, WORLD.HEX_SIZE);
    const centerX = px.x;
    const centerZ = px.y;

    const centerCol = Math.round((centerX - originX) / spacing);
    const centerRow = Math.round((centerZ - originZ) / spacing);

    const searchRadius = Math.ceil(overlay.radius * WORLD.HEX_SIZE / spacing) + 2;
    const colMin = Math.max(0, centerCol - searchRadius);
    const colMax = Math.min(cols - 1, centerCol + searchRadius);
    const rowMin = Math.max(0, centerRow - searchRadius);
    const rowMax = Math.min(rows - 1, centerRow + searchRadius);

    let maxDist2 = 0;
    let solidCount = 0;
    let topYSum = 0;

    for (let r = rowMin; r <= rowMax; r++) {
      for (let c = colMin; c <= colMax; c++) {
        const idx = r * cols + c;
        if (!readback.solid[idx]) continue;

        solidCount++;
        topYSum += bottomYGrid[idx]!;

        const dx = (c - centerCol) * spacing;
        const dz = (r - centerRow) * spacing;
        const d2 = dx * dx + dz * dz;
        if (d2 > maxDist2) maxDist2 = d2;
      }
    }

    if (solidCount === 0) continue;

    const footprintRadius = Math.sqrt(maxDist2);
    const baseRadius = footprintRadius * PLANAR.TORNADO.RADIUS_FRACTION;
    const topY = topYSum / solidCount;

    result.push({
      centerX,
      centerZ,
      topY,
      baseRadius,
      twistSpeed: PLANAR.TORNADO.TWIST_SPEED,
    });
  }

  return result;
}

export function useAirMesh(
  planarOverlays: PlanarOverlay[],
  worldConfig: WorldGenConfig,
  hexes: HexData[],
  sceneRef: RefObject<Scene | null>,
  islandClassifyRef: RefObject<IslandClassify | null>,
  islandTopMeshRef: RefObject<OverlayMesh | null>,
  islandUnderMeshRef: RefObject<OverlayMesh | null>,
  tornadoMeshRef: RefObject<OverlayMesh | null>,
  terrainGridRef: RefObject<TerrainGridData | null>,
) {
  // Config is stable — all values accessed via refs at call time.
  const config = useMemo((): OverlayMeshConfig<IslandReadbackData> => ({
    planeType: PlanarAlignment.AIR,

    isReady: () => !!(
      sceneRef.current &&
      islandClassifyRef.current &&
      islandTopMeshRef.current &&
      islandUnderMeshRef.current &&
      terrainGridRef.current &&
      sceneRef.current.getObject('island-top') &&
      sceneRef.current.getObject('island-under')
    ),

    readback: () => islandClassifyRef.current!.readback(),

    buildAndUpload: (readbackData, overlays, wc, hx) => {
      const grid = terrainGridRef.current!;
      const topMesh = islandTopMeshRef.current!;
      const underMesh = islandUnderMeshRef.current!;
      const tMesh = tornadoMeshRef.current;
      const scene = sceneRef.current!;
      const { seaLevel, landRange, heightScale } = getTerrainRenderParams(wc);
      const renderParams = { seaLevel, landRange, heightScale };

      const result = buildIslandMesh(readbackData, hx, grid, WORLD.HEX_SIZE, renderParams);
      const islandTop = scene.getObject('island-top')!;
      const islandUnder = scene.getObject('island-under')!;
      const tornadoObj = scene.getObject('tornado');

      if (!result) {
        islandTop.visible = false;
        islandUnder.visible = false;
        if (tornadoObj) tornadoObj.visible = false;
        return;
      }

      topMesh.upload(result.top);
      underMesh.upload(result.underside);
      islandTop.visible = true;
      islandUnder.visible = true;

      // Build + upload tornado mesh — one tornado per Air overlay
      if (tMesh && tornadoObj) {
        const descriptors = buildTornadoDescriptors(
          overlays, grid, readbackData, result.bottomYGrid,
        );
        const gougeY = heightScale * PLANAR.TORNADO.GOUGE_DEPTH;
        const tornadoResult = buildTornadoMesh(descriptors, gougeY);
        if (tornadoResult) {
          tMesh.upload(tornadoResult);
          tornadoObj.visible = true;
        } else {
          tornadoObj.visible = false;
        }
      }
    },

    hide: () => {
      const scene = sceneRef.current;
      if (!scene) return;
      const top = scene.getObject('island-top');
      const under = scene.getObject('island-under');
      const tornado = scene.getObject('tornado');
      if (top) top.visible = false;
      if (under) under.visible = false;
      if (tornado) tornado.visible = false;
    },

    show: () => {
      const scene = sceneRef.current;
      if (!scene) return;
      const top = scene.getObject('island-top');
      const under = scene.getObject('island-under');
      if (top) top.visible = true;
      if (under) under.visible = true;
    },

    fullKey: (overlays, wc) =>
      overlays.map(o =>
        `${o.id}:${o.coordinates.q},${o.coordinates.r}:${o.intensity}:${o.radius}:${o.falloff}:${o.fragmentation}:${o.lift}`
      ).sort().join('|') + `|cfg:${wc.seed}:${wc.verticality}:${wc.waterLevel}`,

    shapeKey: (overlays, wc) =>
      overlays.map(o =>
        `${o.id}:${o.coordinates.q},${o.coordinates.r}:${o.intensity}:${o.radius}:${o.falloff}:${o.fragmentation}`
      ).sort().join('|') + `|seed:${wc.seed}`,

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  useOverlayMesh(planarOverlays, worldConfig, hexes, config);
}
