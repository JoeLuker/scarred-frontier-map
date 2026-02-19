import React, { useMemo, useState } from 'react';
import { HexData, PlanarOverlay, PlanarAlignment, HistoryAction } from '../../core/types';
import { getActionLabel } from '../../core/history';
import { PLANAR_COLORS } from '../theme';
import { WORLD } from '../../core/config';
import { Map as MapIcon, ChevronRight, ChevronUp, ChevronDown, Upload, Download, RotateCcw, RotateCw, Trash2, Plus, Move, Clock, Grid3x3 } from 'lucide-react';

const AVAILABLE_PLANES = [
  PlanarAlignment.FIRE,
  PlanarAlignment.WATER,
  PlanarAlignment.AIR,
  PlanarAlignment.EARTH,
  PlanarAlignment.POSITIVE,
  PlanarAlignment.NEGATIVE,
  PlanarAlignment.SCAR,
];

interface WorldSidebarProps {
  hexes: HexData[];
  onFocusRegion: (groupId: string) => void;
  onToggleGenBar: () => void;
  isGenBarOpen: boolean;
  onExport: () => void;
  onImport: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  actions: readonly HistoryAction[];
  onRemoveAction: (index: number) => void;
  // Planar
  overlays: PlanarOverlay[];
  onAddPlane: (type: PlanarAlignment) => void;
  onRemoveOverlay: (id: string) => void;
  onModifyOverlay: (overlay: PlanarOverlay) => void;
  onCommitOverlay: () => void;
  onPlanesOpenChange?: (isOpen: boolean) => void;
  showGrid: boolean;
  onToggleGrid: () => void;
}

export const WorldSidebar: React.FC<WorldSidebarProps> = ({
  hexes,
  onFocusRegion,
  onToggleGenBar,
  isGenBarOpen,
  onExport,
  onImport,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  actions,
  onRemoveAction,
  overlays,
  onAddPlane,
  onRemoveOverlay,
  onModifyOverlay,
  onCommitOverlay,
  onPlanesOpenChange,
  showGrid,
  onToggleGrid,
}) => {
  const [isOpen, setIsOpen] = useState(true);
  const [isRegionsOpen, setIsRegionsOpen] = useState(false);
  const [isPlanesOpen, setIsPlanesOpenRaw] = useState(true);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isAddPlaneOpen, setIsAddPlaneOpen] = useState(false);

  const setIsPlanesOpen = (open: boolean) => {
    setIsPlanesOpenRaw(open);
    onPlanesOpenChange?.(open);
  };

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
            {/* Regions — collapsed by default */}
            <button
              onClick={() => setIsRegionsOpen(!isRegionsOpen)}
              className="w-full px-1 pb-1 text-[10px] font-bold text-slate-500 uppercase tracking-wider flex items-center justify-between hover:text-slate-300 transition-colors"
            >
              <span className="flex items-center gap-1">
                {isRegionsOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                Regions
              </span>
              <span className="bg-slate-800 text-slate-500 px-1.5 rounded text-[9px]">{regions.length}</span>
            </button>

            {isRegionsOpen && (
              <div className="pb-2">
                {regions.length === 0 ? (
                  <div className="p-4 text-center text-xs text-slate-600 italic border border-dashed border-slate-800 rounded-lg">
                    Map is unexplored. Click fog to reveal sectors.
                  </div>
                ) : (
                  regions.map(r => (
                    <button
                      key={r.id}
                      onClick={() => onFocusRegion(r.id)}
                      className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-amber-400 text-xs flex items-center justify-between group transition-all border border-transparent hover:border-slate-700"
                    >
                      <span className="truncate font-medium">{r.name}</span>
                      <span className="text-[9px] bg-slate-900 px-1.5 py-0.5 rounded text-slate-600 group-hover:text-amber-500/50 transition-colors border border-slate-800 group-hover:border-amber-500/10">
                        {r.count}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}

            {/* Planar Layers — expanded by default */}
            <div className="border-t border-slate-800/50 pt-2">
              <button
                onClick={() => setIsPlanesOpen(!isPlanesOpen)}
                className="w-full px-1 pb-1 text-[10px] font-bold text-slate-500 uppercase tracking-wider flex items-center justify-between hover:text-slate-300 transition-colors"
              >
                <span className="flex items-center gap-1">
                  {isPlanesOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                  Planar Layers
                </span>
                <span className="bg-slate-800 text-slate-500 px-1.5 rounded text-[9px]">{overlays.length}</span>
              </button>

              {isPlanesOpen && (
                <div className="space-y-2 pb-2">
                  {overlays.length === 0 && (
                    <div className="p-3 text-center text-[10px] text-slate-600 italic border border-dashed border-slate-800 rounded-lg">
                      No active planar overlays.
                    </div>
                  )}

                  {overlays.map((overlay) => (
                    <div
                      key={overlay.id}
                      className="bg-slate-800/50 rounded-lg border border-slate-700/50 p-2 space-y-1.5"
                    >
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-1.5">
                          <div
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: PLANAR_COLORS[overlay.type] }}
                          />
                          <span className="font-bold text-slate-300 text-[11px]">{overlay.type.replace('Plane of ', '')}</span>
                        </div>
                        <button
                          onClick={() => onRemoveOverlay(overlay.id)}
                          className="text-slate-600 hover:text-rose-500 transition-colors p-0.5"
                          title="Remove"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>

                      <div className="space-y-1 pl-4">
                        <div className="flex justify-between text-[9px] text-slate-500 uppercase font-bold">
                          <span>Radius</span>
                          <span>{overlay.radius} hexes</span>
                        </div>
                        <input
                          type="range"
                          min="2" max={WORLD.GRID_RADIUS + 5} step="1"
                          value={overlay.radius}
                          onChange={(e) => onModifyOverlay({ ...overlay, radius: parseInt(e.target.value) })}
                          onPointerUp={() => onCommitOverlay()}
                          className="w-full h-1 bg-slate-700 rounded-full appearance-none cursor-pointer accent-slate-400"
                        />
                        <div className="flex justify-between text-[9px] text-slate-500 uppercase font-bold">
                          <span>Strength</span>
                          <span>{Math.round(overlay.intensity * 100)}%</span>
                        </div>
                        <input
                          type="range"
                          min="0" max="1" step="0.01"
                          value={overlay.intensity}
                          onChange={(e) => onModifyOverlay({ ...overlay, intensity: parseFloat(e.target.value) })}
                          onPointerUp={() => onCommitOverlay()}
                          className="w-full h-1 bg-slate-700 rounded-full appearance-none cursor-pointer accent-slate-400"
                        />
                        <div className="flex justify-between text-[9px] text-slate-500 uppercase font-bold">
                          <span>Edge</span>
                          <span className="flex gap-1.5 items-center">
                            <span className="text-slate-600 font-normal normal-case">{overlay.falloff <= 1.5 ? 'soft' : overlay.falloff <= 3.5 ? 'med' : 'sharp'}</span>
                            {Math.round((overlay.falloff - 0.5) / 5.5 * 100)}%
                          </span>
                        </div>
                        <input
                          type="range"
                          min="0.5" max="6" step="0.1"
                          value={overlay.falloff}
                          onChange={(e) => onModifyOverlay({ ...overlay, falloff: parseFloat(e.target.value) })}
                          onPointerUp={() => onCommitOverlay()}
                          className="w-full h-1 bg-slate-700 rounded-full appearance-none cursor-pointer accent-slate-400"
                        />
                        {overlay.type === PlanarAlignment.AIR && (
                          <>
                            <div className="flex justify-between text-[9px] text-slate-500 uppercase font-bold">
                              <span>Islands</span>
                              <span className="flex gap-1.5 items-center">
                                <span className="text-slate-600 font-normal normal-case">{overlay.fragmentation <= 0.3 ? 'huge' : overlay.fragmentation <= 0.7 ? 'mixed' : 'tiny'}</span>
                                {Math.round(overlay.fragmentation * 100)}%
                              </span>
                            </div>
                            <input
                              type="range"
                              min="0" max="1" step="0.01"
                              value={overlay.fragmentation}
                              onChange={(e) => onModifyOverlay({ ...overlay, fragmentation: parseFloat(e.target.value) })}
                              onPointerUp={() => onCommitOverlay()}
                              className="w-full h-1 bg-slate-700 rounded-full appearance-none cursor-pointer accent-slate-400"
                            />
                            <div className="flex justify-between text-[9px] text-slate-500 uppercase font-bold">
                              <span>Lift</span>
                              <span className="flex gap-1.5 items-center">
                                <span className="text-slate-600 font-normal normal-case">{overlay.lift <= 0.3 ? 'low' : overlay.lift <= 0.7 ? 'mid' : 'high'}</span>
                                {Math.round(overlay.lift * 100)}%
                              </span>
                            </div>
                            <input
                              type="range"
                              min="0" max="1" step="0.01"
                              value={overlay.lift}
                              onChange={(e) => onModifyOverlay({ ...overlay, lift: parseFloat(e.target.value) })}
                              onPointerUp={() => onCommitOverlay()}
                              className="w-full h-1 bg-slate-700 rounded-full appearance-none cursor-pointer accent-slate-400"
                            />
                          </>
                        )}
                        <div className="flex items-center gap-1 text-[9px] text-slate-600">
                          <Move size={8} />
                          <span>({Math.round(overlay.coordinates.q)}, {Math.round(overlay.coordinates.r)}) — drag on map</span>
                        </div>
                      </div>
                    </div>
                  ))}

                  {/* Add plane button / picker */}
                  {isAddPlaneOpen ? (
                    <div className="grid grid-cols-2 gap-1">
                      {AVAILABLE_PLANES.map(plane => (
                        <button
                          key={plane}
                          onClick={() => { onAddPlane(plane); setIsAddPlaneOpen(false); }}
                          className="flex items-center gap-1.5 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 transition-colors text-[10px] text-left"
                        >
                          <div
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: PLANAR_COLORS[plane] }}
                          />
                          <span className="truncate text-slate-300">{plane.replace('Plane of ', '')}</span>
                        </button>
                      ))}
                      <button
                        onClick={() => setIsAddPlaneOpen(false)}
                        className="col-span-2 text-[10px] text-slate-500 hover:text-slate-300 py-1 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setIsAddPlaneOpen(true)}
                      className="w-full flex items-center justify-center gap-1 text-[10px] font-bold text-fuchsia-400/60 hover:text-fuchsia-400 py-1.5 rounded-lg border border-dashed border-slate-700 hover:border-fuchsia-500/30 transition-all"
                    >
                      <Plus size={10} /> Add Plane
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* History — collapsed by default */}
            <div className="border-t border-slate-800/50 pt-2">
              <button
                onClick={() => setIsHistoryOpen(!isHistoryOpen)}
                className="w-full px-1 pb-1 text-[10px] font-bold text-slate-500 uppercase tracking-wider flex items-center justify-between hover:text-slate-300 transition-colors"
              >
                <span className="flex items-center gap-1">
                  {isHistoryOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                  History
                </span>
                <span className="bg-slate-800 text-slate-500 px-1.5 rounded text-[9px]">{actions.length}</span>
              </button>

              {isHistoryOpen && (
                <div className="space-y-0.5 pb-2 max-h-48 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-transparent">
                  {actions.map((action, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between px-2 py-1.5 rounded text-[10px] group hover:bg-slate-800/50 transition-colors"
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Clock size={9} className="shrink-0 text-slate-600" />
                        <span className="truncate text-slate-400">{getActionLabel(action)}</span>
                      </div>
                      {i > 0 && (
                        <button
                          onClick={() => onRemoveAction(i)}
                          className="shrink-0 text-slate-700 hover:text-rose-500 transition-colors p-0.5 opacity-0 group-hover:opacity-100"
                          title="Remove this action"
                        >
                          <Trash2 size={10} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
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
                onClick={onRedo}
                disabled={!canRedo}
                className="bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-700 border border-slate-700 text-slate-400 hover:text-white py-2 rounded-lg flex items-center justify-center transition-all"
                title="Redo"
              >
                <RotateCw size={14} />
              </button>
              <button
                onClick={onToggleGrid}
                className={`border py-2 rounded-lg flex items-center justify-center transition-all ${
                  showGrid
                    ? 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700 hover:text-white'
                    : 'bg-slate-800/50 border-slate-700/50 text-slate-600 hover:bg-slate-700 hover:text-white'
                }`}
                title={showGrid ? 'Hide Grid' : 'Show Grid'}
              >
                <Grid3x3 size={14} />
              </button>
            </div>

            <button
              onClick={onToggleGenBar}
              className={`w-full border text-[10px] font-bold py-2 rounded-lg flex items-center justify-center gap-1.5 transition-all ${
                isGenBarOpen
                  ? 'bg-indigo-950/40 border-indigo-500/30 text-indigo-400'
                  : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-indigo-950/30 hover:border-indigo-500/30 hover:text-indigo-400'
              }`}
            >
              <ChevronUp size={12} className={isGenBarOpen ? 'rotate-180' : ''} /> {isGenBarOpen ? 'CLOSE GEN' : 'WORLD GEN'}
            </button>

            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                onClick={onExport}
                className="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-400 hover:text-slate-200 text-[10px] font-bold py-2 rounded-lg flex items-center justify-center gap-1.5 transition-all"
              >
                <Download size={12} /> EXPORT
              </button>
              <button
                onClick={onImport}
                className="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-400 hover:text-slate-200 text-[10px] font-bold py-2 rounded-lg flex items-center justify-center gap-1.5 transition-all"
              >
                <Upload size={12} /> IMPORT
              </button>
            </div>
          </div>

        </div>
      )}
    </div>
  );
};
