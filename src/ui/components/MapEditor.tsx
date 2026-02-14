import React, { useState, useEffect } from 'react';
import { HexData } from '../../core/types';
import { X, Copy, Check, Save, FileJson } from 'lucide-react';

interface MapEditorProps {
  isOpen: boolean;
  onClose: () => void;
  hexes: HexData[];
  onImport: (data: HexData[]) => void;
}

export const MapEditor: React.FC<MapEditorProps> = ({ isOpen, onClose, hexes, onImport }) => {
  const [json, setJson] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setJson(JSON.stringify(hexes, null, 2));
      setError(null);
      setCopySuccess(false);
    }
  }, [isOpen, hexes]);

  const handleSave = () => {
    try {
      const parsed: unknown = JSON.parse(json);

      if (!Array.isArray(parsed)) {
        throw new Error('Root must be an array of HexData objects.');
      }

      parsed.forEach((hex: unknown, index: number) => {
        if (typeof hex !== 'object' || hex === null) {
          throw new Error(`Item at index ${index} is not an object.`);
        }

        const h = hex as Record<string, unknown>;

        if (!h['id'] || typeof h['id'] !== 'string') {
          throw new Error(`Item at index ${index} is missing a valid 'id'.`);
        }

        const coords = h['coordinates'];
        if (
          typeof coords !== 'object' ||
          coords === null ||
          typeof (coords as Record<string, unknown>)['q'] !== 'number' ||
          typeof (coords as Record<string, unknown>)['r'] !== 'number'
        ) {
          throw new Error(`Item at index ${index} (ID: ${String(h['id'])}) has invalid coordinates. Must have q and r numbers.`);
        }

        if (!h['terrain']) {
          throw new Error(`Item at index ${index} (ID: ${String(h['id'])}) is missing 'terrain'.`);
        }
      });

      onImport(parsed as HexData[]);
      onClose();
    } catch (e: unknown) {
      if (e instanceof Error) {
        setError(e.message);
      } else {
        setError('Unknown error parsing JSON');
      }
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch {
      setError('Failed to copy to clipboard');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 sm:p-8">
      <div className="bg-slate-900 w-full h-full max-w-6xl border border-slate-700 rounded-xl flex flex-col shadow-2xl overflow-hidden">

        <div className="flex items-center justify-between p-4 border-b border-slate-800 bg-slate-800/50">
          <div className="flex items-center gap-2">
            <FileJson className="text-amber-500" size={24} />
            <div>
              <h2 className="text-xl font-bold text-amber-500">Map Data Editor (JSON)</h2>
              <p className="text-xs text-slate-400">Directly manipulate the hex grid state.</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <X size={24} />
          </button>
        </div>

        <div className="flex-1 relative">
          <textarea
            className="w-full h-full bg-slate-950 text-emerald-400 font-mono text-sm p-4 focus:outline-none resize-none"
            value={json}
            onChange={(e) => setJson(e.target.value)}
            spellCheck={false}
          />
        </div>

        <div className="p-4 border-t border-slate-800 bg-slate-800/50 flex items-center justify-between">
          <div className="text-rose-400 text-sm font-mono flex-1 mr-4">
            {error && <span className="flex items-center gap-1"><X size={14} /> {error}</span>}
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleCopy}
              className="px-4 py-2 rounded border border-slate-600 text-slate-300 hover:bg-slate-700 transition-colors text-sm font-semibold flex items-center gap-2"
            >
              {copySuccess ? <Check size={16} /> : <Copy size={16} />}
              {copySuccess ? 'Copied!' : 'Copy to Clipboard'}
            </button>
            <button
              onClick={handleSave}
              className="px-6 py-2 rounded bg-amber-600 hover:bg-amber-500 text-white shadow-lg shadow-amber-900/20 transition-all text-sm font-bold flex items-center gap-2"
            >
              <Save size={16} />
              Apply Changes
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
