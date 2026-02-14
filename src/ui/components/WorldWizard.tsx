import React, { useState } from 'react';
import { WorldGenConfig } from '../../core/types';
import { DEFAULT_WORLD_CONFIG } from '../../core/config';
import { Wand2, X, RefreshCw, Lock, Unlock } from 'lucide-react';

interface WorldWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onGenerate: (config: WorldGenConfig, preserveExplored: boolean) => void;
}

export const WorldWizard: React.FC<WorldWizardProps> = ({ isOpen, onClose, onGenerate }) => {
  const [config, setConfig] = useState<WorldGenConfig>(DEFAULT_WORLD_CONFIG);
  const [preserveExplored, setPreserveExplored] = useState(true);

  if (!isOpen) return null;

  const handleSliderChange = (key: keyof WorldGenConfig, value: string) => {
    setConfig(prev => ({
      ...prev,
      [key]: parseFloat(value),
    }));
  };

  const randomize = () => {
    setConfig({
      waterLevel: Math.random(),
      mountainLevel: Math.random(),
      vegetationLevel: Math.random(),
      riverDensity: Math.random(),
      ruggedness: Math.random(),
      seed: Math.floor(Math.random() * 99999),
    });
  };

  const handleSubmit = () => {
    onGenerate(config, preserveExplored);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 w-full max-w-md border border-slate-700 rounded-xl shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-200">

        <div className="p-5 border-b border-slate-800 flex justify-between items-center bg-slate-800/30">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg">
              <Wand2 className="text-white" size={20} />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">World Architect</h2>
              <p className="text-xs text-slate-400">Configure procedural parameters</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">
            <X size={24} />
          </button>
        </div>

        <div className="p-6 space-y-6">
          <div className="space-y-4">
            {([
              ['waterLevel', 'Water Level'],
              ['mountainLevel', 'Mountain Range Density'],
              ['vegetationLevel', 'Vegetation'],
              ['riverDensity', 'River Density'],
              ['ruggedness', 'World Ruggedness (Scale)'],
            ] as const).map(([key, label]) => (
              <div key={key} className="space-y-1">
                <div className="flex justify-between text-xs font-bold uppercase tracking-wider text-slate-400">
                  <span>{label}</span>
                  <span className="text-indigo-400">{Math.round(config[key] * 100)}%</span>
                </div>
                <input
                  type="range" min="0" max="1" step="0.05"
                  value={config[key]}
                  onChange={(e) => handleSliderChange(key, e.target.value)}
                  className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                />
              </div>
            ))}

            <div className="space-y-1 pt-2">
              <div className="flex justify-between text-xs font-bold uppercase tracking-wider text-slate-400">
                <span>World Seed</span>
                <button onClick={randomize} className="text-indigo-400 flex items-center gap-1 hover:text-indigo-300">
                  <RefreshCw size={10} /> Randomize
                </button>
              </div>
              <input
                type="number"
                value={config.seed}
                onChange={(e) => setConfig(prev => ({ ...prev, seed: parseInt(e.target.value) || 0 }))}
                className="w-full bg-slate-800 border border-slate-600 rounded p-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          <div
            className="bg-slate-800/50 p-3 rounded-lg border border-slate-700 flex items-center justify-between cursor-pointer hover:bg-slate-800 transition-colors"
            onClick={() => setPreserveExplored(!preserveExplored)}
          >
            <div className="flex items-center gap-3">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${preserveExplored ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-slate-500'}`}>
                {preserveExplored ? <Lock size={14} /> : <Unlock size={14} />}
              </div>
              <div>
                <div className="text-sm font-bold text-slate-200">Preserve Explored Areas</div>
                <div className="text-[10px] text-slate-400">If checked, only hidden hexes change.</div>
              </div>
            </div>
            <div className={`w-10 h-5 rounded-full relative transition-colors ${preserveExplored ? 'bg-indigo-600' : 'bg-slate-600'}`}>
              <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${preserveExplored ? 'left-6' : 'left-1'}`} />
            </div>
          </div>
        </div>

        <div className="p-5 border-t border-slate-800 bg-slate-800/30 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-3 rounded-lg border border-slate-600 text-slate-400 hover:text-white hover:bg-slate-700 transition-colors font-bold text-sm"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            className="flex-[2] py-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-900/40 transition-all font-bold text-sm"
          >
            {preserveExplored ? 'Update Unexplored Regions' : 'Generate New World'}
          </button>
        </div>

      </div>
    </div>
  );
};
