import { useEffect, type RefObject } from 'react';
import { HexData } from '../../core/types';
import type { HexStateTexture, IslandClassify } from '../../gpu';

export function useHexStateSync(
  hexes: HexData[],
  hexStateRef: RefObject<HexStateTexture | null>,
  hexStateSourceRef: RefObject<HexData[] | null>,
  islandClassifyRef: RefObject<IslandClassify | null>,
) {
  useEffect(() => {
    const hexState = hexStateRef.current;
    if (!hexState) return;
    if (hexStateSourceRef.current === hexes) return;
    hexStateSourceRef.current = hexes;
    hexState.update(hexes);
    islandClassifyRef.current?.classify();
  }, [hexes]);
}
