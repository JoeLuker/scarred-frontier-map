import { HexData, WorldGenConfig, PlanarAlignment } from './types';
import { WORLD } from './config';
import { getSectorID } from './geometry';
import { getBiomeAt } from './biome';

// --- Public API ---

/** Generate a contiguous hex grid with terrain from noise. Pure function. */
export const generateWorld = (config: WorldGenConfig): HexData[] => {
  const radius = WORLD.GRID_RADIUS;
  const startRadius = WORLD.START_RADIUS;
  const ringWidth = WORLD.RING_WIDTH;
  const hexes: HexData[] = [];

  for (let q = -radius; q <= radius; q++) {
    const r1 = Math.max(-radius, -q - radius);
    const r2 = Math.min(radius, -q + radius);
    for (let r = r1; r <= r2; r++) {
      const dist = (Math.abs(q) + Math.abs(q + r) + Math.abs(r)) / 2;
      const { terrain, element, flavor, elevation } = getBiomeAt(q, r, config);
      const sector = getSectorID(q, r, ringWidth);

      hexes.push({
        id: `HEX-${q}_${r}`,
        groupId: `SECTOR-${sector.q}_${sector.r}`,
        terrain,
        element,
        elevation,
        coordinates: { q, r },
        isExplored: dist <= startRadius,
        description: flavor,
        baseDescription: flavor,
        baseTerrain: terrain,
        notes: '',
        planarAlignment: PlanarAlignment.MATERIAL,
        planarIntensity: 0,
        planarInfluences: [],
        reactionEmission: null,
      });
    }
  }

  return hexes;
};

/** Regenerate unexplored terrain with new config. Pure function. */
export const regenerateUnexplored = (
  currentHexes: readonly HexData[],
  config: WorldGenConfig,
): HexData[] => {
  return currentHexes.map(hex => {
    if (hex.isExplored) return { ...hex };

    const { terrain, element, flavor, elevation } = getBiomeAt(hex.coordinates.q, hex.coordinates.r, config);

    return {
      ...hex,
      terrain,
      element,
      elevation,
      description: flavor,
      baseDescription: flavor,
      baseTerrain: terrain,
      planarAlignment: PlanarAlignment.MATERIAL,
      planarIntensity: 0,
      planarInfluences: [],
      reactionEmission: null,
    };
  });
};

/**
 * Regenerate terrain for all hexes with a new config. Pure function.
 * Always preserves isExplored state (fog never changes).
 * When preserveExploredTerrain is true, explored hexes keep their current terrain.
 */
export const regenerateTerrain = (
  currentHexes: readonly HexData[],
  config: WorldGenConfig,
  preserveExploredTerrain: boolean,
): HexData[] => {
  return currentHexes.map(hex => {
    if (preserveExploredTerrain && hex.isExplored) return { ...hex };

    const { terrain, element, flavor, elevation } = getBiomeAt(hex.coordinates.q, hex.coordinates.r, config);

    return {
      ...hex,
      terrain,
      element,
      elevation,
      description: flavor,
      baseDescription: flavor,
      baseTerrain: terrain,
      planarAlignment: PlanarAlignment.MATERIAL,
      planarIntensity: 0,
      planarInfluences: [],
      reactionEmission: null,
    };
  });
};

/** Reveal a ring group by group ID. Pure function. */
export const revealSector = (targetGroupId: string, currentMap: readonly HexData[]): HexData[] => {
  return currentMap.map(h => {
    if (h.groupId === targetGroupId) {
      return { ...h, isExplored: true };
    }
    return { ...h };
  });
};

/** Reveal entire map. Pure function. */
export const revealAll = (currentHexes: readonly HexData[]): HexData[] => {
  return currentHexes.map(h => ({ ...h, isExplored: true }));
};
