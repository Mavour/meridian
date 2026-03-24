import express from 'express';
import cors from 'cors';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.DASHBOARD_PORT || 3001;

app.use(cors());
app.use(express.json());

// Read data helpers
function readJson(filename) {
  try {
    return JSON.parse(readFileSync(join(__dirname, '..', filename), 'utf8'));
  } catch {
    return null;
  }
}

// API Endpoints
app.get('/api/status', (req, res) => {
  const state = readJson('state.json') || {};
  const perf = readJson('lessons.json') || {};
  const config = readJson('user-config.json') || {};
  
  res.json({
    sol: 0,
    solUsd: 0,
    mode: process.env.DRY_RUN === 'true' ? 'DRY_RUN' : 'LIVE',
    lastUpdate: state.lastUpdated || new Date().toISOString(),
    totalPositions: Object.keys(state.positions || {}).length
  });
});

app.get('/api/positions', (req, res) => {
  const state = readJson('state.json') || {};
  const positions = state.positions || {};
  
  const positionList = Object.entries(positions).map(([address, pos]) => ({
    position: address,
    pool: pos.pool || '',
    pair: pos.pool_name || address.slice(0, 8),
    in_range: !pos.out_of_range_since,
    pnl_usd: 0,
    pnl_pct: 0,
    total_value_usd: pos.initial_value_usd || 0,
    unclaimed_fees_usd: 0,
    collected_fees_usd: pos.total_fees_claimed_usd || 0,
    age_minutes: pos.deployed_at 
      ? Math.floor((Date.now() - new Date(pos.deployed_at).getTime()) / 60000)
      : null,
    minutes_out_of_range: pos.out_of_range_since
      ? Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000)
      : 0,
    lower_bin: pos.bin_range?.min || 0,
    upper_bin: pos.bin_range?.max || 100,
    active_bin: null
  }));
  
  res.json({
    wallet: state.wallet,
    total_positions: positionList.length,
    positions: positionList
  });
});

app.get('/api/config', (req, res) => {
  const config = readJson('user-config.json') || {};
  
  res.json({
    screening: config.screening || {},
    management: config.management || {},
    risk: config.risk || {},
    schedule: config.schedule || {},
    strategy: config.strategy || {}
  });
});

app.get('/api/performance', (req, res) => {
  const lessons = readJson('lessons.json') || {};
  const performance = lessons.performance || [];
  
  if (performance.length === 0) {
    return res.json({
      total_positions_closed: 0,
      win_rate_pct: 0,
      avg_pnl_pct: 0,
      best_pnl_pct: 0,
      worst_pnl_pct: 0,
      total_fees_earned: 0,
      recent_performances: []
    });
  }
  
  const winners = performance.filter(p => (p.pnl_pct || 0) > 0);
  const pnls = performance.map(p => p.pnl_pct || 0);
  
  res.json({
    total_positions_closed: performance.length,
    win_rate_pct: (winners.length / performance.length) * 100,
    avg_pnl_pct: pnls.reduce((a, b) => a + b, 0) / pnls.length,
    best_pnl_pct: Math.max(...pnls),
    worst_pnl_pct: Math.min(...pnls),
    total_fees_earned: performance.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0),
    recent_performances: performance.slice(-20).reverse()
  });
});

app.get('/api/recent-events', (req, res) => {
  const state = readJson('state.json') || {};
  const events = state.recentEvents || [];
  
  res.json({ events: events.slice(-50).reverse() });
});

// Serve static dashboard
app.use(express.static(join(__dirname)));

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Dashboard API running on http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/dashboard/`);
});
