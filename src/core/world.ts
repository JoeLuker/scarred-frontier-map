import { HexData, WorldGenConfig, PlanarAlignment, TerrainType, TerrainElement } from './types';
import { WORLD } from './config';
import { getSectorID } from './geometry';
import type { TerrainResult } from './engine';

// --- Public API ---

/**
 * Generate a contiguous hex grid with placeholder terrain values.
 * Terrain sampling is done later via GPU (TerrainProvider).
 * Pure function — no noise evaluation.
 */
export const generateWorldGrid = (config: WorldGenConfig): HexData[] => {
  const radius = WORLD.GRID_RADIUS;
  const ringWidth = WORLD.RING_WIDTH;
  const hexes: HexData[] = [];

  for (let q = -radius; q <= radius; q++) {
    const r1 = Math.max(-radius, -q - radius);
    const r2 = Math.min(radius, -q + radius);
    for (let r = r1; r <= r2; r++) {
      const sector = getSectorID(q, r, ringWidth);

      hexes.push({
        id: `HEX-${q}_${r}`,
        groupId: `SECTOR-${sector.q}_${sector.r}`,
        terrain: TerrainType.EMPTY,
        element: TerrainElement.STANDARD,
        elevation: 0,
        coordinates: { q, r },
        description: '',
        baseDescription: '',
        baseTerrain: TerrainType.EMPTY,
        notes: '',
        planarAlignment: PlanarAlignment.MATERIAL,
        planarIntensity: 0,
        planarFragmentation: 0.5,
        planarLift: 0.5,
        planarInfluences: [],
        reactionEmission: null,
      });
    }
  }

  return hexes;
};

/**
 * Merge GPU terrain results into a hex grid.
 * Sets terrain, element, elevation, description, baseTerrain, baseDescription.
 */
export const mergeTerrain = (grid: HexData[], results: TerrainResult[]): HexData[] => {
  return grid.map((hex, i) => {
    const r = results[i]!;
    return {
      ...hex,
      terrain: r.terrain,
      element: r.element,
      elevation: r.elevation,
      description: r.description,
      baseDescription: r.description,
      baseTerrain: r.terrain,
    };
  });
};