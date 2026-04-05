import { describe, it, expect } from 'vitest';
import { classifyTerrain } from '../HexSampleSystem';
import { TerrainType } from '../../../../core/types';

describe('classifyTerrain', () => {
  const seaLevel = 0.3;
  const mountainThreshold = 0.8;

  it('returns WATER when waterHeight exceeds threshold', () => {
    expect(classifyTerrain(0.5, 0.5, 0.1, seaLevel, mountainThreshold)).toBe(TerrainType.WATER);
  });

  it('returns WATER when elevation is below sea level', () => {
    expect(classifyTerrain(0.2, 0.5, 0, seaLevel, mountainThreshold)).toBe(TerrainType.WATER);
  });

  it('returns MOUNTAIN when elevation exceeds mountainThreshold', () => {
    expect(classifyTerrain(0.9, 0.5, 0, seaLevel, mountainThreshold)).toBe(TerrainType.MOUNTAIN);
  });

  it('returns HILL when elevation is in hill range', () => {
    // mountainThreshold - 0.15 = 0.65, so 0.7 is in hill range
    expect(classifyTerrain(0.7, 0.5, 0, seaLevel, mountainThreshold)).toBe(TerrainType.HILL);
  });

  it('returns MARSH when moisture > 0.7', () => {
    expect(classifyTerrain(0.5, 0.75, 0, seaLevel, mountainThreshold)).toBe(TerrainType.MARSH);
  });

  it('returns FOREST when moisture > 0.5', () => {
    expect(classifyTerrain(0.5, 0.6, 0, seaLevel, mountainThreshold)).toBe(TerrainType.FOREST);
  });

  it('returns DESERT when moisture < 0.3', () => {
    expect(classifyTerrain(0.5, 0.2, 0, seaLevel, mountainThreshold)).toBe(TerrainType.DESERT);
  });

  it('returns PLAIN for moderate values', () => {
    expect(classifyTerrain(0.5, 0.4, 0, seaLevel, mountainThreshold)).toBe(TerrainType.PLAIN);
  });

  it('water check takes priority over mountain', () => {
    expect(classifyTerrain(0.9, 0.5, 0.1, seaLevel, mountainThreshold)).toBe(TerrainType.WATER);
  });

  it('elevation below sea level takes priority over moisture', () => {
    expect(classifyTerrain(0.1, 0.8, 0, seaLevel, mountainThreshold)).toBe(TerrainType.WATER);
  });

  it('mountain takes priority over moisture classification', () => {
    expect(classifyTerrain(0.85, 0.8, 0, seaLevel, mountainThreshold)).toBe(TerrainType.MOUNTAIN);
  });
});
