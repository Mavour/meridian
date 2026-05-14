import { NavLink } from 'react-router-dom';
import { useEffect, useState } from 'react';

export default function Topbar({ botAlive }) {
  const [balance, setBalance] = useState(null);
  useEffect(() => {
    fetch('/api/status').then(r=>r.json()).then(d => setBalance(d.sol_balance)).catch(()=>{});
  }, []);

  const navStyle = ({ isActive }) => ({
    padding: '5px 11px', borderRadius: 5, fontSize: 12, cursor: 'pointer',
    textDecoration: 'none', color: isActive ? '#a5b4fc' : '#475569',
    background: isActive ? '#1e1b4b' : 'transparent',
  });

  return (
    <div className="topbar" style={{ height:48, background:'#111', borderBottom:'0.5px solid #222', display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0 16px', position:'sticky', top:0, zIndex:100 }}>
      <div style={{ fontSize:14, fontWeight:600, color:'#818cf8', display:'flex', alignItems:'center', gap:8 }}>
        ⬡ LPGoose
      </div>
      <nav style={{ display:'flex', gap:2 }}>
        {[['/', 'Dashboard'], ['/logs', 'Live Logs'], ['/performance', 'Performance'], ['/pools', 'Pools'], ['/config', 'Config']].map(([to, label]) => (
          <NavLink key={to} to={to} end={to==='/'} style={navStyle}>{label}</NavLink>
        ))}
      </nav>
      <div style={{ display:'flex', alignItems:'center', gap:8, fontSize:12, color:'#64748b' }}>
        <div style={{ width:6, height:6, borderRadius:'50%', background: botAlive ? '#22c55e' : '#ef4444', animation: botAlive ? 'pulse 2s infinite' : 'none' }} />
        {botAlive ? 'Bot running' : 'Bot offline'}
        {balance != null && <span style={{color:'#475569'}}>· {balance} SOL</span>}
      </div>
    </div>
  );
}
