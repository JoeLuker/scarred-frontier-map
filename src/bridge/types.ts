import type { PlanarAlignment, WorldGenConfig } from '../core/types';
import type { OverlayParams } from '../ecs/types';

export type MapCommand =
  | { command: 'generateWorld'; config?: Partial<WorldGenConfig> }
  | { command: 'addOverlay'; type: PlanarAlignment; q: number; r: number; params?: Partial<OverlayParams> }
  | { command: 'removeOverlay'; id: number }
  | { command: 'modifyOverlay'; id: number; changes: Partial<OverlayParams> & { q?: number; r?: number } }
  | { command: 'focusRegion'; groupId: string }
  | { command: 'batch'; commands: MapCommand[] };

export interface BridgeState {
  hexCount: number;
  overlayCount: number;
}
