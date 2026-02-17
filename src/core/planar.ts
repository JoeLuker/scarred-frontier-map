import { PlanarAlignment, TerrainType, ChemistryRule, HexData, PlanarOverlay, PlanarInfluence } from './types';
import { CHEMISTRY_RULES, NOISE } from './config';
import { getHexDistance } from './geometry';
import { hashNorm } from './noise';

// --- Generic fallback (no explicit rule matched) ---

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

// --- Chemistry Resolution Engine ---

export interface ChemistryResult {
  readonly terrain: TerrainType;
  readonly flavor: string;
  readonly emission: PlanarAlignment | null;
}

/**
 * Resolve planar chemistry for a hex given its base terrain, active influences, and the rule table.
 *
 * Phase 1: Collision — if 2+ distinct planes present, find best multi-plane collision rule.
 * Phase 2: Sequential chain — evaluate single-plane rules by intensity (descending),
 *          chaining through mutated terrain states (Fire→Magma, then Water+Magma→Obsidian).
 * Phase 3: Generic fallback — prefix-based flavor for unmatched combos.
 */
export const resolveChemistry = (
  baseTerrain: TerrainType,
  baseDescription: string,
  influences: readonly PlanarInfluence[],
  rules: readonly ChemistryRule[],
): ChemistryResult => {
  if (influences.length === 0) {
    return { terrain: baseTerrain, flavor: baseDescription, emission: null };
  }

  // Build active plane set (excluding Material) with max intensity per plane
  const planeIntensities = new Map<PlanarAlignment, number>();
  for (const inf of influences) {
    if (inf.type === PlanarAlignment.MATERIAL) continue;
    const existing = planeIntensities.get(inf.type);
    if (existing === undefined || inf.intensity > existing) {
      planeIntensities.set(inf.type, inf.intensity);
    }
  }

  if (planeIntensities.size === 0) {
    return { terrain: baseTerrain, flavor: baseDescription, emission: null };
  }

  const activePlanes = new Set(planeIntensities.keys());

  // --- Phase 1: Collision check (2+ distinct planes) ---
  if (activePlanes.size >= 2) {
    let bestRule: ChemistryRule | undefined;
    let bestScore = -1;

    for (const rule of rules) {
      if (rule.planes.length < 2) continue;

      // All required planes must be in active set
      let allPresent = true;
      for (const p of rule.planes) {
        if (!activePlanes.has(p)) { allPresent = false; break; }
      }
      if (!allPresent) continue;

      // Check terrain constraint (if specified)
      if (rule.terrain !== undefined && rule.terrain !== baseTerrain) continue;

      // Check min intensity on strongest required plane
      const minInt = rule.minIntensity ?? NOISE.INTENSITY_THRESHOLD;
      let maxPlaneIntensity = 0;
      for (const p of rule.planes) {
        const pi = planeIntensities.get(p) ?? 0;
        if (pi > maxPlaneIntensity) maxPlaneIntensity = pi;
      }
      if (maxPlaneIntensity < minInt) continue;

      // Score: more planes = more specific; terrain constraint adds 1
      const score = rule.planes.length + (rule.terrain !== undefined ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestRule = rule;
      }
    }

    if (bestRule) {
      // Use max intensity across all matched planes for primary/secondary decision
      let maxInt = 0;
      for (const p of bestRule.planes) {
        const pi = planeIntensities.get(p) ?? 0;
        if (pi > maxInt) maxInt = pi;
      }
      const isPrimary = maxInt > NOISE.INTENSITY_THRESHOLD;
      return {
        terrain: (isPrimary && bestRule.outputTerrain) ? bestRule.outputTerrain : baseTerrain,
        flavor: isPrimary ? bestRule.flavorPrimary : bestRule.flavorSecondary,
        emission: bestRule.emit ?? null,
      };
    }
  }

  // --- Phase 2: Sequential chain (single-plane rules by intensity, descending) ---
  // Sort influences strongest-first
  const sorted = [...planeIntensities.entries()].sort((a, b) => b[1] - a[1]);

  let currentTerrain = baseTerrain;
  let resultFlavor = baseDescription;
  let resultEmission: PlanarAlignment | null = null;
  let anyRuleMatched = false;

  for (const [plane, intensity] of sorted) {
    const minInt = NOISE.INTENSITY_THRESHOLD;
    const isPrimary = intensity > minInt;

    // Find best matching rule for this plane + currentTerrain
    // Prefer terrain-specific over generic (terrain === undefined)
    let specificRule: ChemistryRule | undefined;
    let genericRule: ChemistryRule | undefined;

    for (const rule of rules) {
      if (rule.planes.length !== 1 || rule.planes[0] !== plane) continue;

      const ruleMinInt = rule.minIntensity ?? minInt;
      if (intensity < ruleMinInt) continue;

      if (rule.terrain === currentTerrain) {
        specificRule = rule;
        break; // Exact terrain match — can't do better
      }
      if (rule.terrain === undefined && !genericRule) {
        genericRule = rule;
      }
    }

    const matched = specificRule ?? genericRule;
    if (matched) {
      anyRuleMatched = true;
      currentTerrain = (isPrimary && matched.outputTerrain) ? matched.outputTerrain : currentTerrain;
      resultFlavor = isPrimary ? matched.flavorPrimary : matched.flavorSecondary;
      resultEmission = matched.emit ?? resultEmission;
    }
  }

  if (anyRuleMatched) {
    return { terrain: currentTerrain, flavor: resultFlavor, emission: resultEmission };
  }

  // --- Phase 3: Generic fallback ---
  const [strongestPlane, strongestIntensity] = sorted[0]!;
  const isPrimary = strongestIntensity > NOISE.INTENSITY_THRESHOLD;
  const prefix = getGenericFlavorPrefix(strongestPlane, isPrimary);
  return {
    terrain: baseTerrain,
    flavor: `${prefix} ${baseDescription}`,
    emission: null,
  };
};

// --- Hex State Computation ---

/**
 * Calculates the mutated state for a single hex based on active overlays.
 */
export const computeHexState = (hex: HexData, overlays: readonly PlanarOverlay[]): HexData => {
  const baseState = {
    terrain: hex.baseTerrain,
    description: hex.baseDescription,
    planarAlignment: PlanarAlignment.MATERIAL as PlanarAlignment,
    planarIntensity: 0,
    planarInfluences: [] as PlanarInfluence[],
    reactionEmission: null as PlanarAlignment | null,
  };

  if (overlays.length === 0) {
    if (hex.planarAlignment === PlanarAlignment.MATERIAL && hex.reactionEmission === null) return hex;
    return { ...hex, ...baseState };
  }

  // Quick distance pre-check: skip full computation for hexes far from all overlays.
  // EDGE_VARIATION + |EDGE_OFFSET| is the worst-case noise expansion of the radius.
  const maxNoiseExpand = NOISE.EDGE_VARIATION + Math.abs(NOISE.EDGE_OFFSET);
  let anyClose = false;
  for (const overlay of overlays) {
    if (getHexDistance(hex.coordinates, overlay.coordinates) <= overlay.radius + maxNoiseExpand) {
      anyClose = true;
      break;
    }
  }

  if (!anyClose) {
    if (hex.planarAlignment === PlanarAlignment.MATERIAL
      && hex.planarInfluences.length === 0
      && hex.reactionEmission === null) {
      return hex;
    }
    return { ...hex, ...baseState };
  }

  const influences: PlanarInfluence[] = [];
  let maxIntensity = 0;
  let dominantPlane = PlanarAlignment.MATERIAL;

  for (const overlay of overlays) {
    const dist = getHexDistance(hex.coordinates, overlay.coordinates);

    // Organic edge: noise-based radius variation
    const noiseVal = hashNorm(hex.coordinates.q, hex.coordinates.r, NOISE.EDGE_SEED);
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

  // No overlay actually affected this hex (noise pushed edges inward)
  if (influences.length === 0) {
    if (hex.planarAlignment === PlanarAlignment.MATERIAL
      && hex.planarInfluences.length === 0
      && hex.reactionEmission === null) {
      return hex;
    }
    return { ...hex, ...baseState };
  }

  const { terrain, flavor, emission } = resolveChemistry(
    hex.baseTerrain,
    hex.baseDescription,
    influences,
    CHEMISTRY_RULES,
  );

  return {
    ...hex,
    terrain,
    description: flavor,
    planarAlignment: dominantPlane,
    planarIntensity: maxIntensity,
    planarInfluences: influences,
    reactionEmission: emission,
  };
};

export const applyOverlaysToMap = (hexes: readonly HexData[], overlays: readonly PlanarOverlay[]): HexData[] => {
  return hexes.map(hex => computeHexState(hex, overlays));
};
