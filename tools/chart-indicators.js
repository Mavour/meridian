// ════════════════════════════════════════════════════════
// chart-indicators.js — GMGN-BASED DROP-IN REPLACEMENT
// ════════════════════════════════════════════════════════
//
// Cara pake:
//   1. Ganti file ini di ~/degen/meridian/tools/chart-indicators.js
//   2. Isi GMGN_API_KEY di .env atau user-config.json
//   3. Restart Meridian
//
// Output format stays compatible with the previous chart indicator payload.
//
// ════════════════════════════════════════════════════════

import { config } from "../config.js";
import { log } from "../logger.js";
import crypto from "crypto";

const DEFAULT_INTERVALS = ["5_MINUTE"];
const DEFAULT_CANDLES = 298;
const SUPPORTED_INTERVALS = new Set([
  "1_MINUTE",
  "5_MINUTE",
  "15_MINUTE",
  "30_MINUTE",
  "1_HOUR",
  "4_HOUR",
  "1_DAY",
]);

function safeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ─── GMGN API Key ────────────────────────────────────
function getGMGNKey() {
  return (
    process.env.GMGN_API_KEY || ""
  );
}

function getGMGNBase() {
  return "https://openapi.gmgn.ai";
}

// ─── Resolution mapping ──────────────────────────────
function toGMGNResolution(interval) {
  const map = {
    "1_MINUTE": "1m",
    "5_MINUTE": "5m",
    "15_MINUTE": "15m",
    "30_MINUTE": "30m",
    "1_HOUR": "1h",
    "4_HOUR": "4h",
    "1_DAY": "1d",
  };
  return map[interval] || "15m";
}

function normalizeIntervals(intervals) {
  const list = Array.isArray(intervals) ? intervals : DEFAULT_INTERVALS;
  return list
    .map((value) => String(value || "").trim().toUpperCase())
    .filter((value) => SUPPORTED_INTERVALS.has(value));
}

// ─── Indicator Calculators ────────────────────────────

function rma(values, period) {
  let avg = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    avg = (avg * (period - 1) + values[i]) / period;
  }
  return avg;
}

function sma(values, period) {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

function stddev(values, period, mean) {
  const start = values.length - period;
  let sumSq = 0;
  for (let i = start; i < values.length; i++) sumSq += (values[i] - mean) ** 2;
  return Math.sqrt(sumSq / period);
}

function calcSupertrend(candles, period = 10, multiplier = 3) {
  if (candles.length < period + 1) return null;

  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    tr.push(
      Math.max(
        candles[i].h - candles[i].l,
        Math.abs(candles[i].h - candles[i - 1].c),
        Math.abs(candles[i].l - candles[i - 1].c)
      )
    );
  }

  const atr = rma(tr, period);
  const idx = candles.length - 1;
  const pidx = idx - 1;

  const hl2 = (candles[idx].h + candles[idx].l) / 2;
  const phl2 = (candles[pidx].h + candles[pidx].l) / 2;
  const close = candles[idx].c;
  const prevClose = candles[pidx].c;

  const lower = hl2 - multiplier * atr;
  const upper = hl2 + multiplier * atr;
  const prevLower = phl2 - multiplier * atr;

  const prevTrend = prevClose > prevLower ? "bullish" : "bearish";
  const direction = close > prevLower ? "bullish" : "bearish";

  return {
    value: direction === "bullish" ? lower : upper,
    direction,
    supertrendBreakUp: prevTrend === "bearish" && direction === "bullish",
    supertrendBreakDown: prevTrend === "bullish" && direction === "bearish",
  };
}

function calcRSI(candles, length = 2) {
  if (candles.length < length + 1) return null;
  const gains = [];
  const losses = [];
  for (let i = 1; i < candles.length; i++) {
    const change = candles[i].c - candles[i - 1].c;
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }
  const ag = rma(gains, length);
  const al = rma(losses, length);
  if (!al || al === 0) return ag > 0 ? 100 : 50;
  return 100 - (100 / (1 + ag / al));
}

function calcBollinger(candles, period = 20, mult = 2) {
  if (candles.length < period) return null;
  const closes = candles.map((c) => c.c);
  const middle = sma(closes, period);
  if (middle === null) return null;
  const sd = stddev(closes, period, middle);
  if (sd === null) return null;
  return { lower: middle - mult * sd, middle, upper: middle + mult * sd };
}

function calcFibonacci(candles) {
  const lookback = Math.min(50, candles.length);
  const recent = candles.slice(-lookback);
  let high = -Infinity, low = Infinity;
  for (const c of recent) {
    if (c.h > high) high = c.h;
    if (c.l < low) low = c.l;
  }
  const diff = high - low;
  return {
    levels: {
      "0.236": high - diff * 0.236,
      "0.382": high - diff * 0.382,
      "0.500": high - diff * 0.500,
      "0.618": high - diff * 0.618,
      "0.786": high - diff * 0.786,
    },
  };
}

// ─── GMGN K-line Fetch ──────────────────────────────

async function fetchKline(mint, interval, candles) {
  const resolution = toGMGNResolution(interval);
  const limit = Math.max(candles + 5, 105); // buffer
  const ts = Math.floor(Date.now() / 1000);
  const cid = crypto.randomUUID();
  const url = `${getGMGNBase()}/v1/market/token_kline?chain=sol&address=${mint}&resolution=${resolution}&limit=${limit}&timestamp=${ts}&client_id=${cid}`;

  const res = await fetch(url, {
    headers: { "X-APIKEY": getGMGNKey() },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GMGN ${res.status}: ${text.slice(0, 80)}`);
  }

  const json = await res.json();
  if (!json?.data?.list?.length || json.data.list.length < 10) {
    throw new Error(`GMGN insufficient data: ${json?.data?.list?.length ?? 0} candles`);
  }

  // Normalize: { time, open, close, high, low, volume, amount }
  return json.data.list.map((c) => ({
    t: c.time, o: safeNumber(c.open), h: safeNumber(c.high),
    l: safeNumber(c.low), c: safeNumber(c.close), v: safeNumber(c.volume),
  })).filter((c) => c.c !== null);
}

// ─── Signal Summary Builder ──

function buildSignalSummary(payload) {
  const latest = payload?.latest || {};
  const candle = latest?.candle || {};
  const previousCandle = latest?.previousCandle || {};
  const rsi = safeNumber(latest?.rsi?.value);
  const bollinger = latest?.bollinger || {};
  const supertrend = latest?.supertrend || {};
  const fibonacciLevels = latest?.fibonacci?.levels || {};
  return {
    close: safeNumber(candle.close),
    previousClose: safeNumber(previousCandle.close),
    rsi,
    lowerBand: safeNumber(bollinger.lower),
    middleBand: safeNumber(bollinger.middle),
    upperBand: safeNumber(bollinger.upper),
    supertrendValue: safeNumber(supertrend.value),
    supertrendDirection: String(supertrend.direction || "unknown"),
    supertrendBreakUp: !!latest?.states?.supertrendBreakUp,
    supertrendBreakDown: !!latest?.states?.supertrendBreakDown,
    fib50: safeNumber(fibonacciLevels["0.500"]),
    fib618: safeNumber(fibonacciLevels["0.618"]),
    fib786: safeNumber(fibonacciLevels["0.786"]),
  };
}

// ─── Preset Evaluator (IDENTIK) ──────────────────────

function evaluatePreset(side, preset, payload) {
  const summary = buildSignalSummary(payload);
  const oversold = Number(config.indicators.rsiOversold ?? 30);
  const overbought = Number(config.indicators.rsiOverbought ?? 80);
  const close = summary.close;
  const previousClose = summary.previousClose;
  const lowerBand = summary.lowerBand;
  const upperBand = summary.upperBand;
  const rsi = summary.rsi;
  const isBullish = summary.supertrendDirection === "bullish";
  const isBearish = summary.supertrendDirection === "bearish";
  const crossedUp = (level) =>
    level != null && close != null && previousClose != null &&
    previousClose < level && close >= level;
  const crossedDown = (level) =>
    level != null && close != null && previousClose != null &&
    previousClose > level && close <= level;

  switch (preset) {
    case "single_side_reclaim": {
      const reclaimedTrend =
        summary.supertrendBreakUp ||
        (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue);
      const noLongerOversold = rsi == null || rsi > oversold;
      const notUnderLowerBand = close == null || lowerBand == null || close >= lowerBand;
      return side === "entry"
        ? {
            confirmed: reclaimedTrend && noLongerOversold && notUnderLowerBand,
            reason: reclaimedTrend
              ? `Single-side reclaim confirmed: bullish Supertrend, RSI ${rsi ?? "n/a"}, not below lower band`
              : "Single-side reclaim missing: price has not reclaimed bullish Supertrend",
            signal: summary,
          }
        : {
            confirmed: summary.supertrendBreakDown || (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue),
            reason: "Single-side exit: bearish Supertrend break",
            signal: summary,
          };
    }
    case "smart_wallet_retest": {
      const reclaimedTrend =
        summary.supertrendBreakUp ||
        (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue);
      const nearSupport =
        close != null &&
        lowerBand != null &&
        summary.middleBand != null &&
        close >= lowerBand &&
        close <= summary.middleBand;
      const notOverheated = rsi == null || rsi < overbought;
      return side === "entry"
        ? {
            confirmed: reclaimedTrend && nearSupport && notOverheated,
            reason: nearSupport
              ? `Smart-wallet retest confirmed: reclaimed trend, close near lower half of band, RSI ${rsi ?? "n/a"}`
              : "Smart-wallet retest missing: price is not back near support/lower band",
            signal: summary,
          }
        : {
            confirmed: close != null && upperBand != null && close >= upperBand,
            reason: "Smart-wallet exit: price reached upper band/resistance",
            signal: summary,
          };
    }
    case "supertrend_break":
      return side === "entry"
        ? {
            confirmed: summary.supertrendBreakUp || (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue),
            reason: summary.supertrendBreakUp ? "Supertrend flipped bullish" : "Price is above bullish Supertrend",
            signal: summary,
          }
        : {
            confirmed: summary.supertrendBreakDown || (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue),
            reason: summary.supertrendBreakDown ? "Supertrend flipped bearish" : "Price is below bearish Supertrend",
            signal: summary,
          };
    case "rsi_reversal":
      return side === "entry"
        ? { confirmed: rsi != null && rsi <= oversold, reason: `RSI ${rsi ?? "n/a"} <= oversold ${oversold}`, signal: summary }
        : { confirmed: rsi != null && rsi >= overbought, reason: `RSI ${rsi ?? "n/a"} >= overbought ${overbought}`, signal: summary };
    case "bollinger_reversion":
      return side === "entry"
        ? { confirmed: close != null && lowerBand != null && close <= lowerBand, reason: `Close ${close ?? "n/a"} <= lower band ${lowerBand ?? "n/a"}`, signal: summary }
        : { confirmed: close != null && upperBand != null && close >= upperBand, reason: `Close ${close ?? "n/a"} >= upper band ${upperBand ?? "n/a"}`, signal: summary };
    case "rsi_plus_supertrend":
      return side === "entry"
        ? { confirmed: (rsi != null && rsi <= oversold) && (summary.supertrendBreakUp || isBullish), reason: "RSI oversold with bullish Supertrend context", signal: summary }
        : { confirmed: (rsi != null && rsi >= overbought) && (summary.supertrendBreakDown || isBearish), reason: "RSI overbought with bearish Supertrend context", signal: summary };
    case "supertrend_or_rsi":
      return side === "entry"
        ? { confirmed: summary.supertrendBreakUp || (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue) || (rsi != null && rsi <= oversold), reason: "Supertrend bullish confirmation or RSI oversold", signal: summary }
        : { confirmed: summary.supertrendBreakDown || (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue) || (rsi != null && rsi >= overbought), reason: "Supertrend bearish confirmation or RSI overbought", signal: summary };
    case "bb_plus_rsi":
      return side === "entry"
        ? { confirmed: close != null && lowerBand != null && close <= lowerBand && rsi != null && rsi <= oversold, reason: "Close at/below lower band with RSI oversold", signal: summary }
        : { confirmed: close != null && upperBand != null && close >= upperBand && rsi != null && rsi >= overbought, reason: "Close at/above upper band with RSI overbought", signal: summary };
    case "fibo_reclaim":
      return side === "entry"
        ? { confirmed: crossedUp(summary.fib618) || crossedUp(summary.fib50) || crossedUp(summary.fib786), reason: "Price reclaimed a key Fibonacci level", signal: summary }
        : { confirmed: crossedUp(summary.fib618) || crossedUp(summary.fib50), reason: "Price reclaimed a key Fibonacci level upward", signal: summary };
    case "fibo_reject":
      return side === "entry"
        ? { confirmed: crossedDown(summary.fib618) || crossedDown(summary.fib50), reason: "Price rejected from a key Fibonacci level", signal: summary }
        : { confirmed: crossedDown(summary.fib618) || crossedDown(summary.fib50) || crossedDown(summary.fib786), reason: "Price rejected below a key Fibonacci level", signal: summary };
    default:
      return { confirmed: false, reason: `Unknown preset ${preset}`, signal: summary };
  }
}

// ─── MAIN: Build Indicators From GMGN ──────────────

async function fetchIndicatorsFromGMGN(
  mint,
  {
    interval,
    candles = config.indicators.candles ?? DEFAULT_CANDLES,
    rsiLength = config.indicators.rsiLength ?? 2,
    refresh = false,
  } = {},
) {
  const normalizedInterval = String(interval || "15_MINUTE").trim().toUpperCase();
  const klines = await fetchKline(mint, normalizedInterval, candles);

  const supertrend = calcSupertrend(klines);
  const rsiValue = calcRSI(klines, rsiLength);
  const bollinger = calcBollinger(klines);
  const fibonacci = calcFibonacci(klines);
  const last = klines[klines.length - 1];
  const prev = klines[klines.length - 2];

  const payload = {
    candles: klines.map((candle) => ({
      timestamp: candle.t,
      open: candle.o,
      high: candle.h,
      low: candle.l,
      close: candle.c,
      volume: candle.v,
    })),
    latest: {
      candle: {
        timestamp: last.t,
        open: last.o,
        high: last.h,
        low: last.l,
        close: last.c,
        volume: last.v,
      },
      previousCandle: {
        timestamp: prev?.t ?? last.t,
        open: prev?.o ?? last.o,
        high: prev?.h ?? last.h,
        low: prev?.l ?? last.l,
        close: prev?.c ?? last.c,
        volume: prev?.v ?? last.v,
      },
      rsi: { value: rsiValue },
      bollinger: bollinger || { lower: null, middle: null, upper: null },
      supertrend: supertrend
        ? { value: supertrend.value, direction: supertrend.direction }
        : { value: null, direction: "unknown" },
      fibonacci: fibonacci || { levels: {} },
      states: {
        supertrendBreakUp: supertrend?.supertrendBreakUp ?? false,
        supertrendBreakDown: supertrend?.supertrendBreakDown ?? false,
      },
    },
  };

  return payload;
}

// ─── EXPORT ──────────────────────────────────────────
// ⚠️ UNTUK MENGGANTIKAN, GANTI FUNGSI INI DI FILE ASLI:
//    const payload = await fetchIndicatorsFromGMGN(mint, { interval, candles, rsiLength, refresh })

export async function confirmIndicatorPreset({
  mint,
  side,
  preset = side === "entry" ? config.indicators.entryPreset : config.indicators.exitPreset,
  intervals = config.indicators.intervals,
  refresh = false,
  force = false,
  failClosed = false,
} = {}) {
  if (!mint || !preset) {
    return {
      enabled: !!force,
      confirmed: !force && !failClosed,
      reason: "Indicator mint or preset missing",
      intervals: [],
    };
  }

  if (!config.indicators.enabled && !force) {
    return { enabled: false, confirmed: true, reason: "Indicators disabled or not configured", intervals: [] };
  }

  const targets = normalizeIntervals(intervals);
  if (targets.length === 0) {
    return {
      enabled: !!force,
      confirmed: !force && !failClosed,
      reason: "No indicator intervals configured",
      intervals: [],
    };
  }

  const results = [];
  for (const interval of targets) {
    try {
      const payload = await fetchIndicatorsFromGMGN(mint, { interval, refresh });
      const evaluation = evaluatePreset(side, preset, payload);
      results.push({
        interval,
        ok: true,
        confirmed: !!evaluation.confirmed,
        reason: evaluation.reason,
        signal: evaluation.signal,
        latest: payload?.latest || null,
      });
    } catch (error) {
      log("indicators_warn", `Indicator fetch failed for ${mint.slice(0, 8)} ${interval}: ${error.message}`);
      results.push({
        interval,
        ok: false,
        confirmed: null,
        reason: error.message,
        signal: null,
        latest: null,
      });
    }
  }

  const successful = results.filter((entry) => entry.ok);
  if (successful.length === 0) {
    return {
      enabled: true,
      confirmed: !failClosed,
      skipped: !failClosed,
      preset,
      side,
      reason: failClosed
        ? "Indicator API unavailable; hard gate failed closed"
        : "Indicator API unavailable; falling back to existing logic",
      intervals: results,
    };
  }

  const requireAll = !!config.indicators.requireAllIntervals;
  const confirmed = requireAll
    ? successful.every((entry) => entry.confirmed)
    : successful.some((entry) => entry.confirmed);

  return {
    enabled: true,
    confirmed,
    skipped: false,
    preset,
    side,
    requireAllIntervals: requireAll,
    reason: confirmed
      ? `${preset} confirmed on ${successful.filter((entry) => entry.confirmed).map((e) => e.interval).join(", ")}`
      : `${preset} not confirmed on ${successful.map((e) => e.interval).join(", ")}`,
    intervals: results,
  };
}

export async function confirmEntrySupertrendBreak({ mint, refresh = true } = {}) {
  return confirmIndicatorPreset({
    mint,
    side: "entry",
    preset: "supertrend_break",
    intervals: ["5_MINUTE"],
    refresh,
    force: true,
    failClosed: true,
  });
}

// Keep for backward compat + other callers
export { fetchIndicatorsFromGMGN as fetchChartIndicatorsForMint, buildSignalSummary, evaluatePreset };
