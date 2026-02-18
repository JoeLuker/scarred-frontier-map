import React, { useState, useRef, useCallback } from 'react';
import { PlanarAlignment, HexData, WorldGenConfig } from '../core/types';
import { HexGrid } from './components/HexGrid';
import { CurrentHex } from './components/CurrentHex';
import { WorldGenBar } from './components/WorldGenBar';
import { WorldSidebar } from './components/WorldSidebar';
import { useWorldState } from './hooks/useWorldState';
import { useBridgeReceiver } from '../bridge/useBridgeReceiver';

const App: React.FC = () => {
  const {
    hexes,
    selectedHex,
    focusedHex,
    worldConfig,
    planarOverlays,
    actions,
    canUndo,
    canRedo,
    undo,
    redo,
    removeAction,
    dispatch,
    previewWorldConfig,
    cancelPreview,
    modifyOverlay,
    commitOverlayModification,
    updateHex,
    selectHex,
    focusRegion,
    importMap,
    handleHexClick,
    addOverlay,
    removeOverlay,
  } = useWorldState();

  useBridgeReceiver({ hexes, planarOverlays, dispatch, focusRegion });

  const [isGenBarOpen, setIsGenBarOpen] = useState(false);
  const [isPlanesOpen, setIsPlanesOpen] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleOpenGenBar = useCallback(() => {
    setIsGenBarOpen(true);
  }, []);

  const handleCheckpoint = useCallback((config: WorldGenConfig) => {
    dispatch({ type: 'worldConfig', config });
  }, [dispatch]);

  const handleCancelGenBar = useCallback(() => {
    cancelPreview();
    setIsGenBarOpen(false);
  }, [cancelPreview]);

  const handleCloseGenBar = useCallback(() => {
    setIsGenBarOpen(false);
  }, []);

  const handleAddPlane = useCallback((type: PlanarAlignment) => {
    const center = focusedHex ? focusedHex.coordinates : { q: 0, r: 0 };
    addOverlay({
      id: `PLANE-${Date.now()}`,
      type,
      coordinates: center,
      radius: 5,
    });
  }, [focusedHex, addOverlay]);

  const handleExport = useCallback(() => {
    const data = JSON.stringify(hexes, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scarred-frontier-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [hexes]);

  const handleImport = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed: unknown = JSON.parse(event.target?.result as string);
        if (Array.isArray(parsed)) {
          importMap(parsed as HexData[]);
        }
      } catch (err) {
        console.error('Failed to import map:', err);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [importMap]);

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-slate-950 text-slate-200 font-sans selection:bg-amber-500/30">

      {/* Canvas — always full viewport */}
      <div className="absolute inset-0 z-0">
        <HexGrid
          hexes={hexes}
          worldConfig={worldConfig}
          onHexClick={handleHexClick}
          focusedHex={focusedHex}
          planarOverlays={planarOverlays}
          onModifyOverlay={modifyOverlay}
          onCommitOverlay={commitOverlayModification}
          showGizmos={planarOverlays.length > 0 && isPlanesOpen}
          showGrid={showGrid}
        />
      </div>

      {/* UI overlay — flex layout, panels are structurally aware of each other */}
      <div className="absolute inset-0 z-10 flex pointer-events-none">

        {/* Left sidebar */}
        <div className="shrink-0 p-4">
          <WorldSidebar
            hexes={hexes}
            onFocusRegion={focusRegion}
            onToggleGenBar={handleOpenGenBar}
            isGenBarOpen={isGenBarOpen}
            onExport={handleExport}
            onImport={handleImport}
            onUndo={undo}
            onRedo={redo}
            canUndo={canUndo}
            canRedo={canRedo}
            actions={actions}
            onRemoveAction={removeAction}
            overlays={planarOverlays}
            onAddPlane={handleAddPlane}
            onRemoveOverlay={removeOverlay}
            onModifyOverlay={modifyOverlay}
            onCommitOverlay={commitOverlayModification}
            onPlanesOpenChange={setIsPlanesOpen}
            showGrid={showGrid}
            onToggleGrid={() => setShowGrid(prev => !prev)}
          />
        </div>

        {/* Center column — spacer + bottom bar */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1" />
          {isGenBarOpen && (
            <div className="pointer-events-auto">
              <WorldGenBar
                initialConfig={worldConfig}
                onPreview={previewWorldConfig}
                onCheckpoint={handleCheckpoint}
                onCancel={handleCancelGenBar}
                onClose={handleCloseGenBar}
              />
            </div>
          )}
        </div>

        {/* Right panel — hex details */}
        <div className={`shrink-0 overflow-hidden transition-all duration-300 ease-in-out ${selectedHex ? 'w-[336px] p-4' : 'w-0'}`}>
          <div className="w-80 h-full pointer-events-auto">
            <CurrentHex
              hex={selectedHex}
              onUpdateHex={updateHex}
              onClose={() => selectHex(null)}
            />
          </div>
        </div>
      </div>

      {/* Hidden file input for import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        className="hidden"
        onChange={handleFileChange}
      />
    </div>
  );
};

export default App;
