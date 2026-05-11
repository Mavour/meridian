import "dotenv/config";
import express from "express";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import chokidar from "chokidar";
import {
  readState,
  readLessons,
  readWaves,
  readPoolMemory,
  readUserConfig,
  getLogFilePath,
  listLogDates,
} from "./lib/dataReader.js";
import { parseLogLines } from "./lib/logParser.js";
import { createLogWatcher } from "./lib/logWatcher.js";

const PORT = parseInt(process.env.DASHBOARD_PORT, 10) || 3001;
const MERIDIAN_PATH = process.env.MERIDIAN_PATH || ".";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Static files
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.use(express.json());

// ─── Helpers ────────────────────────────────────────────────────

function sanitizeConfig(cfg) {
  const sensitive = [
    "rpcUrl",
    "walletKey",
    "llmApiKey",
    "hiveMindApiKey",
    "publicApiKey",
    "agentId",
    "hiveMindAgentId",
    "gmgnApiKey",
    "telegramChatId",
    "llmBaseUrl",
  ];
  const out = {};
  for (const [k, v] of Object.entries(cfg)) {
    out[k] = sensitive.includes(k) && v ? "***" : v;
  }
  return out;
}

function calcPerformance(lessons) {
  const perf = lessons.lessons || [];
  const trades = perf.filter((p) => p.pnl_pct != null);
  const wins = trades.filter((p) => Number(p.pnl_pct) > 0);
  const losses = trades.filter((p) => Number(p.pnl_pct) < 0);
  const avgWin =
    wins.length > 0
      ? wins.reduce((s, p) => s + Number(p.pnl_pct), 0) / wins.length
      : 0;
  const avgLoss =
    losses.length > 0
      ? losses.reduce((s, p) => s + Number(p.pnl_pct), 0) / losses.length
      : 0;
  const totalPnl = trades.reduce((s, p) => s + Number(p.pnl_usd || 0), 0);
  return {
    total_trades: trades.length,
    win_count: wins.length,
    loss_count: losses.length,
    win_rate: trades.length > 0 ? ((wins.length / trades.length) * 100).toFixed(1) : 0,
    avg_win_pct: avgWin.toFixed(2),
    avg_loss_pct: avgLoss.toFixed(2),
    total_pnl_usd: totalPnl.toFixed(2),
  };
}

function getOpenPositions(state) {
  const pos = state.positions || {};
  return Object.values(pos).filter((p) => !p.closed);
}

function getClosedPositions(state, lessons) {
  const pos = state.positions || {};
  const lessonList = lessons?.lessons || [];
  // Build lookup: pool -> latest lesson with pnl
  const pnlByPool = {};
  for (const l of lessonList) {
    if (l.pool && l.pnl_pct != null) {
      // keep the latest lesson per pool
      if (!pnlByPool[l.pool] || new Date(l.created_at) > new Date(pnlByPool[l.pool].created_at)) {
        pnlByPool[l.pool] = l;
      }
    }
  }
  return Object.values(pos)
    .filter((p) => p.closed)
    .sort((a, b) => new Date(b.closed_at || 0) - new Date(a.closed_at || 0))
    .slice(0, 20)
    .map((p) => {
      const lesson = pnlByPool[p.pool];
      if (lesson) {
        return { ...p, pnl_pct: lesson.pnl_pct, pnl_usd: lesson.pnl_usd };
      }
      return p;
    });
}

// ─── API Routes ─────────────────────────────────────────────────

app.get("/api/status", (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  const logFile = getLogFilePath(today);
  const alive = fs.existsSync(logFile);
  const stats = alive ? fs.statSync(logFile) : null;
  res.json({
    bot_alive: alive,
    last_log_time: stats ? new Date(stats.mtime).toISOString() : null,
    meridian_path: MERIDIAN_PATH,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/positions", (req, res) => {
  const state = readState();
  res.json(getOpenPositions(state));
});

app.get("/api/positions/closed", (req, res) => {
  const state = readState();
  const lessons = readLessons();
  res.json(getClosedPositions(state, lessons));
});

app.get("/api/performance", (req, res) => {
  const lessons = readLessons();
  const perf = calcPerformance(lessons);

  // Calculate today fees from lessons created today
  const today = new Date().toISOString().split("T")[0];
  const todayLessons = (lessons.lessons || []).filter((l) =>
    l.created_at && l.created_at.startsWith(today)
  );
  const todayFeesUsd = todayLessons.reduce((s, l) => s + Number(l.fees_earned_usd || 0), 0);
  const solPrice = 150; // approximate SOL price
  perf.today_fees_sol = (todayFeesUsd / solPrice).toFixed(4);
  perf.today_fees_usd = todayFeesUsd.toFixed(2);

  res.json(perf);
});

app.get("/api/lessons", (req, res) => {
  const lessons = readLessons();
  res.json(lessons.lessons?.slice(-50) || []);
});

app.get("/api/waves", (req, res) => {
  const waves = readWaves();
  res.json(waves.waves || {});
});

app.get("/api/pools", (req, res) => {
  const pools = readPoolMemory();
  res.json(pools.pools || {});
});

app.get("/api/config", (req, res) => {
  const cfg = readUserConfig();
  res.json(sanitizeConfig(cfg));
});

app.get("/api/logs", (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  const date = req.query.date || today;
  const limit = parseInt(req.query.limit, 10) || 500;
  const offset = parseInt(req.query.offset, 10) || 0;

  const logFile = getLogFilePath(date);
  if (!fs.existsSync(logFile)) {
    return res.json({ lines: [], total: 0, date });
  }

  const allLines = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean);
  const paginated = allLines.slice(offset, offset + limit);
  const parsed = parseLogLines(paginated);

  res.json({
    lines: parsed,
    total: allLines.length,
    date,
    offset,
    limit,
  });
});

app.get("/api/log-dates", (req, res) => {
  res.json(listLogDates());
});

app.get("/api/snapshots", (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  const date = req.query.date || today;
  const fp = path.join(MERIDIAN_PATH, "logs", `snapshots-${date}.jsonl`);
  if (!fs.existsSync(fp)) return res.json([]);
  const lines = fs.readFileSync(fp, "utf8").split("\n").filter(Boolean);
  const parsed = lines.map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  res.json(parsed);
});

// ─── WebSocket ──────────────────────────────────────────────────

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(msg);
    }
  });
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "connected", data: "LPGoose Dashboard" }));
});

// ─── File Watchers ──────────────────────────────────────────────

const stateWatcher = chokidar.watch(
  ["state.json", "wave-history.json", "lessons.json", "pool-memory.json"],
  { cwd: MERIDIAN_PATH, ignoreInitial: true }
);

stateWatcher.on("change", (file) => {
  if (file === "state.json") {
    const state = readState();
    broadcast("positions", getOpenPositions(state));
    broadcast("closed", getClosedPositions(state));
  }
  if (file === "wave-history.json") {
    broadcast("waves", readWaves());
  }
});

// Log tail
const logWatcher = createLogWatcher(broadcast);

// ─── Start ──────────────────────────────────────────────────────

server.listen(PORT, "0.0.0.0", () => {
  console.log(`LPGoose Dashboard running on http://0.0.0.0:${PORT}`);
});
