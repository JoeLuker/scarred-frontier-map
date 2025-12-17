
import { HexData, TerrainType, TerrainElement, WorldGenConfig, PlanarAlignment } from '../types';
import { calculateTravelStats } from './gameLogic';
import { MAP_CONFIG } from '../constants';
import { getSectorCenter, getHexDistance, hexLine, getSectorID } from './geometry';
import { getBiomeAt } from './biome';

// --- Public API ---

export const getInitialMapData = (config: WorldGenConfig): HexData[] => {
  let allHexes: HexData[] = [];
  const processedSectors = new Set<string>();

  // 1. Spiral outward to generate sectors in order (ensures bridges connect nicely to center)
  const radius = MAP_CONFIG.WORLD_RADIUS_SECTORS;
  
  for (let r = 0; r <= radius; r++) {
      for (let sq = -r; sq <= r; sq++) {
          for (let sr = -r; sr <= r; sr++) {
              // Hex logic for sector grid
              if (Math.abs(sq + sr) <= r && Math.abs(sq) <= r && Math.abs(sr) <= r) {
                 // Optimization: Only process this ring
                 const dist = (Math.abs(sq) + Math.abs(sq + sr) + Math.abs(sr)) / 2;
                 if (dist !== r) continue;

                 const sectorId = `SECTOR-${sq}-${sr}`;
                 if (processedSectors.has(sectorId)) continue;
                 processedSectors.add(sectorId);

                 const center = getSectorCenter(sq, sr);
                 
                 // Generate Cluster
                 const cluster = generateCluster(center.q, center.r, sectorId, config, allHexes, { sq, sr });
                 
                 // Set Exploration State (Only 0,0 is explored initially)
                 const isStart = sq === 0 && sr === 0;
                 cluster.forEach(h => {
                     h.isExplored = isStart;
                     // Clean up placeholder flags if they exist (shouldn't from generateCluster but safe to reset)
                     h.isSectorPlaceholder = false; 
                 });

                 // Generate Bridges to existing neighbors (inward)
                 // We temporarily add cluster to allHexes to check adjacency, then add bridges
                 const preBridgeMap = [...allHexes, ...cluster];
                 const bridges = generateBridges({x: center.q, y: center.r}, sectorId, preBridgeMap, config);
                 
                 bridges.forEach(b => {
                     b.isExplored = isStart;
                     b.isSectorPlaceholder = false;
                 });

                 // Merge
                 const existingKeys = new Set(allHexes.map(h => h.id));
                 const newHexes = [...cluster, ...bridges].filter(h => !existingKeys.has(h.id));
                 
                 allHexes.push(...newHexes);
              }
          }
      }
  }

  return allHexes;
};

export const regenerateUnexploredTerrain = (
    currentHexes: HexData[],
    config: WorldGenConfig
): HexData[] => {
    return currentHexes.map(hex => {
        if (hex.isExplored) return hex;

        // Regenerate biome for unexplored hexes using the NEW config
        const { terrain, element, flavor } = getBiomeAt(hex.coordinates.x, hex.coordinates.y, config);
        const stats = calculateTravelStats(30, terrain, element);

        return {
            ...hex,
            // Update procedural data
            terrain,
            element,
            description: flavor,
            baseDescription: flavor,
            baseTerrain: terrain,
            travelTimeHours: stats.travelTime,
            explorationTimeDays: stats.explorationTime,
            
            // Reset planar mutations to "Material" so applyOverlaysToMap can re-calc them cleanly later
            planarAlignment: PlanarAlignment.MATERIAL,
            planarIntensity: 0,
            planarInfluences: [] 
        };
    });
};

export const revealSector = (targetGroupId: string, currentMap: HexData[]): HexData[] => {
    return currentMap.map(h => {
        if (h.groupId === targetGroupId) {
            return { ...h, isExplored: true };
        }
        return h;
    });
};

export const revealEntireMap = (currentHexes: HexData[], config: WorldGenConfig): HexData[] => {
    return currentHexes.map(h => ({ ...h, isExplored: true }));
};

// --- Generators ---

const generateBridges = (
    newSectorCenter: {x: number, y: number}, 
    groupId: string,
    allHexes: HexData[],
    config: WorldGenConfig
): HexData[] => {
    const occupiedSet = new Set(allHexes.map(h => `${h.coordinates.x},${h.coordinates.y}`));
    
    // Check all 6 directions for existing neighbors
    const directions = [
        { sq: 1, sr: 0 }, { sq: 1, sr: -1 }, { sq: 0, sr: -1 },
        { sq: -1, sr: 0 }, { sq: -1, sr: 1 }, { sq: 0, sr: 1 }
    ];

    const bridges: HexData[] = [];

    directions.forEach(d => {
        const offset = getSectorCenter(d.sq, d.sr); 
        const nX = newSectorCenter.x + offset.q;
        const nY = newSectorCenter.y + offset.r;

        // Do we have any hexes from this neighbor sector?
        // We look for any hex roughly in that area (simple heuristic or id check)
        const hasNeighbor = allHexes.some(h => 
            // Check if hex belongs to a sector or is a bridge nearby
            getHexDistance({ q: h.coordinates.x, r: h.coordinates.y }, {q: nX, r: nY}) < MAP_CONFIG.SECTOR_SIZE
        );

        if (!hasNeighbor) return;

        // Create Land Bridge
        const line = hexLine({q: newSectorCenter.x, r: newSectorCenter.y}, {q: nX, r: nY});
        
        line.forEach(pt => {
            // Widen the path
            for (let dq = -MAP_CONFIG.BRIDGE_RADIUS; dq <= MAP_CONFIG.BRIDGE_RADIUS; dq++) {
                for (let dr = -MAP_CONFIG.BRIDGE_RADIUS; dr <= MAP_CONFIG.BRIDGE_RADIUS; dr++) {
                    if (Math.abs(dq + dr) > MAP_CONFIG.BRIDGE_RADIUS) continue;
                    const tx = pt.q + dq;
                    const ty = pt.r + dr;
                    const key = `${tx},${ty}`;
                    
                    if (!occupiedSet.has(key)) {
                        occupiedSet.add(key);
                        const { terrain, element, flavor } = getBiomeAt(tx, ty, config);
                        const stats = calculateTravelStats(30, terrain, element);
                        
                        bridges.push({
                            id: `BRIDGE-${tx}_${ty}`,
                            groupId: groupId, // Bridges belong to the sector being generated
                            terrain,
                            element,
                            coordinates: { x: tx, y: ty },
                            travelTimeHours: stats.travelTime,
                            explorationTimeDays: stats.explorationTime,
                            isExplored: false, // Default hidden
                            description: flavor,
                            baseDescription: flavor,
                            baseTerrain: terrain,
                            notes: "Land Bridge",
                            isSectorPlaceholder: false,
                            planarAlignment: PlanarAlignment.MATERIAL,
                            planarIntensity: 0
                        });
                    }
                }
            }
        });
    });

    return bridges;
};

export const generateCluster = (
    centerQ: number, 
    centerR: number, 
    groupId: string, 
    config: WorldGenConfig,
    contextHexes: HexData[] = [],
    overrideSector?: { sq: number, sr: number }
): HexData[] => {
    let clusterHexes: HexData[] = [];
    const centerPoint = { q: centerQ, r: centerR };

    // 1. Generate Raw Hexes
    for (let dq = -MAP_CONFIG.SECTOR_SIZE; dq <= MAP_CONFIG.SECTOR_SIZE; dq++) {
        for (let dr = -MAP_CONFIG.SECTOR_SIZE; dr <= MAP_CONFIG.SECTOR_SIZE; dr++) {
            if (Math.abs(dq + dr) > MAP_CONFIG.SECTOR_SIZE) continue; 

            const q = centerQ + dq;
            const r = centerR + dr;
            
            if (getHexDistance(centerPoint, {q, r}) <= MAP_CONFIG.SECTOR_SIZE) {
                const { terrain, element, flavor } = getBiomeAt(q, r, config, false, overrideSector);
                const stats = calculateTravelStats(30, terrain, element);
                
                clusterHexes.push({
                    id: `HEX-${q}_${r}`, 
                    groupId,
                    terrain,
                    element,
                    coordinates: { x: q, y: r },
                    travelTimeHours: stats.travelTime,
                    explorationTimeDays: stats.explorationTime,
                    isExplored: false, // Default hidden
                    description: flavor,
                    baseDescription: flavor,
                    baseTerrain: terrain,
                    notes: groupId,
                    planarAlignment: PlanarAlignment.MATERIAL,
                    planarIntensity: 0
                });
            }
        }
    }

    // 2. Prune Isolated Rivers (Basic)
    // (We skip complex river context checks for pre-gen speed, or implement fully if needed)
    // For now, let's just keep it simple.
    
    return clusterHexes;
};
