import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

export function WinLossBar({ data = [], loading = false }) {
  if (loading) return <div className="chart-empty">Loading trading history...</div>;
  if (data.length === 0) return <div className="chart-empty">No closed trades yet</div>;
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data}>
        <XAxis dataKey="name" tick={{ fill:'#94a3b8', fontSize:11 }} axisLine={{ stroke:'#1a1a1a' }} />
        <YAxis tick={{ fill:'#475569', fontSize:11 }} axisLine={{ stroke:'#1a1a1a' }} />
        <Tooltip
          contentStyle={{ background:'#111', border:'0.5px solid #222', borderRadius:6, fontSize:12 }}
          labelStyle={{ color:'#94a3b8' }}
        />
        <Bar dataKey="value" radius={[3,3,0,0]} isAnimationActive={false}>
          {data.map((entry) => <Cell key={entry.name} fill={entry.fill} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
