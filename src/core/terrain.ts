import { TerrainType, WorldGenConfig } from './types';
import { fbm } from './noise';
import { TERRAIN } from './config';

export interface TerrainSample {
  readonly terrain: TerrainType;
  readonly elevation: number;
  readonly moisture: number;
  readonly flavor: string;
}

/**
 * Sample the continuous terrain field at world-space (pixel) coordinates.
 * Returns terrain type, elevation, moisture, and flavor — all position-dependent.
 * No hex identity: element/settlement logic is per-hex and lives in biome.ts.
 */
export const sampleTerrain = (
  x: number,
  y: number,
  config: WorldGenConfig,
  forceNoRiver: boolean = false,
): TerrainSample => {
  const {
    seed, waterLevel, mountainLevel, vegetationLevel, riverDensity, ruggedness,
    continentScale, temperature, ridgeSharpness, plateauFactor,
    coastComplexity, erosion, valleyDepth, chaos,
  } = config;

  // --- 0. CHAOS DOMAIN WARP (before all noise) ---
  let sx = x;
  let sy = y;
  if (chaos > 0) {
    const warpAmount = chaos * TERRAIN.DOMAIN_WARP_MAX;
    const wx = fbm(x * TERRAIN.DOMAIN_WARP_SCALE, y * TERRAIN.DOMAIN_WARP_SCALE, seed + 900, 3);
    const wy = fbm(x * TERRAIN.DOMAIN_WARP_SCALE + 7.0, y * TERRAIN.DOMAIN_WARP_SCALE + 7.0, seed + 900, 3);
    sx = x + (wx - 0.5) * warpAmount;
    sy = y + (wy - 0.5) * warpAmount;
  }

  // --- 1. LAYERED ELEVATION ---

  // Continental: scale modulated by continentScale slider
  const contFreq = TERRAIN.CONTINENTAL_SCALE * (0.25 + continentScale * 1.5);
  const continental = fbm(sx * contFreq, sy * contFreq, seed, 4);

  // Ridge: mid-frequency ridged noise with sharpness control
  const ridgeRaw = fbm(sx * TERRAIN.RIDGE_SCALE, sy * TERRAIN.RIDGE_SCALE, seed + 200, 3);
  const ridgeExp = 0.3 + ridgeSharpness * 1.4;
  const ridge = Math.pow(1 - Math.abs(2 * ridgeRaw - 1), ridgeExp);

  // Detail: high-frequency local variation
  const detail = fbm(sx * TERRAIN.DETAIL_SCALE, sy * TERRAIN.DETAIL_SCALE, seed + 400, 2);

  // Erosion: suppress ridge and detail weights
  const effRidgeWeight = TERRAIN.RIDGE_WEIGHT * (1 - erosion * 0.5);
  const effDetailWeight = TERRAIN.DETAIL_WEIGHT * (1 - erosion * 0.9);

  // Composite elevation
  let elevation = Math.max(0, Math.min(1,
    continental * TERRAIN.CONTINENTAL_WEIGHT
    + ridge * mountainLevel * effRidgeWeight
    + detail * ruggedness * effDetailWeight
  ));

  // --- 2. THRESHOLDS ---
  const baseSeaLevel = TERRAIN.SEA_LEVEL_MIN + waterLevel * TERRAIN.SEA_LEVEL_RANGE;
  const mountainThreshold = TERRAIN.MOUNTAIN_THRESHOLD_BASE - mountainLevel * TERRAIN.MOUNTAIN_THRESHOLD_RANGE;
  const hillThreshold = mountainThreshold - TERRAIN.HILL_OFFSET;

  // --- 2b. COAST COMPLEXITY ---
  let seaLevel = baseSeaLevel;
  if (coastComplexity > 0) {
    const coastNoise = fbm(sx * TERRAIN.COAST_NOISE_SCALE, sy * TERRAIN.COAST_NOISE_SCALE, seed + 1100, 2) - 0.5;
    seaLevel = Math.max(0.01, baseSeaLevel + coastNoise * coastComplexity * 0.1);
  }

  // --- 2c. PLATEAU QUANTIZATION ---
  if (plateauFactor > 0) {
    const bands = 3 + (1 - plateauFactor) * 20;
    const quantized = Math.round(elevation * bands) / bands;
    const blend = plateauFactor * plateauFactor;
    elevation = elevation * (1 - blend) + quantized * blend;
  }

  // --- 2d. VALLEY DEPTH ---
  if (elevation > seaLevel && elevation < (seaLevel + mountainThreshold) * 0.5) {
    const range = (seaLevel + mountainThreshold) * 0.5 - seaLevel;
    if (range > 0) {
      const t = (elevation - seaLevel) / range;
      const shaped = Math.pow(t, 0.5 + valleyDepth);
      elevation = seaLevel + shaped * range;
    }
  }

  // --- 3. MOISTURE (elevation-aware) ---
  const moistureNoise = fbm(sx * TERRAIN.MOISTURE_SCALE, sy * TERRAIN.MOISTURE_SCALE, seed + 600, 3);

  // Coastal proximity: 1 at sea level, 0 at mountain threshold
  const elevRange = mountainThreshold - seaLevel;
  const coastalProximity = elevRange > 0
    ? Math.max(0, Math.min(1, 1 - (elevation - seaLevel) / elevRange))
    : 0;

  const moisture = Math.max(0, Math.min(1,
    moistureNoise * TERRAIN.MOISTURE_NOISE_WEIGHT
    + coastalProximity * TERRAIN.COASTAL_WEIGHT
    + vegetationLevel * TERRAIN.VEG_BIAS_WEIGHT
  ));

  // --- 4. RIVERS (domain-warped valley detection) ---
  const rwx = sx * TERRAIN.RIVER_SCALE;
  const rwy = sy * TERRAIN.RIVER_SCALE;
  const warpX = fbm(rwx * 0.5, rwy * 0.5, seed + 800, 2) * TERRAIN.RIVER_WARP_AMOUNT;
  const warpY = fbm(rwx * 0.5 + 5.0, rwy * 0.5 + 5.0, seed + 800, 2) * TERRAIN.RIVER_WARP_AMOUNT;
  const riverNoise = fbm(rwx + warpX, rwy + warpY, seed + 700, 2);
  const riverValley = Math.abs(riverNoise - 0.5) * 2;
  const isRiver = !forceNoRiver
    && riverValley < riverDensity * TERRAIN.RIVER_SENSITIVITY
    && elevation > seaLevel + TERRAIN.RIVER_MIN_ELEV
    && elevation < mountainThreshold - TERRAIN.RIVER_HIGH_ELEV;

  // --- 5. BIOME SELECTION (elevation × moisture) with temperature shift ---
  const tempShift = temperature - 0.5;
  const desertThreshold = TERRAIN.MOISTURE_DESERT + tempShift * 0.3;
  const forestThreshold = TERRAIN.MOISTURE_FOREST + tempShift * 0.2;
  const marshThreshold = TERRAIN.MOISTURE_MARSH - tempShift * 0.2;

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
    flavor = moisture > forestThreshold ? 'Wooded Hills' : 'Rocky Bluffs';
  } else {
    if (moisture < desertThreshold) {
      terrain = TerrainType.DESERT;
      flavor = moisture < desertThreshold * 0.5 ? 'Barren Waste' : 'Arid Scrubland';
    } else if (moisture > marshThreshold) {
      terrain = TerrainType.MARSH;
      flavor = moisture > (1 + marshThreshold) * 0.5 ? 'Deep Swamp' : 'Wetland';
    } else if (moisture > forestThreshold) {
      terrain = TerrainType.FOREST;
      flavor = moisture > (forestThreshold + marshThreshold) * 0.5 ? 'Dense Forest' : 'Light Woodland';
    } else {
      terrain = TerrainType.PLAIN;
      flavor = moisture > (desertThreshold + forestThreshold) * 0.5 ? 'Grassland' : 'Dry Plains';
    }
  }

  return { terrain, elevation, moisture, flavor };
};
