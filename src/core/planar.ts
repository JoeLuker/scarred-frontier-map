import { PlanarAlignment, TerrainType, HexData, PlanarOverlay, PlanarInfluence } from './types';
import { PLANAR_MUTATIONS, NOISE } from './config';
import { getHexDistance } from './geometry';
import { hash } from './noise';

const getGenericFlavorPrefix = (plane: PlanarAlignment, isPrimary: boolean): string => {
  switch (plane) {
    case PlanarAlignment.FIRE: return isPrimary ? 'Infernal' : 'Hot';
    case PlanarAlignment.WATER: return isPrimary ? 'Submerged' : 'Drenched';
    case PlanarAlignment.EARTH: return isPrimary ? 'Geo-Crystalline' : 'Dusty';
    case PlanarAlignment.AIR: return isPrimary ? 'Tempestuous' : 'Breezy';
    case PlanarAlignment.POSITIVE: return isPrimary ? 'Radiant' : 'Vibrant';
    case PlanarAlignment.NEGATIVE: return isPrimary ? 'Necrotic' : 'Shadow-Touched';
    case PlanarAlignment.SCAR: return isPrimary ? 'Chaotic' : 'Warped';
    default: return 'Magical';
  }
};

export const mutateTerrainByPlane = (
  baseTerrain: TerrainType,
  baseFlavor: string,
  plane: PlanarAlignment,
  intensity: number,
): { terrain: TerrainType; flavor: string } => {
  if (plane === PlanarAlignment.MATERIAL || intensity <= 0) {
    return { terrain: baseTerrain, flavor: baseFlavor };
  }

  const isPrimary = intensity > NOISE.INTENSITY_THRESHOLD;

  const planeRules = PLANAR_MUTATIONS[plane];
  if (planeRules) {
    const mutation = planeRules[baseTerrain];
    if (mutation) {
      const newTerrain = isPrimary && mutation.targetTerrain ? mutation.targetTerrain : baseTerrain;
      return {
        terrain: newTerrain,
        flavor: isPrimary ? mutation.flavorPrimary : mutation.flavorSecondary,
      };
    }
  }

  const prefix = getGenericFlavorPrefix(plane, isPrimary);
  return {
    terrain: baseTerrain,
    flavor: `${prefix} ${baseFlavor}`,
  };
};

/**
 * Calculates the mutated state for a single hex based on active overlays.
 */
export const computeHexState = (hex: HexData, overlays: readonly PlanarOverlay[]): HexData => {
  if (overlays.length === 0) {
    if (hex.planarAlignment === PlanarAlignment.MATERIAL) return hex;

    return {
      ...hex,
      terrain: hex.baseTerrain,
      description: hex.baseDescription,
      planarAlignment: PlanarAlignment.MATERIAL,
      planarIntensity: 0,
      planarInfluences: [],
    };
  }

  const influences: PlanarInfluence[] = [];
  let maxIntensity = 0;
  let dominantPlane = PlanarAlignment.MATERIAL;

  for (const overlay of overlays) {
    const dist = getHexDistance(hex.coordinates, overlay.coordinates);

    // Organic edge: noise-based radius variation
    const noiseVal = hash(hex.coordinates.q, hex.coordinates.r, NOISE.EDGE_SEED) / NOISE.HASH_DIVISOR;
    const noiseOffset = noiseVal * NOISE.EDGE_VARIATION + NOISE.EDGE_OFFSET;

    const effectiveRadius = overlay.radius + noiseOffset;

    if (dist <= effectiveRadius) {
      const normalizedDist = dist / (effectiveRadius + NOISE.INTENSITY_EPSILON);
      const intensity = Math.max(0, 1.0 - normalizedDist * normalizedDist * normalizedDist);

      if (intensity > 0) {
        influences.push({ type: overlay.type, intensity });

        if (intensity > maxIntensity) {
          maxIntensity = intensity;
          dominantPlane = overlay.type;
        }
      }
    }
  }

  const { terrain, flavor } = mutateTerrainByPlane(
    hex.baseTerrain,
    hex.baseDescription,
    dominantPlane,
    maxIntensity,
  );

  return {
    ...hex,
    terrain,
    description: flavor,
    planarAlignment: dominantPlane,
    planarIntensity: maxIntensity,
    planarInfluences: influences,
  };
};

export const applyOverlaysToMap = (hexes: readonly HexData[], overlays: readonly PlanarOverlay[]): HexData[] => {
  return hexes.map(hex => computeHexState(hex, overlays));
};
