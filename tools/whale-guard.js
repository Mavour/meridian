import { config } from "../config.js";
import { log } from "../logger.js";

const METEORA_DLMM_API = "https://dlmm.datapi.meteora.ag";
const snapshotsByPool = new Map();
const lastTriggerByPool = new Map();

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(digits));
}

function isSolToken(token = {}) {
  const symbol = String(token.symbol || "").toUpperCase();
  const address = String(token.address || "");
  return symbol === "SOL" || symbol === "WSOL" || address === config.tokens.SOL;
}

function tokenUsdAmount(pool, side) {
  const token = side === "x" ? pool.token_x : pool.token_y;
  const amount = num(side === "x" ? pool.token_x_amount : pool.token_y_amount);
  const price = num(token?.price);
  if (amount == null || price == null) return null;
  return amount * price;
}

function makeSnapshot(pool) {
  const xUsd = tokenUsdAmount(pool, "x");
  const yUsd = tokenUsdAmount(pool, "y");
  return {
    at: Date.now(),
    pool: pool.address,
    name: pool.name,
    tvl: num(pool.tvl),
    currentPrice: num(pool.current_price),
    xAmount: num(pool.token_x_amount),
    yAmount: num(pool.token_y_amount),
    xUsd,
    yUsd,
    tokenX: {
      symbol: pool.token_x?.symbol || null,
      address: pool.token_x?.address || null,
      price: num(pool.token_x?.price),
      isSol: isSolToken(pool.token_x),
    },
    tokenY: {
      symbol: pool.token_y?.symbol || null,
      address: pool.token_y?.address || null,
      price: num(pool.token_y?.price),
      isSol: isSolToken(pool.token_y),
    },
  };
}

async function fetchMeteoraPool(poolAddress) {
  const res = await fetch(`${METEORA_DLMM_API}/pools/${encodeURIComponent(poolAddress)}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Meteora pool API ${res.status}: ${body.slice(0, 120)}`);
  }
  return res.json();
}

function pruneSnapshots(poolAddress, maxAgeMs) {
  const snapshots = snapshotsByPool.get(poolAddress) || [];
  const cutoff = Date.now() - maxAgeMs;
  const kept = snapshots.filter((snapshot) => snapshot.at >= cutoff);
  snapshotsByPool.set(poolAddress, kept);
  return kept;
}

function getQuoteSide(snapshot, position = {}) {
  if (snapshot.tokenY.isSol) return "y";
  if (snapshot.tokenX.isSol) return "x";
  if (position.base_mint && snapshot.tokenX.address === position.base_mint) return "y";
  if (position.base_mint && snapshot.tokenY.address === position.base_mint) return "x";
  return "y";
}

function buildDelta(previous, current, position) {
  const quoteSide = getQuoteSide(current, position);
  const baseSide = quoteSide === "y" ? "x" : "y";
  const tvlDeltaUsd = current.tvl != null && previous.tvl != null ? current.tvl - previous.tvl : null;
  const tvlDropPct = tvlDeltaUsd != null && previous.tvl > 0 ? (-tvlDeltaUsd / previous.tvl) * 100 : null;
  const quoteUsdPrev = quoteSide === "y" ? previous.yUsd : previous.xUsd;
  const quoteUsdNow = quoteSide === "y" ? current.yUsd : current.xUsd;
  const baseAmountPrev = baseSide === "y" ? previous.yAmount : previous.xAmount;
  const baseAmountNow = baseSide === "y" ? current.yAmount : current.xAmount;
  const quoteDeltaUsd = quoteUsdNow != null && quoteUsdPrev != null ? quoteUsdNow - quoteUsdPrev : null;
  const baseDeltaAmount = baseAmountNow != null && baseAmountPrev != null ? baseAmountNow - baseAmountPrev : null;
  const priceDeltaPct = current.currentPrice != null && previous.currentPrice > 0
    ? ((current.currentPrice - previous.currentPrice) / previous.currentPrice) * 100
    : null;

  return {
    elapsedSec: Math.round((current.at - previous.at) / 1000),
    quoteSide,
    quoteSymbol: quoteSide === "y" ? current.tokenY.symbol : current.tokenX.symbol,
    baseSymbol: baseSide === "y" ? current.tokenY.symbol : current.tokenX.symbol,
    tvlDeltaUsd,
    tvlDropPct,
    quoteDeltaUsd,
    baseDeltaAmount,
    priceDeltaPct,
  };
}

function evaluateDelta(delta, cfg) {
  const minQuoteDrainUsd = Number(cfg.minQuoteDrainUsd ?? cfg.minNetWithdrawUsd ?? 12_000);
  const minTvlDropUsd = Number(cfg.minTvlDropUsd ?? cfg.minNetWithdrawUsd ?? 12_000);
  const minTvlDropPct = Number(cfg.minTvlDropPct ?? 18);
  const requireBaseIncrease = cfg.requireBaseIncreaseForQuoteDrain !== false;

  const quoteDrainUsd = delta.quoteDeltaUsd != null && delta.quoteDeltaUsd < 0
    ? Math.abs(delta.quoteDeltaUsd)
    : 0;
  const tvlDropUsd = delta.tvlDeltaUsd != null && delta.tvlDeltaUsd < 0
    ? Math.abs(delta.tvlDeltaUsd)
    : 0;
  const baseIncreased = delta.baseDeltaAmount == null || delta.baseDeltaAmount > 0;

  if (
    quoteDrainUsd >= minQuoteDrainUsd &&
    (!requireBaseIncrease || baseIncreased)
  ) {
    return {
      action: "CLOSE",
      signal: "quote_drain",
      reason: `Whale activity detected: ${delta.quoteSymbol || "quote"} reserve drained $${round(quoteDrainUsd, 0)} in ${delta.elapsedSec}s`,
    };
  }

  if (
    tvlDropUsd >= minTvlDropUsd &&
    delta.tvlDropPct != null &&
    delta.tvlDropPct >= minTvlDropPct
  ) {
    return {
      action: "CLOSE",
      signal: "tvl_drop",
      reason: `Whale activity detected: Meteora TVL dropped $${round(tvlDropUsd, 0)} (${round(delta.tvlDropPct, 1)}%) in ${delta.elapsedSec}s`,
    };
  }

  return null;
}

export async function checkMeteoraWhaleGuard(position) {
  const cfg = config.whaleGuard || {};
  if (cfg.enabled === false) return null;
  if (String(cfg.source || "meteora").toLowerCase() !== "meteora") return null;
  if (!position?.pool) return null;

  const poolAddress = position.pool;
  const windowMs = Math.max(1, Number(cfg.windowMinutes ?? 5)) * 60_000;
  const cooldownMs = Math.max(0, Number(cfg.cooldownMinutes ?? 10)) * 60_000;
  const lastTriggerAt = lastTriggerByPool.get(poolAddress) || 0;
  if (Date.now() - lastTriggerAt < cooldownMs) return null;

  let current;
  try {
    current = makeSnapshot(await fetchMeteoraPool(poolAddress));
  } catch (error) {
    log("whale_guard", `Meteora snapshot failed for ${poolAddress.slice(0, 8)}: ${error.message}`);
    return null;
  }

  const snapshots = pruneSnapshots(poolAddress, windowMs);
  const previous = snapshots[0] || null;
  snapshots.push(current);
  snapshotsByPool.set(poolAddress, snapshots);

  if (!previous) {
    log("whale_guard", `Baseline snapshot ${current.name || poolAddress.slice(0, 8)} TVL=$${round(current.tvl, 0) ?? "?"}`);
    return null;
  }

  const delta = buildDelta(previous, current, position);
  const decision = evaluateDelta(delta, cfg);
  if (!decision) return null;

  lastTriggerByPool.set(poolAddress, Date.now());
  log(
    "whale_guard",
    `${decision.reason} | pool=${current.name || poolAddress.slice(0, 8)} ` +
    `quote_delta=$${round(delta.quoteDeltaUsd, 0)} tvl_delta=$${round(delta.tvlDeltaUsd, 0)} price=${round(delta.priceDeltaPct, 2)}%`,
  );

  return {
    ...decision,
    source: "meteora_pool_state",
    pool: poolAddress,
    pair: position.pair || current.name || poolAddress,
    metrics: {
      quote_delta_usd: round(delta.quoteDeltaUsd, 2),
      tvl_delta_usd: round(delta.tvlDeltaUsd, 2),
      tvl_drop_pct: round(delta.tvlDropPct, 2),
      price_delta_pct: round(delta.priceDeltaPct, 2),
      elapsed_sec: delta.elapsedSec,
    },
  };
}
