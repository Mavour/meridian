import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

export function CumPnlChart({ data = [] }) {
  if (data.length === 0) return <div style={{ color:'#475569', fontSize:12 }}>No data yet</div>;
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data}>
        <XAxis dataKey="i" tick={false} axisLine={{ stroke:'#1a1a1a' }} />
        <YAxis tick={{ fill:'#475569', fontSize:11 }} axisLine={{ stroke:'#1a1a1a' }} tickFormatter={v => `$${v}`} />
        <Tooltip
          contentStyle={{ background:'#111', border:'0.5px solid #222', borderRadius:6, fontSize:12 }}
          labelStyle={{ color:'#94a3b8' }}
          formatter={(v) => [`$${v.toFixed(2)}`, 'PnL']}
        />
        <Line type="monotone" dataKey="cum" stroke="#a5b4fc" strokeWidth={1.5} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
