import React, { useState, useEffect } from 'react';
import { HexData, TerrainType, PlanarAlignment } from '../../core/types';
import { TERRAIN_PATHS, PLANAR_COLORS } from '../theme';
import { X, Save, Edit3, Sparkles } from 'lucide-react';

interface CurrentHexProps {
  hex: HexData | null;
  onUpdateHex: (hex: HexData) => void;
  onClose: () => void;
}

export const CurrentHex: React.FC<CurrentHexProps> = ({ hex, onUpdateHex, onClose }) => {
  const [isEditing, setIsEditing] = useState(false);

  const [editNotes, setEditNotes] = useState('');
  const [editTerrain, setEditTerrain] = useState<TerrainType>(TerrainType.PLAIN);

  useEffect(() => {
    setIsEditing(false);
    if (hex) {
      setEditNotes(hex.notes || '');
      setEditTerrain(hex.terrain);
    }
  }, [hex]);

  const handleSaveEdit = () => {
    if (!hex) return;
    onUpdateHex({
      ...hex,
      notes: editNotes,
      terrain: editTerrain,
    });
    setIsEditing(false);
  };

  if (!hex) return null;

  const iconPath = TERRAIN_PATHS[hex.terrain];
  const planarColor = hex.planarAlignment !== PlanarAlignment.MATERIAL ? PLANAR_COLORS[hex.planarAlignment] : undefined;

  return (
    <div className="bg-slate-900/95 backdrop-blur-md h-full flex flex-col border border-slate-700 shadow-2xl rounded-l-2xl overflow-hidden animate-in slide-in-from-right-10">

      {/* Header */}
      <div className="relative bg-slate-950 p-6 flex flex-col items-center justify-center border-b border-slate-800">
        <button
          onClick={onClose}
          className="absolute top-4 left-4 text-slate-500 hover:text-white transition-colors"
        >
          <X size={20} />
        </button>

        <div
          className="w-20 h-20 rounded-full border-2 border-slate-700 flex items-center justify-center text-slate-200 relative overflow-hidden shadow-inner mb-3"
          style={{
            backgroundColor: planarColor ? `${planarColor}33` : '#1e293b',
            borderColor: planarColor || '#334155',
          }}
        >
          <svg viewBox="0 0 24 24" className="w-10 h-10 stroke-current fill-none stroke-2 relative z-10">
            <path d={iconPath} />
          </svg>
        </div>

        <div className="text-center w-full">
          {isEditing ? (
            <select
              value={editTerrain}
              onChange={(e) => setEditTerrain(e.target.value as TerrainType)}
              className="bg-slate-800 text-slate-200 text-sm p-1 rounded border border-slate-600 outline-none w-full text-center"
            >
              {Object.values(TerrainType).filter(t => t !== TerrainType.EMPTY).map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          ) : (
            <h2 className="text-2xl font-bold text-slate-100">{hex.terrain}</h2>
          )}

          <p className="text-xs text-slate-500 font-mono mt-1">
            COORD: {hex.coordinates.q}, {hex.coordinates.r}
          </p>

          {hex.planarAlignment !== PlanarAlignment.MATERIAL && (
            <div
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider mt-2 border"
              style={{
                borderColor: planarColor,
                backgroundColor: `${planarColor}20`,
                color: planarColor,
              }}
            >
              <Sparkles size={10} />
              {hex.planarAlignment}
            </div>
          )}
        </div>

        <button
          onClick={() => setIsEditing(!isEditing)}
          className="absolute top-4 right-4 text-slate-500 hover:text-white transition-colors"
          title="Edit Hex Details"
        >
          {isEditing ? <X size={18} /> : <Edit3 size={18} />}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6 scrollbar-thin scrollbar-thumb-slate-700">

        {/* GM Notes */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">GM Notes</label>
          </div>
          {isEditing ? (
            <div className="space-y-2">
              <textarea
                className="w-full h-32 bg-slate-800 border border-slate-600 rounded p-2 text-sm text-slate-200 focus:ring-1 focus:ring-amber-500 outline-none resize-none"
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                placeholder="Add secret notes..."
              />
              <button
                onClick={handleSaveEdit}
                className="w-full bg-amber-700 hover:bg-amber-600 text-white text-xs font-bold py-2 rounded flex items-center justify-center gap-2"
              >
                <Save size={14} /> Save Changes
              </button>
            </div>
          ) : (
            <div className="bg-slate-800/50 p-3 rounded border border-slate-700/50 min-h-[3rem]">
              {hex.notes && hex.notes !== hex.groupId ? (
                <p className="text-sm text-slate-300 whitespace-pre-wrap">{hex.notes}</p>
              ) : (
                <p className="text-xs text-slate-600 italic">No notes added.</p>
              )}
            </div>
          )}
        </div>

        {/* Flavor Description */}
        {!isEditing && (
          <div className="space-y-2">
            <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Description</label>
            <div className="text-sm text-slate-400 italic leading-relaxed border-l-2 border-slate-700 pl-3">
              &ldquo;{hex.description || 'The mists obscure this land...'}&rdquo;
            </div>
          </div>
        )}

      </div>
    </div>
  );
};
