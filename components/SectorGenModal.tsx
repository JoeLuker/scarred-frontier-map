
import React, { useState, useEffect } from 'react';
import { HexData, WorldGenConfig } from '../types';
import { getBiomeAt } from '../services/biome';
import { Compass, Telescope, Sprout, Mountain, Waves, Sun, Wind, Check, AlertCircle } from 'lucide-react';

interface SectorGenModalProps {
  pendingSector: HexData | null;
  globalConfig: WorldGenConfig;
  onConfirm: (config: WorldGenConfig) => void;
  onCancel: () => void;
}

const BIOME_PRESETS = [
    {
        id: 'DEFAULT',
        name: 'Procedural Standard',
        desc: 'Follow the global world seed.',
        icon: Compass,
        color: 'text-slate-300',
        config: null // Use global
    },
    {
        id: 'OCEANIC',
        name: 'Archipelago',
        desc: 'Scattered islands in a vast sea.',
        icon: Waves,
        color: 'text-cyan-400',
        config: { waterLevel: 0.9, mountainLevel: 0.5, vegetationLevel: 0.7, riverDensity: 0.0, ruggedness: 0.2 }
    },
    {
        id: 'DESERT',
        name: 'Arid Wastes',
        desc: 'Dry badlands and sand dunes.',
        icon: Sun,
        color: 'text-orange-400',
        config: { waterLevel: 0.0, mountainLevel: 0.4, vegetationLevel: 0.0, riverDensity: 0.1, ruggedness: 0.4 }
    },
    {
        id: 'JUNGLE',
        name: 'Dense Jungle',
        desc: 'Heavy vegetation and rivers.',
        icon: Sprout,
        color: 'text-emerald-400',
        config: { waterLevel: 0.4, mountainLevel: 0.5, vegetationLevel: 1.0, riverDensity: 0.8, ruggedness: 0.6 }
    },
    {
        id: 'HIGHLAND',
        name: 'High Peaks',
        desc: 'Impassable mountains and cliffs.',
        icon: Mountain,
        color: 'text-indigo-400',
        config: { waterLevel: 0.3, mountainLevel: 1.0, vegetationLevel: 0.3, riverDensity: 0.6, ruggedness: 0.9 }
    },
];

export const SectorGenModal: React.FC<SectorGenModalProps> = ({ 
    pendingSector, 
    globalConfig,
    onConfirm, 
    onCancel 
}) => {
  const [selectedPresetId, setSelectedPresetId] = useState('DEFAULT');
  const [localConfig, setLocalConfig] = useState<WorldGenConfig>(globalConfig);
  const [previewFlavor, setPreviewFlavor] = useState<string>('');

  // When sector opens, reset config to global
  useEffect(() => {
    if (pendingSector) {
        setLocalConfig(globalConfig);
        setSelectedPresetId('DEFAULT');
        updatePreview(globalConfig);
    }
  }, [pendingSector, globalConfig]);

  const updatePreview = (cfg: WorldGenConfig) => {
      if (!pendingSector) return;
      // Sample the center of the sector to guess the biome flavor
      const { flavor, terrain } = getBiomeAt(pendingSector.coordinates.x, pendingSector.coordinates.y, cfg);
      setPreviewFlavor(`${flavor} (${terrain})`);
  };

  const handlePresetSelect = (preset: typeof BIOME_PRESETS[0]) => {
      setSelectedPresetId(preset.id);
      const newConfig = preset.config ? { ...globalConfig, ...preset.config } : globalConfig;
      setLocalConfig(newConfig);
      updatePreview(newConfig);
  };

  const handleSliderChange = (key: keyof WorldGenConfig, value: number) => {
      const newConfig = { ...localConfig, [key]: value };
      setLocalConfig(newConfig);
      setSelectedPresetId('CUSTOM');
      updatePreview(newConfig);
  };

  if (!pendingSector) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
        <div className="bg-slate-900 w-full max-w-2xl border border-slate-700 rounded-xl shadow-2xl overflow-hidden flex flex-col">
            
            {/* Header */}
            <div className="p-5 border-b border-slate-800 bg-slate-800/50 flex justify-between items-center">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-amber-600 rounded-lg flex items-center justify-center shadow-lg shadow-amber-900/40">
                        <Telescope className="text-white" size={20} />
                    </div>
                    <div>
                        <h2 className="text-xl font-bold text-white">Survey Sector</h2>
                        <p className="text-xs text-slate-400 font-mono">
                            COORD: {pendingSector.coordinates.x}, {pendingSector.coordinates.y}
                        </p>
                    </div>
                </div>
            </div>

            <div className="flex-1 p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
                
                {/* Left: Presets */}
                <div className="space-y-3">
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Biome Presets</label>
                    <div className="grid grid-cols-1 gap-2">
                        {BIOME_PRESETS.map(preset => (
                            <button
                                key={preset.id}
                                onClick={() => handlePresetSelect(preset)}
                                className={`flex items-center gap-3 p-3 rounded-lg border transition-all text-left group ${
                                    selectedPresetId === preset.id 
                                    ? 'bg-slate-800 border-amber-500/50 shadow-md' 
                                    : 'bg-slate-900 border-slate-700 hover:bg-slate-800'
                                }`}
                            >
                                <preset.icon size={18} className={preset.color} />
                                <div>
                                    <div className={`text-sm font-bold ${selectedPresetId === preset.id ? 'text-white' : 'text-slate-300'}`}>
                                        {preset.name}
                                    </div>
                                    <div className="text-[10px] text-slate-500">{preset.desc}</div>
                                </div>
                                {selectedPresetId === preset.id && <Check size={16} className="ml-auto text-amber-500" />}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Right: Fine Tuning & Preview */}
                <div className="space-y-6">
                    
                    {/* Oracle Preview */}
                    <div className="bg-slate-950/50 border border-slate-800 p-4 rounded-lg">
                        <div className="flex items-center gap-2 mb-2">
                            <Wind size={14} className="text-indigo-400" />
                            <span className="text-xs font-bold text-indigo-300 uppercase">Surveyor's Prediction</span>
                        </div>
                        <p className="text-sm text-slate-300 italic">
                            "The region appears to be dominantly <span className="text-white font-bold">{previewFlavor}</span>..."
                        </p>
                    </div>

                    {/* Sliders */}
                    <div className="space-y-4">
                        <div className="flex items-center justify-between text-xs font-bold text-slate-500 uppercase">
                            <span>Fine Tuning</span>
                            {selectedPresetId !== 'CUSTOM' && selectedPresetId !== 'DEFAULT' && <span className="text-amber-500">Preset Active</span>}
                        </div>
                        
                        <div className="space-y-1">
                            <div className="flex justify-between text-[10px] text-slate-400">
                                <span>Water Level</span>
                                <span>{Math.round(localConfig.waterLevel * 100)}%</span>
                            </div>
                            <input 
                                type="range" min="0" max="1" step="0.1" 
                                value={localConfig.waterLevel}
                                onChange={(e) => handleSliderChange('waterLevel', parseFloat(e.target.value))}
                                className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-slate-400"
                            />
                        </div>
                        <div className="space-y-1">
                            <div className="flex justify-between text-[10px] text-slate-400">
                                <span>Mountain Level</span>
                                <span>{Math.round(localConfig.mountainLevel * 100)}%</span>
                            </div>
                            <input 
                                type="range" min="0" max="1" step="0.1" 
                                value={localConfig.mountainLevel}
                                onChange={(e) => handleSliderChange('mountainLevel', parseFloat(e.target.value))}
                                className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-slate-400"
                            />
                        </div>
                        <div className="space-y-1">
                            <div className="flex justify-between text-[10px] text-slate-400">
                                <span>Vegetation</span>
                                <span>{Math.round(localConfig.vegetationLevel * 100)}%</span>
                            </div>
                            <input 
                                type="range" min="0" max="1" step="0.1" 
                                value={localConfig.vegetationLevel}
                                onChange={(e) => handleSliderChange('vegetationLevel', parseFloat(e.target.value))}
                                className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-slate-400"
                            />
                        </div>
                    </div>

                </div>
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-slate-800 bg-slate-800/30 flex justify-end gap-3">
                <button 
                    onClick={onCancel}
                    className="px-4 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors text-sm font-bold"
                >
                    Cancel
                </button>
                <button 
                    onClick={() => onConfirm(localConfig)}
                    className="px-6 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white shadow-lg shadow-amber-900/40 transition-all font-bold text-sm flex items-center gap-2"
                >
                    <Telescope size={16} />
                    Reveal Sector
                </button>
            </div>
        </div>
    </div>
  );
};
