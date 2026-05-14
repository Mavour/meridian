import { useEffect, useState } from 'react';

export default function Pools() {
  const [pools, setPools] = useState([]);

  useEffect(() => {
    fetch('/api/pools').then(r=>r.json()).then(setPools).catch(()=>{});
  }, []);

  return (
    <div style={{ padding:'12px 16px', maxWidth:1400 }}>
      <div style={{ background:'#111', border:'0.5px solid #222', borderRadius:8, overflow:'hidden' }}>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
          <thead>
            <tr>
              {['Name','Deploys','Wins','Losses','Avg PnL%','Last Deploy','Cooldown'].map(h => (
                <th key={h} style={{ fontSize:10, color:'#334155', textTransform:'uppercase', letterSpacing:'0.8px', fontWeight:400, textAlign:'left', padding:'8px 12px', borderBottom:'0.5px solid #1a1a1a' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pools.map((p, i) => (
              <tr key={p.id} style={{ ':hover':{ background:'#161616' } }}>
                <td style={{ padding:'8px 12px', color:'#cbd5e1', fontWeight:500, borderBottom:'0.5px solid #111' }}>{p.name}</td>
                <td style={{ padding:'8px 12px', color:'#94a3b8', borderBottom:'0.5px solid #111' }}>{p.deploys}</td>
                <td style={{ padding:'8px 12px', color:'#22c55e', borderBottom:'0.5px solid #111' }}>{p.wins}</td>
                <td style={{ padding:'8px 12px', color:'#ef4444', borderBottom:'0.5px solid #111' }}>{p.losses}</td>
                <td style={{ padding:'8px 12px', color: (p.avg_pnl||0)>=0?'#22c55e':'#ef4444', borderBottom:'0.5px solid #111' }}>
                  {(p.avg_pnl||0)>=0?'+':''}{(p.avg_pnl||0).toFixed(2)}%
                </td>
                <td style={{ padding:'8px 12px', color:'#475569', borderBottom:'0.5px solid #111', fontSize:11 }}>
                  {p.last_deploy ? new Date(p.last_deploy).toLocaleString() : '—'}
                </td>
                <td style={{ padding:'8px 12px', color:'#475569', borderBottom:'0.5px solid #111', fontSize:11 }}>
                  {p.cooldown_until ? new Date(p.cooldown_until).toLocaleString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
