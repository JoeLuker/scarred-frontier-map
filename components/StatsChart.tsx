
import React from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { HexData, TerrainType } from '../types';
import { TERRAIN_COLORS } from '../theme';

interface StatsChartProps {
  hexes: HexData[];
}

export const StatsChart: React.FC<StatsChartProps> = ({ hexes }) => {
  const data = React.useMemo(() => {
    const counts: Record<string, number> = {};
    // Initialize with 0, excluding EMPTY
    Object.values(TerrainType)
      .filter(t => t !== TerrainType.EMPTY)
      .forEach(t => counts[t] = 0);
    
    hexes.forEach(h => {
      if (h.terrain !== TerrainType.EMPTY) {
        counts[h.terrain] = (counts[h.terrain] || 0) + 1;
      }
    });

    return Object.entries(counts)
      .filter(([, value]) => value > 0)
      .map(([name, value]) => ({ name, value }));
  }, [hexes]);

  if (data.length === 0) {
    return <div className="text-center text-slate-500 py-10">No data to visualize</div>;
  }

  return (
    <div className="w-full h-64">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={60}
            outerRadius={80}
            paddingAngle={5}
            dataKey="value"
          >
            {data.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={TERRAIN_COLORS[entry.name as TerrainType] || '#8884d8'} />
            ))}
          </Pie>
          <Tooltip 
            contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', color: '#f1f5f9' }}
            itemStyle={{ color: '#f1f5f9' }}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="text-center text-xs text-slate-400 mt-2">Explored Terrain Distribution</div>
    </div>
  );
};
