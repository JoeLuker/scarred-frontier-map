
import { TerrainType, TerrainElement, PartySpeed, WorldGenConfig, PlanarAlignment } from './types';

// --- WORLD CONFIGURATION ---
export const MAP_CONFIG = {
  HEX_SIZE: 50,               
  SECTOR_SIZE: 4,             
  SECTOR_SPACING: 6, // Reduced from 10 to fit new Flat-Top geometry (Basis vectors are sqrt(3) larger)
  WORLD_RADIUS_SECTORS: 6,    
  BRIDGE_RADIUS: 3,           
};

export const DEFAULT_WORLD_CONFIG: WorldGenConfig = {
  waterLevel: 0.5,
  mountainLevel: 0.5,
  vegetationLevel: 0.5,
  riverDensity: 0.5,
  ruggedness: 0.5,
  seed: 12345
};

// --- GAME RULES ---

export const getSlowerSpeed = (speed: PartySpeed): PartySpeed => {
  if (speed === 50) return 40;
  if (speed === 40) return 30;
  if (speed === 30) return 20;
  if (speed === 20) return 15;
  return 15;
};

// Table: Travel Time (1 hex) - in Hours
export const TRAVEL_TIME_TABLE: Record<PartySpeed, [number, number]> = {
  15: [11, 16],
  20: [8, 12],
  30: [5, 8],
  40: [4, 6],
  50: [3, 5]
};

// Table: Exploration Time (1 hex) - in Days
export const EXPLORATION_TIME_TABLE: Record<PartySpeed, [number, number, number]> = {
  15: [3, 4, 5],
  20: [2, 3, 4],
  30: [1, 2, 3],
  40: [1, 1, 2],
  50: [1, 1, 1]
};

// --- RANDOM GENERATION TABLES ---
// Decoupled probability logic. Keys are upper bounds for a d20 roll.

export const TERRAIN_GENERATION_TABLE = [
  { threshold: 3, result: TerrainType.FOREST },
  { threshold: 6, result: TerrainType.HILL },
  { threshold: 8, result: TerrainType.MARSH },
  { threshold: 10, result: TerrainType.MOUNTAIN },
  { threshold: 13, result: TerrainType.PLAIN },
  { threshold: 14, result: TerrainType.SETTLEMENT },
  { threshold: 16, result: TerrainType.WATER },
  // 17-20: Previous/Fallback
];

export const ELEMENT_GENERATION_TABLE = [
  { threshold: 3, result: TerrainElement.DIFFICULT },
  { threshold: 6, result: TerrainElement.FEATURE },
  { threshold: 10, result: TerrainElement.HUNTING_GROUND },
  { threshold: 12, result: TerrainElement.RESOURCE },
  { threshold: 14, result: TerrainElement.SECRET },
  // 15-20: Standard
];

// --- AI CONFIGURATION ---
// Decoupled flavor text and prompts.

export const AI_CONFIG = {
  SETTING_THEME: "The setting is a blend of the American Wild West and Ancient Western China (Silk Road / Wuxia). Think: High steppes, red rock canyons, jade mountains, dusty trading posts, and spirits of the desert.",
  
  DESCRIPTION_PROMPT: (terrain: string, element: string) => `
    You are a Pathfinder RPG Game Master helper for a unique setting.
    ${AI_CONFIG.SETTING_THEME}

    Generate a concise, atmospheric description (max 3 sentences) for a wilderness hex.
    
    Terrain: ${terrain}
    Feature/Element: ${element}
    
    If the element is "Feature", "Resource", or "Secret", invent a specific interesting detail fitting this "East meets West" frontier theme.
    If "Difficult", describe the obstacle (e.g., flash floods, crumbling cliffside paths).
    If "Hunting Ground", hint at a predator (e.g., giant vultures, dune worms, spirit wolves).
    Do not use Markdown formatting. Keep it immersive.
  `,

  ENCOUNTER_PROMPT: (terrain: string, level: number) => `
    You are a Pathfinder RPG Game Master helper for a setting blending the American Wild West and Ancient Western China.
    Generate a random encounter for a party of level ${level} in a ${terrain} terrain.
    
    Provide:
    1. Name of creature(s) or hazard (Mix western tropes like Gunslingers/Bandits with Eastern tropes like Jiangshi/Spirit Beasts).
    2. A one-sentence setup describing how the encounter begins.
    Keep it brief.
  `
};

// --- PLANAR MUTATION RULES ---
// Declarative logic: "If Plane X affects Terrain Y, it becomes Z with Flavor W"

export interface MutationRule {
    targetTerrain?: TerrainType;
    flavorPrimary: string;    // Used for Epicenters (High Intensity)
    flavorSecondary: string;  // Used for Neighbors (Low Intensity)
}

export const PLANAR_MUTATIONS: Record<string, Partial<Record<TerrainType, MutationRule>>> = {
    [PlanarAlignment.FIRE]: {
        [TerrainType.FOREST]:   { targetTerrain: TerrainType.MAGMA, flavorPrimary: "Burning Weald", flavorSecondary: "Singed Woods" },
        [TerrainType.WATER]:    { targetTerrain: TerrainType.MAGMA, flavorPrimary: "Boiling Caldera", flavorSecondary: "Steam Vent" },
        [TerrainType.MARSH]:    { targetTerrain: TerrainType.DESERT, flavorPrimary: "Dried Clay", flavorSecondary: "Mudflats" },
        [TerrainType.PLAIN]:    { targetTerrain: TerrainType.DESERT, flavorPrimary: "Scorched Earth", flavorSecondary: "Dry Cracked Earth" },
        [TerrainType.MOUNTAIN]: { targetTerrain: TerrainType.MAGMA, flavorPrimary: "Volcano", flavorSecondary: "Smoking Peak" },
        [TerrainType.HILL]:     { targetTerrain: TerrainType.MAGMA, flavorPrimary: "Lava Flows", flavorSecondary: "Hot Springs" },
    },
    [PlanarAlignment.WATER]: {
        [TerrainType.DESERT]:   { targetTerrain: TerrainType.WATER, flavorPrimary: "Oasis Lake", flavorSecondary: "Salt Marsh" },
        [TerrainType.PLAIN]:    { targetTerrain: TerrainType.MARSH, flavorPrimary: "Tidal Flat", flavorSecondary: "Waterlogged Plains" },
        [TerrainType.MOUNTAIN]: { targetTerrain: TerrainType.HILL, flavorPrimary: "Eroded Peaks", flavorSecondary: "Rain-Slicked Crags" },
        [TerrainType.HILL]:     { targetTerrain: TerrainType.WATER, flavorPrimary: "Submerged Hills", flavorSecondary: "Island Chain" },
        [TerrainType.MAGMA]:    { targetTerrain: TerrainType.MOUNTAIN, flavorPrimary: "Obsidian Field", flavorSecondary: "Cooled Rock" },
    },
    [PlanarAlignment.EARTH]: {
        [TerrainType.FOREST]:   { targetTerrain: TerrainType.MOUNTAIN, flavorPrimary: "Petrified Forest", flavorSecondary: "Stony Thicket" },
        [TerrainType.WATER]:    { targetTerrain: TerrainType.HILL, flavorPrimary: "Land Bridge", flavorSecondary: "Filled-in Riverbed" },
        [TerrainType.PLAIN]:    { targetTerrain: TerrainType.HILL, flavorPrimary: "Jagged Plateaus", flavorSecondary: "Rocky Fields" },
        [TerrainType.MAGMA]:    { targetTerrain: TerrainType.MOUNTAIN, flavorPrimary: "Capped Volcano", flavorSecondary: "Basalt Pillars" },
    },
    [PlanarAlignment.AIR]: {
        [TerrainType.MOUNTAIN]: { targetTerrain: TerrainType.FLOATING, flavorPrimary: "Floating Earthmote", flavorSecondary: "Wind-Carved Spire" },
        [TerrainType.WATER]:    { flavorPrimary: "Endless Cloud Sea", flavorSecondary: "Misty Lake" },
        [TerrainType.PLAIN]:    { targetTerrain: TerrainType.FLOATING, flavorPrimary: "Sky Plateau", flavorSecondary: "Breezy Steppe" },
        [TerrainType.FOREST]:   { flavorPrimary: "Whispering Woods", flavorSecondary: "Rustling Grove" },
        [TerrainType.MARSH]:    { targetTerrain: TerrainType.PLAIN, flavorPrimary: "Mist Valley", flavorSecondary: "Foggy Fen" },
    },
    [PlanarAlignment.POSITIVE]: {
        [TerrainType.DESERT]:   { targetTerrain: TerrainType.CRYSTAL, flavorPrimary: "Glass Sands", flavorSecondary: "Blooming Sands" },
        [TerrainType.MARSH]:    { targetTerrain: TerrainType.FOREST, flavorPrimary: "Glimmering Grove", flavorSecondary: "Sparkling Bog" },
        [TerrainType.MOUNTAIN]: { targetTerrain: TerrainType.CRYSTAL, flavorPrimary: "Crystal Peak", flavorSecondary: "Shining Summit" },
        [TerrainType.PLAIN]:    { targetTerrain: TerrainType.FOREST, flavorPrimary: "Elysian Fields", flavorSecondary: "Vibrant Meadow" },
        [TerrainType.FOREST]:   { targetTerrain: TerrainType.CRYSTAL, flavorPrimary: "Towering Lightwood", flavorSecondary: "Sun-dappled Grove" },
    },
    [PlanarAlignment.NEGATIVE]: {
        [TerrainType.FOREST]:   { targetTerrain: TerrainType.MARSH, flavorPrimary: "Rotting Weald", flavorSecondary: "Withered Grove" },
        [TerrainType.WATER]:    { flavorPrimary: "Stagnant Blackwater", flavorSecondary: "Oily Waters" },
        [TerrainType.SETTLEMENT]: { flavorPrimary: "Ghost Town", flavorSecondary: "Abandoned Outpost" },
        [TerrainType.PLAIN]:    { targetTerrain: TerrainType.DESERT, flavorPrimary: "Ash Waste", flavorSecondary: "Grey Plains" },
    },
    [PlanarAlignment.SCAR]: {
        [TerrainType.PLAIN]:    { targetTerrain: TerrainType.MAGMA, flavorPrimary: "Reality Rift", flavorSecondary: "Warped Badlands" },
        [TerrainType.FOREST]:   { targetTerrain: TerrainType.MARSH, flavorPrimary: "Flesh-Like Growth", flavorSecondary: "Twisted Thorns" },
    }
};
