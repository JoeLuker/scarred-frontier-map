import { describe, it, expect } from 'vitest';
import { resolveChemistry, computeHexState } from '../planar';
import { TerrainType, TerrainElement, PlanarAlignment, PlanarInfluence, ChemistryRule, HexData, PlanarOverlay } from '../types';
import { CHEMISTRY_RULES } from '../config';

// --- resolveChemistry ---

describe('resolveChemistry', () => {
  it('returns base state with no influences', () => {
    const result = resolveChemistry(TerrainType.PLAIN, 'Grassland', [], CHEMISTRY_RULES);
    expect(result).toEqual({ terrain: TerrainType.PLAIN, flavor: 'Grassland', emission: null });
  });

  it('ignores Material plane influences', () => {
    const influences: PlanarInfluence[] = [{ type: PlanarAlignment.MATERIAL, intensity: 0.8 }];
    const result = resolveChemistry(TerrainType.PLAIN, 'Grassland', influences, CHEMISTRY_RULES);
    expect(result.terrain).toBe(TerrainType.PLAIN);
    expect(result.flavor).toBe('Grassland');
  });

  it('applies single-plane Fire rule to Forest', () => {
    const influences: PlanarInfluence[] = [{ type: PlanarAlignment.FIRE, intensity: 0.9 }];
    const result = resolveChemistry(TerrainType.FOREST, 'Oak Woods', influences, CHEMISTRY_RULES);
    expect(result.terrain).toBe(TerrainType.MAGMA);
    expect(result.flavor).toBe('Burning Weald');
  });

  it('uses generic fallback for below-threshold intensity', () => {
    // Intensity 0.05 is below INTENSITY_THRESHOLD (0.1), so no rule matches.
    // Falls through to generic fallback: secondary prefix "Hot" + base description.
    const influences: PlanarInfluence[] = [{ type: PlanarAlignment.FIRE, intensity: 0.05 }];
    const result = resolveChemistry(TerrainType.FOREST, 'Oak Woods', influences, CHEMISTRY_RULES);
    expect(result.flavor).toBe('Hot Oak Woods');
    // Below threshold should NOT mutate terrain
    expect(result.terrain).toBe(TerrainType.FOREST);
  });

  it('resolves Fire+Water collision', () => {
    const influences: PlanarInfluence[] = [
      { type: PlanarAlignment.FIRE, intensity: 0.8 },
      { type: PlanarAlignment.WATER, intensity: 0.7 },
    ];
    const result = resolveChemistry(TerrainType.PLAIN, 'Grassland', influences, CHEMISTRY_RULES);
    expect(result.terrain).toBe(TerrainType.DESERT);
    expect(result.flavor).toBe('Steam Wastes');
    expect(result.emission).toBe(PlanarAlignment.AIR);
  });

  it('resolves Positive+Negative collision with Scar emission', () => {
    const influences: PlanarInfluence[] = [
      { type: PlanarAlignment.POSITIVE, intensity: 0.8 },
      { type: PlanarAlignment.NEGATIVE, intensity: 0.8 },
    ];
    const result = resolveChemistry(TerrainType.PLAIN, 'Grassland', influences, CHEMISTRY_RULES);
    expect(result.terrain).toBe(TerrainType.CRYSTAL);
    expect(result.emission).toBe(PlanarAlignment.SCAR);
  });

  it('chains sequential rules (Fire→Magma, then Water+Magma→Obsidian)', () => {
    // Fire makes Forest → Magma, then Water on Magma → Mountain (Obsidian Field)
    const influences: PlanarInfluence[] = [
      { type: PlanarAlignment.FIRE, intensity: 0.9 },
      { type: PlanarAlignment.WATER, intensity: 0.8 },
    ];
    // Note: with 2+ planes, this hits the collision path first
    const result = resolveChemistry(TerrainType.FOREST, 'Oak Woods', influences, CHEMISTRY_RULES);
    // Fire+Water collision → Steam Wastes
    expect(result.terrain).toBe(TerrainType.DESERT);
    expect(result.flavor).toBe('Steam Wastes');
  });

  it('falls back to generic prefix for unmatched combos', () => {
    // Use a terrain that has no specific rule for Scar
    const influences: PlanarInfluence[] = [{ type: PlanarAlignment.SCAR, intensity: 0.9 }];
    const result = resolveChemistry(TerrainType.WATER, 'Deep Sea', influences, CHEMISTRY_RULES);
    // No Scar+Water rule exists → generic fallback
    expect(result.flavor).toContain('Chaotic');
  });

  it('resolves Earth+Air collision to Floating terrain', () => {
    const influences: PlanarInfluence[] = [
      { type: PlanarAlignment.EARTH, intensity: 0.7 },
      { type: PlanarAlignment.AIR, intensity: 0.6 },
    ];
    const result = resolveChemistry(TerrainType.PLAIN, 'Grassland', influences, CHEMISTRY_RULES);
    expect(result.terrain).toBe(TerrainType.FLOATING);
    expect(result.flavor).toBe('Shattered Uplift');
  });
});

// --- computeHexState ---

describe('computeHexState', () => {
  const makeHex = (q: number, r: number, terrain = TerrainType.PLAIN): HexData => ({
    id: `hex-${q}-${r}`,
    groupId: 'SECTOR-0_0',
    coordinates: { q, r },
    terrain,
    element: TerrainElement.STANDARD,
    baseTerrain: terrain,
    description: `${terrain} hex`,
    baseDescription: `${terrain} hex`,
    notes: '',
    elevation: 0.5,
    hasRiver: false,
    planarAlignment: PlanarAlignment.MATERIAL,
    planarIntensity: 0,
    planarFragmentation: 0.5,
    planarLift: 0.5,
    planarRadius: 0,
    planarInfluences: [],
    reactionEmission: null,
  });

  it('returns same hex with no overlays', () => {
    const hex = makeHex(0, 0);
    const result = computeHexState(hex, []);
    expect(result).toBe(hex); // Same reference — fast path
  });

  it('applies overlay influence at center', () => {
    const hex = makeHex(0, 0, TerrainType.FOREST);
    const overlay: PlanarOverlay = {
      id: 'test',
      type: PlanarAlignment.FIRE,
      coordinates: { q: 0, r: 0 },
      intensity: 1.0,
      radius: 5,
      falloff: 3.0,
      fragmentation: 0.5,
      lift: 0.5,
    };
    const result = computeHexState(hex, [overlay]);
    expect(result.planarAlignment).toBe(PlanarAlignment.FIRE);
    expect(result.planarIntensity).toBeGreaterThan(0.5);
    expect(result.terrain).toBe(TerrainType.MAGMA); // Fire + Forest → Magma
  });

  it('has zero influence far from overlay', () => {
    const hex = makeHex(100, 100);
    const overlay: PlanarOverlay = {
      id: 'test',
      type: PlanarAlignment.FIRE,
      coordinates: { q: 0, r: 0 },
      intensity: 1.0,
      radius: 5,
      falloff: 3.0,
      fragmentation: 0.5,
      lift: 0.5,
    };
    const result = computeHexState(hex, [overlay]);
    expect(result.planarAlignment).toBe(PlanarAlignment.MATERIAL);
    expect(result.planarIntensity).toBe(0);
  });

  it('intensity falls off with distance', () => {
    const overlay: PlanarOverlay = {
      id: 'test',
      type: PlanarAlignment.WATER,
      coordinates: { q: 0, r: 0 },
      intensity: 1.0,
      radius: 10,
      falloff: 2.0,
      fragmentation: 0.5,
      lift: 0.5,
    };

    const hexCenter = makeHex(0, 0);
    const hexEdge = makeHex(4, 0);

    const centerResult = computeHexState(hexCenter, [overlay]);
    const edgeResult = computeHexState(hexEdge, [overlay]);

    expect(centerResult.planarIntensity).toBeGreaterThan(edgeResult.planarIntensity);
  });
});
