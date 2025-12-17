
import { useState, useCallback, useEffect } from 'react';
import { HexData, PartySpeed, WorldGenConfig, PlanarOverlay, PlanarAlignment } from '../types';
import { DEFAULT_WORLD_CONFIG } from '../constants';
import { getInitialMapData, revealSector, revealEntireMap, regenerateUnexploredTerrain } from '../services/mapData';
import { applyOverlaysToMap } from '../services/planar';
import { getHexDistance } from '../services/geometry';

interface HistorySnapshot {
    hexes: HexData[];
    overlays: PlanarOverlay[];
}

interface HistoryState {
    past: HistorySnapshot[];
    future: HistorySnapshot[];
}

export const useWorldState = () => {
  // Map Data State
  const [hexes, setHexes] = useState<HexData[]>([]);
  const [worldConfig, setWorldConfig] = useState<WorldGenConfig>(DEFAULT_WORLD_CONFIG);
  const [isGenerating, setIsGenerating] = useState(false);
  const [planarOverlays, setPlanarOverlays] = useState<PlanarOverlay[]>([]);
  
  // History State
  const [history, setHistory] = useState<HistoryState>({ past: [], future: [] });

  // Interaction State
  const [selectedHexId, setSelectedHexId] = useState<string | null>(null);
  const [focusedHex, setFocusedHex] = useState<HexData | null>(null);

  // Game State
  const [partySpeed, setPartySpeed] = useState<PartySpeed>(30);
  const [campaignTime, setCampaignTime] = useState(0);

  // Computed
  const selectedHex = hexes.find(h => h.id === selectedHexId) || null;

  // Initial Load
  useEffect(() => {
    const initialMap = getInitialMapData(DEFAULT_WORLD_CONFIG);
    const processedMap = applyOverlaysToMap(initialMap, []);
    setHexes(processedMap);
    // We don't push initial state to history to keep start clean, or we could.
  }, []);

  // --- History Management ---

  const saveToHistory = useCallback((currentHexes: HexData[], currentOverlays: PlanarOverlay[]) => {
      setHistory(prev => {
          const newPast = [...prev.past, { hexes: currentHexes, overlays: currentOverlays }];
          // Limit history to 20 steps to prevent memory issues
          if (newPast.length > 20) newPast.shift();
          return {
              past: newPast,
              future: []
          };
      });
  }, []);

  const undo = useCallback(() => {
      setHistory(prev => {
          if (prev.past.length === 0) return prev;
          
          const previous = prev.past[prev.past.length - 1];
          const newPast = prev.past.slice(0, -1);
          
          setHexes(previous.hexes);
          setPlanarOverlays(previous.overlays);
          
          return {
              past: newPast,
              future: [{ hexes, overlays: planarOverlays }, ...prev.future]
          };
      });
  }, [hexes, planarOverlays]);

  const redo = useCallback(() => {
      setHistory(prev => {
          if (prev.future.length === 0) return prev;

          const next = prev.future[0];
          const newFuture = prev.future.slice(1);

          setHexes(next.hexes);
          setPlanarOverlays(next.overlays);

          return {
              past: [...prev.past, { hexes, overlays: planarOverlays }],
              future: newFuture
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
    // Note: We don't save history on every drag frame, handled by caller (usually on mouse up)
    // But for direct modifications via UI, we might want to.
    const newOverlays = planarOverlays.map(o => o.id === updated.id ? updated : o);
    updateOverlays(newOverlays);
  }, [planarOverlays, updateOverlays]);
  
  // Use this for discrete modification events (like mouse up after drag)
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
    saveToHistory(hexes, planarOverlays); // Save before import
    setHexes(newHexes);
    setSelectedHexId(null);
  }, [hexes, planarOverlays, saveToHistory]);

  // --- Complex Async Actions ---

  const handleHexClick = useCallback((hex: HexData) => {
    // If hidden, reveal its sector
    if (!hex.isExplored) {
        if (!hex.groupId) return;
        
        // Reveal Logic
        const updatedHexes = revealSector(hex.groupId, hexes);
        const finalHexes = applyOverlaysToMap(updatedHexes, planarOverlays);
        
        setHexes(finalHexes);
        return;
    }

    setSelectedHexId(hex.id);
  }, [hexes, planarOverlays]);

  const generateWorld = useCallback((config: WorldGenConfig, preserveExplored: boolean = false) => {
    setIsGenerating(true);
    // Save history before generating new world
    saveToHistory(hexes, planarOverlays);

    setTimeout(() => {
        setWorldConfig(config);
        
        let newHexes: HexData[];
        
        if (preserveExplored) {
            const updatedBaseMap = regenerateUnexploredTerrain(hexes, config);
            newHexes = applyOverlaysToMap(updatedBaseMap, planarOverlays);
        } else {
            newHexes = getInitialMapData(config);
            setPlanarOverlays([]);
            setCampaignTime(0);
        }
        
        setHexes(newHexes);
        setSelectedHexId(null);
        setIsGenerating(false);
    }, 100);
  }, [hexes, planarOverlays, saveToHistory]);

  const revealAll = useCallback(() => {
    if (isGenerating) return;
    setIsGenerating(true);
    setTimeout(() => {
        const fullMap = revealEntireMap(hexes, worldConfig);
        const finalMap = applyOverlaysToMap(fullMap, planarOverlays);
        setHexes(finalMap);
        setIsGenerating(false);
    }, 100);
  }, [isGenerating, worldConfig, hexes, planarOverlays]);

  return {
    hexes,
    selectedHex,
    focusedHex,
    worldConfig,
    isGenerating,
    campaignTime,
    partySpeed,
    planarOverlays,
    history,
    
    setCampaignTime,
    setPartySpeed,
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
    generateWorld,
    revealAll
  };
};
