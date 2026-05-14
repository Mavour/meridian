import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFileSync, existsSync, createReadStream, statSync } from 'fs';
import { createInterface } from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';
import chokidar from 'chokidar';
import cors from 'cors';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MERIDIAN_PATH = process.env.MERIDIAN_PATH || path.join(__dirname, '../meridian');
const PORT = parseInt(process.env.DASHBOARD_PORT || '3001');

// ── helpers ──────────────────────────────────────────
function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function parseLogLine(raw) {
  const m = raw.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\] \[([^\]]+)\] (.+)$/);
  if (!m) return null;
  const [, iso, tag, msg] = m;
  return { iso, time: new Date(iso).toLocaleTimeString('en-GB',{hour12:false}), tag: tag.trim(), msg: msg.trim() };
}

const MASK_KEYS = ['telegramBotToken','apiKey','privateKey','LLM_API_KEY','OPENROUTER_API_KEY','GMGN_API_KEY','password','token','secret'];
function maskConfig(obj) {
  return JSON.parse(JSON.stringify(obj), (k, v) =>
    MASK_KEYS.some(mk => k.toLowerCase().includes(mk.toLowerCase())) ? '••••••••' : v
  );
}

function todayLog() {
  const d = new Date().toISOString().slice(0,10);
  return path.join(MERIDIAN_PATH, 'logs', `agent-${d}.log`);
}

// ── Express ───────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'dist')));

// Optional basic auth
if (process.env.DASHBOARD_USER) {
  app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path === '/ws') {
      const b64 = (req.headers.authorization||'').split(' ')[1]||'';
      const [u, p] = Buffer.from(b64,'base64').toString().split(':');
      if (u === process.env.DASHBOARD_USER && p === process.env.DASHBOARD_PASS) return next();
      res.set('WWW-Authenticate','Basic realm="Meridian"');
      return res.status(401).send('Unauthorized');
    }
    next();
  });
}

// ── API routes ────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ alive: true, uptime_s: Math.floor(process.uptime()), pid: process.pid });
});

app.get('/api/positions', (req, res) => {
  const state = readJson(path.join(MERIDIAN_PATH, 'state.json')) || {};
  const positions = Object.values(state.positions || {}).filter(p => !p.closed);
  res.json({ positions, total: positions.length });
});

app.get('/api/performance', (req, res) => {
  const data = readJson(path.join(MERIDIAN_PATH, 'lessons.json')) || {};
  const perf = data.performance || [];
  const wins = perf.filter(p => (p.pnl_usd||0) > 0);
  const losses = perf.filter(p => (p.pnl_usd||0) < 0);
  const today = new Date(); today.setHours(0,0,0,0);
  const todayPerf = perf.filter(p => new Date(p.recorded_at) >= today);
  const todayFees = todayPerf.reduce((s,p) => s + (p.fees_earned_usd||0), 0);
  const todayFeesSol = todayPerf.reduce((s,p) => s + (p.fees_earned_sol||0), 0);
  res.json({
    total: perf.length,
    wins: wins.length,
    losses: losses.length,
    win_rate: perf.length ? Math.round(wins.length/perf.length*100*10)/10 : 0,
    avg_win: wins.length ? wins.reduce((s,p)=>s+(p.pnl_usd||0),0)/wins.length : 0,
    avg_loss: losses.length ? losses.reduce((s,p)=>s+(p.pnl_usd||0),0)/losses.length : 0,
    total_pnl: perf.reduce((s,p)=>s+(p.pnl_usd||0),0),
    today_fees_usd: todayFees,
    today_fees_sol: todayFeesSol,
    recent: perf.slice(-20).reverse(),
  });
});

app.get('/api/waves', (req, res) => {
  const data = readJson(path.join(MERIDIAN_PATH, 'wave-history.json')) || {};
  res.json(data.waves || {});
});

app.get('/api/config', (req, res) => {
  const cfg = readJson(path.join(MERIDIAN_PATH, 'user-config.json')) || {};
  res.json(maskConfig(cfg));
});

app.get('/api/pools', (req, res) => {
  const data = readJson(path.join(MERIDIAN_PATH, 'pool-memory.json')) || {};
  const pools = Object.entries(data).map(([id, p]) => ({
    id,
    name: p.pool_name || p.name || id.slice(0,8),
    deploys: (p.deploys||[]).length,
    wins: (p.deploys||[]).filter(d=>(d.pnl_pct||0)>0).length,
    losses: (p.deploys||[]).filter(d=>(d.pnl_pct||0)<0).length,
    avg_pnl: (p.deploys||[]).length ? (p.deploys||[]).reduce((s,d)=>s+(d.pnl_pct||0),0)/(p.deploys||[]).length : 0,
    last_deploy: (p.deploys||[]).slice(-1)[0]?.deployed_at || null,
    cooldown_until: p.base_mint_cooldown_until || null,
  }));
  res.json(pools);
});

app.get('/api/logs', (req, res) => {
  const n = parseInt(req.query.n || '300');
  const tagFilter = req.query.tag ? req.query.tag.split(',') : null;
  const logFile = todayLog();
  if (!existsSync(logFile)) return res.json({ lines: [] });
  const lines = [];
  const rl = createInterface({ input: createReadStream(logFile), crlfDelay: Infinity });
  rl.on('line', raw => {
    const parsed = parseLogLine(raw);
    if (parsed && (!tagFilter || tagFilter.includes(parsed.tag))) lines.push(parsed);
  });
  rl.on('close', () => res.json({ lines: lines.slice(-n) }));
});

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));

// ── WebSocket ─────────────────────────────────────────
const server = createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

wss.on('connection', async (ws) => {
  const logFile = todayLog();
  if (existsSync(logFile)) {
    const lines = [];
    const rl = createInterface({ input: createReadStream(logFile), crlfDelay: Infinity });
    rl.on('line', raw => { const p = parseLogLine(raw); if (p) lines.push(p); });
    rl.on('close', () => {
      lines.slice(-200).forEach(line => ws.send(JSON.stringify({ type: 'log', data: line })));
    });
  }
});

// ── File watchers ─────────────────────────────────────
let logFilePos = existsSync(todayLog()) ? statSync(todayLog()).size : 0;

chokidar.watch(todayLog(), { usePolling: false }).on('change', (filePath) => {
  const size = statSync(filePath).size;
  if (size <= logFilePos) return;
  const stream = createReadStream(filePath, { start: logFilePos, encoding: 'utf8' });
  let buf = '';
  stream.on('data', chunk => { buf += chunk; });
  stream.on('end', () => {
    logFilePos = size;
    buf.split('\n').filter(Boolean).forEach(raw => {
      const parsed = parseLogLine(raw);
      if (!parsed) return;
      broadcast('log', parsed);
      if (parsed.tag === 'DEPLOY' && parsed.msg.includes('SUCCESS')) {
        broadcast('alert', { kind: 'deploy', msg: parsed.msg });
      }
      if (parsed.tag === 'STATE' && parsed.msg.includes('Stop loss')) {
        broadcast('alert', { kind: 'sl', msg: parsed.msg });
      }
      if (parsed.tag === 'STATE' && parsed.msg.includes('Trailing TP')) {
        broadcast('alert', { kind: 'tp', msg: parsed.msg });
      }
    });
  });
});

chokidar.watch([
  path.join(MERIDIAN_PATH, 'state.json'),
  path.join(MERIDIAN_PATH, 'lessons.json'),
  path.join(MERIDIAN_PATH, 'wave-history.json'),
], { usePolling: false }).on('change', (filePath) => {
  const name = path.basename(filePath);
  if (name === 'state.json') broadcast('state_update', { file: name });
  if (name === 'lessons.json') broadcast('perf_update', { file: name });
  if (name === 'wave-history.json') broadcast('wave_update', { file: name });
});

setInterval(() => {
  const logFile = todayLog();
  if (!existsSync(logFile)) return broadcast('bot_status', { alive: false });
  const age = Date.now() - statSync(logFile).mtimeMs;
  broadcast('bot_status', { alive: age < 5 * 60 * 1000 });
}, 15000);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Meridian Dashboard running at http://127.0.0.1:${PORT}`);
  console.log(`MERIDIAN_PATH: ${MERIDIAN_PATH}`);
});
