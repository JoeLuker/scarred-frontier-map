import type { HexData, WorldGenConfig, PlanarOverlay } from '../core/types';

export type MapCommand =
  | { command: 'updateHex'; hex: Partial<HexData> & { id: string } }
  | { command: 'importMap'; hexes: HexData[] }
  | { command: 'generateWorld'; config?: Partial<WorldGenConfig> }
  | { command: 'addOverlay'; overlay: PlanarOverlay }
  | { command: 'removeOverlay'; id: string }
  | { command: 'modifyOverlay'; overlay: PlanarOverlay }
  | { command: 'focusRegion'; groupId: string }
  | { command: 'batch'; commands: MapCommand[] };

export interface BridgeState {
  hexCount: number;
  hexes: HexData[];
  overlays: PlanarOverlay[];
}
