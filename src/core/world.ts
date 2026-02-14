import { HexData, TerrainType, WorldGenConfig, PlanarAlignment, AxialCoord } from './types';
import { WORLD } from './config';
import { getSectorCenter, getHexDistance, hexLine } from './geometry';
import { getBiomeAt } from './biome';

// --- Public API ---

/** Generate a complete world from config. Pure function, no side effects. */
export const generateWorld = (config: WorldGenConfig): HexData[] => {
  let allHexes: HexData[] = [];
  const processedSectors = new Set<string>();

  const radius = WORLD.WORLD_RADIUS_SECTORS;

  for (let r = 0; r <= radius; r++) {
    for (let sq = -r; sq <= r; sq++) {
      for (let sr = -r; sr <= r; sr++) {
        if (Math.abs(sq + sr) <= r && Math.abs(sq) <= r && Math.abs(sr) <= r) {
          const dist = (Math.abs(sq) + Math.abs(sq + sr) + Math.abs(sr)) / 2;
          if (dist !== r) continue;

          const sectorId = `SECTOR-${sq}-${sr}`;
          if (processedSectors.has(sectorId)) continue;
          processedSectors.add(sectorId);

          const center = getSectorCenter(sq, sr, WORLD.SECTOR_SPACING);

          const cluster = generateCluster(center.q, center.r, sectorId, config);

          const isStart = sq === 0 && sr === 0;
          cluster.forEach(h => {
            h.isExplored = isStart;
          });

          const preBridgeMap = [...allHexes, ...cluster];
          const bridges = generateBridges(center, sectorId, preBridgeMap, config);

          bridges.forEach(b => {
            b.isExplored = isStart;
          });

          const existingKeys = new Set(allHexes.map(h => h.id));
          const newHexes = [...cluster, ...bridges].filter(h => !existingKeys.has(h.id));

          allHexes.push(...newHexes);
        }
      }
    }
  }

  return allHexes;
};

/** Regenerate unexplored terrain with new config. Pure function. */
export const regenerateUnexplored = (
  currentHexes: readonly HexData[],
  config: WorldGenConfig,
): HexData[] => {
  return currentHexes.map(hex => {
    if (hex.isExplored) return { ...hex };

    const { terrain, element, flavor } = getBiomeAt(hex.coordinates.q, hex.coordinates.r, config);

    return {
      ...hex,
      terrain,
      element,
      description: flavor,
      baseDescription: flavor,
      baseTerrain: terrain,
      planarAlignment: PlanarAlignment.MATERIAL,
      planarIntensity: 0,
      planarInfluences: [],
    };
  });
};

/** Reveal a sector by group ID. Pure function. */
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

// --- Internal Generators ---

const generateBridges = (
  newSectorCenter: AxialCoord,
  groupId: string,
  allHexes: readonly HexData[],
  config: WorldGenConfig,
): HexData[] => {
  const occupiedSet = new Set(allHexes.map(h => `${h.coordinates.q},${h.coordinates.r}`));

  const directions = [
    { sq: 1, sr: 0 }, { sq: 1, sr: -1 }, { sq: 0, sr: -1 },
    { sq: -1, sr: 0 }, { sq: -1, sr: 1 }, { sq: 0, sr: 1 },
  ];

  const bridges: HexData[] = [];

  directions.forEach(d => {
    const offset = getSectorCenter(d.sq, d.sr, WORLD.SECTOR_SPACING);
    const nQ = newSectorCenter.q + offset.q;
    const nR = newSectorCenter.r + offset.r;

    const hasNeighbor = allHexes.some(h =>
      getHexDistance(h.coordinates, { q: nQ, r: nR }) < WORLD.SECTOR_SIZE,
    );

    if (!hasNeighbor) return;

    const line = hexLine(newSectorCenter, { q: nQ, r: nR });

    line.forEach(pt => {
      for (let dq = -WORLD.BRIDGE_RADIUS; dq <= WORLD.BRIDGE_RADIUS; dq++) {
        for (let dr = -WORLD.BRIDGE_RADIUS; dr <= WORLD.BRIDGE_RADIUS; dr++) {
          if (Math.abs(dq + dr) > WORLD.BRIDGE_RADIUS) continue;
          const tq = pt.q + dq;
          const tr = pt.r + dr;
          const key = `${tq},${tr}`;

          if (!occupiedSet.has(key)) {
            occupiedSet.add(key);
            const { terrain, element, flavor } = getBiomeAt(tq, tr, config);

            bridges.push({
              id: `BRIDGE-${tq}_${tr}`,
              groupId,
              terrain,
              element,
              coordinates: { q: tq, r: tr },
              isExplored: false,
              description: flavor,
              baseDescription: flavor,
              baseTerrain: terrain,
              notes: 'Land Bridge',
              planarAlignment: PlanarAlignment.MATERIAL,
              planarIntensity: 0,
              planarInfluences: [],
            });
          }
        }
      }
    });
  });

  return bridges;
};

const generateCluster = (
  centerQ: number,
  centerR: number,
  groupId: string,
  config: WorldGenConfig,
): HexData[] => {
  const clusterHexes: HexData[] = [];
  const centerPoint = { q: centerQ, r: centerR };

  for (let dq = -WORLD.SECTOR_SIZE; dq <= WORLD.SECTOR_SIZE; dq++) {
    for (let dr = -WORLD.SECTOR_SIZE; dr <= WORLD.SECTOR_SIZE; dr++) {
      if (Math.abs(dq + dr) > WORLD.SECTOR_SIZE) continue;

      const q = centerQ + dq;
      const r = centerR + dr;

      if (getHexDistance(centerPoint, { q, r }) <= WORLD.SECTOR_SIZE) {
        const { terrain, element, flavor } = getBiomeAt(q, r, config);

        clusterHexes.push({
          id: `HEX-${q}_${r}`,
          groupId,
          terrain,
          element,
          coordinates: { q, r },
          isExplored: false,
          description: flavor,
          baseDescription: flavor,
          baseTerrain: terrain,
          notes: groupId,
          planarAlignment: PlanarAlignment.MATERIAL,
          planarIntensity: 0,
          planarInfluences: [],
        });
      }
    }
  }

  return clusterHexes;
};
