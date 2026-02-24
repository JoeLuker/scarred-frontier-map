/**
 * Fire overlay mesh hook — builds volcanic plume meshes.
 *
 * Lava pools are handled entirely by the terrain pipeline:
 *   - vs_main clamps Fire terrain vertices up to the lava level
 *   - fs_main Fire branch renders full animated lava material for clamped vertices
 *
 * This hook only manages plume meshes (volumetric smoke columns above eruption sites).
 * Plume descriptors are computed from overlay data + terrain render params.
 */

import { useMemo, type RefObject } from 'react';
import { HexData, PlanarAlignment, PlanarOverlay, WorldGenConfig } from '../../core/types';
import { WORLD, PLANAR, getTerrainRenderParams } from '../../core/config';
import { hexToPixel } from '../../core/geometry';
import { computeDisplacedY } from '../../gpu/terrain-mesh';
import type { Scene } from '../../gpu';
import { buildPlumeMesh } from '../../gpu';
import type { PlumeDescriptor } from '../../gpu';
import type { OverlayMesh } from './useGpuResources';
import { useOverlayMesh, type OverlayMeshConfig } from './useOverlayMesh';

/**
 * Build plume descriptors from Fire overlays.
 * Plume center = overlay center, radius = overlay hex radius * hexSize * fraction,
 * baseY = lava threshold Y (where the lava surface sits).
 */
function buildPlumeDescriptors(
  overlays: PlanarOverlay[],
  worldConfig: WorldGenConfig,
): PlumeDescriptor[] {
  const { seaLevel, landRange, heightScale } = getTerrainRenderParams(worldConfig);
  const result: PlumeDescriptor[] = [];

  for (const overlay of overlays) {
    const volcanism = overlay.fragmentation;
    if (volcanism < 0.1) continue; // Dormant volcanoes don't plume

    const lift = overlay.lift;
    if (lift < 0.01) continue; // No lava level → no plume

    const px = hexToPixel(overlay.coordinates.q, overlay.coordinates.r, WORLD.HEX_SIZE);

    // Plume base at lava threshold Y (scaled by LAVA_RANGE to match VS clamping)
    const lavaNormElev = lift * PLANAR.FIRE.LAVA_RANGE;
    const lavaThreshold = seaLevel + lavaNormElev * landRange;
    const baseY = computeDisplacedY(lavaThreshold, seaLevel, landRange, heightScale);

    // Plume radius proportional to overlay hex radius
    const baseRadius = overlay.radius * WORLD.HEX_SIZE * PLANAR.PLUME.RADIUS_FRACTION;

    result.push({
      centerX: px.x,
      centerZ: px.y,
      baseY,
      baseRadius,
      volcanism,
    });
  }

  return result;
}

type FireReadback = null;

export function useFireMesh(
  planarOverlays: PlanarOverlay[],
  worldConfig: WorldGenConfig,
  hexes: HexData[],
  sceneRef: RefObject<Scene | null>,
  plumeMeshRef: RefObject<OverlayMesh | null>,
) {
  const config = useMemo((): OverlayMeshConfig<FireReadback> => ({
    planeType: PlanarAlignment.FIRE,

    isReady: () => !!(
      sceneRef.current &&
      plumeMeshRef.current &&
      sceneRef.current.getObject('plume')
    ),

    readback: () => Promise.resolve(null),

    buildAndUpload: (_readback, overlays, wc) => {
      const pMesh = plumeMeshRef.current!;
      const scene = sceneRef.current!;
      const plumeObj = scene.getObject('plume');
      if (!pMesh || !plumeObj) return;

      const { heightScale } = getTerrainRenderParams(wc);
      const descriptors = buildPlumeDescriptors(overlays, wc);

      if (descriptors.length === 0) {
        plumeObj.visible = false;
        return;
      }

      const plumeResult = buildPlumeMesh(descriptors, heightScale);
      if (plumeResult) {
        pMesh.upload(plumeResult);
        plumeObj.visible = true;
      } else {
        plumeObj.visible = false;
      }
    },

    hide: () => {
      const scene = sceneRef.current;
      if (!scene) return;
      const plume = scene.getObject('plume');
      if (plume) plume.visible = false;
    },

    show: () => {
      const scene = sceneRef.current;
      if (!scene) return;
      const plume = scene.getObject('plume');
      if (plume) plume.visible = true;
    },

    // Full key: every parameter affecting plume mesh
    fullKey: (overlays, wc) =>
      overlays.map(o =>
        `${o.id}:${o.coordinates.q},${o.coordinates.r}:${o.radius}:${o.fragmentation}:${o.lift}`
      ).sort().join('|') + `|cfg:${wc.seed}:${wc.waterLevel}:${wc.verticality}`,

    // Shape key: plumes always rebuild (no separate readback step)
    shapeKey: (overlays, wc) =>
      overlays.map(o =>
        `${o.id}:${o.coordinates.q},${o.coordinates.r}:${o.radius}:${o.fragmentation}:${o.lift}`
      ).sort().join('|') + `|cfg:${wc.seed}:${wc.waterLevel}:${wc.verticality}`,

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  useOverlayMesh(planarOverlays, worldConfig, hexes, config);
}
