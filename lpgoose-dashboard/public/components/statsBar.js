function renderStatsBar(container, perf) {
  if (!perf) return;
  container.innerHTML = `
    <div class="stats-grid">
      <div class="stat-box">
        <div class="stat-value">${perf.total_trades}</div>
        <div class="stat-label">Total Trades</div>
      </div>
      <div class="stat-box">
        <div class="stat-value ${parseFloat(perf.win_rate) >= 50 ? 'pos' : 'neg'}">${perf.win_rate}%</div>
        <div class="stat-label">Win Rate</div>
      </div>
      <div class="stat-box">
        <div class="stat-value pos">${perf.avg_win_pct}%</div>
        <div class="stat-label">Avg Win</div>
      </div>
      <div class="stat-box">
        <div class="stat-value neg">${perf.avg_loss_pct}%</div>
        <div class="stat-label">Avg Loss</div>
      </div>
      <div class="stat-box">
        <div class="stat-value ${parseFloat(perf.total_pnl_usd) >= 0 ? 'pos' : 'neg'}">$${perf.total_pnl_usd}</div>
        <div class="stat-label">Total PnL</div>
      </div>
    </div>
  `;
}
