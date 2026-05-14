import { ScatterChart, Scatter, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

export function HoldScatter({ data = [] }) {
  const chartData = data
    .filter(l => l.minutes_held != null && l.pnl_pct != null)
    .map(l => ({ x: l.minutes_held, y: l.pnl_pct, name: l.pool_name }));

  if (chartData.length === 0) return <div style={{ color:'#475569', fontSize:12 }}>No data yet</div>;
  return (
    <ResponsiveContainer width="100%" height={200}>
      <ScatterChart>
        <XAxis dataKey="x" tick={{ fill:'#475569', fontSize:11 }} axisLine={{ stroke:'#1a1a1a' }} label={{ value:'Hold (min)', position:'bottom', fill:'#475569', fontSize:10 }} />
        <YAxis dataKey="y" tick={{ fill:'#475569', fontSize:11 }} axisLine={{ stroke:'#1a1a1a' }} label={{ value:'PnL%', angle:-90, position:'insideLeft', fill:'#475569', fontSize:10 }} />
        <Tooltip
          contentStyle={{ background:'#111', border:'0.5px solid #222', borderRadius:6, fontSize:12 }}
          labelStyle={{ color:'#94a3b8' }}
          formatter={(v, name) => [name === 'x' ? `${v}m` : `${v.toFixed(2)}%`, name === 'x' ? 'Hold' : 'PnL%']}
        />
        <Scatter data={chartData} fill="#a5b4fc" />
      </ScatterChart>
    </ResponsiveContainer>
  );
}
