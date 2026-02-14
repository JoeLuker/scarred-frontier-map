import {
  TerrainType,
  PlanarAlignment,
  WorldGenConfig,
  MutationRule,
} from './types';

// --- World Layout ---

export const WORLD = {
  HEX_SIZE: 50,
  SECTOR_SIZE: 4,
  SECTOR_SPACING: 6,
  WORLD_RADIUS_SECTORS: 6,
  BRIDGE_RADIUS: 3,
  HISTORY_LIMIT: 20,
} as const;

export const DEFAULT_WORLD_CONFIG: WorldGenConfig = {
  waterLevel: 0.5,
  mountainLevel: 0.5,
  vegetationLevel: 0.5,
  riverDensity: 0.5,
  ruggedness: 0.5,
  seed: 12345,
};

// --- Biome Generation Thresholds ---

export const BIOME = {
  // Settlement scoring
  SETTLEMENT_BASE_SCORE: 0.5,
  SETTLEMENT_PLAIN_BONUS: 0.3,
  SETTLEMENT_HILL_BONUS: 0.2,
  SETTLEMENT_DESERT_PENALTY: 0.1,
  SETTLEMENT_CHAOS_WEIGHT: 0.2,
  SETTLEMENT_ROLL_THRESHOLD: 0.7,
  SETTLEMENT_SCORE_THRESHOLD: 0.75,

  // Mountain element thresholds
  MOUNTAIN_SECRET: 0.92,
  MOUNTAIN_DIFFICULT: 0.75,
  MOUNTAIN_RESOURCE: 0.65,

  // Forest element thresholds
  FOREST_HUNTING: 0.88,
  FOREST_SECRET: 0.82,

  // Generic element thresholds
  GLOBAL_FEATURE: 0.96,
  GLOBAL_RESOURCE: 0.93,

  // Terrain noise
  BASE_SCALE: 0.04,
  KARST_BASE: 2.0,
  MOISTURE_FREQ_MULT: 1.5,
  RAIN_SHADOW_ELEV: 0.6,
  RAIN_SHADOW_VALUE: -0.3,
  VEG_SHIFT_RANGE: 0.5,
  RIVER_FREQ: 0.08,
  RIVER_THRESHOLD_MULT: 0.04,
  SEA_LEVEL_MULT: 0.6,
  MOUNTAIN_HIGH: 0.9,
  MOUNTAIN_RANGE: 0.6,
  HILL_OFFSET: 0.15,

  // Moisture biome boundaries
  MOISTURE_DESERT: 0.3,
  MOISTURE_MARSH: 0.7,
  MOISTURE_FOREST: 0.5,

  // Hash seed offsets
  HASH_SETTLEMENT_CHAOS: 111,
  HASH_ELEMENT: 777,
  HASH_SETTLEMENT_ROLL: 999,
} as const;

// --- Noise / Planar Edge Constants ---

export const NOISE = {
  EDGE_VARIATION: 3.0,
  EDGE_OFFSET: -1.5,
  INTENSITY_EPSILON: 0.1,
  INTENSITY_THRESHOLD: 0.1,
  HASH_DIVISOR: 4294967296,
  EDGE_SEED: 12345,
} as const;

// --- Render / LOD Constants ---

export const RENDER = {
  ZOOM_ICONS: 0.6,
  ZOOM_COORDS: 1.5,
  ZOOM_FOG_TEXT: 0.35,
  ZOOM_SIMPLE_FOG: 0.20,
  ZOOM_BEVEL: 0.4,
  ZOOM_FOG_FILL: 0.5,
  ZOOM_MIN: 0.05,
  ZOOM_MAX: 3.0,
  ZOOM_SCALE_FACTOR: 1.1,
  DRAG_THRESHOLD: 5,
  GIZMO_HIT_RADIUS_FACTOR: 1.5,
  HEX_SQRT3: Math.sqrt(3),
  ICON_SCALE_DIVISOR: 24,
  ICON_SCALE_FACTOR: 0.5,
  COORD_FONT_SCALE: 0.25,
  COORD_OFFSET_SCALE: 0.6,
  FOG_FONT_SCALE: 0.3,
  UNEXPLORED_FOG_ALPHA: 0.03,
  PLANAR_TINT_WEIGHT: 0.6,
  FOG_TINT_MULT: 0.3,
} as const;

// --- Planar Mutation Rules ---

export const PLANAR_MUTATIONS: Partial<Record<PlanarAlignment, Partial<Record<TerrainType, MutationRule>>>> = {
  [PlanarAlignment.FIRE]: {
    [TerrainType.FOREST]:   { targetTerrain: TerrainType.MAGMA, flavorPrimary: 'Burning Weald', flavorSecondary: 'Singed Woods' },
    [TerrainType.WATER]:    { targetTerrain: TerrainType.MAGMA, flavorPrimary: 'Boiling Caldera', flavorSecondary: 'Steam Vent' },
    [TerrainType.MARSH]:    { targetTerrain: TerrainType.DESERT, flavorPrimary: 'Dried Clay', flavorSecondary: 'Mudflats' },
    [TerrainType.PLAIN]:    { targetTerrain: TerrainType.DESERT, flavorPrimary: 'Scorched Earth', flavorSecondary: 'Dry Cracked Earth' },
    [TerrainType.MOUNTAIN]: { targetTerrain: TerrainType.MAGMA, flavorPrimary: 'Volcano', flavorSecondary: 'Smoking Peak' },
    [TerrainType.HILL]:     { targetTerrain: TerrainType.MAGMA, flavorPrimary: 'Lava Flows', flavorSecondary: 'Hot Springs' },
  },
  [PlanarAlignment.WATER]: {
    [TerrainType.DESERT]:   { targetTerrain: TerrainType.WATER, flavorPrimary: 'Oasis Lake', flavorSecondary: 'Salt Marsh' },
    [TerrainType.PLAIN]:    { targetTerrain: TerrainType.MARSH, flavorPrimary: 'Tidal Flat', flavorSecondary: 'Waterlogged Plains' },
    [TerrainType.MOUNTAIN]: { targetTerrain: TerrainType.HILL, flavorPrimary: 'Eroded Peaks', flavorSecondary: 'Rain-Slicked Crags' },
    [TerrainType.HILL]:     { targetTerrain: TerrainType.WATER, flavorPrimary: 'Submerged Hills', flavorSecondary: 'Island Chain' },
    [TerrainType.MAGMA]:    { targetTerrain: TerrainType.MOUNTAIN, flavorPrimary: 'Obsidian Field', flavorSecondary: 'Cooled Rock' },
  },
  [PlanarAlignment.EARTH]: {
    [TerrainType.FOREST]:   { targetTerrain: TerrainType.MOUNTAIN, flavorPrimary: 'Petrified Forest', flavorSecondary: 'Stony Thicket' },
    [TerrainType.WATER]:    { targetTerrain: TerrainType.HILL, flavorPrimary: 'Land Bridge', flavorSecondary: 'Filled-in Riverbed' },
    [TerrainType.PLAIN]:    { targetTerrain: TerrainType.HILL, flavorPrimary: 'Jagged Plateaus', flavorSecondary: 'Rocky Fields' },
    [TerrainType.MAGMA]:    { targetTerrain: TerrainType.MOUNTAIN, flavorPrimary: 'Capped Volcano', flavorSecondary: 'Basalt Pillars' },
  },
  [PlanarAlignment.AIR]: {
    [TerrainType.MOUNTAIN]: { targetTerrain: TerrainType.FLOATING, flavorPrimary: 'Floating Earthmote', flavorSecondary: 'Wind-Carved Spire' },
    [TerrainType.WATER]:    { flavorPrimary: 'Endless Cloud Sea', flavorSecondary: 'Misty Lake' },
    [TerrainType.PLAIN]:    { targetTerrain: TerrainType.FLOATING, flavorPrimary: 'Sky Plateau', flavorSecondary: 'Breezy Steppe' },
    [TerrainType.FOREST]:   { flavorPrimary: 'Whispering Woods', flavorSecondary: 'Rustling Grove' },
    [TerrainType.MARSH]:    { targetTerrain: TerrainType.PLAIN, flavorPrimary: 'Mist Valley', flavorSecondary: 'Foggy Fen' },
  },
  [PlanarAlignment.POSITIVE]: {
    [TerrainType.DESERT]:   { targetTerrain: TerrainType.CRYSTAL, flavorPrimary: 'Glass Sands', flavorSecondary: 'Blooming Sands' },
    [TerrainType.MARSH]:    { targetTerrain: TerrainType.FOREST, flavorPrimary: 'Glimmering Grove', flavorSecondary: 'Sparkling Bog' },
    [TerrainType.MOUNTAIN]: { targetTerrain: TerrainType.CRYSTAL, flavorPrimary: 'Crystal Peak', flavorSecondary: 'Shining Summit' },
    [TerrainType.PLAIN]:    { targetTerrain: TerrainType.FOREST, flavorPrimary: 'Elysian Fields', flavorSecondary: 'Vibrant Meadow' },
    [TerrainType.FOREST]:   { targetTerrain: TerrainType.CRYSTAL, flavorPrimary: 'Towering Lightwood', flavorSecondary: 'Sun-dappled Grove' },
  },
  [PlanarAlignment.NEGATIVE]: {
    [TerrainType.FOREST]:     { targetTerrain: TerrainType.MARSH, flavorPrimary: 'Rotting Weald', flavorSecondary: 'Withered Grove' },
    [TerrainType.WATER]:      { flavorPrimary: 'Stagnant Blackwater', flavorSecondary: 'Oily Waters' },
    [TerrainType.SETTLEMENT]: { flavorPrimary: 'Ghost Town', flavorSecondary: 'Abandoned Outpost' },
    [TerrainType.PLAIN]:      { targetTerrain: TerrainType.DESERT, flavorPrimary: 'Ash Waste', flavorSecondary: 'Grey Plains' },
  },
  [PlanarAlignment.SCAR]: {
    [TerrainType.PLAIN]:  { targetTerrain: TerrainType.MAGMA, flavorPrimary: 'Reality Rift', flavorSecondary: 'Warped Badlands' },
    [TerrainType.FOREST]: { targetTerrain: TerrainType.MARSH, flavorPrimary: 'Flesh-Like Growth', flavorSecondary: 'Twisted Thorns' },
  },
};

