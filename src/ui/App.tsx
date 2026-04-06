import React from 'react';
import { WorldProvider } from './WorldContext';
import { TelemetryOverlay } from './components/TelemetryOverlay';

const App: React.FC = () => {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-slate-950 text-slate-200 font-sans selection:bg-amber-500/30">
      <WorldProvider>
        <WorldOverlay />
      </WorldProvider>
    </div>
  );
};

function WorldOverlay() {
  return (
    <div className="absolute inset-0 z-10 pointer-events-none">
      <TelemetryOverlay />
    </div>
  );
}

export default App;
