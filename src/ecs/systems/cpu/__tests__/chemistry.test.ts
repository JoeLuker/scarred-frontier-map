import { describe, it, expect } from 'vitest';
import { resolveChemistry } from '../ChemistrySystem';
import { PlanarAlignment, TerrainType } from '../../../../core/types';
import { CHEMISTRY_RULES } from '../../../../core/constants';

describe('resolveChemistry', () => {
  it('returns base terrain with no influences', () => {
    const result = resolveChemistry(TerrainType.PLAIN, [], CHEMISTRY_RULES);
    expect(result.terrain).toBe(TerrainType.PLAIN);
    expect(result.emission).toBeNull();
  });

  it('ignores Material plane influences', () => {
    const result = resolveChemistry(
      TerrainType.PLAIN,
      [{ type: PlanarAlignment.MATERIAL, intensity: 1.0 }],
      CHEMISTRY_RULES,
    );
    expect(result.terrain).toBe(TerrainType.PLAIN);
  });

  it('applies collision rule for Fire + Water', () => {
    const result = resolveChemistry(
      TerrainType.PLAIN,
      [
        { type: PlanarAlignment.FIRE, intensity: 0.8 },
        { type: PlanarAlignment.WATER, intensity: 0.7 },
      ],
      CHEMISTRY_RULES,
    );
    expect(result.terrain).toBe(TerrainType.DESERT);
    expect(result.emission).toBe(PlanarAlignment.AIR);
  });

  it('applies collision rule for Positive + Negative', () => {
    const result = resolveChemistry(
      TerrainType.PLAIN,
      [
        { type: PlanarAlignment.POSITIVE, intensity: 0.5 },
        { type: PlanarAlignment.NEGATIVE, intensity: 0.5 },
      ],
      CHEMISTRY_RULES,
    );
    expect(result.terrain).toBe(TerrainType.CRYSTAL);
    expect(result.emission).toBe(PlanarAlignment.SCAR);
  });

  it('applies single-plane rule: Forest + Fire → Magma', () => {
    const result = resolveChemistry(
      TerrainType.FOREST,
      [{ type: PlanarAlignment.FIRE, intensity: 0.8 }],
      CHEMISTRY_RULES,
    );
    expect(result.terrain).toBe(TerrainType.MAGMA);
  });

  it('chains sequential rules: strongest plane first', () => {
    // Plain + Fire → Desert (via single-plane rule), then Water on Desert → Oasis/Water
    const result = resolveChemistry(
      TerrainType.PLAIN,
      [
        { type: PlanarAlignment.FIRE, intensity: 0.9 },
        { type: PlanarAlignment.WATER, intensity: 0.3 },
      ],
      CHEMISTRY_RULES,
    );
    // Collision rule Fire+Water → Desert takes priority (it's a 2-plane collision)
    expect(result.terrain).toBe(TerrainType.DESERT);
  });

  it('does not apply rule when intensity below threshold', () => {
    const result = resolveChemistry(
      TerrainType.FOREST,
      [{ type: PlanarAlignment.FIRE, intensity: 0.05 }],
      CHEMISTRY_RULES,
    );
    // Intensity 0.05 < INTENSITY_THRESHOLD(0.1), no rule matches
    expect(result.terrain).toBe(TerrainType.FOREST);
  });

  it('applies chain rule: Magma + Water → Mountain (Obsidian Field)', () => {
    const result = resolveChemistry(
      TerrainType.MAGMA,
      [{ type: PlanarAlignment.WATER, intensity: 0.5 }],
      CHEMISTRY_RULES,
    );
    expect(result.terrain).toBe(TerrainType.MOUNTAIN);
  });

  it('applies Earth + Air collision → Floating', () => {
    const result = resolveChemistry(
      TerrainType.PLAIN,
      [
        { type: PlanarAlignment.EARTH, intensity: 0.6 },
        { type: PlanarAlignment.AIR, intensity: 0.5 },
      ],
      CHEMISTRY_RULES,
    );
    expect(result.terrain).toBe(TerrainType.FLOATING);
  });
});
