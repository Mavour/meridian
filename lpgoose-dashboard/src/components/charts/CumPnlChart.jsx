import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

function fmt(value, unit = 'USD') {
  return unit === 'SOL' ? `${Number(value).toFixed(4)} SOL` : `$${Number(value).toFixed(2)}`;
}

export function CumPnlChart({ data = [], loading = false, unit = 'USD' }) {
  if (loading) return <div className="chart-empty">Loading trading history...</div>;
  if (data.length === 0) return <div className="chart-empty">No closed trades yet</div>;
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data}>
        <XAxis dataKey="trade_index" tick={{ fill:'#66758d', fontSize:11 }} axisLine={{ stroke:'#1a1a1a' }} />
        <YAxis tick={{ fill:'#475569', fontSize:11 }} axisLine={{ stroke:'#1a1a1a' }} tickFormatter={v => unit === 'SOL' ? `${Number(v).toFixed(3)}` : `$${v}`} />
        <Tooltip
          contentStyle={{ background:'#111', border:'0.5px solid #222', borderRadius:6, fontSize:12 }}
          labelStyle={{ color:'#94a3b8' }}
          labelFormatter={(v) => `Trade ${v}`}
          formatter={(v) => [fmt(v, unit), 'Cumulative PnL']}
        />
        <Line type="monotone" dataKey="cum" stroke="#a5b4fc" strokeWidth={1.5} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
