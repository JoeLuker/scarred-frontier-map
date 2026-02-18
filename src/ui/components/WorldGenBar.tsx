import React, { useState, useRef, useEffect } from 'react';
import { WorldGenConfig } from '../../core/types';
import { DEFAULT_WORLD_CONFIG } from '../../core/config';
import { RefreshCw, Save, X, Check, ChevronDown } from 'lucide-react';

interface WorldGenBarProps {
  initialConfig: WorldGenConfig;
  onPreview: (config: WorldGenConfig) => void;
  onCheckpoint: (config: WorldGenConfig) => void;
  onCancel: () => void;
  onClose: () => void;
}

type SliderDef = readonly [key: keyof WorldGenConfig, label: string];

const ESSENTIAL_SLIDERS: readonly SliderDef[] = [
  ['continentScale', 'Continent Scale'],
  ['waterLevel', 'Water Level'],
  ['mountainLevel', 'Mountains'],
  ['vegetationLevel', 'Vegetation'],
  ['temperature', 'Temperature'],
  ['ruggedness', 'Ruggedness'],
];

const ADVANCED_GROUPS: readonly { key: string; label: string; sliders: readonly SliderDef[] }[] = [
  {
    key: 'landform',
    label: 'Landform',
    sliders: [
      ['ridgeSharpness', 'Ridge Sharpness'],
      ['valleyDepth', 'Valley Depth'],
      ['plateauFactor', 'Plateau'],
      ['verticality', 'Verticality'],
    ],
  },
  {
    key: 'detail',
    label: 'Detail',
    sliders: [
      ['riverDensity', 'Rivers'],
      ['coastComplexity', 'Coast Complexity'],
      ['erosion', 'Erosion'],
      ['chaos', 'Chaos'],
    ],
  },
];

const SliderControl: React.FC<{
  sliderKey: keyof WorldGenConfig;
  label: string;
  value: number;
  onChange: (key: keyof WorldGenConfig, value: string) => void;
}> = ({ sliderKey, label, value, onChange }) => (
  <div className="min-w-[160px]">
    <div className="flex justify-between text-[10px] font-bold uppercase tracking-wider mb-1">
      <span className="text-slate-500">{label}</span>
      <span className="text-indigo-400 tabular-nums">{Math.round(value * 100)}%</span>
    </div>
    <input
      type="range" min="0" max="1" step="0.01"
      value={value}
      onChange={(e) => onChange(sliderKey, e.target.value)}
      className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
    />
  </div>
);

const AdvancedSection: React.FC<{
  label: string;
  expanded: boolean;
  onToggle: () => void;
  sliders: readonly SliderDef[];
  config: WorldGenConfig;
  onChange: (key: keyof WorldGenConfig, value: string) => void;
}> = ({ label, expanded, onToggle, sliders, config, onChange }) => (
  <div className="border-t border-slate-800/50">
    <button
      onClick={onToggle}
      className="flex items-center gap-2 w-full px-4 py-1.5 text-[10px] font-bold text-slate-500 uppercase tracking-widest hover:text-slate-300 transition-colors"
    >
      <ChevronDown
        size={12}
        className={`transition-transform duration-200 ${expanded ? 'rotate-0' : '-rotate-90'}`}
      />
      Advanced: {label}
    </button>
    <div
      className="overflow-hidden transition-all duration-200 ease-in-out"
      style={{ maxHeight: expanded ? '120px' : '0px', opacity: expanded ? 1 : 0 }}
    >
      <div className="flex flex-wrap gap-3 px-4 pb-2">
        {sliders.map(([key, lbl]) => (
          <SliderControl
            key={key}
            sliderKey={key}
            label={lbl}
            value={config[key] as number}
            onChange={onChange}
          />
        ))}
      </div>
    </div>
  </div>
);

export const WorldGenBar: React.FC<WorldGenBarProps> = ({ initialConfig, onPreview, onCheckpoint, onCancel, onClose }) => {
  const [config, setConfig] = useState<WorldGenConfig>(initialConfig);
  const [isDirty, setIsDirty] = useState(false);
  const [showLandform, setShowLandform] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const rafRef = useRef(0);

  // Refs for unmount auto-commit
  const isDirtyRef = useRef(false);
  const configRef = useRef(config);
  const pendingConfigRef = useRef<WorldGenConfig | null>(null);
  configRef.current = config;

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
          onPreview(pending);
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
    onPreview(config);
    onCheckpoint(config);
    setIsDirty(false);
    isDirtyRef.current = false;
  };

  const handleDone = () => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    pendingConfigRef.current = null;
    if (isDirty) {
      onPreview(config);
      onCheckpoint(config);
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

  const advancedToggle: Record<string, [boolean, () => void]> = {
    landform: [showLandform, () => setShowLandform(v => !v)],
    detail: [showDetail, () => setShowDetail(v => !v)],
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

      {/* Essential Sliders */}
      <div className="flex flex-wrap gap-3 px-4 py-3">
        {ESSENTIAL_SLIDERS.map(([key, label]) => (
          <SliderControl
            key={key}
            sliderKey={key}
            label={label}
            value={config[key] as number}
            onChange={handleSliderChange}
          />
        ))}
      </div>

      {/* Advanced Sections */}
      {ADVANCED_GROUPS.map(group => {
        const [expanded, toggle] = advancedToggle[group.key]!;
        return (
          <AdvancedSection
            key={group.key}
            label={group.label}
            expanded={expanded}
            onToggle={toggle}
            sliders={group.sliders}
            config={config}
            onChange={handleSliderChange}
          />
        );
      })}

      {/* Seed */}
      <div className="border-t border-slate-800/50 px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Seed</span>
          <input
            type="number"
            value={config.seed}
            onChange={(e) => handleSeedChange(e.target.value)}
            className="w-24 bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 tabular-nums"
          />
        </div>
      </div>
    </div>
  );
};
