import React, { useState } from 'react';
import { PlanarAlignment } from '../core/types';
import { HexGrid } from './components/HexGrid';
import { CurrentHex } from './components/CurrentHex';
import { MapEditor } from './components/MapEditor';
import { WorldWizard } from './components/WorldWizard';
import { WorldSidebar } from './components/WorldSidebar';
import { PlanarManager } from './components/PlanarManager';
import { Loader2 } from 'lucide-react';
import { useWorldState } from './hooks/useWorldState';

const App: React.FC = () => {
  const {
    hexes,
    selectedHex,
    focusedHex,
    isGenerating,
    planarOverlays,
    history,
    updateHex,
    selectHex,
    focusRegion,
    importMap,
    handleHexClick,
    generateWorld,
    revealAll,
    addOverlay,
    removeOverlay,
    modifyOverlay,
    commitOverlayModification,
    undo,
    redo,
  } = useWorldState();

  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [isPlanarManagerOpen, setIsPlanarManagerOpen] = useState(false);

  const handleAddPlane = (type: PlanarAlignment) => {
    const center = focusedHex ? focusedHex.coordinates : { q: 0, r: 0 };
    addOverlay({
      id: `PLANE-${Date.now()}`,
      type,
      coordinates: center,
      radius: 5,
    });
  };

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-slate-950 text-slate-200 font-sans selection:bg-amber-500/30">

      <div className="absolute inset-0 z-0">
        <HexGrid
          hexes={hexes}
          onHexClick={handleHexClick}
          focusedHex={focusedHex}
          planarOverlays={planarOverlays}
          onModifyOverlay={modifyOverlay}
          onCommitOverlay={commitOverlayModification}
          showGizmos={isPlanarManagerOpen}
        />
      </div>

      <div className="absolute top-4 left-4 bottom-4 z-20 pointer-events-none flex flex-col justify-center">
        <div className="pointer-events-auto h-full flex">
          <WorldSidebar
            hexes={hexes}
            onFocusRegion={focusRegion}
            onOpenWizard={() => setIsWizardOpen(true)}
            onOpenEditor={() => setIsEditorOpen(true)}
            onRevealAll={revealAll}
            isGenerating={isGenerating}
            onTogglePlanarManager={() => setIsPlanarManagerOpen(!isPlanarManagerOpen)}
            onUndo={undo}
            onRedo={redo}
            canUndo={history.past.length > 0}
            canRedo={history.future.length > 0}
          />
        </div>
      </div>

      <PlanarManager
        isOpen={isPlanarManagerOpen}
        onClose={() => setIsPlanarManagerOpen(false)}
        overlays={planarOverlays}
        onAdd={handleAddPlane}
        onRemove={removeOverlay}
        onModify={modifyOverlay}
      />

      <div className={`absolute top-4 right-4 bottom-4 w-80 z-20 transition-transform duration-300 ease-in-out pointer-events-none ${selectedHex ? 'translate-x-0' : 'translate-x-[120%]'}`}>
        <div className="h-full pointer-events-auto">
          <CurrentHex
            hex={selectedHex}
            onUpdateHex={updateHex}
            onClose={() => selectHex(null)}
          />
        </div>
      </div>

      {isGenerating && (
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2 z-50 bg-indigo-600 text-white px-6 py-3 rounded-full shadow-2xl flex items-center gap-3 animate-in fade-in slide-in-from-bottom-4">
          <Loader2 className="animate-spin" size={20} />
          <span className="font-bold tracking-wide">Forging Landscape...</span>
        </div>
      )}

      <MapEditor
        isOpen={isEditorOpen}
        onClose={() => setIsEditorOpen(false)}
        hexes={hexes}
        onImport={importMap}
      />

      <WorldWizard
        isOpen={isWizardOpen}
        onClose={() => setIsWizardOpen(false)}
        onGenerate={(config, preserve) => generateWorld(config, preserve)}
      />
    </div>
  );
};

export default App;
