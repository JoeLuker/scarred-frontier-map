import { useState, useCallback, useRef, useEffect } from 'react';
import { HexData, WorldGenConfig, PlanarOverlay, PlanarAlignment, HistoryAction, WorldState } from '../../core/types';
import { WorldEngine } from '../../core/engine';
import { applyOverlaysToMap } from '../../core/planar';
import { getGpuContext, GpuTerrainProvider } from '../../gpu';

export const useWorldState = () => {
  const [engine, setEngine] = useState<WorldEngine | null>(null);
  const engineRef = useRef<WorldEngine | null>(null);

  // Live state: what the UI renders. Equals committed state except during preview/drag.
  const [liveState, setLiveState] = useState<WorldState>({
    hexes: [],
    overlays: [],
    config: { waterLevel: 0.5, mountainLevel: 0.5, vegetationLevel: 0.5, riverDensity: 0.5,
      ruggedness: 0.5, seed: 12345, continentScale: 0.5, temperature: 0.5, ridgeSharpness: 0.5,
      plateauFactor: 0, coastComplexity: 0, erosion: 0, valleyDepth: 0.5, chaos: 0, verticality: 0.5 },
  });
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
  const canUndo = engine?.canUndo ?? false;
  const canRedo = engine?.canRedo ?? false;

  // --- Async engine initialization ---

  const previewGenRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ctx = await getGpuContext();
      if (cancelled || !ctx) return;
      const provider = GpuTerrainProvider.create(ctx.device, 20000);
      const e = await WorldEngine.create(provider);
      if (cancelled) { e.destroy(); return; }
      engineRef.current = e;
      setEngine(e);
      setLiveState(e.state);
      console.log(`WorldEngine initialized (${e.hexes.length} hexes via GPU)`);
    })();
    return () => {
      cancelled = true;
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, []);

  // --- Pending overlay modifications ---
  // Map keyed by overlay ID so multiple overlays can be previewed concurrently.
  // Survives engine state resets (dispatch/undo/redo) until explicitly committed.
  const pendingOverlaysRef = useRef<Map<string, PlanarOverlay>>(new Map());

  // Merge engine's committed state with any pending overlay previews
  const mergeWithPending = useCallback((state: WorldState): WorldState => {
    const pending = pendingOverlaysRef.current;
    if (pending.size === 0) return state;
    const overlays = state.overlays.map(o => pending.get(o.id) ?? o);
    const hexes = applyOverlaysToMap(state.hexes, overlays);
    return { ...state, hexes, overlays };
  }, []);

  // --- Dispatch: commit an action to history (async for terrain actions) ---
  const dispatch = useCallback(async (action: HistoryAction) => {
    const eng = engineRef.current;
    if (!eng) return;
    await eng.dispatch(action);
    setLiveState(mergeWithPending(eng.state));
  }, [mergeWithPending]);

  // --- Undo / Redo ---
  const undo = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return;
    eng.undo();
    setLiveState(mergeWithPending(eng.state));
  }, [mergeWithPending]);

  const redo = useCallback(async () => {
    const eng = engineRef.current;
    if (!eng) return;
    // Try sync redo first (non-terrain actions), fall back to async
    if (!eng.redo()) {
      await eng.redoAsync();
    }
    setLiveState(mergeWithPending(eng.state));
  }, [mergeWithPending]);

  // --- Remove a specific action (selective undo) ---
  const removeAction = useCallback(async (index: number) => {
    const eng = engineRef.current;
    if (!eng) return;
    await eng.removeAction(index);
    setLiveState(mergeWithPending(eng.state));
  }, [mergeWithPending]);

  // --- Live Preview (no history entry) ---

  const previewWorldConfig = useCallback(async (config: WorldGenConfig) => {
    const eng = engineRef.current;
    if (!eng) return;
    const committed = eng.state;
    if (committed.hexes.length === 0) return;

    const gen = ++previewGenRef.current;
    const results = await eng.computeTerrain(
      committed.hexes.map(h => h.coordinates),
      config,
    );
    if (gen !== previewGenRef.current) return; // stale

    const newHexes = committed.hexes.map((hex, i) => {
      const r = results[i]!;
      return {
        ...hex,
        terrain: r.terrain,
        element: r.element,
        elevation: r.elevation,
        hasRiver: r.hasRiver,
        description: r.description,
        baseDescription: r.description,
        baseTerrain: r.terrain,
        planarAlignment: PlanarAlignment.MATERIAL,
        planarIntensity: 0,
        planarFragmentation: 0.5,
        planarLift: 0.5,
        planarInfluences: [],
        reactionEmission: null,
      };
    });
    const withOverlays = applyOverlaysToMap(newHexes, committed.overlays);
    setLiveState({ hexes: withOverlays, overlays: committed.overlays, config });
  }, []);

  const modifyOverlay = useCallback((updated: PlanarOverlay) => {
    pendingOverlaysRef.current.set(updated.id, updated);
    setLiveState(prev => {
      const overlays = prev.overlays.map(o => o.id === updated.id ? updated : o);
      const withOverlays = applyOverlaysToMap(prev.hexes, overlays);
      return { ...prev, hexes: withOverlays, overlays };
    });
  }, []);

  const cancelPreview = useCallback(() => {
    const eng = engineRef.current;
    if (eng) setLiveState(mergeWithPending(eng.state));
  }, [mergeWithPending]);

  // --- Commit live changes ---

  const commitOverlayModification = useCallback(async () => {
    const pending = pendingOverlaysRef.current;
    if (pending.size === 0) return;
    const entries = Array.from(pending.values());
    pending.clear();
    for (const overlay of entries) {
      await dispatch({ type: 'modifyOverlay', overlay });
    }
  }, [dispatch]);

  // --- Convenience wrappers ---

  const addOverlay = useCallback(async (overlay: PlanarOverlay) => {
    await dispatch({ type: 'addOverlay', overlay });
  }, [dispatch]);

  const removeOverlay = useCallback(async (id: string) => {
    await dispatch({ type: 'removeOverlay', overlayId: id });
  }, [dispatch]);

  const updateHex = useCallback(async (updatedHex: HexData) => {
    await dispatch({ type: 'updateHex', hexId: updatedHex.id, changes: updatedHex });
  }, [dispatch]);

  const importMap = useCallback(async (newHexes: HexData[]) => {
    await dispatch({ type: 'importMap', hexes: newHexes });
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
    setSelectedHexId(hex.id);
  }, []);

  return {
    // State
    hexes,
    selectedHex,
    focusedHex,
    worldConfig,
    planarOverlays,

    // History
    actions: engine?.actions ?? [],
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
    importMap,

    // UI
    selectHex,
    focusRegion,
    handleHexClick,
  };
};
