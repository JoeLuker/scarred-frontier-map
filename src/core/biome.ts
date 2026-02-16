import { TerrainType, TerrainElement, WorldGenConfig } from './types';
import { hash } from './noise';
import { hexToPixel } from './geometry';
import { WORLD, BIOME } from './config';
import { sampleTerrain } from './terrain';

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
  // Layer 1: continuous terrain field in world-space
  const { x, y } = hexToPixel(q, r, WORLD.HEX_SIZE);
  const sample = sampleTerrain(x, y, config, forceNoRiver);

  let { terrain } = sample;
  let { flavor } = sample;
  const { elevation, moisture } = sample;

  // Layer 2: per-hex element (uses hash(q, r, seed))
  const element = calculateElement(terrain, elevation, moisture, q, r, config.seed);

  // Layer 2: per-hex settlement (uses hash(q, r, seed))
  const settlementRoll = (hash(q, r, config.seed + BIOME.HASH_SETTLEMENT_ROLL) % 100) / 100;

  if (element === TerrainElement.FEATURE && settlementRoll > BIOME.SETTLEMENT_ROLL_THRESHOLD) {
    const settlementScore = calculateSettlementScore(terrain, elevation, moisture, q, r, config.seed);
    if (settlementScore > BIOME.SETTLEMENT_SCORE_THRESHOLD) {
      terrain = TerrainType.SETTLEMENT;
      flavor = flavor + ' Settlement';
    }
  }

  return { terrain, element, flavor, elevation };
};
