async function renderPools(container) {
  container.innerHTML = `
    <div class="page-title">Pool Memory</div>
    <div class="card">
      <div class="table-wrap">
        <table id="pools-table">
          <thead>
            <tr>
              <th onclick="sortPools('name')">Pool</th>
              <th onclick="sortPools('deploys')">Deploys</th>
              <th onclick="sortPools('winRate')">Win Rate</th>
              <th onclick="sortPools('avgPnl')">Avg PnL</th>
              <th onclick="sortPools('lastDeploy')">Last Deploy</th>
              <th onclick="sortPools('status')">Status</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
  `;

  try {
    const pools = await api("/api/pools");
    window._poolsData = pools;
    renderPoolsTable(pools);
  } catch (err) {
    container.innerHTML = `<div style="color:var(--red)">Error loading pools: ${err.message}</div>`;
  }
}

function renderPoolsTable(pools) {
  const tbody = document.querySelector("#pools-table tbody");
  if (!tbody) return;

  const entries = Object.entries(pools).map(([pool, data]) => {
    const deploys = data.deploys || [];
    const wins = deploys.filter((d) => (d.pnl_pct || 0) > 0).length;
    const losses = deploys.filter((d) => (d.pnl_pct || 0) <= 0).length;
    const winRate = deploys.length > 0 ? ((wins / deploys.length) * 100).toFixed(1) : 0;
    const avgPnl = deploys.length > 0
      ? deploys.reduce((s, d) => s + (d.pnl_pct || 0), 0) / deploys.length
      : 0;
    const lastDeploy = deploys.length > 0 ? deploys[deploys.length - 1].closed_at || deploys[deploys.length - 1].deployed_at : null;
    const hasRecentLoss = deploys.some((d) => {
      if ((d.pnl_pct || 0) >= 0) return false;
      const closed = d.closed_at ? new Date(d.closed_at) : null;
      return closed && Date.now() - closed.getTime() < 48 * 3600_000;
    });

    return {
      name: data.pool_name || pool.slice(0, 8),
      deploys: deploys.length,
      wins,
      losses,
      winRate,
      avgPnl,
      lastDeploy,
      status: hasRecentLoss ? "cooldown" : "active",
      raw: data,
    };
  });

  window._poolsEntries = entries;
  displayPools(entries);
}

function displayPools(entries) {
  const tbody = document.querySelector("#pools-table tbody");
  if (!tbody) return;
  if (entries.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-2)">No pool memory</td></tr>`;
    return;
  }
  tbody.innerHTML = entries.map((p) => `
    <tr>
      <td>${p.name}</td>
      <td>${p.deploys}</td>
      <td class="${p.winRate >= 50 ? 'pos' : 'neg'}">${p.winRate}%</td>
      <td class="${p.avgPnl >= 0 ? 'pos' : 'neg'}">${fmtPct(p.avgPnl)}</td>
      <td class="muted">${timeAgo(p.lastDeploy)}</td>
      <td><span class="pc-badge ${p.status === 'cooldown' ? 'oor' : 'live'}">${p.status}</span></td>
    </tr>
  `).join("");
}

function sortPools(key) {
  if (!window._poolsEntries) return;
  const dir = window._poolSortKey === key ? (window._poolSortDir === "asc" ? "desc" : "asc") : "desc";
  window._poolSortKey = key;
  window._poolSortDir = dir;

  const sorted = [...window._poolsEntries].sort((a, b) => {
    let av = a[key];
    let bv = b[key];
    if (typeof av === "string") {
      av = av.toLowerCase();
      bv = bv.toLowerCase();
    }
    if (av == null) av = 0;
    if (bv == null) bv = 0;
    if (av < bv) return dir === "asc" ? -1 : 1;
    if (av > bv) return dir === "asc" ? 1 : -1;
    return 0;
  });
  displayPools(sorted);
}
