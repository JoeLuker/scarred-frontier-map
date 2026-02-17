import {
  TerrainType,
  PlanarAlignment,
  WorldGenConfig,
  MutationRule,
} from './types';

// --- World Layout ---

export const WORLD = {
  HEX_SIZE: 50,
  GRID_RADIUS: 66,           // Hex grid radius (~13,000 hexes)
  START_RADIUS: 8,           // Center hexes start explored
  RING_WIDTH: 5,             // Ring width for fog-of-war reveal groups
  HISTORY_LIMIT: 20,
} as const;

export const DEFAULT_WORLD_CONFIG: WorldGenConfig = {
  waterLevel: 0.5,
  mountainLevel: 0.5,
  vegetationLevel: 0.5,
  riverDensity: 0.5,
  ruggedness: 0.5,
  seed: 12345,
  continentScale: 0.5,
  temperature: 0.5,
  ridgeSharpness: 0.5,
  plateauFactor: 0.0,
  coastComplexity: 0.0,
  erosion: 0.0,
  valleyDepth: 0.5,
  chaos: 0.0,
  verticality: 0.5,
};

// --- Continuous Terrain Field (world-space coordinates) ---
// Scales calibrated for pixel coordinates: old hex-space values ÷ (√3 × HEX_SIZE ≈ 86.6)

export const TERRAIN = {
  // Layered elevation model — noise scales (world-space)
  CONTINENTAL_SCALE: 0.0001386,  // Very low freq: large landmasses vs ocean basins
  RIDGE_SCALE: 0.0002887,        // Mid freq: coherent mountain ranges
  DETAIL_SCALE: 0.0008083,       // High freq: local hills and dips

  // Layered elevation model — layer weights
  CONTINENTAL_WEIGHT: 0.55,
  RIDGE_WEIGHT: 0.35,            // Scaled by mountainLevel slider
  DETAIL_WEIGHT: 0.10,           // Scaled by ruggedness slider

  // Slider-driven thresholds
  SEA_LEVEL_MIN: 0.15,           // Sea level at waterLevel=0
  SEA_LEVEL_RANGE: 0.35,         // Sea level at waterLevel=1 → 0.50
  MOUNTAIN_THRESHOLD_BASE: 0.85, // Mountain threshold at mountainLevel=0
  MOUNTAIN_THRESHOLD_RANGE: 0.25, // Mountain threshold at mountainLevel=1 → 0.60
  HILL_OFFSET: 0.15,             // Hills form this far below mountain threshold

  // Moisture model (world-space)
  MOISTURE_SCALE: 0.0003464,     // Spatial moisture noise frequency
  MOISTURE_NOISE_WEIGHT: 0.4,    // Weight of independent noise
  COASTAL_WEIGHT: 0.4,           // Weight of elevation-derived coastal proximity
  VEG_BIAS_WEIGHT: 0.2,          // Weight of vegetation slider bias

  // River detection (world-space)
  RIVER_SCALE: 0.0005774,        // River noise frequency
  RIVER_WARP_AMOUNT: 3.0,        // Domain warp strength for organic meandering
  RIVER_SENSITIVITY: 0.3,        // Valley detection threshold (scaled by riverDensity)
  RIVER_MIN_ELEV: 0.05,          // Min elevation above sea level for rivers
  RIVER_HIGH_ELEV: 0.15,         // Min distance below mountain threshold for rivers

  // Moisture biome boundaries
  MOISTURE_DESERT: 0.3,
  MOISTURE_MARSH: 0.7,
  MOISTURE_FOREST: 0.5,

  // Coast complexity noise scale (world-space)
  COAST_NOISE_SCALE: 0.001,

  // Domain warp (chaos parameter)
  DOMAIN_WARP_SCALE: 0.0003,
  DOMAIN_WARP_MAX: 300.0,
  WARP_COORD_OFFSET: 7.0,           // Decorrelation offset for second warp sample

  // Continent frequency: contFreq = CONTINENTAL_SCALE * (CONT_FREQ_BASE + continentScale * CONT_FREQ_RANGE)
  CONT_FREQ_BASE: 0.25,
  CONT_FREQ_RANGE: 1.5,

  // Ridge exponent: ridgeExp = RIDGE_EXP_BASE + ridgeSharpness * RIDGE_EXP_RANGE
  RIDGE_EXP_BASE: 0.3,
  RIDGE_EXP_RANGE: 1.4,

  // Erosion suppression: effWeight = weight * (1 - erosion * factor)
  EROSION_RIDGE_FACTOR: 0.5,
  EROSION_DETAIL_FACTOR: 0.9,

  // Coast complexity
  COAST_AMPLITUDE: 0.1,
  COAST_MIN_SEA_LEVEL: 0.01,

  // Plateau quantization: bands = PLATEAU_BANDS_MIN + (1 - plateauFactor) * PLATEAU_BANDS_RANGE
  PLATEAU_BANDS_MIN: 3,
  PLATEAU_BANDS_RANGE: 20,

  // Valley depth shape: pow(t, VALLEY_EXP_BASE + valleyDepth)
  VALLEY_EXP_BASE: 0.5,

  // Temperature-driven biome threshold shifts
  TEMP_DESERT_SHIFT: 0.3,
  TEMP_FOREST_SHIFT: 0.2,

  // Flavor sub-thresholds (relative position within biome range)
  DEEP_OCEAN_RATIO: 0.5,
  SNOW_MOISTURE: 0.5,

  // River warp sub-frequency and decorrelation offset
  RIVER_WARP_FREQ: 0.5,
  RIVER_WARP_OFFSET: 5.0,
} as const;

// --- Per-Hex Biome Constants (use hash(q, r, seed)) ---

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
  EDGE_SEED: 12345,
} as const;

// --- Continuous Terrain Mesh ---

export const MESH = {
  VERTEX_SPACING: WORLD.HEX_SIZE / 2,  // Derived from HEX_SIZE — half a hex width
  HEX_GRID_OPACITY: 0.15,    // Opacity of hex grid overlay lines
  FOG_MIX: 0.35,             // Desaturation + darken for unexplored fog overlay
} as const;

// --- Render / LOD Constants ---

export const RENDER = {
  ZOOM_ICONS: 0.6,
  ZOOM_COORDS: 1.5,
  ZOOM_FOG_TEXT: 0.35,
  ZOOM_SIMPLE_FOG: 0.20,
  ZOOM_BEVEL: 0.4,
  ZOOM_FOG_FILL: 0.5,
  // 3D height
  HEIGHT_SCALE: 12.0,            // Max height offset as fraction of HEX_SIZE
  SIDE_DARKEN: 0.3,              // Side face color multiplier at cliff top
  CLIFF_BASE_DARKEN: 0.12,       // Side face color multiplier at cliff base
  BEVEL_INNER: 0.80,             // Bevel highlight starts at this distance from center
  BEVEL_OUTER: 0.92,             // Bevel highlight ends at this distance
  BEVEL_STRENGTH: 0.12,          // White highlight intensity
  FOG_WHITE_MIX: 0.04,           // Fog overlay white tint (similar to UNEXPLORED_FOG_ALPHA)

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

// --- 3D Camera ---

export const CAMERA = {
  FOV: Math.PI / 3,              // 60° vertical field of view
  NEAR: 10,
  FAR: 20000,
  DEFAULT_DISTANCE: 3000,
  DEFAULT_ELEVATION: Math.PI / 4, // 45° tilt
  DEFAULT_AZIMUTH: 0,
  ORBIT_SPEED: 0.005,
  PAN_SPEED: 0.002,
  ZOOM_MIN: 200,
  ZOOM_MAX: 15000,
  ZOOM_FACTOR: 1.08,
  DRAG_THRESHOLD: 5,
} as const;

// --- Derived Terrain Render Params (single source of truth) ---
// These formulas are used by: terrain-mesh.ts, terrain-renderer.ts (via uniforms),
// HexGrid.tsx (uniforms + overlay alignment), terrain.ts (seaLevel for biome classification).

export interface TerrainRenderParams {
  readonly seaLevel: number;
  readonly landRange: number;
  readonly heightScale: number;
}

export function getTerrainRenderParams(cfg: WorldGenConfig): TerrainRenderParams {
  const seaLevel = TERRAIN.SEA_LEVEL_MIN + cfg.waterLevel * TERRAIN.SEA_LEVEL_RANGE;
  return {
    seaLevel,
    landRange: 1 - seaLevel,
    heightScale: WORLD.HEX_SIZE * RENDER.HEIGHT_SCALE * (0.2 + cfg.verticality * 1.8),
  };
}

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

