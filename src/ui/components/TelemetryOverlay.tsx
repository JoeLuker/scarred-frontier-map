import React, { useEffect, useState } from 'react';
import { useWorld } from '../WorldContext';
import type { TelemetrySnapshot } from '../../ecs/telemetry/Telemetry';

/**
 * In-app telemetry overlay. Updates at 4Hz (not every frame) to avoid
 * React re-renders affecting the metrics it's measuring.
 */
export function TelemetryOverlay() {
  const world = useWorld();
  const [snap, setSnap] = useState<TelemetrySnapshot | null>(null);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setSnap(world.getTelemetry());
    }, 250);
    return () => clearInterval(interval);
  }, [world]);

  if (!snap) return null;

  return (
    <div className="absolute top-4 right-4 pointer-events-auto">
      <button
        onClick={() => setVisible(v => !v)}
        className="text-xs text-slate-500 hover:text-slate-300 mb-1"
      >
        {visible ? 'hide' : 'perf'}
      </button>
      {visible && (
        <div className="bg-slate-900/90 backdrop-blur-sm rounded-lg px-3 py-2 text-xs font-mono text-slate-300 space-y-0.5 min-w-[200px]">
          <Row label="fps" value={snap.fps} unit="" color={snap.fps >= 55 ? 'text-green-400' : snap.fps >= 30 ? 'text-yellow-400' : 'text-red-400'} />
          <Row label="frame" value={snap.frameTimeAvg} unit="ms" max={snap.frameTimeMax} />
          <div className="border-t border-slate-700/50 my-1" />
          <Row label="sim" value={snap.simTimeAvg} unit="ms" />
          <Row label="ticks/f" value={snap.simTicksPerFrame} unit="" />
          <Row label="uniform" value={snap.uniformTimeAvg} unit="ms" />
          <Row label="render" value={snap.renderTimeAvg} unit="ms" />
          {snap.gpuSupported && (
            <>
              <div className="border-t border-slate-700/50 my-1" />
              <div className="text-slate-500 text-[10px]">GPU</div>
              <Row label="water" value={snap.gpuShallowWater} unit="ms" precision={3} />
              <Row label="inject" value={snap.gpuSourceInjection} unit="ms" precision={3} />
              <Row label="render" value={snap.gpuRender} unit="ms" precision={3} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, unit, max, precision = 2, color }: {
  label: string;
  value: number;
  unit: string;
  max?: number;
  precision?: number;
  color?: string;
}) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-slate-500">{label}</span>
      <span className={color ?? 'text-slate-300'}>
        {value.toFixed(precision)}{unit}
        {max !== undefined && <span className="text-slate-600 ml-1">({max.toFixed(1)})</span>}
      </span>
    </div>
  );
}
