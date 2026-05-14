import { NavLink } from 'react-router-dom';
import { Activity, BarChart3, Database, Gauge, Settings, Terminal } from 'lucide-react';

const navItems = [
  ['/', 'Dashboard', Gauge],
  ['/logs', 'Live Logs', Terminal],
  ['/performance', 'Performance', BarChart3],
  ['/pools', 'Pools', Database],
  ['/config', 'Config', Settings],
];

export default function Topbar({ botAlive }) {
  return (
    <header className="topbar">
      <div className="brand-lockup">
        <img className="brand-logo" src="/lpgoose-logo.png" alt="LPGoose" />
        <div>
          <div className="brand-title">LPGoose</div>
          <div className="brand-subtitle">DLMM command center</div>
        </div>
      </div>

      <nav className="topnav" aria-label="Primary navigation">
        {navItems.map(([to, label, Icon]) => (
          <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `nav-pill${isActive ? ' active' : ''}`}>
            <Icon size={14} strokeWidth={1.8} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="agent-status">
        <span className={`status-dot ${botAlive ? 'online' : 'offline'}`} />
        <Activity size={14} strokeWidth={1.8} />
        <span>{botAlive ? 'Agent running' : 'Agent offline'}</span>
      </div>
    </header>
  );
}
