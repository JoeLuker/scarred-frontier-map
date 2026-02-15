import React, { useState, useRef, useEffect } from 'react';
import { WorldGenConfig } from '../../core/types';
import { DEFAULT_WORLD_CONFIG } from '../../core/config';
import { RefreshCw, Lock, Unlock, Save, X, Check } from 'lucide-react';

interface WorldGenBarProps {
  initialConfig: WorldGenConfig;
  onPreview: (config: WorldGenConfig, preserveExplored: boolean) => void;
  onCheckpoint: (config: WorldGenConfig, preserveExplored: boolean) => void;
  onCancel: () => void;
  onClose: () => void;
}

const SLIDERS = [
  ['waterLevel', 'Water'],
  ['mountainLevel', 'Mountains'],
  ['vegetationLevel', 'Vegetation'],
  ['riverDensity', 'Rivers'],
  ['ruggedness', 'Ruggedness'],
] as const;

export const WorldGenBar: React.FC<WorldGenBarProps> = ({ initialConfig, onPreview, onCheckpoint, onCancel, onClose }) => {
  const [config, setConfig] = useState<WorldGenConfig>(initialConfig);
  const [preserveExplored, setPreserveExplored] = useState(true);
  const [isDirty, setIsDirty] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Refs for unmount auto-commit
  const isDirtyRef = useRef(false);
  const configRef = useRef(config);
  const preserveExploredRef = useRef(preserveExplored);
  configRef.current = config;
  preserveExploredRef.current = preserveExplored;

  useEffect(() => {
    return () => clearTimeout(timeoutRef.current);
  }, []);

  const schedulePreview = (newConfig: WorldGenConfig) => {
    setIsDirty(true);
    isDirtyRef.current = true;
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      onPreview(newConfig, preserveExploredRef.current);
    }, 16);
  };

  const handleSliderChange = (key: keyof WorldGenConfig, value: string) => {
    const newConfig = { ...config, [key]: parseFloat(value) } as WorldGenConfig;
    setConfig(newConfig);
    schedulePreview(newConfig);
  };

  const handleSeedChange = (value: string) => {
    const newConfig = { ...config, seed: parseInt(value) || 0 } as WorldGenConfig;
    setConfig(newConfig);
    schedulePreview(newConfig);
  };

  const randomize = () => {
    const newConfig: WorldGenConfig = {
      waterLevel: Math.random(),
      mountainLevel: Math.random(),
      vegetationLevel: Math.random(),
      riverDensity: Math.random(),
      ruggedness: Math.random(),
      seed: Math.floor(Math.random() * 99999),
    };
    setConfig(newConfig);
    schedulePreview(newConfig);
  };

  const reset = () => {
    setConfig(DEFAULT_WORLD_CONFIG);
    schedulePreview(DEFAULT_WORLD_CONFIG);
  };

  const handleCheckpoint = () => {
    clearTimeout(timeoutRef.current);
    onPreview(config, preserveExplored);
    onCheckpoint(config, preserveExplored);
    setIsDirty(false);
    isDirtyRef.current = false;
  };

  const handleDone = () => {
    clearTimeout(timeoutRef.current);
    if (isDirty) {
      onPreview(config, preserveExplored);
      onCheckpoint(config, preserveExplored);
    }
    onClose();
  };

  const handleCancel = () => {
    clearTimeout(timeoutRef.current);
    isDirtyRef.current = false; // Prevent any stale state
    onCancel();
  };

  return (
    <div className="bg-slate-950/95 backdrop-blur-xl border-t border-x border-slate-800 shadow-2xl rounded-t-xl animate-in slide-in-from-bottom-4 fade-in duration-200">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800/50">
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">World Generator</span>
          <button
            onClick={randomize}
            className="text-[10px] font-bold text-indigo-400 hover:text-indigo-300 flex items-center gap-1 transition-colors"
          >
            <RefreshCw size={10} /> Randomize
          </button>
          <button
            onClick={reset}
            className="text-[10px] font-bold text-slate-500 hover:text-slate-300 transition-colors"
          >
            Reset
          </button>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setPreserveExplored(!preserveExplored)}
            className={`flex items-center gap-1.5 text-[10px] font-bold px-2 py-1 rounded transition-colors ${
              preserveExplored
                ? 'text-indigo-400 bg-indigo-950/30 border border-indigo-500/20'
                : 'text-slate-500 bg-slate-800/50 border border-slate-700'
            }`}
          >
            {preserveExplored ? <Lock size={10} /> : <Unlock size={10} />}
            {preserveExplored ? 'Preserve Explored' : 'Full Regen'}
          </button>
          <button
            onClick={handleCheckpoint}
            className={`flex items-center gap-1 text-[10px] font-bold px-3 py-1 rounded transition-colors ${
              isDirty
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                : 'bg-slate-700 text-slate-500 cursor-default'
            }`}
            title="Save checkpoint (undo point)"
          >
            <Save size={10} /> Checkpoint
          </button>
          <button
            onClick={handleDone}
            className="flex items-center gap-1 text-[10px] font-bold px-3 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
            title="Keep changes and close"
          >
            <Check size={10} /> Done
          </button>
          <button
            onClick={handleCancel}
            className="text-slate-500 hover:text-white transition-colors p-1"
            title="Revert all changes and close"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Sliders */}
      <div className="flex items-center gap-4 px-4 py-3 overflow-x-auto">
        {SLIDERS.map(([key, label]) => (
          <div key={key} className="flex-shrink-0 flex items-center gap-2 min-w-[140px]">
            <div className="flex-1">
              <div className="flex justify-between text-[10px] font-bold uppercase tracking-wider mb-1">
                <span className="text-slate-500">{label}</span>
                <span className="text-indigo-400 tabular-nums">{Math.round(config[key] * 100)}%</span>
              </div>
              <input
                type="range" min="0" max="1" step="0.05"
                value={config[key]}
                onChange={(e) => handleSliderChange(key, e.target.value)}
                className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
              />
            </div>
          </div>
        ))}

        {/* Seed */}
        <div className="flex-shrink-0 min-w-[100px]">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Seed</div>
          <input
            type="number"
            value={config.seed}
            onChange={(e) => handleSeedChange(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 tabular-nums"
          />
        </div>
      </div>
    </div>
  );
};
