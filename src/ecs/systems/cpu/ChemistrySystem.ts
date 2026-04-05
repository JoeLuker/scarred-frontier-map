import { PlanarAlignment, TerrainType } from '../../../core/types';
import { CHEMISTRY_RULES, type ChemistryRule } from '../../../core/constants';
import { getHexDistance } from '../../../core/geometry';
import { hashNorm } from '../../../core/noise';
import { HexStore } from '../../components/HexStore';
import { OverlayStore } from '../../components/OverlayStore';

const EDGE_VARIATION = 3.0;
const EDGE_OFFSET = -1.5;
const INTENSITY_EPSILON = 0.1;
const INTENSITY_THRESHOLD = 0.1;
const EDGE_SEED = 12345;

interface PlanarInfluence {
  readonly type: PlanarAlignment;
  readonly intensity: number;
}

/**
 * Resolve planar chemistry for a hex given its base terrain, active influences, and the rule table.
 * Port of v1 resolveChemistry operating on numeric enums.
 */
export function resolveChemistry(
  baseTerrain: TerrainType,
  influences: readonly PlanarInfluence[],
  rules: readonly ChemistryRule[],
): {
  terrain: TerrainType;
  emission: PlanarAlignment | null;
} {
  if (influences.length === 0) {
    return { terrain: baseTerrain, emission: null };
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
    return { terrain: baseTerrain, emission: null };
  }

  const activePlanes = new Set(planeIntensities.keys());

  // Phase 1: Collision check (2+ distinct planes)
  if (activePlanes.size >= 2) {
    let bestRule: ChemistryRule | undefined;
    let bestScore = -1;

    for (const rule of rules) {
      if (rule.planes.length < 2) continue;
      if (!rule.planes.every(p => activePlanes.has(p))) continue;
      if (rule.terrain !== undefined && rule.terrain !== baseTerrain) continue;

      const maxPlaneIntensity = Math.max(...rule.planes.map(p => planeIntensities.get(p) ?? 0));
      const minInt = rule.minIntensity ?? INTENSITY_THRESHOLD;
      if (maxPlaneIntensity < minInt) continue;

      const score = rule.planes.length + (rule.terrain !== undefined ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestRule = rule;
      }
    }

    if (bestRule) {
      let maxInt = 0;
      for (const p of bestRule.planes) {
        const pi = planeIntensities.get(p) ?? 0;
        if (pi > maxInt) maxInt = pi;
      }
      const isPrimary = maxInt > INTENSITY_THRESHOLD;
      return {
        terrain: (isPrimary && bestRule.outputTerrain !== undefined) ? bestRule.outputTerrain : baseTerrain,
        emission: bestRule.emit ?? null,
      };
    }
  }

  // Phase 2: Sequential chain (single-plane rules by intensity, descending)
  const sorted = [...planeIntensities.entries()].sort((a, b) => b[1] - a[1]);

  let currentTerrain = baseTerrain;
  let resultEmission: PlanarAlignment | null = null;
  let anyRuleMatched = false;

  for (const [plane, intensity] of sorted) {
    const isPrimary = intensity > INTENSITY_THRESHOLD;

    let specificRule: ChemistryRule | undefined;
    let genericRule: ChemistryRule | undefined;

    for (const rule of rules) {
      if (rule.planes.length !== 1 || rule.planes[0] !== plane) continue;
      const ruleMinInt = rule.minIntensity ?? INTENSITY_THRESHOLD;
      if (intensity < ruleMinInt) continue;

      if (rule.terrain === currentTerrain) {
        specificRule = rule;
        break;
      }
      if (rule.terrain === undefined && !genericRule) {
        genericRule = rule;
      }
    }

    const matched = specificRule ?? genericRule;
    if (matched) {
      anyRuleMatched = true;
      currentTerrain = (isPrimary && matched.outputTerrain !== undefined) ? matched.outputTerrain : currentTerrain;
      resultEmission = matched.emit ?? resultEmission;
    }
  }

  if (anyRuleMatched) {
    return { terrain: currentTerrain, emission: resultEmission };
  }

  // Phase 3: No rule matched — return base terrain
  return { terrain: baseTerrain, emission: null };
}

/**
 * Evaluates planar overlays and applies chemistry rules to hex state.
 * Port of v1 computeHexState operating on SoA arrays.
 */
export class ChemistrySystem {
  readonly name = 'ChemistrySystem';

  execute(hexes: HexStore, overlays: OverlayStore): void {
    const maxNoiseExpand = EDGE_VARIATION + Math.abs(EDGE_OFFSET);

    // Collect active overlay data into local arrays for tight inner loop
    const activeSlots: number[] = [];
    for (const slot of overlays.activeSlots()) {
      activeSlots.push(slot);
    }

    if (activeSlots.length === 0) {
      // No overlays — reset all hexes to material
      hexes.planarAlignment.fill(PlanarAlignment.MATERIAL);
      hexes.planarIntensity.fill(0);
      hexes.planarFragmentation.fill(0.5);
      hexes.planarLift.fill(0.5);
      hexes.planarRadius.fill(0);
      return;
    }

    for (let i = 0; i < hexes.hexCount; i++) {
      const hq = hexes.coordQ[i]!;
      const hr = hexes.coordR[i]!;

      const influences: PlanarInfluence[] = [];
      let maxIntensity = 0;
      let dominantPlane = PlanarAlignment.MATERIAL;
      let dominantFragmentation = 0.5;
      let dominantLift = 0.5;
      let dominantRadius = 0;

      for (const slot of activeSlots) {
        const oq = overlays.coordQ[slot]!;
        const or = overlays.coordR[slot]!;
        const dist = getHexDistance({ q: hq, r: hr }, { q: oq, r: or });
        const overlayRadius = overlays.radius[slot]!;

        // Quick distance check
        if (dist > overlayRadius + maxNoiseExpand) continue;

        // Organic edge: noise-based radius variation
        const noiseVal = hashNorm(hq, hr, EDGE_SEED);
        const noiseOffset = noiseVal * EDGE_VARIATION + EDGE_OFFSET;
        const effectiveRadius = overlayRadius + noiseOffset;

        if (dist > effectiveRadius) continue;

        const normalizedDist = dist / (effectiveRadius + INTENSITY_EPSILON);
        const overlayFalloff = overlays.falloff[slot]!;
        const overlayIntensity = overlays.intensity[slot]!;
        const rawIntensity = Math.max(0, 1.0 - Math.pow(normalizedDist, overlayFalloff));
        const intensity = rawIntensity * overlayIntensity;

        if (intensity > 0) {
          const planeType = overlays.type[slot]! as PlanarAlignment;
          influences.push({ type: planeType, intensity });

          if (intensity > maxIntensity) {
            maxIntensity = intensity;
            dominantPlane = planeType;
            dominantFragmentation = overlays.fragmentation[slot]!;
            dominantLift = overlays.lift[slot]!;
            dominantRadius = overlayRadius;
          }
        }
      }

      if (influences.length === 0) {
        hexes.planarAlignment[i] = PlanarAlignment.MATERIAL;
        hexes.planarIntensity[i] = 0;
        hexes.planarFragmentation[i] = 0.5;
        hexes.planarLift[i] = 0.5;
        hexes.planarRadius[i] = 0;
        continue;
      }

      const baseTerrain = hexes.terrainType[i]! as TerrainType;
      const { terrain } = resolveChemistry(baseTerrain, influences, CHEMISTRY_RULES);

      hexes.terrainType[i] = terrain;
      hexes.planarAlignment[i] = dominantPlane;
      hexes.planarIntensity[i] = maxIntensity;
      hexes.planarFragmentation[i] = dominantFragmentation;
      hexes.planarLift[i] = dominantLift;
      hexes.planarRadius[i] = dominantRadius;
    }
  }
}
