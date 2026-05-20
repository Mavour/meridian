import { useEffect, useState, useContext, useMemo, useRef } from 'react';
import { AlertTriangle, Crosshair, ShieldCheck, TrendingUp } from 'lucide-react';
import { WSContext } from '../App';
import StatCard from '../components/StatCard';
import PositionCard from '../components/PositionCard';
import WaveChips from '../components/WaveChips';
import LogTerminal from '../components/LogTerminal';
import ClosedTable from '../components/ClosedTable';

const POSITION_REFRESH_MS = 10_000;

function formatUsd(value) {
  const n = Number(value || 0);
  return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
}

function computeScreening(logs) {
  const recent = logs.slice(-120);
  const counts = {
    screened: recent.filter((l) => /Starting screening cycle/i.test(l.msg || '')).length,
    filtered: recent.filter((l) => /Filtered|rejected|Skipping|removed/i.test(l.msg || '')).length,
    safety: recent.filter((l) => /SAFETY|rug|wash|bundle|bot|top10/i.test(`${l.tag || ''} ${l.msg || ''}`)).length,
    deploys: recent.filter((l) => /DEPLOY|deployed/i.test(`${l.tag || ''} ${l.msg || ''}`)).length,
  };
  const total = Math.max(1, counts.screened + counts.filtered + counts.deploys);
  return [
    ['Cycles', counts.screened, 100],
    ['Risk filters', counts.filtered, Math.min(100, (counts.filtered / total) * 100)],
    ['Safety flags', counts.safety, Math.min(100, (counts.safety / total) * 100)],
    ['Deploys', counts.deploys, Math.min(100, (counts.deploys / total) * 100)],
  ];
}

function computePeakPnlByPosition(logs) {
  const peaks = {};
  const re = /Position\s+([1-9A-HJ-NP-Za-km-z]+)\s+peak PnL accepted at\s+([+-]?\d+(?:\.\d+)?)%/i;
  logs.forEach((line) => {
    if (line.tag !== 'STATE') return;
    const match = String(line.msg || '').match(re);
    if (!match) return;
    const value = Number(match[2]);
    if (Number.isFinite(value)) peaks[match[1]] = value;
  });
  return peaks;
}

export default function Dashboard() {
  const { events } = useContext(WSContext);
  const [perf, setPerf] = useState(null);
  const [positions, setPositions] = useState([]);
  const [waves, setWaves] = useState({});
  const [config, setConfig] = useState({});
  const positionsLoading = useRef(false);

  const loadPositions = () => {
    if (positionsLoading.current) return;
    positionsLoading.current = true;
    fetch('/api/positions')
      .then((r) => r.json())
      .then((d) => setPositions(d.positions || []))
      .catch(() => {})
      .finally(() => { positionsLoading.current = false; });
  };

  const reload = () => {
    fetch('/api/performance').then((r) => r.json()).then(setPerf).catch(() => {});
    loadPositions();
    fetch('/api/waves').then((r) => r.json()).then(setWaves).catch(() => {});
    fetch('/api/config').then((r) => r.json()).then(setConfig).catch(() => {});
  };

  useEffect(() => {
    reload();
    const id = window.setInterval(loadPositions, POSITION_REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const last = events[events.length - 1];
    if (!last) return;
    if (['state_update', 'perf_update', 'wave_update', 'close', 'deploy'].includes(last.type)) reload();
  }, [events]);

  const logEvents = events.filter((e) => e.type === 'log').map((e) => e.data);
  const decisionLogs = logEvents.filter((l) => ['DEPLOY', 'CLOSE', 'STATE', 'SCREENING', 'SAFETY_BLOCK', 'WARN', 'CLOSE_WARN'].includes(l.tag)).slice(-80);
  const screeningBars = useMemo(() => computeScreening(logEvents), [logEvents]);
  const peakPnlByPosition = useMemo(() => computePeakPnlByPosition(logEvents), [logEvents]);
  const todayFeesUsd = Number(perf?.today_fees_usd || 0);
  const maxPositions = config.maxPositions ?? '-';
  const openLimit = `${positions.length} / ${maxPositions}`;
  const healthTone = positions.length >= Number(maxPositions || 999) ? 'warn' : 'good';

  return (
    <main className="page-shell">
      <section className="hero-grid">
        <div className="capital-panel">
          <div>
            <div className="card-label">Capital Health</div>
            <div className={`health-word ${perf?.total_pnl >= 0 ? 'positive' : 'negative'}`}>
              {perf?.total_pnl >= 0 ? 'Stable' : 'Drawdown'}
            </div>
            <p className="panel-copy">
              {perf?.total || 0} closed positions · {perf?.win_rate || 0}% win rate · avg win/loss
              {' '}+${Number(perf?.avg_win || 0).toFixed(2)} / -${Math.abs(Number(perf?.avg_loss || 0)).toFixed(2)}
            </p>
          </div>
          <div className="capital-pnl">
            <span>All-time PnL</span>
            <strong className={perf?.total_pnl >= 0 ? 'positive' : 'negative'}>{formatUsd(perf?.total_pnl)}</strong>
          </div>
        </div>

        <StatCard label="Open Positions" value={openLimit} tone={healthTone} sub="capacity guard" />
        <StatCard label="Today Fees" value={`$${todayFeesUsd.toFixed(2)}`} tone="neutral" sub={`${Number(perf?.today_fees_sol || 0).toFixed(4)} SOL`} />
        <StatCard label="Deploy Size" value={`${Number(config.deployAmountSol || 0).toFixed(2)} SOL`} tone="blue" sub={`max ${Number(config.maxDeployAmount || 0).toFixed(2)} SOL`} />
        <StatCard label="Exit Trigger" value={`${Number(config.trailingDropPct ?? 0.5).toFixed(1)}%`} tone="warn" sub={`after +${Number(config.trailingTriggerPct ?? 2).toFixed(1)}% peak`} />
      </section>

      <section className="command-grid">
        <div className="panel risk-gates-panel">
          <div className="panel-head compact">
            <div>
              <div className="card-label">Risk Gates</div>
              <h2>Entry rules</h2>
            </div>
            <ShieldCheck size={18} className="positive" />
          </div>
          <div className="gate-list">
            <div><span>Fee / active TVL</span><b>{config.minFeeActiveTvlRatio ?? 0.08}% min</b></div>
            <div><span>Token fees</span><b>{config.minTokenFeesSol ?? 30} SOL min</b></div>
            <div><span>Volatility</span><b>max {config.maxVolatility ?? 7}</b></div>
            <div><span>Bin step</span><b>{config.minBinStep ?? 80}-{config.maxBinStep ?? 200}</b></div>
            <div className="watch"><span>Top10</span><b>{config.maxTop10Pct ?? 65}% target</b></div>
            <div className="watch"><span>Bundle</span><b>{config.maxBundlePct ?? 35}% target</b></div>
          </div>
        </div>

        <div className="panel liquidity-panel">
          <div className="panel-head">
            <div>
              <div className="card-label">Active Liquidity</div>
              <h2>{positions.length ? 'Current position view' : 'No open position'}</h2>
            </div>
            <span className={`status-pill ${positions.length ? 'watch' : 'ready'}`}>{positions.length ? 'MANAGING' : 'READY'}</span>
          </div>
          {positions.length === 0 ? (
            <div className="empty-command">
              <Crosshair size={22} />
              <div>
                <strong>Waiting for a clean entry</strong>
                <span>Single-side SOL deploys stay below active bin. The next position will appear here with range and exit state.</span>
              </div>
            </div>
          ) : (
            <div className={`position-stack ${positions.length === 1 ? 'single' : ''}`}>
              {positions.map((p) => (
                <PositionCard
                  key={p.position}
                  pos={p}
                  peakPnl={peakPnlByPosition[p.position] ?? p.peak_pnl_pct}
                />
              ))}
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-head compact">
            <div>
              <div className="card-label">Screening Activity</div>
              <h2>Recent funnel</h2>
            </div>
            <TrendingUp size={18} className="blue" />
          </div>
          <div className="funnel-list">
            {screeningBars.map(([label, value, width]) => (
              <div className="funnel-row" key={label}>
                <div><span>{label}</span><b>{value}</b></div>
                <i><em style={{ width: `${Math.max(7, width)}%` }} /></i>
              </div>
            ))}
          </div>
        </div>

        <div className="panel wide">
          <div className="panel-head compact">
            <div>
              <div className="card-label">Live Decision Feed</div>
              <h2>Agent stream</h2>
            </div>
            <AlertTriangle size={18} className="amber" />
          </div>
          <LogTerminal lines={decisionLogs} maxHeight={292} compact />
        </div>

        <div className="panel">
          <div className="panel-head compact">
            <div>
              <div className="card-label">Wave History</div>
              <h2>Repeat winners</h2>
            </div>
          </div>
          <WaveChips waves={waves} />
        </div>

        <div className="panel table-panel">
          <div className="panel-head compact">
            <div>
              <div className="card-label">Recent Closed</div>
              <h2>Last exits</h2>
            </div>
          </div>
          <ClosedTable rows={perf?.recent || []} />
        </div>
      </section>
    </main>
  );
}
