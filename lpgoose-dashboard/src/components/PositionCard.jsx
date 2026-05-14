export default function PositionCard({ pos }) {
  const sl = -10;
  const pnl = pos.pnl_pct || 0;
  const peak = pos.peak_pnl_pct || 0;
  const inRange = pos.in_range;
  const isOOR = !inRange;
  const nearSL = pnl <= sl * 0.7;

  const borderColor = isOOR ? '#7f1d1d' : nearSL ? '#78350f' : '#166534';
  const badgeStyle = isOOR
    ? { background:'#1a0000', color:'#f87171', border:'0.5px solid #7f1d1d' }
    : { background:'#052e16', color:'#4ade80', border:'0.5px solid #166534' };

  const range = Math.abs(sl) + 10;
  const fillPct = Math.min(100, Math.max(0, ((pnl - sl) / range) * 100));
  const zeroPct = (Math.abs(sl) / range) * 100;

  return (
    <div style={{ background:'#111', border:'0.5px solid #222', borderRadius:8, borderLeft:`2px solid ${borderColor}`, padding:14 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:10 }}>
        <div>
          <div style={{ fontSize:14, fontWeight:600 }}>{pos.pair}</div>
          <div style={{ fontSize:11, color:'#475569', marginTop:2 }}>
            {pos.strategy} · {pos.bins_below||'?'} bins · step {pos.bin_step||'?'}
          </div>
        </div>
        <span style={{ fontSize:10, padding:'2px 8px', borderRadius:20, fontWeight:500, ...badgeStyle }}>
          {isOOR ? `OOR ${pos.minutes_oor||0}m` : 'IN RANGE'}
        </span>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8, marginBottom:10 }}>
        {[
          ['Val', `$${(pos.total_value_usd||0).toFixed(2)}`],
          ['Unclaimed', `$${(pos.unclaimed_fees_usd||0).toFixed(2)}`, '#4ade80'],
          ['Age', `${pos.age_minutes||0}m`],
          ['Yield', `${(pos.yield_pct||0).toFixed(1)}%`],
        ].map(([label, val, color]) => (
          <div key={label}>
            <div style={{ fontSize:10, color:'#475569', marginBottom:2 }}>{label}</div>
            <div style={{ fontSize:12, color: color||'#cbd5e1' }}>{val}</div>
          </div>
        ))}
      </div>

      <div style={{ background:'#1a1a1a', borderRadius:3, height:4, position:'relative', margin:'8px 0' }}>
        <div style={{ height:4, borderRadius:3, position:'absolute', top:0, left:0, width:`${fillPct}%`, background: pnl>=0?'#22c55e':'#ef4444', transition:'width 0.3s' }} />
        <div style={{ position:'absolute', top:-2, left:`${zeroPct}%`, width:1, height:8, background:'#334155' }} />
      </div>

      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <span style={{ fontSize:11, color:'#475569' }}>SL {sl}%</span>
        <span style={{ fontSize:18, fontWeight:600, color: pnl>=0?'#22c55e':'#ef4444' }}>
          {pnl>=0?'+':''}{pnl.toFixed(2)}%
        </span>
        <span style={{ fontSize:11, color:'#475569' }}>Peak {peak>=0?'+':''}{peak.toFixed(2)}%</span>
      </div>
    </div>
  );
}
