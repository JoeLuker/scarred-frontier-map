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

  // --- Dispatch: commit an action to history (async for terrain actions) ---
  const dispatch = useCallback(async (action: HistoryAction) => {
    const eng = engineRef.current;
    if (!eng) return;
    await eng.dispatch(action);
    setLiveState(eng.state);
  }, []);

  // --- Undo / Redo ---
  const undo = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return;
    eng.undo();
    setLiveState(eng.state);
  }, []);

  const redo = useCallback(async () => {
    const eng = engineRef.current;
    if (!eng) return;
    // Try sync redo first (non-terrain actions), fall back to async
    if (!eng.redo()) {
      await eng.redoAsync();
    }
    setLiveState(eng.state);
  }, []);

  // --- Remove a specific action (selective undo) ---
  const removeAction = useCallback(async (index: number) => {
    const eng = engineRef.current;
    if (!eng) return;
    await eng.removeAction(index);
    setLiveState(eng.state);
  }, []);

  // --- Live Preview (no history entry) ---

  const previewWorldConfig = useCallback(async (config: WorldGenConfig, preserveExplored: boolean) => {
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
      if (preserveExplored && hex.isExplored) return { ...hex };
      const r = results[i]!;
      return {
        ...hex,
        terrain: r.terrain,
        element: r.element,
        elevation: r.elevation,
        description: r.description,
        baseDescription: r.description,
        baseTerrain: r.terrain,
        planarAlignment: PlanarAlignment.MATERIAL,
        planarIntensity: 0,
        planarInfluences: [],
        reactionEmission: null,
      };
    });
    const withOverlays = applyOverlaysToMap(newHexes, committed.overlays);
    setLiveState({ hexes: withOverlays, overlays: committed.overlays, config });
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
    const eng = engineRef.current;
    if (eng) setLiveState(eng.state);
  }, []);

  // --- Commit live changes ---

  const commitOverlayModification = useCallback(async () => {
    if (pendingOverlayRef.current) {
      await dispatch({ type: 'modifyOverlay', overlay: pendingOverlayRef.current });
      pendingOverlayRef.current = null;
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

  const revealAllHexes = useCallback(async () => {
    await dispatch({ type: 'revealAll' });
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

  const handleHexClick = useCallback(async (hex: HexData) => {
    if (!hex.isExplored) {
      if (!hex.groupId) return;
      await dispatch({ type: 'revealSector', groupId: hex.groupId });
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
    revealAll: revealAllHexes,
    importMap,

    // UI
    selectHex,
    focusRegion,
    handleHexClick,
  };
};
