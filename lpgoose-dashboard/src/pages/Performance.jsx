import { useEffect, useState } from 'react';
import { CumPnlChart } from '../components/charts/CumPnlChart';
import { WinLossBar } from '../components/charts/WinLossBar';
import { HoldScatter } from '../components/charts/HoldScatter';

const sectionLabel = { fontSize:10, color:'#334155', textTransform:'uppercase', letterSpacing:1, margin:'16px 0 8px' };

export default function Performance() {
  const [perf, setPerf] = useState(null);
  const [lessons, setLessons] = useState([]);

  useEffect(() => {
    fetch('/api/performance').then(r=>r.json()).then(setPerf).catch(()=>{});
    fetch('/api/lessons').then(r=>r.json()).then(setLessons).catch(()=>{});
  }, []);

  const trades = lessons.filter(l => l.pnl_pct != null);
  const cumData = trades.map((l, i) => ({
    i,
    cum: trades.slice(0, i+1).reduce((s, t) => s + (t.pnl_usd||0), 0),
    ...l,
  }));
  const wlbData = [
    { name: 'Wins', value: perf?.wins||0, fill: '#22c55e' },
    { name: 'Losses', value: perf?.losses||0, fill: '#ef4444' },
  ];

  return (
    <div style={{ padding:'12px 16px', maxWidth:1400 }}>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8 }}>
        <div style={{ background:'#111', border:'0.5px solid #222', borderRadius:8, padding:'14px 16px' }}>
          <div style={{ fontSize:10, color:'#475569', textTransform:'uppercase', letterSpacing:'0.8px', marginBottom:4 }}>Total Trades</div>
          <div style={{ fontSize:24, fontWeight:600 }}>{perf?.total||0}</div>
        </div>
        <div style={{ background:'#111', border:'0.5px solid #222', borderRadius:8, padding:'14px 16px' }}>
          <div style={{ fontSize:10, color:'#475569', textTransform:'uppercase', letterSpacing:'0.8px', marginBottom:4 }}>Win Rate</div>
          <div style={{ fontSize:24, fontWeight:600, color: (perf?.win_rate||0) >= 50 ? '#22c55e' : '#ef4444' }}>{perf?.win_rate||0}%</div>
        </div>
        <div style={{ background:'#111', border:'0.5px solid #222', borderRadius:8, padding:'14px 16px' }}>
          <div style={{ fontSize:10, color:'#475569', textTransform:'uppercase', letterSpacing:'0.8px', marginBottom:4 }}>Avg Win / Loss</div>
          <div style={{ fontSize:24, fontWeight:600 }}>
            <span style={{color:'#22c55e'}}>+${(perf?.avg_win||0).toFixed(2)}</span>
            <span style={{fontSize:14, color:'#475569', margin:'0 4px'}}>/</span>
            <span style={{color:'#ef4444'}}>-${Math.abs(perf?.avg_loss||0).toFixed(2)}</span>
          </div>
        </div>
        <div style={{ background:'#111', border:'0.5px solid #222', borderRadius:8, padding:'14px 16px' }}>
          <div style={{ fontSize:10, color:'#475569', textTransform:'uppercase', letterSpacing:'0.8px', marginBottom:4 }}>Total PnL</div>
          <div style={{ fontSize:24, fontWeight:600, color: (perf?.total_pnl||0) >= 0 ? '#22c55e' : '#ef4444' }}>
            {(perf?.total_pnl||0) >= 0 ? '+' : ''}${(perf?.total_pnl||0).toFixed(2)}
          </div>
        </div>
      </div>

      <div style={sectionLabel}>Cumulative PnL</div>
      <div style={{ background:'#111', border:'0.5px solid #222', borderRadius:8, padding:16 }}>
        <CumPnlChart data={cumData} />
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginTop:16 }}>
        <div style={{ background:'#111', border:'0.5px solid #222', borderRadius:8, padding:16 }}>
          <div style={sectionLabel}>Win / Loss Distribution</div>
          <WinLossBar data={wlbData} />
        </div>
        <div style={{ background:'#111', border:'0.5px solid #222', borderRadius:8, padding:16 }}>
          <div style={sectionLabel}>Hold Time vs PnL</div>
          <HoldScatter data={trades} />
        </div>
      </div>
    </div>
  );
}
