import {
  TerrainType,
  PlanarAlignment,
  WorldGenConfig,
  ChemistryRule,
} from './types';

// --- World Layout ---

export const WORLD = {
  HEX_SIZE: 50,
  GRID_RADIUS: 66,           // Hex grid radius (~13,000 hexes)
  RING_WIDTH: 5,             // Ring width for sector groups
  HISTORY_LIMIT: 20,
} as const;

export const DEFAULT_WORLD_CONFIG: WorldGenConfig = {
  waterLevel: 0.45,
  mountainLevel: 0.7,
  vegetationLevel: 0.5,
  riverDensity: 0.5,
  ruggedness: 0.6,
  seed: 12345,
  continentScale: 0.5,
  temperature: 0.5,
  ridgeSharpness: 0.7,
  plateauFactor: 0.0,
  coastComplexity: 0.0,
  erosion: 0.15,
  valleyDepth: 0.7,
  chaos: 0.0,
  verticality: 0.8,
};

export const PLANAR_DEFAULTS: Record<PlanarAlignment, {
  readonly intensity: number;
  readonly falloff: number;
  readonly radius: number;
  readonly fragmentation: number;
  readonly lift: number;
}> = {
  [PlanarAlignment.MATERIAL]:  { intensity: 1.0, falloff: 3.0, radius: 5, fragmentation: 0.5, lift: 0.5 },
  [PlanarAlignment.FIRE]:      { intensity: 0.9, falloff: 4.0, radius: 5, fragmentation: 0.6, lift: 0.4 },
  [PlanarAlignment.WATER]:     { intensity: 0.7, falloff: 1.5, radius: 8, fragmentation: 0.5, lift: 0.3 },
  [PlanarAlignment.AIR]:       { intensity: 0.6, falloff: 1.0, radius: 10, fragmentation: 0.5, lift: 0.5 },
  [PlanarAlignment.EARTH]:     { intensity: 0.8, falloff: 3.0, radius: 6, fragmentation: 0.5, lift: 0.5 },
  [PlanarAlignment.POSITIVE]:  { intensity: 0.7, falloff: 2.0, radius: 7, fragmentation: 0.5, lift: 0.5 },
  [PlanarAlignment.NEGATIVE]:  { intensity: 0.8, falloff: 2.5, radius: 6, fragmentation: 0.5, lift: 0.5 },
  [PlanarAlignment.SCAR]:      { intensity: 1.0, falloff: 5.0, radius: 4, fragmentation: 0.5, lift: 0.5 },
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

  // Temperature-driven biome threshold shifts (Whittaker-style)
  TEMP_DESERT_SHIFT: 0.3,
  TEMP_FOREST_SHIFT: 0.2,
  // Elevation lapse rate: higher elevation → colder local temperature.
  // At the mountain threshold, effective temperature drops by this much.
  ELEVATION_LAPSE_RATE: 0.3,

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

// --- Planar Displacement Constants (WGSL vertex + fragment shaders) ---
// These values are injected into WGSL as named constants via render-noise.wgsl.ts.

export const PLANAR = {
  FIRE: { CONTRAST_CENTER: 0.35, CONTRAST_SCALE: 0.02, JAG_FREQ: 0.12, JAG_AMP: 0.008, LAVA_RANGE: 0.25 },
  WATER: { FLOOD_RANGE: 0.25 },
  EARTH: { NOISE_FREQ: 0.05, UPLIFT_AMP: 0.015, QUANTIZE_BANDS: 4 },
  AIR: {
    BASE_FREQ: 0.003, FRAG_EXPONENT: 8.0, DETAIL_FREQ_MUL: 3.75,
    CHUNK_BLEND_FBM: 0.7, CHUNK_BLEND_DETAIL: 0.3,
    COVERAGE_THRESHOLD: 0.40, EDGE_ONSET: 0.2,
    THRESHOLD_HIGH: 0.75, SMOOTHSTEP_WIDTH: 0.01,
    MAX_LIFT_FRACTION: 0.15, SMOOTH_MEDIAN: 0.35, SMOOTH_FACTOR: 0.3,
    ALT_VARIATION_FREQ: 0.001,
    UNDERSIDE_THICKNESS: 0.08, UNDERSIDE_STALACTITE: 0.008,
    UNDERSIDE_MAX_DIST: 20,
  },
  POSITIVE: { NOISE_FREQ: 0.04, UPLIFT_AMP: 0.005 },
  NEGATIVE: { PEAK_SINK: 0.02, BASE_SINK: 0.005 },
  SCAR: { NOISE_FREQ: 0.06, DISPLACEMENT_AMP: 0.012 },
  TORNADO: {
    RINGS: 16,               // Vertical rings per funnel
    SEGMENTS: 20,            // Vertices per ring (circumference resolution)
    GOUGE_DEPTH: -0.005,     // Ground depression level (fraction of heightScale)
    TWIST_SPEED: 0.45,       // Base angular speed (rad/s) — slow, ominous rotation
    RADIUS_FRACTION: 0.8,    // Tornado base radius = island footprint radius × this
  },
  LAVA: {
    RIPPLE_FREQ: 0.03,       // Frequency of animated surface ripple noise
    RIPPLE_AMP: 0.002,       // Amplitude of surface ripple (fraction of heightScale)
  },
  PLUME: {
    RINGS: 18,               // Vertical rings per plume column
    SEGMENTS: 20,            // Vertices per ring (circumference resolution)
    HEIGHT_FACTOR: 3.0,      // Plume height = baseRadius × this × volcanism
    TWIST_SPEED: 0.20,       // Base angular speed (rad/s) — slow, lazy rotation
    RADIUS_FRACTION: 0.6,    // Plume base radius = lava footprint radius × this
  },
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
} as const;

// Max height offset as fraction of HEX_SIZE (used by getTerrainRenderParams)
const HEIGHT_SCALE = 120.0;

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
  ELEVATION_MIN: 0.02,            // ~1° above horizon — allows looking up at island undersides
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
    heightScale: WORLD.HEX_SIZE * HEIGHT_SCALE * (0.2 + cfg.verticality * 1.8),
  };
}

// --- Chemistry Rules ---
// Flat rule table: collision rules (2+ planes) > chain rules (mutated terrain + plane) > single-plane rules.
// Resolution engine in planar.ts scores by specificity; highest wins.
// New reaction = one entry. New terrain/plane = enum + rules. Engine never changes.

export const CHEMISTRY_RULES: readonly ChemistryRule[] = [

  // ── Collision rules (2+ planes present simultaneously) ──────────────────

  { planes: [PlanarAlignment.FIRE, PlanarAlignment.WATER],
    outputTerrain: TerrainType.DESERT, flavorPrimary: 'Steam Wastes', flavorSecondary: 'Hissing Mire', emit: PlanarAlignment.AIR },
  { planes: [PlanarAlignment.FIRE, PlanarAlignment.EARTH],
    outputTerrain: TerrainType.MAGMA, flavorPrimary: 'Volcanic Forge', flavorSecondary: 'Smoldering Cavern' },
  { planes: [PlanarAlignment.FIRE, PlanarAlignment.AIR],
    outputTerrain: TerrainType.DESERT, flavorPrimary: 'Firestorm Barrens', flavorSecondary: 'Scorching Gale' },
  { planes: [PlanarAlignment.WATER, PlanarAlignment.EARTH],
    outputTerrain: TerrainType.MARSH, flavorPrimary: 'Primordial Mud', flavorSecondary: 'Sodden Earth' },
  { planes: [PlanarAlignment.WATER, PlanarAlignment.AIR],
    flavorPrimary: 'Endless Tempest', flavorSecondary: 'Driving Rain' },
  { planes: [PlanarAlignment.EARTH, PlanarAlignment.AIR],
    outputTerrain: TerrainType.FLOATING, flavorPrimary: 'Shattered Uplift', flavorSecondary: 'Dust Devil' },
  { planes: [PlanarAlignment.POSITIVE, PlanarAlignment.NEGATIVE],
    outputTerrain: TerrainType.CRYSTAL, flavorPrimary: 'Reality Fracture', flavorSecondary: 'Flickering Veil', emit: PlanarAlignment.SCAR },
  { planes: [PlanarAlignment.FIRE, PlanarAlignment.NEGATIVE],
    outputTerrain: TerrainType.MAGMA, flavorPrimary: 'Hellfire Pit', flavorSecondary: 'Smoldering Shadow' },
  { planes: [PlanarAlignment.WATER, PlanarAlignment.POSITIVE],
    flavorPrimary: 'Font of Renewal', flavorSecondary: 'Blessed Spring' },

  // ── Chain rules (mutated terrain + plane) ───────────────────────────────

  { terrain: TerrainType.MAGMA, planes: [PlanarAlignment.WATER],
    outputTerrain: TerrainType.MOUNTAIN, flavorPrimary: 'Obsidian Field', flavorSecondary: 'Cooled Rock' },
  { terrain: TerrainType.MAGMA, planes: [PlanarAlignment.AIR],
    outputTerrain: TerrainType.DESERT, flavorPrimary: 'Ash Cloud', flavorSecondary: 'Cinder Haze' },
  { terrain: TerrainType.MAGMA, planes: [PlanarAlignment.EARTH],
    outputTerrain: TerrainType.MOUNTAIN, flavorPrimary: 'Capped Volcano', flavorSecondary: 'Basalt Pillars' },
  { terrain: TerrainType.CRYSTAL, planes: [PlanarAlignment.FIRE],
    outputTerrain: TerrainType.MAGMA, flavorPrimary: 'Melted Prisms', flavorSecondary: 'Glowing Shards' },
  { terrain: TerrainType.CRYSTAL, planes: [PlanarAlignment.EARTH],
    outputTerrain: TerrainType.MOUNTAIN, flavorPrimary: 'Geode Mountains', flavorSecondary: 'Encrusted Peaks' },
  { terrain: TerrainType.FLOATING, planes: [PlanarAlignment.FIRE],
    outputTerrain: TerrainType.MAGMA, flavorPrimary: 'Burning Skyfall', flavorSecondary: 'Smoldering Islet' },
  { terrain: TerrainType.FLOATING, planes: [PlanarAlignment.EARTH],
    outputTerrain: TerrainType.MOUNTAIN, flavorPrimary: 'Grounded Monolith', flavorSecondary: 'Settled Stone' },
  { terrain: TerrainType.FLOATING, planes: [PlanarAlignment.NEGATIVE],
    outputTerrain: TerrainType.DESERT, flavorPrimary: 'Void Remnant', flavorSecondary: 'Fading Mote' },

  // ── Single-plane rules (base terrain + one plane) ──────────────────────

  // Fire
  { terrain: TerrainType.FOREST, planes: [PlanarAlignment.FIRE],
    outputTerrain: TerrainType.MAGMA, flavorPrimary: 'Burning Weald', flavorSecondary: 'Singed Woods' },
  { terrain: TerrainType.WATER, planes: [PlanarAlignment.FIRE],
    outputTerrain: TerrainType.MAGMA, flavorPrimary: 'Boiling Caldera', flavorSecondary: 'Steam Vent' },
  { terrain: TerrainType.MARSH, planes: [PlanarAlignment.FIRE],
    outputTerrain: TerrainType.DESERT, flavorPrimary: 'Dried Clay', flavorSecondary: 'Mudflats' },
  { terrain: TerrainType.PLAIN, planes: [PlanarAlignment.FIRE],
    outputTerrain: TerrainType.DESERT, flavorPrimary: 'Scorched Earth', flavorSecondary: 'Dry Cracked Earth' },
  { terrain: TerrainType.MOUNTAIN, planes: [PlanarAlignment.FIRE],
    outputTerrain: TerrainType.MAGMA, flavorPrimary: 'Volcano', flavorSecondary: 'Smoking Peak' },
  { terrain: TerrainType.HILL, planes: [PlanarAlignment.FIRE],
    outputTerrain: TerrainType.MAGMA, flavorPrimary: 'Lava Flows', flavorSecondary: 'Hot Springs' },

  // Water
  { terrain: TerrainType.DESERT, planes: [PlanarAlignment.WATER],
    outputTerrain: TerrainType.WATER, flavorPrimary: 'Oasis Lake', flavorSecondary: 'Salt Marsh' },
  { terrain: TerrainType.PLAIN, planes: [PlanarAlignment.WATER],
    outputTerrain: TerrainType.MARSH, flavorPrimary: 'Tidal Flat', flavorSecondary: 'Waterlogged Plains' },
  { terrain: TerrainType.MOUNTAIN, planes: [PlanarAlignment.WATER],
    outputTerrain: TerrainType.HILL, flavorPrimary: 'Eroded Peaks', flavorSecondary: 'Rain-Slicked Crags' },
  { terrain: TerrainType.HILL, planes: [PlanarAlignment.WATER],
    outputTerrain: TerrainType.WATER, flavorPrimary: 'Submerged Hills', flavorSecondary: 'Island Chain' },

  // Earth
  { terrain: TerrainType.FOREST, planes: [PlanarAlignment.EARTH],
    outputTerrain: TerrainType.MOUNTAIN, flavorPrimary: 'Petrified Forest', flavorSecondary: 'Stony Thicket' },
  { terrain: TerrainType.WATER, planes: [PlanarAlignment.EARTH],
    outputTerrain: TerrainType.HILL, flavorPrimary: 'Land Bridge', flavorSecondary: 'Filled-in Riverbed' },
  { terrain: TerrainType.PLAIN, planes: [PlanarAlignment.EARTH],
    outputTerrain: TerrainType.HILL, flavorPrimary: 'Jagged Plateaus', flavorSecondary: 'Rocky Fields' },

  // Air
  { terrain: TerrainType.MOUNTAIN, planes: [PlanarAlignment.AIR],
    outputTerrain: TerrainType.FLOATING, flavorPrimary: 'Floating Earthmote', flavorSecondary: 'Wind-Carved Spire' },
  { terrain: TerrainType.WATER, planes: [PlanarAlignment.AIR],
    flavorPrimary: 'Endless Cloud Sea', flavorSecondary: 'Misty Lake' },
  { terrain: TerrainType.PLAIN, planes: [PlanarAlignment.AIR],
    outputTerrain: TerrainType.FLOATING, flavorPrimary: 'Sky Plateau', flavorSecondary: 'Breezy Steppe' },
  { terrain: TerrainType.FOREST, planes: [PlanarAlignment.AIR],
    flavorPrimary: 'Whispering Woods', flavorSecondary: 'Rustling Grove' },
  { terrain: TerrainType.MARSH, planes: [PlanarAlignment.AIR],
    outputTerrain: TerrainType.PLAIN, flavorPrimary: 'Mist Valley', flavorSecondary: 'Foggy Fen' },

  // Positive Energy
  { terrain: TerrainType.DESERT, planes: [PlanarAlignment.POSITIVE],
    outputTerrain: TerrainType.CRYSTAL, flavorPrimary: 'Glass Sands', flavorSecondary: 'Blooming Sands' },
  { terrain: TerrainType.MARSH, planes: [PlanarAlignment.POSITIVE],
    outputTerrain: TerrainType.FOREST, flavorPrimary: 'Glimmering Grove', flavorSecondary: 'Sparkling Bog' },
  { terrain: TerrainType.MOUNTAIN, planes: [PlanarAlignment.POSITIVE],
    outputTerrain: TerrainType.CRYSTAL, flavorPrimary: 'Crystal Peak', flavorSecondary: 'Shining Summit' },
  { terrain: TerrainType.PLAIN, planes: [PlanarAlignment.POSITIVE],
    outputTerrain: TerrainType.FOREST, flavorPrimary: 'Elysian Fields', flavorSecondary: 'Vibrant Meadow' },
  { terrain: TerrainType.FOREST, planes: [PlanarAlignment.POSITIVE],
    outputTerrain: TerrainType.CRYSTAL, flavorPrimary: 'Towering Lightwood', flavorSecondary: 'Sun-dappled Grove' },

  // Negative Energy
  { terrain: TerrainType.FOREST, planes: [PlanarAlignment.NEGATIVE],
    outputTerrain: TerrainType.MARSH, flavorPrimary: 'Rotting Weald', flavorSecondary: 'Withered Grove' },
  { terrain: TerrainType.WATER, planes: [PlanarAlignment.NEGATIVE],
    flavorPrimary: 'Stagnant Blackwater', flavorSecondary: 'Oily Waters' },
  { terrain: TerrainType.SETTLEMENT, planes: [PlanarAlignment.NEGATIVE],
    flavorPrimary: 'Ghost Town', flavorSecondary: 'Abandoned Outpost' },
  { terrain: TerrainType.PLAIN, planes: [PlanarAlignment.NEGATIVE],
    outputTerrain: TerrainType.DESERT, flavorPrimary: 'Ash Waste', flavorSecondary: 'Grey Plains' },

  // World Scar
  { terrain: TerrainType.PLAIN, planes: [PlanarAlignment.SCAR],
    outputTerrain: TerrainType.MAGMA, flavorPrimary: 'Reality Rift', flavorSecondary: 'Warped Badlands' },
  { terrain: TerrainType.FOREST, planes: [PlanarAlignment.SCAR],
    outputTerrain: TerrainType.MARSH, flavorPrimary: 'Flesh-Like Growth', flavorSecondary: 'Twisted Thorns' },
];

