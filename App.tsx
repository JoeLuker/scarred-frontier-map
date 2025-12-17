
import React, { useState } from 'react';
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
      handleHexClick,
      generateWorld,
      revealAll,
      addOverlay,
      removeOverlay,
      modifyOverlay,
      commitOverlayModification,
      undo,
      redo
  } = useWorldState();
  
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [isPlanarManagerOpen, setIsPlanarManagerOpen] = useState(false);
  
  const handleAddPlane = (type: any) => {
     // Add to center of current view (0,0 default) or existing focus
     const center = focusedHex ? focusedHex.coordinates : { x: 0, y: 0 };
     addOverlay({
         id: `PLANE-${Date.now()}`,
         type,
         coordinates: center,
         radius: 5
     });
  };

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-slate-950 text-slate-200 font-sans selection:bg-amber-500/30">
      
      {/* FULLSCREEN MAP */}
      <div className="absolute inset-0 z-0">
        <HexGrid 
            hexes={hexes} 
            onHexClick={handleHexClick} 
            focusedHex={focusedHex}
            planarOverlays={planarOverlays}
            onModifyOverlay={modifyOverlay}
            onCommitOverlay={commitOverlayModification}
            showGizmos={isPlanarManagerOpen} // Only show handles when manager is open
        />
      </div>

      {/* LEFT SIDEBAR: World / Map UI */}
      <div className="absolute top-4 left-4 bottom-4 z-20 pointer-events-none flex flex-col justify-center">
          <div className="pointer-events-auto h-full flex">
            <WorldSidebar 
                hexes={hexes}
                onFocusRegion={focusRegion}
                campaignTime={campaignTime}
                setCampaignTime={setCampaignTime}
                onOpenWizard={() => setIsWizardOpen(true)}
                onOpenEditor={() => setIsEditorOpen(true)}
                partySpeed={partySpeed}
                setPartySpeed={setPartySpeed}
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

      {/* PLANAR MANAGER SIDEBAR (Floating) */}
      <PlanarManager 
        isOpen={isPlanarManagerOpen}
        onClose={() => setIsPlanarManagerOpen(false)}
        overlays={planarOverlays}
        onAdd={handleAddPlane}
        onRemove={removeOverlay}
        onModify={modifyOverlay}
      />

      {/* RIGHT SIDEBAR: Hex Inspector */}
      <div className={`absolute top-4 right-4 bottom-4 w-80 z-20 transition-transform duration-300 ease-in-out pointer-events-none ${selectedHex ? 'translate-x-0' : 'translate-x-[120%]'}`}>
          <div className="h-full pointer-events-auto">
             <CurrentHex 
                hex={selectedHex} 
                onUpdateHex={updateHex}
                onClose={() => selectHex(null)}
             />
          </div>
      </div>
      
      {/* Loading Overlay */}
      {isGenerating && (
          <div className="absolute bottom-10 left-1/2 -translate-x-1/2 z-50 bg-indigo-600 text-white px-6 py-3 rounded-full shadow-2xl flex items-center gap-3 animate-in fade-in slide-in-from-bottom-4">
              <Loader2 className="animate-spin" size={20} />
              <span className="font-bold tracking-wide">Forging Landscape...</span>
          </div>
      )}

      {/* Modals */}
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
