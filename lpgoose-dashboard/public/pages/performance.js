async function renderPerformance(container) {
  container.innerHTML = `
    <div class="page-title">Performance</div>
    <div id="perf-stats"></div>
    <div id="charts-area"></div>
    <div class="page-title">Top Performers</div>
    <div class="card"><div class="table-wrap"><table id="top-perf-table"><thead><tr>
      <th>Token</th><th>Deploys</th><th>Wins</th><th>Losses</th><th>Avg PnL</th><th>Best</th><th>Worst</th>
    </tr></thead><tbody></tbody></table></div></div>
  `;

  try {
    const [perf, lessons, waves] = await Promise.all([
      api("/api/performance"),
      api("/api/lessons"),
      api("/api/waves"),
    ]);

    renderStatsBar(document.getElementById("perf-stats"), perf);

    // Build charts
    const chartsArea = document.getElementById("charts-area");

    // 1. Cumulative PnL
    let cumPnl = 0;
    const cumData = lessons.map((l) => {
      cumPnl += l.pnl_usd || 0;
      return { x: new Date(l.created_at).getTime(), y: cumPnl };
    });
    const cumDiv = document.createElement("div");
    cumDiv.className = "chart-box";
    cumDiv.innerHTML = `<div class="card-header">Cumulative PnL (USD)</div>`;
    chartsArea.appendChild(cumDiv);
    renderPnlChart(cumDiv, [{ name: "Cumulative PnL", data: cumData }], "Cumulative PnL", "area");

    // 2. Win/Loss per token
    const tokenStats = {};
    lessons.forEach((l) => {
      const name = l.pool?.slice(0, 8) || "unknown";
      if (!tokenStats[name]) tokenStats[name] = { wins: 0, losses: 0 };
      if ((l.pnl_pct || 0) > 0) tokenStats[name].wins++;
      else tokenStats[name].losses++;
    });
    const tokenNames = Object.keys(tokenStats).slice(0, 15);
    const winData = tokenNames.map((t) => tokenStats[t].wins);
    const lossData = tokenNames.map((t) => tokenStats[t].losses);
    const wlDiv = document.createElement("div");
    wlDiv.className = "chart-box";
    wlDiv.innerHTML = `<div class="card-header">Win / Loss per Token</div>`;
    chartsArea.appendChild(wlDiv);
    const wlChartEl = document.createElement("div");
    wlChartEl.style.minHeight = "300px";
    wlDiv.appendChild(wlChartEl);
    new ApexCharts(wlChartEl, {
      chart: { type: "bar", height: 300, background: "transparent", toolbar: { show: false } },
      theme: { mode: "dark" },
      colors: ["#22c55e", "#ef4444"],
      series: [
        { name: "Wins", data: winData },
        { name: "Losses", data: lossData },
      ],
      xaxis: { categories: tokenNames, labels: { style: { colors: "#94a3b8" } } },
      yaxis: { labels: { style: { colors: "#94a3b8" } } },
      grid: { borderColor: "#222222" },
      tooltip: { theme: "dark" },
      legend: { labels: { colors: "#f1f5f9" } },
    }).render();

    // 3. Hold time vs PnL scatter
    const scatterData = lessons
      .filter((l) => l.pnl_pct != null)
      .map((l) => {
        const holdMin = l.context?.match(/age=(\d+)/)?.[1] || 0;
        return { x: parseFloat(holdMin) || 0, y: l.pnl_pct };
      });
    const scDiv = document.createElement("div");
    scDiv.className = "chart-box";
    scDiv.innerHTML = `<div class="card-header">Hold Time vs PnL%</div>`;
    chartsArea.appendChild(scDiv);
    const scChartEl = document.createElement("div");
    scChartEl.style.minHeight = "300px";
    scDiv.appendChild(scChartEl);
    new ApexCharts(scChartEl, {
      chart: { type: "scatter", height: 300, background: "transparent", toolbar: { show: false } },
      theme: { mode: "dark" },
      colors: ["#6366f1"],
      series: [{ name: "Trades", data: scatterData }],
      xaxis: { title: { text: "Hold Time (min)", style: { color: "#94a3b8" } }, labels: { style: { colors: "#94a3b8" } } },
      yaxis: { title: { text: "PnL %", style: { color: "#94a3b8" } }, labels: { style: { colors: "#94a3b8" } } },
      grid: { borderColor: "#222222" },
      tooltip: { theme: "dark" },
    }).render();

    // 4. Daily PnL summary
    const daily = {};
    lessons.forEach((l) => {
      const d = l.created_at?.split("T")[0];
      if (!d) return;
      daily[d] = (daily[d] || 0) + (l.pnl_usd || 0);
    });
    const dailyDates = Object.keys(daily).sort();
    const dailyData = dailyDates.map((d) => ({ x: new Date(d).getTime(), y: daily[d] }));
    const dayDiv = document.createElement("div");
    dayDiv.className = "chart-box";
    dayDiv.innerHTML = `<div class="card-header">Daily PnL (USD)</div>`;
    chartsArea.appendChild(dayDiv);
    const dayChartEl = document.createElement("div");
    dayChartEl.style.minHeight = "300px";
    dayDiv.appendChild(dayChartEl);
    new ApexCharts(dayChartEl, {
      chart: { type: "bar", height: 300, background: "transparent", toolbar: { show: false } },
      theme: { mode: "dark" },
      colors: ["#6366f1"],
      series: [{ name: "Daily PnL", data: dailyData }],
      xaxis: { type: "datetime", labels: { style: { colors: "#94a3b8" } } },
      yaxis: { labels: { style: { colors: "#94a3b8" } } },
      grid: { borderColor: "#222222" },
      tooltip: { theme: "dark" },
    }).render();

    // Top performers table
    const tbody = document.querySelector("#top-perf-table tbody");
    if (tbody) {
      const poolPerf = {};
      lessons.forEach((l) => {
        const name = l.pool?.slice(0, 8) || "unknown";
        if (!poolPerf[name]) poolPerf[name] = { deploys: 0, wins: 0, losses: 0, totalPnl: 0, best: -Infinity, worst: Infinity };
        poolPerf[name].deploys++;
        if (l.pnl_pct > 0) poolPerf[name].wins++;
        else poolPerf[name].losses++;
        poolPerf[name].totalPnl += l.pnl_pct;
        poolPerf[name].best = Math.max(poolPerf[name].best, l.pnl_pct);
        poolPerf[name].worst = Math.min(poolPerf[name].worst, l.pnl_pct);
      });
      const rows = Object.entries(poolPerf)
        .sort((a, b) => b[1].totalPnl - a[1].totalPnl)
        .slice(0, 20)
        .map(([name, p]) => `
          <tr>
            <td>${name}</td>
            <td>${p.deploys}</td>
            <td class="pos">${p.wins}</td>
            <td class="neg">${p.losses}</td>
            <td class="${p.totalPnl >= 0 ? 'pos' : 'neg'}">${fmtPct(p.totalPnl / p.deploys)}</td>
            <td class="pos">${fmtPct(p.best)}</td>
            <td class="neg">${fmtPct(p.worst)}</td>
          </tr>
        `).join("");
      tbody.innerHTML = rows || `<tr><td colspan="7" style="text-align:center;color:var(--text-2)">No data</td></tr>`;
    }
  } catch (err) {
    container.innerHTML = `<div style="color:var(--red)">Error loading performance: ${err.message}</div>`;
  }
}
