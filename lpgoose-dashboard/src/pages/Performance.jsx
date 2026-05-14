import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { WSContext } from '../App';
import { CumPnlChart } from '../components/charts/CumPnlChart';
import { WinLossBar } from '../components/charts/WinLossBar';
import { HoldScatter } from '../components/charts/HoldScatter';

const sectionLabel = { fontSize: 10, color: '#66758d', textTransform: 'uppercase', letterSpacing: 1, margin: '16px 0 8px' };

function tradePnl(trade) {
  const n = Number(trade.pnl_amount ?? trade.pnl_usd ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function buildCumulativeData(trades) {
  let cumulative = 0;
  return trades.map((trade, index) => {
    cumulative += tradePnl(trade);
    return {
      ...trade,
      i: trade.trade_index ?? index + 1,
      trade_index: trade.trade_index ?? index + 1,
      pnl_amount: tradePnl(trade),
      cum: Number(cumulative.toFixed(4)),
    };
  });
}

function buildWinLossData(trades) {
  const winsCount = trades.filter((trade) => tradePnl(trade) > 0).length;
  const lossesCount = trades.filter((trade) => tradePnl(trade) <= 0).length;
  return [
    { name: 'Wins', value: winsCount, fill: '#22c55e' },
    { name: 'Losses', value: lossesCount, fill: '#ef4444' },
  ];
}

export default function Performance() {
  const { events } = useContext(WSContext);
  const [perf, setPerf] = useState(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    fetch('/api/performance')
      .then((r) => r.json())
      .then(setPerf)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const last = events[events.length - 1];
    if (!last) return;
    if (['perf_update', 'close'].includes(last.type)) reload();
    if (last.type === 'log' && ['CLOSE', 'LESSONS'].includes(last.data?.tag)) reload();
  }, [events, reload]);

  const trades = useMemo(() => Array.isArray(perf?.trades) ? perf.trades : [], [perf]);
  const cumData = useMemo(() => buildCumulativeData(trades), [trades]);
  const wlbData = useMemo(() => buildWinLossData(trades), [trades]);

  return (
    <main className="page-shell">
      <div className="stat-grid" style={{ gap: 8 }}>
        <div className="stat-card">
          <div className="card-label">Total Trades</div>
          <div className="stat-value">{perf?.total || trades.length || 0}</div>
        </div>
        <div className="stat-card">
          <div className="card-label">Win Rate</div>
          <div className={`stat-value ${(perf?.win_rate || 0) >= 50 ? 'positive' : 'negative'}`}>{perf?.win_rate || 0}%</div>
        </div>
        <div className="stat-card">
          <div className="card-label">Avg Win / Loss</div>
          <div className="stat-value">
            <span className="positive">+${(perf?.avg_win || 0).toFixed(2)}</span>
            <span style={{ fontSize: 14, color: '#66758d', margin: '0 4px' }}>/</span>
            <span className="negative">-${Math.abs(perf?.avg_loss || 0).toFixed(2)}</span>
          </div>
        </div>
        <div className="stat-card">
          <div className="card-label">Total PnL</div>
          <div className={`stat-value ${(perf?.total_pnl || 0) >= 0 ? 'positive' : 'negative'}`}>
            {(perf?.total_pnl || 0) >= 0 ? '+' : ''}${(perf?.total_pnl || 0).toFixed(2)}
          </div>
        </div>
      </div>

      <div style={sectionLabel}>Cumulative PnL</div>
      <div className="panel" style={{ padding: 16 }}>
        <CumPnlChart data={cumData} loading={loading} />
      </div>

      <div className="chart-grid" style={{ gap: 8, marginTop: 16 }}>
        <div className="panel" style={{ padding: 16 }}>
          <div style={sectionLabel}>Win / Loss Distribution</div>
          <WinLossBar data={wlbData} loading={loading} />
        </div>
        <div className="panel" style={{ padding: 16 }}>
          <div style={sectionLabel}>Hold Time vs PnL</div>
          <HoldScatter data={trades} loading={loading} />
        </div>
      </div>
    </main>
  );
}
