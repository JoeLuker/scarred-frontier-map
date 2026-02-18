import { useEffect, useRef } from 'react';
import type { HexData, WorldGenConfig, PlanarOverlay, HistoryAction } from '../core/types';
import { DEFAULT_WORLD_CONFIG } from '../core/config';
import type { MapCommand } from './types';

export interface BridgeActions {
  hexes: HexData[];
  planarOverlays: PlanarOverlay[];
  dispatch: (action: HistoryAction) => Promise<void>;
  focusRegion: (groupId: string) => void;
}

function commandToActions(cmd: MapCommand, hexes: HexData[]): HistoryAction[] {
  switch (cmd.command) {
    case 'updateHex':
      return [{ type: 'updateHex', hexId: cmd.hex.id, changes: cmd.hex }];
    case 'importMap':
      return [{ type: 'importMap', hexes: cmd.hexes }];
    case 'generateWorld': {
      const config: WorldGenConfig = { ...DEFAULT_WORLD_CONFIG, ...cmd.config };
      return [{ type: 'worldConfig', config, preserveExplored: cmd.preserveExplored ?? false }];
    }
    case 'revealAll':
      return [{ type: 'revealAll' }];
    case 'addOverlay':
      return [{ type: 'addOverlay', overlay: cmd.overlay }];
    case 'removeOverlay':
      return [{ type: 'removeOverlay', overlayId: cmd.id }];
    case 'modifyOverlay':
      return [{ type: 'modifyOverlay', overlay: cmd.overlay }];
    case 'focusRegion':
      return []; // UI-only, handled separately
    case 'batch': {
      const all: HistoryAction[] = [];
      for (const sub of cmd.commands) {
        all.push(...commandToActions(sub, hexes));
      }
      return all;
    }
  }
}

function reportState(hexes: HexData[], overlays: PlanarOverlay[]): void {
  const explored = hexes.filter((h) => h.isExplored);
  const payload = JSON.stringify({
    hexCount: hexes.length,
    exploredCount: explored.length,
    hexes: explored,
    overlays,
  });

  fetch('/api/bridge/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  }).catch(() => {
    // Silently ignore — server might not be ready yet
  });
}

export function useBridgeReceiver(actions: BridgeActions): void {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const reportTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!import.meta.env.DEV) return;

    const es = new EventSource('/api/bridge/events');

    es.onopen = () => {
      console.log('[MapBridge] Connected to bridge');
      reportState(actionsRef.current.hexes, actionsRef.current.planarOverlays);
    };

    es.onmessage = (event: MessageEvent) => {
      try {
        const cmd = JSON.parse(event.data as string) as MapCommand;
        console.log('[MapBridge] Received:', cmd.command);

        const current = actionsRef.current;

        // Dispatch history actions (async — terrain actions need GPU)
        const historyActions = commandToActions(cmd, current.hexes);
        (async () => {
          for (const action of historyActions) {
            await current.dispatch(action);
          }
        })();

        // Handle UI-only commands
        if (cmd.command === 'focusRegion') {
          current.focusRegion(cmd.groupId);
        } else if (cmd.command === 'batch') {
          for (const sub of cmd.commands) {
            if (sub.command === 'focusRegion') {
              current.focusRegion(sub.groupId);
            }
          }
        }

        // Report state after React processes the update
        clearTimeout(reportTimeoutRef.current);
        reportTimeoutRef.current = setTimeout(() => {
          reportState(actionsRef.current.hexes, actionsRef.current.planarOverlays);
        }, 300);
      } catch (err) {
        console.error('[MapBridge] Failed to parse command:', err);
      }
    };

    es.onerror = () => {
      console.warn('[MapBridge] SSE connection error, will retry...');
    };

    // Periodic state reporting
    const interval = setInterval(() => {
      reportState(actionsRef.current.hexes, actionsRef.current.planarOverlays);
    }, 5000);

    return () => {
      es.close();
      clearInterval(interval);
      clearTimeout(reportTimeoutRef.current);
    };
  }, []);
}
