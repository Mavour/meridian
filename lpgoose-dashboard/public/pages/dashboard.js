async function renderDashboard(container) {
  container.innerHTML = `
    <div id="dashboard-stats"></div>

    <div class="section-title">Open Positions</div>
    <div class="positions-row" id="open-positions">
      <div style="color:var(--text-2);padding:20px;">Loading...</div>
    </div>

    <div class="section-title">Wave History</div>
    <div class="wave-row" id="wave-chips"></div>

    <div class="section-title">Live Logs</div>
    <div id="inline-logs-wrap"></div>

    <div class="section-title">Recent Closed</div>
    <div class="card" style="padding:0;">
      <table class="rc-table">
        <thead>
          <tr>
            <th>Token</th>
            <th>PnL%</th>
            <th>USD</th>
            <th>Hold</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody id="rc-tbody"></tbody>
      </table>
    </div>
  `;

  try {
    const [perf, positions, waves] = await Promise.all([
      api("/api/performance"),
      api("/api/positions"),
      api("/api/waves"),
    ]);

    cache.performance = perf;
    cache.positions = positions;
    cache.waves = waves;

    // Stats
    renderStatsBar(document.getElementById("dashboard-stats"), perf, positions, 1);

    // Open positions
    refreshDashboardPositions();

    // Waves
    refreshDashboardWaves();

    // Inline logs
    const logsWrap = document.getElementById("inline-logs-wrap");
    if (logsWrap) renderLogTerminal(logsWrap, { compact: true, maxLines: 8 });

    // Recent closed
    const closed = await api("/api/positions/closed");
    renderRecentClosed(closed);
  } catch (err) {
    container.innerHTML = `<div style="color:var(--red);padding:20px;">Error loading dashboard: ${err.message}</div>`;
  }
}

function refreshDashboardPositions() {
  const grid = document.getElementById("open-positions");
  if (!grid) return;
  const positions = cache.positions || [];
  if (positions.length === 0) {
    grid.innerHTML = `<div style="color:var(--text-2);padding:20px 0;">No open positions</div>`;
    return;
  }
  grid.innerHTML = positions.map(renderPositionCard).join("");
}

function refreshDashboardWaves() {
  const container = document.getElementById("wave-chips");
  if (!container) return;
  const waves = cache.waves || {};
  const entries = Object.entries(waves).sort((a, b) => (b[1].wins || 0) - (a[1].wins || 0));
  if (entries.length === 0) {
    container.innerHTML = `<span style="color:var(--text-2)">No wave history</span>`;
    return;
  }
  container.innerHTML = entries.map(([key, data]) => {
    const symbol = data.symbol || key;
    const wins = data.wins || 0;
    const losses = data.losses || 0;
    const icon = losses > 0 ? "⚠" : "✓";
    return `<div class="wave-chip">${symbol} <span class="count">×${wins}</span> <span class="icon">${icon}</span></div>`;
  }).join("");
}

function renderRecentClosed(closed) {
  const tbody = document.getElementById("rc-tbody");
  if (!tbody) return;
  if (!closed || closed.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-2);padding:20px;">No closed positions yet</td></tr>`;
    return;
  }
  tbody.innerHTML = closed.slice(0, 10).map((p) => {
    const pnl = p.pnl_pct || 0;
    const pnlUsd = p.pnl_usd || 0;
    const holdMin = p.deployed_at && p.closed_at
      ? (new Date(p.closed_at) - new Date(p.deployed_at)) / 60000
      : 0;
    const reason = p.notes?.[0]
      ? p.notes[0].replace(/^Closed at [^:]+: /, "").replace(/^agent decision$/, "Agent")
      : "—";
    const pnlClass = pnl >= 0 ? 'pos' : 'neg';
    return `
      <tr>
        <td class="rc-token">${p.pool_name || p.pool?.slice(0, 8)}</td>
        <td class="rc-pnl ${pnlClass}">${fmtPct(pnl)}</td>
        <td class="rc-usd ${pnlClass}">${fmtUsd(pnlUsd)}</td>
        <td class="rc-hold">${fmtDuration(holdMin)}</td>
        <td class="rc-reason">${reason}</td>
      </tr>
    `;
  }).join("");
}
