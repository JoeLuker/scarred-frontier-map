import { TerrainType, TerrainElement, WorldGenConfig } from './types';
import { domainWarp, fbm, hash } from './noise';
import { BIOME } from './config';

interface BiomeInfo {
  terrain: TerrainType;
  element: TerrainElement;
  flavor: string;
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

  const baseScale = BIOME.BASE_SCALE + ruggedness * BIOME.BASE_SCALE;

  // 1. ELEVATION
  const rawElevation = domainWarp(q * baseScale, r * baseScale, seed);
  const karstFactor = BIOME.KARST_BASE + ruggedness * BIOME.KARST_BASE;
  const elevation = Math.pow(rawElevation, karstFactor);

  // 2. MOISTURE
  const moistureNoise = fbm(q * baseScale * BIOME.MOISTURE_FREQ_MULT, r * baseScale * BIOME.MOISTURE_FREQ_MULT, seed + 500, 3);
  const rainShadow = elevation > BIOME.RAIN_SHADOW_ELEV ? BIOME.RAIN_SHADOW_VALUE : 0;
  const moistureShift = (vegetationLevel - BIOME.VEG_SHIFT_RANGE) * BIOME.VEG_SHIFT_RANGE;
  const moisture = Math.max(0, Math.min(1, moistureNoise + rainShadow + moistureShift));

  // 3. RIVER
  const riverNoiseVal = fbm(q * BIOME.RIVER_FREQ, r * BIOME.RIVER_FREQ, seed + 200, 2);
  const riverRidge = Math.abs(riverNoiseVal - 0.5) * 2;
  const isRiverPotential = !forceNoRiver && riverRidge < BIOME.RIVER_THRESHOLD_MULT * riverDensity;

  // 4. THRESHOLDS
  const seaLevel = waterLevel * BIOME.SEA_LEVEL_MULT;
  const mountainThreshold = BIOME.MOUNTAIN_HIGH - mountainLevel * BIOME.MOUNTAIN_RANGE;
  const hillThreshold = mountainThreshold - BIOME.HILL_OFFSET;

  let terrain: TerrainType = TerrainType.PLAIN;
  let flavor = 'Wilderness';

  if (elevation < seaLevel) {
    terrain = TerrainType.WATER;
    flavor = 'Lake';
  } else if (elevation > mountainThreshold) {
    terrain = TerrainType.MOUNTAIN;
    flavor = 'Peak';
  } else if (isRiverPotential && elevation > seaLevel && elevation < mountainThreshold) {
    terrain = TerrainType.WATER;
    flavor = 'River';
  } else if (elevation > hillThreshold) {
    terrain = TerrainType.HILL;
    flavor = 'Hills';
  } else {
    if (moisture < BIOME.MOISTURE_DESERT) {
      terrain = TerrainType.DESERT;
      flavor = 'Wasteland';
    } else if (moisture > BIOME.MOISTURE_MARSH) {
      terrain = TerrainType.MARSH;
      flavor = 'Marsh';
    } else if (moisture > BIOME.MOISTURE_FOREST) {
      terrain = TerrainType.FOREST;
      flavor = 'Forest';
    } else {
      terrain = TerrainType.PLAIN;
      flavor = 'Plains';
    }
  }

  // Feature / Element placement
  const element = calculateElement(terrain, elevation, moisture, q, r, seed);

  const settlementRoll = (hash(q, r, seed + BIOME.HASH_SETTLEMENT_ROLL) % 100) / 100;

  if (element === TerrainElement.FEATURE && settlementRoll > BIOME.SETTLEMENT_ROLL_THRESHOLD) {
    const settlementScore = calculateSettlementScore(terrain, elevation, moisture, q, r, seed);
    if (settlementScore > BIOME.SETTLEMENT_SCORE_THRESHOLD) {
      terrain = TerrainType.SETTLEMENT;
      flavor = flavor + ' Settlement';
    }
  }

  return { terrain, element, flavor };
};
