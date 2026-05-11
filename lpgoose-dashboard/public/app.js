/**
 * LPGoose Dashboard — SPA Router + WebSocket Client
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

// ─── Navigation ───────────────────────────────────────────────────────

function initNav() {
  document.querySelectorAll(".nav-link").forEach((btn) => {
    btn.addEventListener("click", () => {
      const page = btn.dataset.page;
      setPage(page);
      document.querySelectorAll(".nav-link").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });
}

function setPage(page) {
  const main = document.getElementById("main-content");
  window.currentPage = page;
  switch (page) {
    case "dashboard": renderDashboard(main); break;
    case "logs": renderLogs(main); break;
    case "performance": renderPerformance(main); break;
    case "pools": renderPools(main); break;
    case "config": renderConfig(main); break;
    default: renderDashboard(main);
  }
}

// ─── WebSocket ────────────────────────────────────────────────────────

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
      handleWSMessage(msg);
    } catch {}
  };

  ws.onclose = () => {
    updateBotDot(false);
    wsReconnectTimer = setTimeout(connectWS, wsReconnectDelay);
  };

  ws.onerror = () => updateBotDot(false);
}

function handleWSMessage(msg) {
  if (msg.type === "log" && window.currentPage === "dashboard") {
    appendInlineLog(msg.data);
  }
  if (msg.type === "log" && window.currentPage === "logs") {
    appendLogLine(msg.data);
  }
  if (msg.type === "positions" && window.currentPage === "dashboard") {
    cache.positions = msg.data;
    refreshDashboardPositions();
  }
  if (msg.type === "waves" && window.currentPage === "dashboard") {
    cache.waves = msg.data;
    refreshDashboardWaves();
  }
}

function updateBotDot(online) {
  const dot = document.getElementById("bot-dot");
  const text = document.getElementById("bot-text");
  if (dot) dot.classList.toggle("online", online);
  if (text) text.textContent = online ? "Bot running" : "Bot offline";
}

// ─── API helpers ──────────────────────────────────────────────────────

async function api(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

// ─── Formatters ───────────────────────────────────────────────────────

function fmtPct(n) {
  if (n == null) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}
function fmtUsd(n) {
  if (n == null) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}$${n.toFixed(2)}`;
}
function fmtSol(n) {
  if (n == null) return "—";
  return `◎${n.toFixed(4)}`;
}
function fmtDuration(minutes) {
  if (!minutes && minutes !== 0) return "—";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
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

// ─── Init ─────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  initNav();
  connectWS();
  setPage("dashboard");

  // Poll status + balance
  setInterval(async () => {
    try {
      const s = await api("/api/status");
      cache.status = s;
      updateBotDot(!!s.bot_alive);
    } catch { updateBotDot(false); }
  }, 5000);

  // Try to fetch balance from latest snapshot (best effort)
  setInterval(async () => {
    try {
      const today = new Date().toISOString().split("T")[0];
      const snaps = await api(`/api/snapshots?date=${today}`);
      if (snaps && snaps.length > 0) {
        const latest = snaps[snaps.length - 1];
        if (latest.sol != null) {
          document.getElementById("balance-pill").textContent = `◎${latest.sol.toFixed(3)} SOL`;
        }
      }
    } catch {
      // ignore
    }
  }, 30000);
});
