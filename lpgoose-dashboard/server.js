import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFileSync, existsSync, createReadStream, statSync } from 'fs';
import { createInterface } from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';
import chokidar from 'chokidar';
import cors from 'cors';
import { loadEnv } from '../envcrypt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({
  envPath: path.join(__dirname, '../.env'),
  keyPath: path.join(__dirname, '../.envrypt'),
});
const MERIDIAN_PATH = process.env.MERIDIAN_PATH || path.join(__dirname, '..');
const PORT = parseInt(process.env.DASHBOARD_PORT || '3001');
const LOG_DIR = path.join(MERIDIAN_PATH, 'logs');

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

const MASK_KEYS = ['telegramBotToken','apiKey','privateKey','walletKey','LLM_API_KEY','OPENROUTER_API_KEY','GMGN_API_KEY','password','secret'];
function maskConfig(obj) {
  return JSON.parse(JSON.stringify(obj), (k, v) =>
    MASK_KEYS.some(mk => k.toLowerCase().includes(mk.toLowerCase())) ? '••••••••' : v
  );
}

function todayLog() {
  const d = new Date().toISOString().slice(0,10);
  return path.join(LOG_DIR, `agent-${d}.log`);
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const PRICE_CACHE_MS = 30_000;
const priceCache = new Map();
const decimalsCache = new Map([[SOL_MINT, 9], [USDC_MINT, 6], [USDT_MINT, 6]]);
const poolCache = new Map();
let sdkPromise = null;
let connectionPromise = null;

function asNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value?.toNumber === 'function') return value.toNumber();
  if (typeof value?.toString === 'function') {
    const n = Number(value.toString());
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = asNumber(value);
    if (n != null) return n;
  }
  return null;
}

function round(value, digits = 4) {
  const n = asNumber(value);
  if (n == null) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function uiAmount(raw, decimals = 0) {
  const n = asNumber(raw);
  if (n == null) return null;
  return n / (10 ** Number(decimals || 0));
}

function pairSymbols(pair) {
  const parts = String(pair || '').split(/[/-]/).map((p) => p.trim()).filter(Boolean);
  return { x: parts[0] || 'Token', y: parts[1] || 'SOL' };
}

function readState() {
  return readJson(path.join(MERIDIAN_PATH, 'state.json')) || {};
}

function getRpcUrl() {
  const cfg = readJson(path.join(MERIDIAN_PATH, 'user-config.json')) || {};
  return process.env.RPC_URL || cfg.rpcUrl || null;
}

async function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = Promise.all([
      import('@meteora-ag/dlmm'),
      import('@solana/web3.js'),
    ]).then(([dlmmMod, web3]) => ({
      DLMM: dlmmMod.default,
      getPriceOfBinByBinId: dlmmMod.getPriceOfBinByBinId,
      PublicKey: web3.PublicKey,
      Connection: web3.Connection,
    }));
  }
  return sdkPromise;
}

async function getConnection() {
  if (!connectionPromise) {
    connectionPromise = (async () => {
      const rpcUrl = getRpcUrl();
      if (!rpcUrl) throw new Error('RPC_URL/rpcUrl not configured');
      const { Connection } = await loadSdk();
      return new Connection(rpcUrl, 'confirmed');
    })();
  }
  return connectionPromise;
}

async function getPool(poolAddress) {
  if (!poolAddress) return null;
  if (poolCache.has(poolAddress)) return poolCache.get(poolAddress);
  const { DLMM, PublicKey } = await loadSdk();
  const pool = await DLMM.create(await getConnection(), new PublicKey(poolAddress));
  poolCache.set(poolAddress, pool);
  return pool;
}

async function getMintDecimals(mint) {
  if (!mint) return 9;
  if (decimalsCache.has(mint)) return decimalsCache.get(mint);
  try {
    const { PublicKey } = await loadSdk();
    const info = await (await getConnection()).getParsedAccountInfo(new PublicKey(mint));
    const decimals = firstNumber(info.value?.data?.parsed?.info?.decimals) ?? 9;
    decimalsCache.set(mint, decimals);
    return decimals;
  } catch {
    decimalsCache.set(mint, 9);
    return 9;
  }
}

async function fetchTokenPrices(mints) {
  const unique = [...new Set(mints.filter(Boolean))];
  const now = Date.now();
  const prices = {};
  const missing = [];

  for (const mint of unique) {
    const cached = priceCache.get(mint);
    if (cached && now - cached.ts < PRICE_CACHE_MS) prices[mint] = cached.price;
    else missing.push(mint);
  }

  if (missing.length) {
    try {
      const res = await fetch(`https://api.jup.ag/price/v3?ids=${encodeURIComponent(missing.join(','))}`);
      if (res.ok) {
        const data = await res.json();
        for (const mint of missing) {
          const entry = data?.[mint] || data?.data?.[mint];
          const price = firstNumber(entry?.usdPrice, entry?.price, entry);
          if (price && price > 0) {
            prices[mint] = price;
            priceCache.set(mint, { price, ts: now });
          }
        }
      }
    } catch {
      // Keep dashboard responsive; missing prices fall back to existing API totals.
    }
  }

  if (prices[USDC_MINT] == null) prices[USDC_MINT] = 1;
  if (prices[USDT_MINT] == null) prices[USDT_MINT] = 1;
  return prices;
}

function getPositionBins(meteoraPosition) {
  return [
    meteoraPosition?.binData,
    meteoraPosition?.positionData?.binData,
    meteoraPosition?.positionData?.positionBinData,
    meteoraPosition?.positionBinData,
  ].find(Array.isArray) || [];
}

function fallbackBinPrice(binId, binStep) {
  const id = asNumber(binId);
  const step = asNumber(binStep);
  if (id == null || step == null) return null;
  return Math.pow(1 + step / 10_000, id);
}

function priceForBin(getPriceOfBinByBinId, binId, binStep) {
  try {
    const price = getPriceOfBinByBinId && binId != null && binStep != null
      ? Number(getPriceOfBinByBinId(binId, binStep).toString())
      : null;
    return Number.isFinite(price) ? price : fallbackBinPrice(binId, binStep);
  } catch {
    return fallbackBinPrice(binId, binStep);
  }
}

async function sdkPositionSnapshot(position, tracked) {
  try {
    const pool = await getPool(position.pool || tracked?.pool);
    if (!pool) return {};
    const { PublicKey, getPriceOfBinByBinId } = await loadSdk();
    const meteoraPosition = await pool.getPosition(new PublicKey(position.position));
    const positionData = meteoraPosition?.positionData || meteoraPosition || {};
    const bins = getPositionBins(meteoraPosition);

    const tokenXMint = pool.lbPair?.tokenXMint?.toString?.() || position.base_mint || tracked?.token_mint || null;
    const tokenYMint = pool.lbPair?.tokenYMint?.toString?.() || SOL_MINT;
    const [xDecimals, yDecimals, prices] = await Promise.all([
      getMintDecimals(tokenXMint),
      getMintDecimals(tokenYMint),
      fetchTokenPrices([tokenXMint, tokenYMint]),
    ]);

    const tokenXAmount = uiAmount(positionData.totalXAmount, xDecimals) ?? null;
    const tokenYAmount = uiAmount(positionData.totalYAmount, yDecimals) ?? null;
    const feeXAmount = uiAmount(positionData.feeX, xDecimals) ?? null;
    const feeYAmount = uiAmount(positionData.feeY, yDecimals) ?? null;
    const priceX = tokenXMint ? prices[tokenXMint] : null;
    const priceY = tokenYMint ? prices[tokenYMint] : null;
    const computedValue = tokenXAmount != null && tokenYAmount != null && priceX != null && priceY != null
      ? tokenXAmount * priceX + tokenYAmount * priceY
      : null;
    const computedFees = feeXAmount != null && feeYAmount != null && priceX != null && priceY != null
      ? feeXAmount * priceX + feeYAmount * priceY
      : null;

    const lowerBin = firstNumber(positionData.lowerBinId, position.lower_bin, tracked?.bin_range?.min);
    const upperBin = firstNumber(positionData.upperBinId, position.upper_bin, tracked?.bin_range?.max);
    let activeBin = firstNumber(pool.lbPair?.activeId, position.active_bin, tracked?.bin_range?.active);
    if (activeBin == null && typeof pool.getActiveBin === 'function') {
      activeBin = firstNumber((await pool.getActiveBin())?.binId);
    }
    const binStep = firstNumber(pool.lbPair?.binStep, position.bin_step, tracked?.bin_step);
    const symbols = pairSymbols(position.pair || tracked?.pool_name);
    const inputUsd = firstNumber(tracked?.initial_value_usd, position.initial_value_usd);
    const unclaimedUsd = firstNumber(computedFees, position.unclaimed_fees_true_usd, position.unclaimed_fees_usd);

    return {
      lower_bin: lowerBin,
      upper_bin: upperBin,
      active_bin: activeBin,
      bin_step: binStep,
      total_bins: bins.length || (lowerBin != null && upperBin != null ? Math.abs(upperBin - lowerBin) + 1 : null),
      bins_below: lowerBin != null && activeBin != null ? Math.max(0, activeBin - lowerBin) : position.bins_below,
      bins_above: upperBin != null && activeBin != null ? Math.max(0, upperBin - activeBin) : position.bins_above,
      total_value_usd: firstNumber(computedValue, position.total_value_true_usd, position.total_value_usd),
      unclaimed_fees_usd: unclaimedUsd,
      claimed_fees_usd: firstNumber(tracked?.total_fees_claimed_usd, position.collected_fees_true_usd, position.collected_fees_usd, 0),
      fee_pct_of_input: inputUsd > 0 && unclaimedUsd != null ? (unclaimedUsd / inputUsd) * 100 : null,
      price_range: {
        min: priceForBin(getPriceOfBinByBinId, lowerBin, binStep),
        max: priceForBin(getPriceOfBinByBinId, upperBin, binStep),
        current: priceForBin(getPriceOfBinByBinId, activeBin, binStep),
      },
      holdings: {
        tokenX: {
          symbol: symbols.x,
          mint: tokenXMint,
          amount: tokenXAmount,
          value_usd: tokenXAmount != null && priceX != null ? tokenXAmount * priceX : null,
        },
        tokenY: {
          symbol: tokenYMint === SOL_MINT ? 'SOL' : symbols.y,
          mint: tokenYMint,
          amount: tokenYAmount,
          value_usd: tokenYAmount != null && priceY != null ? tokenYAmount * priceY : null,
        },
      },
      fees: {
        unclaimed_x_amount: feeXAmount,
        unclaimed_y_amount: feeYAmount,
        unclaimed_usd: unclaimedUsd,
        pct_of_input: inputUsd > 0 && unclaimedUsd != null ? (unclaimedUsd / inputUsd) * 100 : null,
        claimed_usd: firstNumber(tracked?.total_fees_claimed_usd, position.collected_fees_true_usd, position.collected_fees_usd, 0),
      },
    };
  } catch {
    return {};
  }
}

function normalizePosition(position, tracked = {}, snapshot = {}) {
  const merged = { ...tracked, ...position, ...snapshot };
  const lowerBin = firstNumber(merged.lower_bin, tracked.bin_range?.min);
  const upperBin = firstNumber(merged.upper_bin, tracked.bin_range?.max);
  const activeBin = firstNumber(merged.active_bin, tracked.bin_range?.active);
  const totalBins = firstNumber(merged.total_bins, lowerBin != null && upperBin != null ? Math.abs(upperBin - lowerBin) + 1 : null);
  const binStep = firstNumber(merged.bin_step, tracked.bin_step);
  const symbols = pairSymbols(merged.pair || tracked.pool_name);
  const valueUsd = firstNumber(merged.total_value_usd, merged.total_value_true_usd);
  const unclaimedFees = firstNumber(merged.unclaimed_fees_usd, merged.unclaimed_fees_true_usd);
  const claimedFees = firstNumber(merged.claimed_fees_usd, tracked.total_fees_claimed_usd, merged.collected_fees_true_usd, merged.collected_fees_usd, 0);

  return {
    ...merged,
    pair: merged.pair || tracked.pool_name || tracked.pool || merged.pool || 'Unknown pool',
    strategy: merged.strategy || tracked.strategy || 'DLMM',
    lower_bin: lowerBin,
    upper_bin: upperBin,
    active_bin: activeBin,
    bin_step: binStep,
    total_bins: totalBins,
    bins_below: firstNumber(merged.bins_below, lowerBin != null && activeBin != null ? Math.max(0, activeBin - lowerBin) : totalBins),
    total_value_usd: valueUsd,
    unclaimed_fees_usd: unclaimedFees,
    claimed_fees_usd: claimedFees,
    fee_pct_of_input: firstNumber(merged.fee_pct_of_input, merged.fees?.pct_of_input),
    price_range: merged.price_range || (
      lowerBin != null && upperBin != null && activeBin != null && binStep != null
        ? { min: fallbackBinPrice(lowerBin, binStep), max: fallbackBinPrice(upperBin, binStep), current: fallbackBinPrice(activeBin, binStep) }
        : null
    ),
    holdings: merged.holdings || {
      tokenX: { symbol: symbols.x, amount: firstNumber(merged.token_x_amount) },
      tokenY: { symbol: symbols.y || 'SOL', amount: firstNumber(merged.token_y_amount) },
    },
    fees: merged.fees || {
      unclaimed_usd: unclaimedFees,
      pct_of_input: firstNumber(merged.fee_pct_of_input),
      claimed_usd: claimedFees,
    },
    peak_pnl_pct: firstNumber(merged.peak_pnl_pct, tracked.peak_pnl_pct, 0),
    minutes_oor: firstNumber(merged.minutes_oor, merged.minutes_out_of_range, 0),
  };
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

function readTrackedOpenPositions() {
  const state = readState();
  return Object.values(state.positions || {}).filter(p => !p.closed);
}

app.get('/api/positions', async (req, res) => {
  const fallbackPositions = readTrackedOpenPositions();
  const trackedByPosition = Object.fromEntries(fallbackPositions.map((p) => [p.position, p]));
  try {
    const { getMyPositions } = await import('../tools/dlmm.js');
    const live = await getMyPositions({ force: true, silent: true });
    const rawPositions = Array.isArray(live?.positions) && live.positions.length > 0
      ? live.positions
      : fallbackPositions;
    const positions = await Promise.all(rawPositions.map(async (position) => {
      const tracked = trackedByPosition[position.position] || {};
      const snapshot = await sdkPositionSnapshot(position, tracked);
      return normalizePosition(position, tracked, snapshot);
    }));
    if (positions.length > 0) {
      return res.json({
        ...live,
        positions,
        total: positions.length,
        source: Array.isArray(live?.positions) && live.positions.length > 0 ? 'onchain' : 'state',
      });
    }
    return res.json({
      positions: fallbackPositions,
      total: fallbackPositions.length,
      source: live?.error ? 'state_fallback' : 'state',
      error: live?.error || null,
    });
  } catch (error) {
    const positions = fallbackPositions.map((position) => normalizePosition(position, position, {}));
    res.json({
      positions,
      total: positions.length,
      source: 'state_fallback',
      error: error.message,
    });
  }
});

app.get('/api/performance', (req, res) => {
  const data = readJson(path.join(MERIDIAN_PATH, 'lessons.json')) || {};
  const perf = data.performance || [];
  const trades = perf
    .map((p, index) => {
      const pnlAmount = firstNumber(p.pnl_usd, p.pnl_amount, p.fees_earned_usd != null && p.final_value_usd != null && p.initial_value_usd != null
        ? p.final_value_usd + p.fees_earned_usd - p.initial_value_usd
        : null);
      const timestamp = p.recorded_at || p.closed_at || p.created_at || null;
      return {
        position: p.position || null,
        pool: p.pool || null,
        pool_name: p.pool_name || p.pool || `Trade ${index + 1}`,
        trade_index: index + 1,
        timestamp,
        pnl_amount: pnlAmount ?? 0,
        pnl_usd: pnlAmount ?? 0,
        pnl_pct: firstNumber(p.pnl_pct, p.pnl_percent, 0),
        is_win: (pnlAmount ?? 0) > 0,
        hold_duration: firstNumber(p.minutes_held, p.hold_duration, p.minutes_in_range, 0),
        minutes_held: firstNumber(p.minutes_held, p.hold_duration, p.minutes_in_range, 0),
        fees_earned_usd: firstNumber(p.fees_earned_usd, 0),
      };
    })
    .sort((a, b) => {
      const at = a.timestamp ? new Date(a.timestamp).getTime() : a.trade_index;
      const bt = b.timestamp ? new Date(b.timestamp).getTime() : b.trade_index;
      return at - bt;
    })
    .map((trade, index) => ({ ...trade, trade_index: index + 1 }));
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
    trades,
    recent: perf.slice(-20).reverse(),
  });
});

app.get('/api/lessons', (req, res) => {
  const data = readJson(path.join(MERIDIAN_PATH, 'lessons.json')) || {};
  res.json(data.lessons || []);
});

app.get('/api/waves', (req, res) => {
  const data = readJson(path.join(MERIDIAN_PATH, 'wave-history.json')) || {};
  res.json(data.waves || {});
});

app.get('/api/config', (req, res) => {
  const cfg = readJson(path.join(MERIDIAN_PATH, 'user-config.json')) || {};
  res.json(maskConfig(cfg));
});

app.get('/api/wallet', async (req, res) => {
  try {
    const { getWalletBalances } = await import('../tools/wallet.js');
    res.json(await getWalletBalances());
  } catch (error) {
    res.json({ wallet: null, sol: 0, sol_usd: 0, usdc: 0, total_usd: 0, tokens: [], error: error.message });
  }
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
const logTailState = new Map();

function shouldTailLog(filePath) {
  const name = path.basename(filePath || '');
  return /^agent-\d{4}-\d{2}-\d{2}\.log$/.test(name) && path.resolve(filePath) === path.resolve(todayLog());
}

function emitLogLine(parsed) {
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
}

function tailLogFile(filePath, { fromStart = false } = {}) {
  if (!shouldTailLog(filePath) || !existsSync(filePath)) return;

  const size = statSync(filePath).size;
  const state = logTailState.get(filePath) || { pos: fromStart ? 0 : size, partial: '' };
  if (size < state.pos) {
    state.pos = 0;
    state.partial = '';
  }
  if (size === state.pos) {
    logTailState.set(filePath, state);
    return;
  }

  const stream = createReadStream(filePath, { start: state.pos, end: size - 1, encoding: 'utf8' });
  let buf = state.partial || '';
  stream.on('data', chunk => { buf += chunk; });
  stream.on('end', () => {
    state.pos = size;
    const parts = buf.split(/\r?\n/);
    state.partial = parts.pop() || '';
    parts.filter(Boolean).forEach(raw => {
      const parsed = parseLogLine(raw);
      if (parsed) emitLogLine(parsed);
    });
    logTailState.set(filePath, state);
  });
  stream.on('error', () => {
    logTailState.set(filePath, state);
  });
}

tailLogFile(todayLog());

chokidar.watch(LOG_DIR, {
  ignoreInitial: true,
  depth: 0,
  usePolling: true,
  interval: 1000,
}).on('add', (filePath) => tailLogFile(filePath, { fromStart: true }))
  .on('change', (filePath) => tailLogFile(filePath));

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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Meridian Dashboard running at http://127.0.0.1:${PORT}`);
  console.log(`MERIDIAN_PATH: ${MERIDIAN_PATH}`);
});
