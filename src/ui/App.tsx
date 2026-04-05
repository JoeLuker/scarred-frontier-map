import React from 'react';
import { WorldProvider } from './WorldContext';

const App: React.FC = () => {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-slate-950 text-slate-200 font-sans selection:bg-amber-500/30">
      <WorldProvider>
        <WorldOverlay />
      </WorldProvider>
    </div>
  );
};

/** UI overlay — panels rendered on top of the WebGPU canvas. */
function WorldOverlay() {
  return (
    <div className="absolute inset-0 z-10 flex pointer-events-none">
      {/* Phase 3 UI panels will be added here */}
      <div className="absolute top-4 left-4 pointer-events-auto">
        <div className="bg-slate-900/80 backdrop-blur-sm rounded-lg px-3 py-2 text-xs text-slate-400">
          ECS v2 — simulation running
        </div>
      </div>
    </div>
  );
}

export default App;
