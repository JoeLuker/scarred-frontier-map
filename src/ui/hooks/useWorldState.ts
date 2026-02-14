import { useState, useCallback, useEffect } from 'react';
import { HexData, WorldGenConfig, PlanarOverlay, PlanarAlignment } from '../../core/types';
import { DEFAULT_WORLD_CONFIG, WORLD } from '../../core/config';
import { generateWorld, revealSector, revealAll, regenerateUnexplored } from '../../core/world';
import { applyOverlaysToMap } from '../../core/planar';

interface HistorySnapshot {
  hexes: HexData[];
  overlays: PlanarOverlay[];
}

interface HistoryState {
  past: HistorySnapshot[];
  future: HistorySnapshot[];
}

export const useWorldState = () => {
  const [hexes, setHexes] = useState<HexData[]>([]);
  const [worldConfig, setWorldConfig] = useState<WorldGenConfig>(DEFAULT_WORLD_CONFIG);
  const [isGenerating, setIsGenerating] = useState(false);
  const [planarOverlays, setPlanarOverlays] = useState<PlanarOverlay[]>([]);

  const [history, setHistory] = useState<HistoryState>({ past: [], future: [] });

  const [selectedHexId, setSelectedHexId] = useState<string | null>(null);
  const [focusedHex, setFocusedHex] = useState<HexData | null>(null);

  const selectedHex = hexes.find(h => h.id === selectedHexId) ?? null;

  // Initial Load
  useEffect(() => {
    const initialMap = generateWorld(DEFAULT_WORLD_CONFIG);
    const processedMap = applyOverlaysToMap(initialMap, []);
    setHexes(processedMap);
  }, []);

  // --- History Management ---

  const saveToHistory = useCallback((currentHexes: HexData[], currentOverlays: PlanarOverlay[]) => {
    setHistory(prev => {
      const newPast = [...prev.past, { hexes: currentHexes, overlays: currentOverlays }];
      if (newPast.length > WORLD.HISTORY_LIMIT) newPast.shift();
      return {
        past: newPast,
        future: [],
      };
    });
  }, []);

  const undo = useCallback(() => {
    setHistory(prev => {
      if (prev.past.length === 0) return prev;

      const previous = prev.past[prev.past.length - 1];
      if (!previous) return prev;
      const newPast = prev.past.slice(0, -1);

      setHexes(previous.hexes);
      setPlanarOverlays(previous.overlays);

      return {
        past: newPast,
        future: [{ hexes, overlays: planarOverlays }, ...prev.future],
      };
    });
  }, [hexes, planarOverlays]);

  const redo = useCallback(() => {
    setHistory(prev => {
      if (prev.future.length === 0) return prev;

      const next = prev.future[0];
      if (!next) return prev;
      const newFuture = prev.future.slice(1);

      setHexes(next.hexes);
      setPlanarOverlays(next.overlays);

      return {
        past: [...prev.past, { hexes, overlays: planarOverlays }],
        future: newFuture,
      };
    });
  }, [hexes, planarOverlays]);

  // --- Planar Management ---

  const updateOverlays = useCallback((newOverlays: PlanarOverlay[]) => {
    setPlanarOverlays(newOverlays);
    setHexes(prevHexes => applyOverlaysToMap(prevHexes, newOverlays));
  }, []);

  const addOverlay = useCallback((overlay: PlanarOverlay) => {
    saveToHistory(hexes, planarOverlays);
    const newOverlays = [...planarOverlays, overlay];
    updateOverlays(newOverlays);
  }, [planarOverlays, hexes, updateOverlays, saveToHistory]);

  const removeOverlay = useCallback((id: string) => {
    saveToHistory(hexes, planarOverlays);
    const newOverlays = planarOverlays.filter(o => o.id !== id);
    updateOverlays(newOverlays);
  }, [planarOverlays, hexes, updateOverlays, saveToHistory]);

  const modifyOverlay = useCallback((updated: PlanarOverlay) => {
    const newOverlays = planarOverlays.map(o => o.id === updated.id ? updated : o);
    updateOverlays(newOverlays);
  }, [planarOverlays, updateOverlays]);

  const commitOverlayModification = useCallback(() => {
    saveToHistory(hexes, planarOverlays);
  }, [hexes, planarOverlays, saveToHistory]);

  // --- Actions ---

  const updateHex = useCallback((updatedHex: HexData) => {
    setHexes(prev => prev.map(h => h.id === updatedHex.id ? updatedHex : h));
  }, []);

  const selectHex = useCallback((id: string | null) => {
    setSelectedHexId(id);
  }, []);

  const focusRegion = useCallback((regionId: string) => {
    const target = hexes.find(h => h.groupId === regionId);
    if (target) setFocusedHex(target);
  }, [hexes]);

  const importMap = useCallback((newHexes: HexData[]) => {
    saveToHistory(hexes, planarOverlays);
    setHexes(newHexes);
    setSelectedHexId(null);
  }, [hexes, planarOverlays, saveToHistory]);

  // --- Complex Actions ---

  const handleHexClick = useCallback((hex: HexData) => {
    if (!hex.isExplored) {
      if (!hex.groupId) return;

      const updatedHexes = revealSector(hex.groupId, hexes);
      const finalHexes = applyOverlaysToMap(updatedHexes, planarOverlays);

      setHexes(finalHexes);
      return;
    }

    setSelectedHexId(hex.id);
  }, [hexes, planarOverlays]);

  const handleGenerateWorld = useCallback((config: WorldGenConfig, preserveExplored: boolean = false) => {
    setIsGenerating(true);
    saveToHistory(hexes, planarOverlays);

    setWorldConfig(config);

    let newHexes: HexData[];

    if (preserveExplored) {
      const updatedBaseMap = regenerateUnexplored(hexes, config);
      newHexes = applyOverlaysToMap(updatedBaseMap, planarOverlays);
    } else {
      newHexes = generateWorld(config);
      setPlanarOverlays([]);
    }

    setHexes(newHexes);
    setSelectedHexId(null);
    setIsGenerating(false);
  }, [hexes, planarOverlays, saveToHistory]);

  const handleRevealAll = useCallback(() => {
    if (isGenerating) return;
    setIsGenerating(true);
    const fullMap = revealAll(hexes);
    const finalMap = applyOverlaysToMap(fullMap, planarOverlays);
    setHexes(finalMap);
    setIsGenerating(false);
  }, [isGenerating, hexes, planarOverlays]);

  return {
    hexes,
    selectedHex,
    focusedHex,
    worldConfig,
    isGenerating,
    planarOverlays,
    history,

    updateHex,
    selectHex,
    focusRegion,
    importMap,

    addOverlay,
    removeOverlay,
    modifyOverlay,
    commitOverlayModification,

    undo,
    redo,

    handleHexClick,
    generateWorld: handleGenerateWorld,
    revealAll: handleRevealAll,
  };
};
