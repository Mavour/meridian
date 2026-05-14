import { useEffect, useState, useContext } from 'react';
import { WSContext } from '../App';
import StatCard from '../components/StatCard';
import PositionCard from '../components/PositionCard';
import WaveChips from '../components/WaveChips';
import LogTerminal from '../components/LogTerminal';
import ClosedTable from '../components/ClosedTable';

const sectionLabel = { fontSize:10, color:'#334155', textTransform:'uppercase', letterSpacing:1, margin:'16px 0 8px' };
const page = { padding:'12px 16px', maxWidth:1400 };

export default function Dashboard() {
  const { events } = useContext(WSContext);
  const [perf, setPerf] = useState(null);
  const [positions, setPositions] = useState([]);
  const [waves, setWaves] = useState({});

  const reload = () => {
    fetch('/api/performance').then(r=>r.json()).then(setPerf).catch(()=>{});
    fetch('/api/positions').then(r=>r.json()).then(d=>setPositions(d.positions||[])).catch(()=>{});
    fetch('/api/waves').then(r=>r.json()).then(setWaves).catch(()=>{});
  };

  useEffect(() => { reload(); }, []);

  useEffect(() => {
    const last = events[events.length-1];
    if (!last) return;
    if (['state_update','perf_update','wave_update','close','deploy'].includes(last.type)) reload();
  }, [events]);

  const logEvents = events.filter(e => e.type === 'log').map(e => e.data);

  return (
    <div style={page}>
      <div className="stat-grid" style={{ gap:8, marginBottom:0 }}>
        <StatCard label="Open Positions" value={`${positions.length} / 1`} color="#a5b4fc" sub="max positions" />
        <StatCard label="Win Rate" value={perf ? `${perf.win_rate}%` : '—'} color="#22c55e" sub={`${perf?.total||0} closed`} />
        <StatCard label="All-time PnL" value={perf ? `${perf.total_pnl>=0?'+':''}$${perf.total_pnl.toFixed(2)}` : '—'} color={perf?.total_pnl>=0?'#22c55e':'#ef4444'} sub={`avg ${perf?.avg_win>=0?'+':''}$${perf?.avg_win?.toFixed(2)||'0.00'}`} />
        <StatCard label="Today Fees" value={perf ? `$${perf.today_fees_sol?.toFixed(4)||'0'}` : '—'} sub={`$${perf?.today_fees_usd?.toFixed(2)||'0.00'}`} />
      </div>

      <div style={sectionLabel}>Open Positions</div>
      {positions.length === 0
        ? <div style={{ color:'#334155', fontSize:12, padding:'8px 0' }}>No open positions</div>
        : <div className="pos-grid" style={{ gap:8 }}>
            {positions.map(p => <PositionCard key={p.position} pos={p} />)}
          </div>
      }

      <div style={sectionLabel}>Wave History</div>
      <WaveChips waves={waves} />

      <div style={sectionLabel}>Live Logs</div>
      <LogTerminal lines={logEvents} maxHeight={260} />

      <div style={sectionLabel}>Recent Closed</div>
      <ClosedTable rows={perf?.recent||[]} />
    </div>
  );
}
