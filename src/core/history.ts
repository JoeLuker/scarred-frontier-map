import { WorldState, HistoryAction, HexData } from './types';
import { DEFAULT_WORLD_CONFIG } from './config';
import { applyOverlaysToMap } from './planar';

export const EMPTY_STATE: WorldState = {
  hexes: [],
  overlays: [],
  config: DEFAULT_WORLD_CONFIG,
};

export function applyAction(state: WorldState, action: HistoryAction): WorldState {
  switch (action.type) {
    case 'generateWorld':
    case 'worldConfig':
      throw new Error(`${action.type} requires async dispatch through WorldEngine`);
    case 'updateHex': {
      const hexes = state.hexes.map(h =>
        h.id === action.hexId ? { ...h, ...action.changes } as HexData : h,
      );
      return { hexes, overlays: state.overlays, config: state.config };
    }
    case 'addOverlay': {
      const overlays = [...state.overlays, action.overlay];
      const hexes = applyOverlaysToMap(state.hexes, overlays);
      return { hexes, overlays, config: state.config };
    }
    case 'removeOverlay': {
      const overlays = state.overlays.filter(o => o.id !== action.overlayId);
      const hexes = applyOverlaysToMap(state.hexes, overlays);
      return { hexes, overlays, config: state.config };
    }
    case 'modifyOverlay': {
      const overlays = state.overlays.map(o =>
        o.id === action.overlay.id ? action.overlay : o,
      );
      const hexes = applyOverlaysToMap(state.hexes, overlays);
      return { hexes, overlays, config: state.config };
    }
    case 'importMap': {
      return { hexes: action.hexes, overlays: [], config: state.config };
    }
  }
}

export function replayFrom(
  baseState: WorldState,
  actions: readonly HistoryAction[],
  startIndex: number,
): WorldState[] {
  const cache: WorldState[] = [];
  let state = baseState;
  for (let i = startIndex; i < actions.length; i++) {
    const action = actions[i];
    if (!action) break;
    state = applyAction(state, action);
    cache.push(state);
  }
  return cache;
}

export function getActionLabel(action: HistoryAction): string {
  switch (action.type) {
    case 'generateWorld': return `Generate World (seed ${action.config.seed})`;
    case 'worldConfig': return `Terrain Config (seed ${action.config.seed})`;
    case 'updateHex': return `Edit ${action.hexId.replace('HEX-', '')}`;
    case 'addOverlay': return `Add ${action.overlay.type.replace('Plane of ', '')} Plane`;
    case 'removeOverlay': return 'Remove Overlay';
    case 'modifyOverlay': return 'Move/Resize Overlay';
    case 'importMap': return `Import Map (${action.hexes.length} hexes)`;
  }
}
