import { TerrainType, TerrainElement, WorldGenConfig } from './types';
import { fbm, hash } from './noise';
import { BIOME } from './config';

interface BiomeInfo {
  terrain: TerrainType;
  element: TerrainElement;
  flavor: string;
  elevation: number;
}

const calculateSettlementScore = (
  terrain: TerrainType,
  _elev: number,
  _moist: number,
  q: number,
  r: number,
  seed: number,
): number => {
  if (terrain === TerrainType.WATER || terrain === TerrainType.MOUNTAIN) return 0;
  let score = BIOME.SETTLEMENT_BASE_SCORE;
  if (terrain === TerrainType.PLAIN) score += BIOME.SETTLEMENT_PLAIN_BONUS;
  if (terrain === TerrainType.HILL) score += BIOME.SETTLEMENT_HILL_BONUS;
  if (terrain === TerrainType.DESERT) score -= BIOME.SETTLEMENT_DESERT_PENALTY;
  const chaos = (hash(q, r, seed + BIOME.HASH_SETTLEMENT_CHAOS) % 100) / 100;
  score += chaos * BIOME.SETTLEMENT_CHAOS_WEIGHT;
  return score;
};

const calculateElement = (
  terrain: TerrainType,
  _elev: number,
  _moist: number,
  q: number,
  r: number,
  seed: number,
): TerrainElement => {
  const val = (hash(q, r, seed + BIOME.HASH_ELEMENT) % 1000) / 1000;

  if (terrain === TerrainType.MOUNTAIN) {
    if (val > BIOME.MOUNTAIN_SECRET) return TerrainElement.SECRET;
    if (val > BIOME.MOUNTAIN_DIFFICULT) return TerrainElement.DIFFICULT;
    if (val > BIOME.MOUNTAIN_RESOURCE) return TerrainElement.RESOURCE;
  }
  if (terrain === TerrainType.FOREST) {
    if (val > BIOME.FOREST_HUNTING) return TerrainElement.HUNTING_GROUND;
    if (val > BIOME.FOREST_SECRET) return TerrainElement.SECRET;
  }
  if (val > BIOME.GLOBAL_FEATURE) return TerrainElement.FEATURE;
  if (val > BIOME.GLOBAL_RESOURCE) return TerrainElement.RESOURCE;

  return TerrainElement.STANDARD;
};

export const getBiomeAt = (
  q: number,
  r: number,
  config: WorldGenConfig,
  forceNoRiver: boolean = false,
): BiomeInfo => {
  const { seed, waterLevel, mountainLevel, vegetationLevel, riverDensity, ruggedness } = config;

  // --- 1. LAYERED ELEVATION ---

  // Continental: very low-frequency, creates large landmasses vs ocean basins
  const continental = fbm(q * BIOME.CONTINENTAL_SCALE, r * BIOME.CONTINENTAL_SCALE, seed, 4);

  // Ridge: mid-frequency ridged noise, creates coherent mountain ranges
  const ridgeRaw = fbm(q * BIOME.RIDGE_SCALE, r * BIOME.RIDGE_SCALE, seed + 200, 3);
  const ridge = 1 - Math.abs(2 * ridgeRaw - 1);

  // Detail: high-frequency local variation
  const detail = fbm(q * BIOME.DETAIL_SCALE, r * BIOME.DETAIL_SCALE, seed + 400, 2);

  // Composite elevation: continental base + mountain ranges + local detail
  const elevation = Math.max(0, Math.min(1,
    continental * BIOME.CONTINENTAL_WEIGHT
    + ridge * mountainLevel * BIOME.RIDGE_WEIGHT
    + detail * ruggedness * BIOME.DETAIL_WEIGHT
  ));

  // --- 2. THRESHOLDS ---
  const seaLevel = BIOME.SEA_LEVEL_MIN + waterLevel * BIOME.SEA_LEVEL_RANGE;
  const mountainThreshold = BIOME.MOUNTAIN_THRESHOLD_BASE - mountainLevel * BIOME.MOUNTAIN_THRESHOLD_RANGE;
  const hillThreshold = mountainThreshold - BIOME.HILL_OFFSET;

  // --- 3. MOISTURE (elevation-aware) ---
  const moistureNoise = fbm(q * BIOME.MOISTURE_SCALE, r * BIOME.MOISTURE_SCALE, seed + 600, 3);

  // Coastal proximity: 1 at sea level, 0 at mountain threshold
  // Lowlands near water are wet, highlands are dry
  const elevRange = mountainThreshold - seaLevel;
  const coastalProximity = elevRange > 0
    ? Math.max(0, Math.min(1, 1 - (elevation - seaLevel) / elevRange))
    : 0;

  const moisture = Math.max(0, Math.min(1,
    moistureNoise * BIOME.MOISTURE_NOISE_WEIGHT
    + coastalProximity * BIOME.COASTAL_WEIGHT
    + vegetationLevel * BIOME.VEG_BIAS_WEIGHT
  ));

  // --- 4. RIVERS (domain-warped valley detection) ---
  const rwx = q * BIOME.RIVER_SCALE;
  const rwy = r * BIOME.RIVER_SCALE;
  // Domain warp for organic meandering paths
  const warpX = fbm(rwx * 0.5, rwy * 0.5, seed + 800, 2) * BIOME.RIVER_WARP_AMOUNT;
  const warpY = fbm(rwx * 0.5 + 5.0, rwy * 0.5 + 5.0, seed + 800, 2) * BIOME.RIVER_WARP_AMOUNT;
  const riverNoise = fbm(rwx + warpX, rwy + warpY, seed + 700, 2);
  // Valley detection: low values near the 0.5 contour = river path
  const riverValley = Math.abs(riverNoise - 0.5) * 2;
  const isRiver = !forceNoRiver
    && riverValley < riverDensity * BIOME.RIVER_SENSITIVITY
    && elevation > seaLevel + BIOME.RIVER_MIN_ELEV
    && elevation < mountainThreshold - BIOME.RIVER_HIGH_ELEV;

  // --- 5. BIOME SELECTION (elevation × moisture) ---
  let terrain: TerrainType = TerrainType.PLAIN;
  let flavor = 'Wilderness';

  if (elevation < seaLevel) {
    terrain = TerrainType.WATER;
    flavor = elevation < seaLevel * 0.5 ? 'Deep Ocean' : 'Shallow Sea';
  } else if (elevation > mountainThreshold) {
    terrain = TerrainType.MOUNTAIN;
    flavor = moisture > 0.5 ? 'Snow-Capped Peak' : 'Bare Peak';
  } else if (isRiver) {
    terrain = TerrainType.WATER;
    flavor = 'River';
  } else if (elevation > hillThreshold) {
    terrain = TerrainType.HILL;
    flavor = moisture > BIOME.MOISTURE_FOREST ? 'Wooded Hills' : 'Rocky Bluffs';
  } else {
    // Lowland biome selection by moisture
    if (moisture < BIOME.MOISTURE_DESERT) {
      terrain = TerrainType.DESERT;
      flavor = moisture < BIOME.MOISTURE_DESERT * 0.5 ? 'Barren Waste' : 'Arid Scrubland';
    } else if (moisture > BIOME.MOISTURE_MARSH) {
      terrain = TerrainType.MARSH;
      flavor = moisture > (1 + BIOME.MOISTURE_MARSH) * 0.5 ? 'Deep Swamp' : 'Wetland';
    } else if (moisture > BIOME.MOISTURE_FOREST) {
      terrain = TerrainType.FOREST;
      flavor = moisture > (BIOME.MOISTURE_FOREST + BIOME.MOISTURE_MARSH) * 0.5 ? 'Dense Forest' : 'Light Woodland';
    } else {
      terrain = TerrainType.PLAIN;
      flavor = moisture > (BIOME.MOISTURE_DESERT + BIOME.MOISTURE_FOREST) * 0.5 ? 'Grassland' : 'Dry Plains';
    }
  }

  // --- 6. FEATURE / ELEMENT / SETTLEMENT ---
  const element = calculateElement(terrain, elevation, moisture, q, r, seed);

  const settlementRoll = (hash(q, r, seed + BIOME.HASH_SETTLEMENT_ROLL) % 100) / 100;

  if (element === TerrainElement.FEATURE && settlementRoll > BIOME.SETTLEMENT_ROLL_THRESHOLD) {
    const settlementScore = calculateSettlementScore(terrain, elevation, moisture, q, r, seed);
    if (settlementScore > BIOME.SETTLEMENT_SCORE_THRESHOLD) {
      terrain = TerrainType.SETTLEMENT;
      flavor = flavor + ' Settlement';
    }
  }

  return { terrain, element, flavor, elevation };
};
