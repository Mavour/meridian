/**
 * LPGoose Dashboard — Single Page (no tabs)
 */

const API_BASE = "";
let ws = null;
let wsReconnectTimer = null;
const wsReconnectDelay = 5000;

const cache = {
  status: null,
  positions: [],
  closed: [],
  performance: null,
  waves: {},
  logs: [],
};

// ─── Formatters ───────────────────────────────────────────────────────

function fmtNum(n, digits = 2) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  return num.toFixed(digits);
}
function fmtPct(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  const sign = num >= 0 ? "+" : "";
  return `${sign}${num.toFixed(2)}%`;
}
function fmtUsd(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  const sign = num >= 0 ? "+" : "";
  return `${sign}$${num.toFixed(2)}`;
}
function fmtSol(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  return `◎${num.toFixed(4)}`;
}
function fmtDuration(minutes) {
  const num = Number(minutes);
  if (!Number.isFinite(num)) return "—";
  if (num < 60) return `${Math.round(num)}m`;
  const h = Math.floor(num / 60);
  const m = Math.round(num % 60);
  return `${h}h ${m}m`;
}
function timeAgo(iso) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toTimeString().slice(0, 8);
}

// ─── API helpers ──────────────────────────────────────────────────────

async function api(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

// ─── WebSocket ────────────────────────────────────────────────────────

const logBuffer = [];
const MAX_LOG_BUFFER = 50;

function connectWS() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    clearTimeout(wsReconnectTimer);
    updateBotDot(true);
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "log") {
        logBuffer.push(msg.data);
        if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();
        appendInlineLog(msg.data);
        // Also re-render all buffered logs to keep inline container up to date
        renderInlineLogBuffer();
      }
      if (msg.type === "positions") { cache.positions = msg.data; refreshPositions(); }
      if (msg.type === "waves") { cache.waves = msg.data; refreshWaves(); }
    } catch {}
  };

  ws.onclose = () => {
    updateBotDot(false);
    wsReconnectTimer = setTimeout(connectWS, wsReconnectDelay);
  };

  ws.onerror = () => updateBotDot(false);
}

function renderInlineLogBuffer() {
  const container = document.getElementById("inline-log-container");
  if (!container) return;
  const lines = logBuffer.slice(-8);
  container.innerHTML = lines.map(renderInlineLogLine).join("") || `<div style="color:var(--text-2)">No logs yet</div>`;
}

function updateBotDot(online) {
  const dot = document.getElementById("bot-dot");
  const text = document.getElementById("bot-text");
  if (dot) dot.classList.toggle("online", online);
  if (text) text.textContent = online ? "Bot running" : "Bot offline";
}

// ─── Position Card ────────────────────────────────────────────────────

function renderPositionCard(pos) {
  const pnl = Number(pos.pnl_pct) || 0;
  const peak = Number(pos.peak_pnl_pct) || pnl;
  const ageMin = pos.deployed_at
    ? (Date.now() - new Date(pos.deployed_at).getTime()) / 60000
    : 0;
  const isOor = !!pos.out_of_range_since;
  const statusText = isOor ? `OOR ${fmtDuration((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000)}` : "IN RANGE";
  const statusClass = isOor ? "oor" : "in-range";
  const cardClass = pnl > 0 ? "profit" : pnl < -1 ? "loss" : isOor ? "oor" : "profit";
  const pnlClass = pnl > 0 ? "pos" : pnl < 0 ? "neg" : "neu";

  const ageHours = ageMin / 60;
  const yieldPct = pos.fee_tvl_ratio && ageHours > 0
    ? (pos.fee_tvl_ratio * ageHours).toFixed(2)
    : "0.00";

  const unclaimed = pos.total_fees_claimed_usd != null && pos.initial_value_usd != null
    ? Math.max(0, (Number(pos.pnl_usd) || 0) - pos.total_fees_claimed_usd)
    : 0;

  return `
    <div class="pos-card ${cardClass}" data-position="${pos.position}">
      <div class="pos-header">
        <div class="pos-name">${pos.pool_name || pos.pool?.slice(0, 8)}</div>
        <div class="pos-status ${statusClass}">
          <span class="pos-status-dot"></span>
          ${statusText}
        </div>
      </div>
      <div class="pos-subtitle">${pos.strategy} · ${pos.bin_range?.bins_below || 0} bins · step ${pos.bin_step}</div>
      <div class="pos-metrics">
        <div class="metric">
          <div class="metric-label">Val</div>
          <div class="metric-value">${fmtSol(pos.amount_sol)}</div>
        </div>
        <div class="metric">
          <div class="metric-label">Unclaimed</div>
          <div class="metric-value ${unclaimed >= 0 ? 'pos' : 'neg'}">${fmtSol(unclaimed / 150)}</div>
        </div>
        <div class="metric">
          <div class="metric-label">Age</div>
          <div class="metric-value">${fmtDuration(ageMin)}</div>
        </div>
        <div class="metric">
          <div class="metric-label">Yield</div>
          <div class="metric-value">${yieldPct}%</div>
        </div>
      </div>
      <div class="pos-bar-wrap">
        <div class="pos-bar-fill" style="width:${Math.min(Math.max(pnl + 10, 0) * 5, 100)}%"></div>
      </div>
      <div class="pos-footer">
        <div class="pos-sl">SL ${fmtPct(pos.stopLossPct || -12)}</div>
        <div class="pos-pnl-big ${pnlClass}">${fmtPct(pnl)}</div>
        <div class="pos-peak">Peak ${fmtPct(peak)}</div>
      </div>
    </div>
  `;
}

// ─── Inline Log ───────────────────────────────────────────────────────

function renderInlineLogLine(line) {
  const tagLower = (line.tag || "").toLowerCase();
  const tagClass = `il-tag-${tagLower}`;
  return `
    <div class="inline-log-line">
      <span class="il-time">${fmtTime(line.timestamp)}</span>
      <span class="il-tag ${tagClass}">[${line.tag}]</span>
      <span class="il-msg">${escapeHtml(line.message)}</span>
    </div>
  `;
}

function appendInlineLog(line) {
  const container = document.getElementById("inline-log-container");
  if (!container) return;
  const div = document.createElement("div");
  div.className = "inline-log-line";
  div.innerHTML = renderInlineLogLine(line);
  container.appendChild(div);
  while (container.children.length > 8) {
    container.removeChild(container.firstChild);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ─── Main Render ──────────────────────────────────────────────────────

async function renderPage() {
  const main = document.getElementById("main-content");
  main.innerHTML = `
    <div id="dashboard-stats"></div>

    <div class="section-title">Open Positions</div>
    <div class="positions-row" id="open-positions"><div style="color:var(--text-2);padding:20px;">Loading...</div></div>

    <div class="section-title">Wave History</div>
    <div class="wave-row" id="wave-chips"></div>

    <div class="section-title">Live Logs</div>
    <div class="inline-logs" id="inline-log-container"><div style="color:var(--text-2)">Loading logs...</div></div>

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

    renderStats(perf, positions);
    refreshPositions();
    refreshWaves();
    loadInlineLogs();

    const closed = await api("/api/positions/closed");
    renderRecentClosed(closed);
  } catch (err) {
    main.innerHTML = `<div style="color:var(--red);padding:20px;">Error loading dashboard: ${err.message}</div>`;
  }
}

function renderStats(perf, positions) {
  const openCount = positions?.length || 0;
  const maxPositions = 1;
  const winRate = perf?.win_rate || 0;
  const totalPnl = Number(perf?.total_pnl_usd) || 0;
  const avgPnl = perf?.total_trades > 0 ? (totalPnl / perf.total_trades).toFixed(2) : "0.00";

  document.getElementById("dashboard-stats").innerHTML = `
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
        <div class="stat-value ${totalPnl >= 0 ? 'pos' : 'neg'}">${fmtUsd(totalPnl)}</div>
        <div class="stat-sublabel">avg ${fmtUsd(avgPnl)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Today Fees</div>
        <div class="stat-value">◎${perf?.today_fees_sol || "0.0000"}</div>
        <div class="stat-sublabel">$${perf?.today_fees_usd || "0.00"}</div>
      </div>
    </div>
  `;
}

function refreshPositions() {
  const grid = document.getElementById("open-positions");
  if (!grid) return;
  const positions = cache.positions || [];
  if (positions.length === 0) {
    grid.innerHTML = `<div style="color:var(--text-2);padding:20px 0;">No open positions</div>`;
    return;
  }
  grid.innerHTML = positions.map(renderPositionCard).join("");
}

function refreshWaves() {
  const container = document.getElementById("wave-chips");
  if (!container) return;
  const waves = cache.waves || {};

  // Deduplicate by symbol, merge wins/losses
  const merged = {};
  for (const [key, data] of Object.entries(waves)) {
    const symbol = data.symbol || key;
    if (!merged[symbol]) {
      merged[symbol] = { wins: 0, losses: 0 };
    }
    merged[symbol].wins += data.wins || 0;
    merged[symbol].losses += data.losses || 0;
  }

  // Filter: only show tokens with wins >= 1, sort by wins desc
  const entries = Object.entries(merged)
    .filter(([, data]) => data.wins >= 1)
    .sort((a, b) => b[1].wins - a[1].wins);

  if (entries.length === 0) {
    container.innerHTML = `<span style="color:var(--text-2)">No wave history</span>`;
    return;
  }

  container.innerHTML = entries.map(([symbol, data]) => {
    const icon = data.losses > 0 ? "⚠" : "✓";
    return `<div class="wave-chip">${symbol} <span class="count">×${data.wins}</span> <span class="icon">${icon}</span></div>`;
  }).join("");
}

async function loadInlineLogs() {
  try {
    const today = new Date().toISOString().split("T")[0];
    const data = await api(`/api/logs?date=${today}&limit=50&offset=0`);
    const lines = (data.lines || []).slice(-8);
    const container = document.getElementById("inline-log-container");
    if (!container) return;
    container.innerHTML = lines.map(renderInlineLogLine).join("") || `<div style="color:var(--text-2)">No logs yet</div>`;
  } catch {
    const container = document.getElementById("inline-log-container");
    if (container) container.innerHTML = `<div style="color:var(--text-2)">No logs yet</div>`;
  }
}

function renderRecentClosed(closed) {
  const tbody = document.getElementById("rc-tbody");
  if (!tbody) return;
  if (!closed || closed.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-2);padding:20px;">No closed positions yet</td></tr>`;
    return;
  }
  tbody.innerHTML = closed.slice(0, 10).map((p) => {
    const pnl = Number(p.pnl_pct) || 0;
    const pnlUsd = Number(p.pnl_usd) || 0;
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

// ─── Init ─────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  connectWS();
  renderPage();

  // Poll status
  setInterval(async () => {
    try {
      const s = await api("/api/status");
      cache.status = s;
      updateBotDot(!!s.bot_alive);
    } catch { updateBotDot(false); }
  }, 5000);

  // Poll positions + waves + closed + logs every 10s
  setInterval(async () => {
    try {
      const [positions, waves, perf] = await Promise.all([
        api("/api/positions"),
        api("/api/waves"),
        api("/api/performance"),
      ]);
      cache.positions = positions;
      cache.waves = waves;
      cache.performance = perf;
      refreshPositions();
      refreshWaves();

      // Update stats
      const statsContainer = document.getElementById("dashboard-stats");
      if (statsContainer) renderStats(perf, positions);

      // Update closed
      const closed = await api("/api/positions/closed");
      renderRecentClosed(closed);

      // Update balance
      try {
        const today = new Date().toISOString().split("T")[0];
        const snaps = await api(`/api/snapshots?date=${today}`);
        if (snaps && snaps.length > 0) {
          const latest = snaps[snaps.length - 1];
          if (latest.sol != null) {
            document.getElementById("balance-pill").textContent = `◎${latest.sol.toFixed(3)} SOL`;
          }
        }
      } catch {}
    } catch {}
  }, 10000);
});
