/**
 * LPGoose Dashboard — SPA Router + WebSocket Client
 */

const API_BASE = "";
let ws = null;
let wsReconnectTimer = null;
const wsReconnectDelay = 5000;

// Global state cache
const cache = {
  status: null,
  positions: [],
  closed: [],
  performance: null,
  waves: {},
  logs: [],
};

// Navigation
function initNav() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const page = btn.dataset.page;
      setPage(page);
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
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

// WebSocket
function connectWS() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    console.log("[WS] Connected");
    clearTimeout(wsReconnectTimer);
    updateStatusDot(true);
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      handleWSMessage(msg);
    } catch (e) {
      console.error("[WS] Parse error", e);
    }
  };

  ws.onclose = () => {
    updateStatusDot(false);
    wsReconnectTimer = setTimeout(connectWS, wsReconnectDelay);
  };

  ws.onerror = () => {
    updateStatusDot(false);
  };
}

function handleWSMessage(msg) {
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

function updateStatusDot(online) {
  const dot = document.getElementById("bot-status");
  if (!dot) return;
  dot.classList.toggle("online", online);
  dot.title = online ? "Bot connected" : "Bot disconnected";
}

// API helpers
async function api(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return res.json();
}

// Number formatter
function fmtPct(n) {
  if (n == null) return "-";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}
function fmtUsd(n) {
  if (n == null) return "-";
  const sign = n >= 0 ? "+" : "";
  return `${sign}$${n.toFixed(2)}`;
}
function fmtDuration(minutes) {
  if (!minutes && minutes !== 0) return "-";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m}m`;
}
function timeAgo(iso) {
  if (!iso) return "-";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Init
document.addEventListener("DOMContentLoaded", () => {
  initNav();
  connectWS();
  setPage("dashboard");

  // Poll status every 5s as fallback
  setInterval(async () => {
    try {
      const s = await api("/api/status");
      cache.status = s;
      const alive = !!s.bot_alive;
      updateStatusDot(alive);
    } catch {
      updateStatusDot(false);
    }
  }, 5000);
});
