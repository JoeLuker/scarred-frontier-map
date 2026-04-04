import { describe, it, expect } from 'vitest';
import { getFluidTerrainEffect } from '../propagation-rules';
import { SubstanceType } from '../propagation';
import { TerrainType } from '../types';

// Terrain IDs matching gpu/types.ts TERRAIN_ORDER
const TERRAIN_WATER = 0;
const TERRAIN_DESERT = 1;
const TERRAIN_PLAIN = 2;
const TERRAIN_FOREST = 3;
const TERRAIN_MARSH = 4;
const TERRAIN_MOUNTAIN = 6;
const TERRAIN_MAGMA = 8;

describe('getFluidTerrainEffect', () => {
  describe('water effects', () => {
    it('water > 0.5 on plain -> marsh', () => {
      const result = getFluidTerrainEffect(TERRAIN_PLAIN, 0.6, SubstanceType.WATER);
      expect(result).not.toBeNull();
      expect(result!.terrain).toBe(TerrainType.MARSH);
      expect(result!.description).toBe('Waterlogged Plains');
    });

    it('water <= 0.5 on plain -> no effect', () => {
      expect(getFluidTerrainEffect(TERRAIN_PLAIN, 0.5, SubstanceType.WATER)).toBeNull();
      expect(getFluidTerrainEffect(TERRAIN_PLAIN, 0.3, SubstanceType.WATER)).toBeNull();
    });

    it('water > 0.7 on desert -> water terrain', () => {
      const result = getFluidTerrainEffect(TERRAIN_DESERT, 0.8, SubstanceType.WATER);
      expect(result).not.toBeNull();
      expect(result!.terrain).toBe(TerrainType.WATER);
      expect(result!.description).toBe('Flooded Basin');
    });

    it('water <= 0.7 on desert -> no effect', () => {
      expect(getFluidTerrainEffect(TERRAIN_DESERT, 0.7, SubstanceType.WATER)).toBeNull();
    });

    it('water > 0.3 on forest -> marsh', () => {
      const result = getFluidTerrainEffect(TERRAIN_FOREST, 0.4, SubstanceType.WATER);
      expect(result).not.toBeNull();
      expect(result!.terrain).toBe(TerrainType.MARSH);
      expect(result!.description).toBe('Sodden Woods');
    });

    it('water <= 0.3 on forest -> no effect', () => {
      expect(getFluidTerrainEffect(TERRAIN_FOREST, 0.3, SubstanceType.WATER)).toBeNull();
    });

    it('water on mountain -> no effect', () => {
      expect(getFluidTerrainEffect(TERRAIN_MOUNTAIN, 0.9, SubstanceType.WATER)).toBeNull();
    });
  });

  describe('fire effects', () => {
    it('fire > 0.4 on forest -> desert', () => {
      const result = getFluidTerrainEffect(TERRAIN_FOREST, 0.5, SubstanceType.FIRE);
      expect(result).not.toBeNull();
      expect(result!.terrain).toBe(TerrainType.DESERT);
      expect(result!.description).toBe('Scorched Earth');
    });

    it('fire > 0.4 on marsh -> desert', () => {
      const result = getFluidTerrainEffect(TERRAIN_MARSH, 0.5, SubstanceType.FIRE);
      expect(result).not.toBeNull();
      expect(result!.terrain).toBe(TerrainType.DESERT);
    });

    it('fire <= 0.4 on forest -> no effect', () => {
      expect(getFluidTerrainEffect(TERRAIN_FOREST, 0.4, SubstanceType.FIRE)).toBeNull();
    });

    it('fire on desert -> no effect', () => {
      expect(getFluidTerrainEffect(TERRAIN_DESERT, 0.9, SubstanceType.FIRE)).toBeNull();
    });
  });

  describe('lava effects', () => {
    it('lava > 0.3 on plain -> magma', () => {
      const result = getFluidTerrainEffect(TERRAIN_PLAIN, 0.4, SubstanceType.LAVA);
      expect(result).not.toBeNull();
      expect(result!.terrain).toBe(TerrainType.MAGMA);
      expect(result!.description).toBe('Lava Field');
    });

    it('lava > 0.3 on forest -> magma', () => {
      const result = getFluidTerrainEffect(TERRAIN_FOREST, 0.4, SubstanceType.LAVA);
      expect(result).not.toBeNull();
      expect(result!.terrain).toBe(TerrainType.MAGMA);
    });

    it('lava <= 0.3 -> no effect', () => {
      expect(getFluidTerrainEffect(TERRAIN_PLAIN, 0.3, SubstanceType.LAVA)).toBeNull();
    });

    it('lava on mountain -> no effect', () => {
      expect(getFluidTerrainEffect(TERRAIN_MOUNTAIN, 0.9, SubstanceType.LAVA)).toBeNull();
    });

    it('lava on magma -> no effect', () => {
      expect(getFluidTerrainEffect(TERRAIN_MAGMA, 0.9, SubstanceType.LAVA)).toBeNull();
    });
  });

  describe('no substance', () => {
    it('NONE substance -> no effect', () => {
      expect(getFluidTerrainEffect(TERRAIN_PLAIN, 0.9, SubstanceType.NONE)).toBeNull();
    });
  });
});
