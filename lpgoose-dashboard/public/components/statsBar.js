function renderStatsBar(container, perf, positions, maxPos) {
  const openCount = positions?.length || 0;
  const maxPositions = maxPos || 1;
  const winRate = perf?.win_rate || 0;
  const totalPnl = perf?.total_pnl_usd || 0;
  const avgPnl = perf?.total_trades > 0 ? (totalPnl / perf.total_trades).toFixed(2) : "0.00";

  // Today fees — best effort from closed positions today
  const today = new Date().toISOString().split("T")[0];
  const todayFees = 0; // will be calculated from logs if needed

  container.innerHTML = `
    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-label">Open Positions</div>
        <div class="stat-value">${openCount} / ${maxPositions}</div>
        <div class="stat-sublabel">max positions</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Win Rate</div>
        <div class="stat-value ${parseFloat(winRate) >= 50 ? 'pos' : 'neg'}">${winRate}%</div>
        <div class="stat-sublabel">${perf?.win_count || 0} closed</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">All-Time PnL</div>
        <div class="stat-value ${parseFloat(totalPnl) >= 0 ? 'pos' : 'neg'}">${fmtUsd(totalPnl)}</div>
        <div class="stat-sublabel">avg ${fmtUsd(parseFloat(avgPnl))}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Today Fees</div>
        <div class="stat-value">◎${todayFees.toFixed(4)}</div>
        <div class="stat-sublabel">$${(todayFees * 150).toFixed(2)}</div>
      </div>
    </div>
  `;
}
