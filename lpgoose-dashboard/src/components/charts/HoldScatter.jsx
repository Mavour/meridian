import { ScatterChart, Scatter, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

export function HoldScatter({ data = [], loading = false }) {
  const chartData = data
    .map((trade) => ({
      x: Number(trade.hold_duration ?? trade.minutes_held),
      y: Number(trade.pnl_pct),
      name: trade.pool_name,
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));

  if (loading) return <div className="chart-empty">Loading trading history...</div>;
  if (chartData.length === 0) return <div className="chart-empty">No closed trades with hold time yet</div>;
  return (
    <ResponsiveContainer width="100%" height={200}>
      <ScatterChart>
        <XAxis dataKey="x" tick={{ fill:'#475569', fontSize:11 }} axisLine={{ stroke:'#1a1a1a' }} label={{ value:'Hold (min)', position:'bottom', fill:'#475569', fontSize:10 }} />
        <YAxis dataKey="y" tick={{ fill:'#475569', fontSize:11 }} axisLine={{ stroke:'#1a1a1a' }} label={{ value:'PnL%', angle:-90, position:'insideLeft', fill:'#475569', fontSize:10 }} />
        <Tooltip
          contentStyle={{ background:'#111', border:'0.5px solid #222', borderRadius:6, fontSize:12 }}
          labelStyle={{ color:'#94a3b8' }}
          formatter={(v, name) => [name === 'x' ? `${Number(v).toFixed(0)}m` : `${Number(v).toFixed(2)}%`, name === 'x' ? 'Hold' : 'PnL%']}
        />
        <Scatter data={chartData} fill="#a5b4fc" />
      </ScatterChart>
    </ResponsiveContainer>
  );
}
