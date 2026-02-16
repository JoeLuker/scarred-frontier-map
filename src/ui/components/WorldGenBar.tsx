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

type SliderDef = readonly [key: keyof WorldGenConfig, label: string];

const SLIDER_GROUPS: readonly { label: string; sliders: readonly SliderDef[] }[] = [
  {
    label: 'Landform',
    sliders: [
      ['continentScale', 'Continent Scale'],
      ['mountainLevel', 'Mountains'],
      ['ridgeSharpness', 'Ridge Sharpness'],
      ['plateauFactor', 'Plateau'],
      ['valleyDepth', 'Valley Depth'],
    ],
  },
  {
    label: 'Climate',
    sliders: [
      ['waterLevel', 'Water'],
      ['vegetationLevel', 'Vegetation'],
      ['temperature', 'Temperature'],
      ['riverDensity', 'Rivers'],
      ['coastComplexity', 'Coast Complexity'],
    ],
  },
  {
    label: 'Style',
    sliders: [
      ['ruggedness', 'Ruggedness'],
      ['erosion', 'Erosion'],
      ['chaos', 'Chaos'],
      ['verticality', 'Verticality'],
    ],
  },
];

export const WorldGenBar: React.FC<WorldGenBarProps> = ({ initialConfig, onPreview, onCheckpoint, onCancel, onClose }) => {
  const [config, setConfig] = useState<WorldGenConfig>(initialConfig);
  const [preserveExplored, setPreserveExplored] = useState(true);
  const [isDirty, setIsDirty] = useState(false);
  const rafRef = useRef(0);

  // Refs for unmount auto-commit
  const isDirtyRef = useRef(false);
  const configRef = useRef(config);
  const preserveExploredRef = useRef(preserveExplored);
  const pendingConfigRef = useRef<WorldGenConfig | null>(null);
  configRef.current = config;
  preserveExploredRef.current = preserveExplored;

  useEffect(() => {
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const schedulePreview = (newConfig: WorldGenConfig) => {
    setIsDirty(true);
    isDirtyRef.current = true;
    pendingConfigRef.current = newConfig;
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const pending = pendingConfigRef.current;
        if (pending) {
          pendingConfigRef.current = null;
          onPreview(pending, preserveExploredRef.current);
        }
      });
    }
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
      continentScale: Math.random(),
      temperature: Math.random(),
      ridgeSharpness: Math.random(),
      plateauFactor: Math.random() * 0.6,
      coastComplexity: Math.random() * 0.5,
      erosion: Math.random() * 0.6,
      valleyDepth: Math.random(),
      chaos: Math.random() * 0.4,
      verticality: 0.3 + Math.random() * 0.5,
    };
    setConfig(newConfig);
    schedulePreview(newConfig);
  };

  const reset = () => {
    setConfig(DEFAULT_WORLD_CONFIG);
    schedulePreview(DEFAULT_WORLD_CONFIG);
  };

  const handleCheckpoint = () => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    pendingConfigRef.current = null;
    onPreview(config, preserveExplored);
    onCheckpoint(config, preserveExplored);
    setIsDirty(false);
    isDirtyRef.current = false;
  };

  const handleDone = () => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    pendingConfigRef.current = null;
    if (isDirty) {
      onPreview(config, preserveExplored);
      onCheckpoint(config, preserveExplored);
    }
    onClose();
  };

  const handleCancel = () => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    pendingConfigRef.current = null;
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

      {/* Slider Groups */}
      <div className="flex gap-1 px-4 py-3 overflow-x-auto">
        {SLIDER_GROUPS.map(group => (
          <div key={group.label} className="flex-shrink-0">
            <div className="text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-1.5 px-1">{group.label}</div>
            <div className="flex items-center gap-3">
              {group.sliders.map(([key, label]) => (
                <div key={key} className="flex-shrink-0 min-w-[120px]">
                  <div className="flex justify-between text-[10px] font-bold uppercase tracking-wider mb-1">
                    <span className="text-slate-500">{label}</span>
                    <span className="text-indigo-400 tabular-nums">{Math.round(config[key] as number * 100)}%</span>
                  </div>
                  <input
                    type="range" min="0" max="1" step="0.01"
                    value={config[key] as number}
                    onChange={(e) => handleSliderChange(key, e.target.value)}
                    className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                  />
                </div>
              ))}
            </div>
          </div>
        ))}

        {/* Seed */}
        <div className="flex-shrink-0 self-end min-w-[100px]">
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
