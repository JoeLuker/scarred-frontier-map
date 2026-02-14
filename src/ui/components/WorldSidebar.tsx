import React, { useMemo, useState } from 'react';
import { HexData } from '../../core/types';
import { Map as MapIcon, ChevronRight, Wand2, Download, Eye, Loader2, Layers, RotateCcw, RotateCw } from 'lucide-react';

interface WorldSidebarProps {
  hexes: HexData[];
  onFocusRegion: (groupId: string) => void;
  onOpenWizard: () => void;
  onOpenEditor: () => void;
  onRevealAll: () => void;
  isGenerating: boolean;
  onTogglePlanarManager: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export const WorldSidebar: React.FC<WorldSidebarProps> = ({
  hexes,
  onFocusRegion,
  onOpenWizard,
  onOpenEditor,
  onRevealAll,
  isGenerating,
  onTogglePlanarManager,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}) => {
  const [isOpen, setIsOpen] = useState(true);

  const regions = useMemo(() => {
    const regionMap = new Map<string, { id: string; name: string; count: number }>();
    hexes.forEach(h => {
      if (h.groupId && h.groupId !== 'BRIDGE') {
        const existing = regionMap.get(h.groupId);
        if (existing) {
          existing.count++;
        } else {
          regionMap.set(h.groupId, {
            id: h.groupId,
            name: h.notes || h.groupId,
            count: 1,
          });
        }
      }
    });
    return Array.from(regionMap.values());
  }, [hexes]);

  return (
    <div className="flex flex-col h-full pointer-events-auto transition-all duration-300 ease-in-out">
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="bg-slate-900/90 border border-slate-700 p-3 rounded-xl text-slate-400 hover:text-amber-500 shadow-xl backdrop-blur-sm transition-all hover:scale-105"
        >
          <MapIcon size={24} />
        </button>
      )}

      {isOpen && (
        <div className="w-64 bg-slate-950/95 backdrop-blur-xl border border-slate-800 shadow-2xl flex flex-col h-full rounded-2xl overflow-hidden animate-in slide-in-from-left-4 fade-in duration-300">

          <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-900/50">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-600 to-amber-800 flex items-center justify-center text-white shadow-lg shadow-amber-900/20 border border-amber-500/20">
                <MapIcon size={16} />
              </div>
              <div>
                <h2 className="font-bold text-slate-200 text-sm leading-tight">Pathfinder</h2>
                <p className="text-[10px] text-slate-500 uppercase tracking-widest font-semibold">Sandbox Tool</p>
              </div>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-slate-800 text-slate-600 hover:text-slate-200 transition-colors"
            >
              <ChevronRight size={14} className="rotate-180" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-1 scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-transparent">
            <div className="px-1 pb-2 text-[10px] font-bold text-slate-500 uppercase tracking-wider flex items-center justify-between">
              <span>Regions</span>
              <span className="bg-slate-800 text-slate-500 px-1.5 rounded text-[9px]">{regions.length}</span>
            </div>

            {regions.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-600 italic border border-dashed border-slate-800 rounded-lg">
                Map is unexplored. Click fog to reveal sectors.
              </div>
            ) : (
              regions.map(r => (
                <button
                  key={r.id}
                  onClick={() => onFocusRegion(r.id)}
                  className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-amber-400 text-xs flex items-center justify-between group transition-all border border-transparent hover:border-slate-700"
                >
                  <span className="truncate font-medium">{r.name}</span>
                  <span className="text-[9px] bg-slate-900 px-1.5 py-0.5 rounded text-slate-600 group-hover:text-amber-500/50 transition-colors border border-slate-800 group-hover:border-amber-500/10">
                    {r.count}
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="p-3 border-t border-slate-800 bg-slate-900/50 space-y-2">
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={onUndo}
                disabled={!canUndo}
                className="bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-700 border border-slate-700 text-slate-400 hover:text-white py-2 rounded-lg flex items-center justify-center transition-all"
                title="Undo"
              >
                <RotateCcw size={14} />
              </button>
              <button
                onClick={onTogglePlanarManager}
                className="bg-slate-800/50 hover:bg-fuchsia-950/30 border border-slate-700 hover:border-fuchsia-500/30 text-slate-400 hover:text-fuchsia-400 text-[10px] font-bold py-2 rounded-lg flex items-center justify-center gap-1 transition-all"
              >
                <Layers size={14} /> PLANES
              </button>
              <button
                onClick={onRedo}
                disabled={!canRedo}
                className="bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-700 border border-slate-700 text-slate-400 hover:text-white py-2 rounded-lg flex items-center justify-center transition-all"
                title="Redo"
              >
                <RotateCw size={14} />
              </button>
            </div>

            <button
              onClick={onRevealAll}
              disabled={isGenerating}
              className="w-full bg-amber-950/20 hover:bg-amber-900/30 border border-amber-900/20 hover:border-amber-700/50 text-amber-600 hover:text-amber-500 text-[10px] font-bold py-2 rounded-lg flex items-center justify-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isGenerating ? <Loader2 className="animate-spin" size={14} /> : <Eye size={14} />}
              {isGenerating ? 'REVEALING...' : 'REVEAL MAP'}
            </button>

            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                onClick={onOpenWizard}
                className="bg-slate-800 hover:bg-indigo-950/30 border border-slate-700 hover:border-indigo-500/30 text-slate-400 hover:text-indigo-400 text-[10px] font-bold py-2 rounded-lg flex items-center justify-center gap-1.5 transition-all"
              >
                <Wand2 size={12} /> REGEN
              </button>
              <button
                onClick={onOpenEditor}
                className="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-400 hover:text-slate-200 text-[10px] font-bold py-2 rounded-lg flex items-center justify-center gap-1.5 transition-all"
              >
                <Download size={12} /> DATA
              </button>
            </div>
          </div>

        </div>
      )}
    </div>
  );
};
