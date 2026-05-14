export default function ClosedTable({ rows = [] }) {
  return (
    <div style={{ background:'#111', border:'0.5px solid #222', borderRadius:8, overflow:'hidden' }}>
      <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
        <thead>
          <tr>
            {['Token','PnL%','USD','Hold','Reason'].map(h => (
              <th key={h} style={{ fontSize:10, color:'#334155', textTransform:'uppercase', letterSpacing:'0.8px', fontWeight:400, textAlign:'left', padding:'6px 10px', borderBottom:'0.5px solid #1a1a1a' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td style={{ padding:'6px 10px', color:'#cbd5e1', fontWeight:500, borderBottom:'0.5px solid #111' }}>{r.pool_name||'—'}</td>
              <td style={{ padding:'6px 10px', borderBottom:'0.5px solid #111', color:(r.pnl_pct||0)>=0?'#22c55e':'#ef4444' }}>
                {(r.pnl_pct||0)>=0?'+':''}{(r.pnl_pct||0).toFixed(2)}%
              </td>
              <td style={{ padding:'6px 10px', borderBottom:'0.5px solid #111', color:(r.pnl_usd||0)>=0?'#22c55e':'#ef4444' }}>
                {(r.pnl_usd||0)>=0?'+':''}${Math.abs(r.pnl_usd||0).toFixed(2)}
              </td>
              <td style={{ padding:'6px 10px', borderBottom:'0.5px solid #111', color:'#94a3b8' }}>
                {r.minutes_held ? (r.minutes_held >= 60 ? `${Math.floor(r.minutes_held/60)}h ${r.minutes_held%60}m` : `${r.minutes_held}m`) : '—'}
              </td>
              <td style={{ padding:'6px 10px', borderBottom:'0.5px solid #111', color:'#475569', maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                {r.close_reason||'—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
