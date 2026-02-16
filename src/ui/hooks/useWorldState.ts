import { useState, useCallback, useRef, useEffect } from 'react';
import { HexData, WorldGenConfig, PlanarOverlay, PlanarAlignment, HistoryAction, WorldState } from '../../core/types';
import { DEFAULT_WORLD_CONFIG } from '../../core/config';
import { regenerateTerrain } from '../../core/world';
import { applyOverlaysToMap } from '../../core/planar';
import { applyAction, EMPTY_STATE, replayFrom } from '../../core/history';
import { getGpuContext, TerrainCompute, terrainFromId, elementFromId, flavorFromId } from '../../gpu';

const INITIAL_ACTION: HistoryAction = { type: 'generateWorld', config: DEFAULT_WORLD_CONFIG };
const INITIAL_STATE = applyAction(EMPTY_STATE, INITIAL_ACTION);

interface History {
  actions: HistoryAction[];
  cache: WorldState[];       // cache[i] = state after actions[0..i]
  redoStack: HistoryAction[];
}

export const useWorldState = () => {
  // --- History (committed action log + cached states) ---
  const [history, setHistory] = useState<History>({
    actions: [INITIAL_ACTION],
    cache: [INITIAL_STATE],
    redoStack: [],
  });
  const historyRef = useRef(history);
  historyRef.current = history;

  // Live state: what the UI renders. Equals committed state except during preview/drag.
  const [liveState, setLiveState] = useState<WorldState>(INITIAL_STATE);
  const liveStateRef = useRef(liveState);
  liveStateRef.current = liveState;

  // --- UI State ---
  const [selectedHexId, setSelectedHexId] = useState<string | null>(null);
  const [focusedHex, setFocusedHex] = useState<HexData | null>(null);

  // --- Derived ---
  const hexes = liveState.hexes;
  const planarOverlays = liveState.overlays;
  const worldConfig = liveState.config;
  const selectedHex = hexes.find(h => h.id === selectedHexId) ?? null;
  const canUndo = history.actions.length > 1;
  const canRedo = history.redoStack.length > 0;

  // --- Dispatch: commit an action to history ---
  const dispatch = useCallback((action: HistoryAction) => {
    const h = historyRef.current;
    const prevState = h.cache[h.cache.length - 1] ?? EMPTY_STATE;
    const newState = applyAction(prevState, action);

    setHistory({
      actions: [...h.actions, action],
      cache: [...h.cache, newState],
      redoStack: [],
    });
    setLiveState(newState);
  }, []);

  // --- Undo / Redo ---
  const undo = useCallback(() => {
    const h = historyRef.current;
    if (h.actions.length <= 1) return;

    const undone = h.actions[h.actions.length - 1]!;
    const newActions = h.actions.slice(0, -1);
    const newCache = h.cache.slice(0, -1);
    const newState = newCache[newCache.length - 1] ?? EMPTY_STATE;

    setHistory({
      actions: newActions,
      cache: newCache,
      redoStack: [undone, ...h.redoStack],
    });
    setLiveState(newState);
  }, []);

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (h.redoStack.length === 0) return;

    const action = h.redoStack[0]!;
    const prevState = h.cache[h.cache.length - 1] ?? EMPTY_STATE;
    const newState = applyAction(prevState, action);

    setHistory({
      actions: [...h.actions, action],
      cache: [...h.cache, newState],
      redoStack: h.redoStack.slice(1),
    });
    setLiveState(newState);
  }, []);

  // --- Remove a specific action (selective undo) ---
  const removeAction = useCallback((index: number) => {
    const h = historyRef.current;
    if (index <= 0 || index >= h.actions.length) return;

    const newActions = [...h.actions.slice(0, index), ...h.actions.slice(index + 1)];
    const baseState = h.cache[index - 1] ?? EMPTY_STATE;
    const replayedCache = replayFrom(baseState, newActions, index);
    const newCache = [...h.cache.slice(0, index), ...replayedCache];
    const newState = newCache[newCache.length - 1] ?? EMPTY_STATE;

    setHistory({ actions: newActions, cache: newCache, redoStack: [] });
    setLiveState(newState);
  }, []);

  // --- GPU Compute (async init, shared device singleton) ---

  const gpuComputeRef = useRef<TerrainCompute | null>(null);
  const gpuCoordsCountRef = useRef(0); // Track uploaded coord count
  const previewGenRef = useRef(0);     // Race condition guard

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ctx = await getGpuContext();
      if (cancelled || !ctx) return;
      try {
        const compute = TerrainCompute.create(ctx.device, 20000);
        // Upload initial hex coordinates
        const hexes = historyRef.current.cache[historyRef.current.cache.length - 1]?.hexes ?? [];
        if (hexes.length > 0) {
          compute.setCoords(hexes.map(h => h.coordinates));
          gpuCoordsCountRef.current = hexes.length;
        }
        gpuComputeRef.current = compute;
        console.log(`GPU terrain compute initialized (${hexes.length} hexes)`);
      } catch (err) {
        console.warn('GPU compute init failed, using CPU fallback:', err);
      }
    })();
    return () => {
      cancelled = true;
      gpuComputeRef.current?.destroy();
      gpuComputeRef.current = null;
    };
  }, []);

  // --- Live Preview (no history entry) ---

  const previewWorldConfig = useCallback((config: WorldGenConfig, preserveExplored: boolean) => {
    const committed = historyRef.current.cache[historyRef.current.cache.length - 1] ?? EMPTY_STATE;
    const compute = gpuComputeRef.current;

    if (compute && committed.hexes.length > 0) {
      // Ensure coords are uploaded (re-upload if hex count changed)
      if (gpuCoordsCountRef.current !== committed.hexes.length) {
        compute.setCoords(committed.hexes.map(h => h.coordinates));
        gpuCoordsCountRef.current = committed.hexes.length;
      }

      // GPU async path with race condition guard
      const gen = ++previewGenRef.current;
      compute.generate(config, committed.hexes.length).then(results => {
        if (gen !== previewGenRef.current) return; // stale — newer preview superseded this one
        if (results.length === 0) return; // skipped (concurrent generate in flight)

        const newHexes = committed.hexes.map((hex, i) => {
          if (preserveExplored && hex.isExplored) return { ...hex };

          const r = results[i]!;
          const terrain = terrainFromId(r.terrainId);
          const element = elementFromId(r.elementId);
          const flavor = flavorFromId(r.flavorId);
          return {
            ...hex,
            terrain,
            element,
            elevation: r.elevation,
            description: flavor,
            baseDescription: flavor,
            baseTerrain: terrain,
            planarAlignment: PlanarAlignment.MATERIAL,
            planarIntensity: 0,
            planarInfluences: [],
          };
        });
        const withOverlays = applyOverlaysToMap(newHexes, committed.overlays);
        setLiveState({ hexes: withOverlays, overlays: committed.overlays, config });
      });
    } else {
      // CPU sync fallback
      const regenned = regenerateTerrain(committed.hexes, config, preserveExplored);
      const withOverlays = applyOverlaysToMap(regenned, committed.overlays);
      setLiveState({ hexes: withOverlays, overlays: committed.overlays, config });
    }
  }, []);

  const pendingOverlayRef = useRef<PlanarOverlay | null>(null);

  const modifyOverlay = useCallback((updated: PlanarOverlay) => {
    pendingOverlayRef.current = updated;
    setLiveState(prev => {
      const overlays = prev.overlays.map(o => o.id === updated.id ? updated : o);
      const withOverlays = applyOverlaysToMap(prev.hexes, overlays);
      return { ...prev, hexes: withOverlays, overlays };
    });
  }, []);

  const cancelPreview = useCallback(() => {
    const committed = historyRef.current.cache[historyRef.current.cache.length - 1] ?? EMPTY_STATE;
    setLiveState(committed);
  }, []);

  // --- Commit live changes ---

  const commitOverlayModification = useCallback(() => {
    if (pendingOverlayRef.current) {
      dispatch({ type: 'modifyOverlay', overlay: pendingOverlayRef.current });
      pendingOverlayRef.current = null;
    }
  }, [dispatch]);

  // --- Convenience wrappers ---

  const addOverlay = useCallback((overlay: PlanarOverlay) => {
    dispatch({ type: 'addOverlay', overlay });
  }, [dispatch]);

  const removeOverlay = useCallback((id: string) => {
    dispatch({ type: 'removeOverlay', overlayId: id });
  }, [dispatch]);

  const updateHex = useCallback((updatedHex: HexData) => {
    // TODO: For truly correct selective removal, store only changed fields.
    // Currently stores full hex — fine for linear undo, edge-case wrong for
    // selective removal of interleaved edits on the same hex.
    dispatch({ type: 'updateHex', hexId: updatedHex.id, changes: updatedHex });
  }, [dispatch]);

  const revealAllHexes = useCallback(() => {
    dispatch({ type: 'revealAll' });
  }, [dispatch]);

  const importMap = useCallback((newHexes: HexData[]) => {
    dispatch({ type: 'importMap', hexes: newHexes });
  }, [dispatch]);

  // --- UI ---

  const selectHex = useCallback((id: string | null) => {
    setSelectedHexId(id);
  }, []);

  const focusRegion = useCallback((regionId: string) => {
    const target = liveStateRef.current.hexes.find(h => h.groupId === regionId);
    if (target) setFocusedHex(target);
  }, []);

  const handleHexClick = useCallback((hex: HexData) => {
    if (!hex.isExplored) {
      if (!hex.groupId) return;
      dispatch({ type: 'revealSector', groupId: hex.groupId });
      return;
    }
    setSelectedHexId(hex.id);
  }, [dispatch]);

  return {
    // State
    hexes,
    selectedHex,
    focusedHex,
    worldConfig,
    planarOverlays,

    // History
    actions: history.actions,
    canUndo,
    canRedo,
    undo,
    redo,
    removeAction,
    dispatch,

    // Live preview
    previewWorldConfig,
    modifyOverlay,
    cancelPreview,
    commitOverlayModification,

    // Committed convenience wrappers
    addOverlay,
    removeOverlay,
    updateHex,
    revealAll: revealAllHexes,
    importMap,

    // UI
    selectHex,
    focusRegion,
    handleHexClick,
  };
};
