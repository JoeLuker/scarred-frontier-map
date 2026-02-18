import React from 'react';
import { PlanarOverlay, PlanarAlignment } from '../../core/types';
import { WORLD } from '../../core/config';
import { PLANAR_COLORS } from '../theme';
import { Trash2, Move, Layers, X, GripVertical } from 'lucide-react';

interface PlanarManagerProps {
  overlays: PlanarOverlay[];
  onAdd: (type: PlanarAlignment) => void;
  onRemove: (id: string) => void;
  onModify: (overlay: PlanarOverlay) => void;
  isOpen: boolean;
  onClose: () => void;
}

const AVAILABLE_PLANES = [
  PlanarAlignment.FIRE,
  PlanarAlignment.WATER,
  PlanarAlignment.AIR,
  PlanarAlignment.EARTH,
  PlanarAlignment.POSITIVE,
  PlanarAlignment.NEGATIVE,
  PlanarAlignment.SCAR,
];

export const PlanarManager: React.FC<PlanarManagerProps> = ({
  overlays,
  onAdd,
  onRemove,
  onModify,
  isOpen,
  onClose,
}) => {
  if (!isOpen) return null;

  return (
    <div className="absolute top-4 left-20 bottom-4 w-80 bg-slate-900/95 backdrop-blur-md border border-slate-700 shadow-2xl rounded-xl flex flex-col z-30 animate-in slide-in-from-left-4">

      <div className="p-4 border-b border-slate-800 flex justify-between items-center">
        <div className="flex items-center gap-2 text-fuchsia-400">
          <Layers size={20} />
          <h2 className="font-bold">Planar Layers</h2>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-white">
          <X size={20} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {overlays.length === 0 && (
          <div className="text-center p-6 border-2 border-dashed border-slate-800 rounded-lg text-slate-600 text-sm">
            No active planar overlays. Drag planes here to mutate the terrain.
          </div>
        )}

        {overlays.map((overlay) => (
          <div
            key={overlay.id}
            className="bg-slate-800 rounded-lg border border-slate-700 p-3 shadow-sm hover:border-slate-500 transition-colors group"
          >
            <div className="flex justify-between items-start mb-2">
              <div className="flex items-center gap-2">
                <GripVertical size={14} className="text-slate-600 cursor-move" />
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: PLANAR_COLORS[overlay.type] }}
                />
                <span className="font-bold text-slate-200 text-sm">{overlay.type}</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => onRemove(overlay.id)}
                  className="text-slate-500 hover:text-rose-500 transition-colors p-1"
                  title="Remove Layer"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>

            <div className="space-y-2 pl-5">
              <div className="space-y-1">
                <div className="flex justify-between text-[10px] text-slate-500 uppercase font-bold">
                  <span>Radius</span>
                  <span>{overlay.radius} hexes</span>
                </div>
                <input
                  type="range"
                  min="2" max={WORLD.GRID_RADIUS + 5} step="1"
                  value={overlay.radius}
                  onChange={(e) => onModify({ ...overlay, radius: parseInt(e.target.value) })}
                  className="w-full h-1.5 bg-slate-700 rounded-full appearance-none cursor-pointer accent-slate-400"
                />
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-[10px] text-slate-500 uppercase font-bold">
                  <span>Intensity</span>
                  <span>{Math.round(overlay.intensity * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0" max="1" step="0.01"
                  value={overlay.intensity}
                  onChange={(e) => onModify({ ...overlay, intensity: parseFloat(e.target.value) })}
                  className="w-full h-1.5 bg-slate-700 rounded-full appearance-none cursor-pointer accent-slate-400"
                />
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-[10px] text-slate-500 uppercase font-bold">
                  <span>Falloff</span>
                  <span>{overlay.falloff.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min="0.5" max="6" step="0.1"
                  value={overlay.falloff}
                  onChange={(e) => onModify({ ...overlay, falloff: parseFloat(e.target.value) })}
                  className="w-full h-1.5 bg-slate-700 rounded-full appearance-none cursor-pointer accent-slate-400"
                />
              </div>

              <div className="flex justify-between text-[10px] text-slate-500">
                <span>POS: {Math.round(overlay.coordinates.q)}, {Math.round(overlay.coordinates.r)}</span>
                <div className="flex items-center gap-1 text-sky-400">
                  <Move size={10} />
                  <span>Drag on map</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="p-4 border-t border-slate-800 bg-slate-950/50">
        <h3 className="text-xs font-bold text-slate-500 uppercase mb-3">Add New Plane</h3>
        <div className="grid grid-cols-2 gap-2">
          {AVAILABLE_PLANES.map(plane => (
            <button
              key={plane}
              onClick={() => onAdd(plane)}
              className="flex items-center gap-2 px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 transition-colors text-xs text-left"
            >
              <div
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: PLANAR_COLORS[plane] }}
              />
              <span className="truncate text-slate-300">{plane.replace('Plane of ', '')}</span>
            </button>
          ))}
        </div>
      </div>

    </div>
  );
};
