
import { TerrainType, TerrainElement, PartySpeed, TravelRuleResult, HexData } from "../types";
import { 
  TRAVEL_TIME_TABLE, 
  EXPLORATION_TIME_TABLE, 
  getSlowerSpeed, 
  TERRAIN_GENERATION_TABLE,
  ELEMENT_GENERATION_TABLE
} from "../constants";

export const calculateTravelStats = (
  speed: PartySpeed,
  terrain: TerrainType,
  element: TerrainElement
): TravelRuleResult => {
  let effectiveSpeed = speed;

  // Difficult terrain treats party speed as one category slower
  if (element === TerrainElement.DIFFICULT) {
    effectiveSpeed = getSlowerSpeed(speed);
  }

  // Safe lookup for Travel Time
  // If effectiveSpeed is somehow invalid (e.g. from corrupt JSON), fallback to 30
  const travelTimeEntry = TRAVEL_TIME_TABLE[effectiveSpeed] || TRAVEL_TIME_TABLE[30];
  
  // Mapping new mutation terrains to physics equivalents
  let physicsTerrain = terrain;
  if (terrain === TerrainType.MAGMA) physicsTerrain = TerrainType.MOUNTAIN;
  if (terrain === TerrainType.CRYSTAL) physicsTerrain = TerrainType.HILL;
  if (terrain === TerrainType.FLOATING) physicsTerrain = TerrainType.MOUNTAIN;
  
  let travelTime = physicsTerrain === TerrainType.PLAIN ? travelTimeEntry[0] : travelTimeEntry[1];

  // Settlement bonus (reduce travel time by 25%)
  if (terrain === TerrainType.SETTLEMENT) {
    travelTime = travelTime * 0.75;
  }

  // Safe lookup for Exploration Time
  const explorationTimeEntry = EXPLORATION_TIME_TABLE[effectiveSpeed] || EXPLORATION_TIME_TABLE[30];
  let explorationTime = 1;

  if (physicsTerrain === TerrainType.PLAIN || physicsTerrain === TerrainType.HILL) {
    explorationTime = explorationTimeEntry[0];
  } else if (physicsTerrain === TerrainType.MOUNTAIN) {
    explorationTime = explorationTimeEntry[2];
  } else {
    // Desert, Forest, Marsh, Magma, etc fall here
    explorationTime = explorationTimeEntry[1];
  }
  
  if (element === TerrainElement.SECRET && terrain === TerrainType.FOREST) {
    explorationTime = explorationTime * 1.5;
  }

  return {
    travelTime: parseFloat(travelTime.toFixed(1)),
    explorationTime: parseFloat(explorationTime.toFixed(1))
  };
};

export const rollD20 = (): number => Math.floor(Math.random() * 20) + 1;
export const rollD100 = (): number => Math.floor(Math.random() * 100) + 1;

// Generic helper to roll against a threshold table
const rollFromTable = <T>(table: { threshold: number, result: T }[], fallback: T): T => {
  const roll = rollD20();
  for (const entry of table) {
    if (roll <= entry.threshold) {
      return entry.result;
    }
  }
  return fallback;
};

export const generateRandomTerrain = (previousTerrain?: TerrainType): TerrainType => {
  // Pass previous terrain as fallback for 17-20 range
  return rollFromTable(TERRAIN_GENERATION_TABLE, previousTerrain || TerrainType.PLAIN);
};

export const generateRandomElement = (): TerrainElement => {
  return rollFromTable(ELEMENT_GENERATION_TABLE, TerrainElement.STANDARD);
};

// Neighbors in axial coordinates (q, r)
const DIRECTIONS = [
    { x: 1, y: 0 }, { x: 1, y: -1 }, { x: 0, y: -1 },
    { x: -1, y: 0 }, { x: -1, y: 1 }, { x: 0, y: 1 }
];

export const getUnoccupiedNeighbor = (hexes: HexData[], centerHex: HexData | null): { x: number, y: number } => {
    const occupiedMap = new Set(hexes.map(h => `${h.coordinates.x},${h.coordinates.y}`));

    // If no center hex, spiral out from 0,0 until we find an empty spot
    if (!centerHex) {
        if (!occupiedMap.has("0,0")) return { x: 0, y: 0 };
    }

    // Simple Breadth-First Search to find nearest empty spot
    if (centerHex) {
        const neighbors = DIRECTIONS.map(d => ({ x: centerHex.coordinates.x + d.x, y: centerHex.coordinates.y + d.y }));
        const emptyNeighbors = neighbors.filter(n => !occupiedMap.has(`${n.x},${n.y}`));
        if (emptyNeighbors.length > 0) {
            const idx = Math.floor(Math.random() * emptyNeighbors.length);
            return emptyNeighbors[idx];
        }
    }

    // Fallback: Spiral search for ANY empty spot near the center (or 0,0)
    const start = centerHex ? centerHex.coordinates : { x: 0, y: 0 };
    const visited = new Set<string>();
    const bfsQueue = [start];
    visited.add(`${start.x},${start.y}`);

    while (bfsQueue.length > 0) {
        const current = bfsQueue.shift()!;
        
        // Check neighbors
        for (const d of DIRECTIONS) {
            const n = { x: current.x + d.x, y: current.y + d.y };
            const key = `${n.x},${n.y}`;
            if (!visited.has(key)) {
                if (!occupiedMap.has(key)) {
                    return n;
                }
                visited.add(key);
                bfsQueue.push(n);
            }
        }
        
        // Safety break for very large maps
        if (visited.size > 5000) break;
    }

    return { x: 0, y: 0 }; // Fallback
};
