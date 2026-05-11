async function renderDashboard(container) {
  container.innerHTML = `
    <div id="dashboard-stats"></div>
    <div class="page-title">Open Positions</div>
    <div class="position-grid" id="open-positions"></div>
    <div class="page-title">Recent Closed</div>
    <div class="card"><div class="table-wrap"><table id="closed-table"><thead><tr>
      <th>Token</th><th>PnL%</th><th>PnL USD</th><th>Hold</th><th>Reason</th><th>Time</th>
    </tr></thead><tbody></tbody></table></div></div>
    <div class="page-title">Wave History</div>
    <div class="chip-row" id="wave-chips"></div>
  `;

  try {
    const [perf, state, waves] = await Promise.all([
      api("/api/performance"),
      api("/api/positions"),
      api("/api/waves"),
    ]);

    cache.performance = perf;
    cache.positions = state;
    cache.waves = waves;

    renderStatsBar(document.getElementById("dashboard-stats"), perf);
    refreshDashboardPositions();
    refreshDashboardWaves();

    const closed = await api("/api/positions/closed");
    renderClosedTable(closed);
  } catch (err) {
    container.innerHTML = `<div style="color:var(--red)">Error loading dashboard: ${err.message}</div>`;
  }
}

function refreshDashboardPositions() {
  const grid = document.getElementById("open-positions");
  if (!grid) return;
  if (!cache.positions || cache.positions.length === 0) {
    grid.innerHTML = `<div style="color:var(--text-2)">No open positions</div>`;
    return;
  }
  grid.innerHTML = cache.positions.map(renderPositionCard).join("");
}

function renderClosedTable(closed) {
  const tbody = document.querySelector("#closed-table tbody");
  if (!tbody) return;
  if (!closed || closed.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-2)">No closed positions yet</td></tr>`;
    return;
  }
  tbody.innerHTML = closed.map((p) => {
    const pnl = p.pnl_pct || 0;
    const pnlUsd = p.pnl_usd || 0;
    const holdMin = p.deployed_at && p.closed_at
      ? (new Date(p.closed_at) - new Date(p.deployed_at)) / 60000
      : 0;
    const reason = p.notes?.[0] ? p.notes[0].replace(/^Closed at [^:]+: /, "") : "-";
    return `
      <tr>
        <td>${p.pool_name || p.pool?.slice(0, 8)}</td>
        <td class="${pnl >= 0 ? 'pos' : 'neg'}">${fmtPct(pnl)}</td>
        <td class="${pnlUsd >= 0 ? 'pos' : 'neg'}">${fmtUsd(pnlUsd)}</td>
        <td class="muted">${fmtDuration(holdMin)}</td>
        <td class="muted">${reason}</td>
        <td class="muted">${timeAgo(p.closed_at)}</td>
      </tr>
    `;
  }).join("");
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
    const icon = losses > 0 ? "⚠️" : "✅";
    return `<div class="chip">${symbol} <span class="count">×${wins}</span> ${icon}</div>`;
  }).join("");
}
