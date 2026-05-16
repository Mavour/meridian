import { log } from "../logger.js";

const MIN_CANDLES = 10;
const DEFAULT_ATH_LOOKBACK_CANDLES = 48;
const DEFAULT_MIN_DUMP_PCT = 30;
const DEFAULT_MIN_RETRACE_PCT = 5;
const DEFAULT_MIN_BASE_FEE = 2.0;
const DEFAULT_MIN_TVL = 10_000;
const DEFAULT_MAX_TVL = 150_000;
const DEFAULT_MIN_ORGANIC = 65;
const DEFAULT_RANGE_PCT = -45;
const MIN_RANGE_PCT = -55;
const MAX_RANGE_PCT = -30;
const GAS_HEAVY_BIN_COUNT = 200;
const TOO_NARROW_BIN_COUNT = 20;
const RSI_PERIOD = 14;
const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;
const BB_PERIOD = 20;
const BB_STD_DEV = 2;
const DEFAULT_RSI_EXIT = 90;
const DEFAULT_TAKE_PROFIT_FEE_PCT = 5;
const DEFAULT_MAX_IL_PCT = 25;
const DEFAULT_MIN_FEES_OVERRIDE_STOP = 8;
const DEFAULT_OOR_WAIT_MINUTES = 60;
const DEFAULT_OOR_TOLERANCE_MINUTES = 15;
const DEFAULT_FEES_FOR_REPOSITION = 3;

const DEFAULT_CONFIG = {
  enabled: false,
  deployAmountSol: 0.3,
  minBaseFee: DEFAULT_MIN_BASE_FEE,
  minTvl: DEFAULT_MIN_TVL,
  maxTvl: DEFAULT_MAX_TVL,
  minOrganic: DEFAULT_MIN_ORGANIC,
  rangePct: DEFAULT_RANGE_PCT,
  minDumpPct: DEFAULT_MIN_DUMP_PCT,
  minRetracePct: DEFAULT_MIN_RETRACE_PCT,
  athLookbackCandles: DEFAULT_ATH_LOOKBACK_CANDLES,
  rsiExitThreshold: DEFAULT_RSI_EXIT,
  takeProfitFeePct: DEFAULT_TAKE_PROFIT_FEE_PCT,
  maxILPct: DEFAULT_MAX_IL_PCT,
  minFeesToOverrideStopLoss: DEFAULT_MIN_FEES_OVERRIDE_STOP,
  outOfRangeWaitMinutes: DEFAULT_OOR_WAIT_MINUTES,
  outOfRangeTolerance: DEFAULT_OOR_TOLERANCE_MINUTES,
  feesForReposition: DEFAULT_FEES_FOR_REPOSITION,
  enableTAExit: true,
  logLevel: "verbose",
};

const logger = {
  info: (message, details) => log("bottom_spot_lp", formatLog(message, details)),
  warn: (message, details) => log("bottom_spot_lp_warn", formatLog(message, details)),
  debug: (message, details) => log("bottom_spot_lp_debug", formatLog(message, details)),
  error: (message, error) => {
    const detail = error?.stack || error?.message || error;
    log("bottom_spot_lp_error", formatLog(message, detail));
  },
};

function formatLog(message, details) {
  if (details == null) return String(message);
  if (typeof details === "string") return `${message}: ${details}`;
  try {
    return `${message}: ${JSON.stringify(details)}`;
  } catch {
    return String(message);
  }
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getCandleClose(candle) {
  return numberOrNull(candle?.close ?? candle?.c ?? candle?.price ?? candle?.value);
}

function getCandleHigh(candle) {
  return numberOrNull(candle?.high ?? candle?.h) ?? getCandleClose(candle);
}

function getCandleLow(candle) {
  return numberOrNull(candle?.low ?? candle?.l) ?? getCandleClose(candle);
}

function normalizeCandle(candle, index) {
  if (!candle || typeof candle !== "object") return null;
  const close = getCandleClose(candle);
  if (close == null || close <= 0) return null;
  const high = getCandleHigh(candle);
  const low = getCandleLow(candle);
  return {
    ...candle,
    index,
    close,
    high: high != null && high > 0 ? high : close,
    low: low != null && low > 0 ? low : close,
  };
}

function normalizeCandles(candles) {
  if (!Array.isArray(candles)) return [];
  return candles.map(normalizeCandle).filter(Boolean);
}

function poolName(pool) {
  return pool?.name || pool?.pool_name || pool?.pool || pool?.pool_address || "unknown";
}

function getPoolAddress(pool) {
  return pool?.pool || pool?.pool_address || pool?.address || null;
}

function getPoolBaseMint(pool) {
  return pool?.base?.mint ||
    pool?.token_x?.address ||
    pool?.base_mint ||
    pool?.base_token_address ||
    null;
}

function getPoolBaseFee(pool) {
  return numberOrNull(
    pool?.baseFee ??
    pool?.base_fee ??
    pool?.base_fee_pct ??
    pool?.fee_pct ??
    pool?.pool_config?.base_fee_pct,
  );
}

function getPoolTvl(pool) {
  return numberOrNull(pool?.tvl ?? pool?.active_tvl ?? pool?.liquidity);
}

function getPoolOrganic(pool) {
  return numberOrNull(
    pool?.organicScore ??
    pool?.organic_score ??
    pool?.base?.organic ??
    pool?.token_x?.organic_score,
  );
}

function getPoolBinStep(pool) {
  return numberOrNull(
    pool?.binStep ??
    pool?.bin_step ??
    pool?.dlmm_params?.bin_step ??
    pool?.pool_config?.bin_step,
  );
}

function getFeesPaidSol(pool) {
  return numberOrNull(
    pool?.fees_paid_sol ??
    pool?.gmgn_total_fee_sol ??
    pool?.global_fees_sol ??
    pool?.token_info?.global_fees_sol,
  );
}

function clampRangePct(value) {
  const raw = numberOrNull(value) ?? DEFAULT_RANGE_PCT;
  const negative = -Math.abs(raw);
  return Math.max(MIN_RANGE_PCT, Math.min(MAX_RANGE_PCT, negative));
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values, mean) {
  if (!values.length) return null;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function emaSeries(values, period) {
  const result = Array(values.length).fill(null);
  if (!Array.isArray(values) || values.length < period) return result;
  const multiplier = 2 / (period + 1);
  let ema = average(values.slice(0, period));
  result[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
    result[i] = ema;
  }
  return result;
}

export function extractCandlesFromIndicatorPayload(payload) {
  const direct =
    payload?.candles ||
    payload?.data?.candles ||
    payload?.series?.candles ||
    payload?.ohlcv ||
    payload?.data?.ohlcv;
  if (Array.isArray(direct)) return direct;

  const latest = payload?.latest;
  const compact = [latest?.previousCandle, latest?.candle].filter(Boolean);
  return compact.length > 0 ? compact : [];
}

export function detectDumpAndRetrace(priceHistory, strategyConfig = {}) {
  try {
    const cfg = { ...DEFAULT_CONFIG, ...strategyConfig };
    const candles = normalizeCandles(priceHistory);
    if (candles.length < MIN_CANDLES) {
      return { triggered: false, reason: "insufficient_data" };
    }

    const lookback = Math.max(MIN_CANDLES, Number(cfg.athLookbackCandles) || DEFAULT_ATH_LOOKBACK_CANDLES);
    const window = candles.slice(-lookback);
    let athCandle = null;
    for (const candle of window) {
      if (!athCandle || candle.high > athCandle.high) athCandle = candle;
    }

    const athIndex = window.findIndex((candle) => candle === athCandle);
    const afterAth = athIndex >= 0 ? window.slice(athIndex) : window;
    let lowCandle = null;
    for (const candle of afterAth) {
      if (!lowCandle || candle.low < lowCandle.low) lowCandle = candle;
    }

    const current = window[window.length - 1];
    const athPrice = athCandle?.high;
    const dumpLow = lowCandle?.low;
    const currentPrice = current?.close;
    if (!athPrice || !dumpLow || !currentPrice || dumpLow <= 0 || athPrice <= 0) {
      return { triggered: false, reason: "invalid_price_data" };
    }

    const dumpPct = ((athPrice - currentPrice) / athPrice) * 100;
    const retracePct = ((currentPrice - dumpLow) / dumpLow) * 100;
    const minDumpPct = Number(cfg.minDumpPct ?? DEFAULT_MIN_DUMP_PCT);
    const minRetracePct = Number(cfg.minRetracePct ?? DEFAULT_MIN_RETRACE_PCT);
    const triggered = dumpPct >= minDumpPct && retracePct >= minRetracePct;
    const result = {
      triggered,
      athPrice,
      dumpLow,
      currentPrice,
      dumpPct: Number(dumpPct.toFixed(4)),
      retracePct: Number(retracePct.toFixed(4)),
    };
    if (!triggered) {
      result.reason = dumpPct < minDumpPct ? "dump_threshold_not_met" : "retrace_threshold_not_met";
    }
    return result;
  } catch (error) {
    logger.error("[BottomSpotLP] detectDumpAndRetrace failed", error);
    return { triggered: false, reason: "error", error: error.message };
  }
}

export function selectBestPool(pools, strategyConfig = {}) {
  try {
    const cfg = { ...DEFAULT_CONFIG, ...strategyConfig };
    if (!Array.isArray(pools) || pools.length === 0) return null;

    const accepted = [];
    for (const pool of pools) {
      const reasons = [];
      const baseFee = getPoolBaseFee(pool);
      const tvl = getPoolTvl(pool);
      const organic = getPoolOrganic(pool);
      if (baseFee == null || baseFee < cfg.minBaseFee) {
        reasons.push(`baseFee ${baseFee ?? "unknown"} < ${cfg.minBaseFee}`);
      }
      if (tvl == null || tvl < cfg.minTvl) reasons.push(`tvl ${tvl ?? "unknown"} < ${cfg.minTvl}`);
      if (cfg.maxTvl != null && tvl != null && tvl > cfg.maxTvl) {
        reasons.push(`tvl ${tvl} > ${cfg.maxTvl}`);
      }
      if (organic == null || organic < cfg.minOrganic) {
        reasons.push(`organic ${organic ?? "unknown"} < ${cfg.minOrganic}`);
      }

      if (reasons.length > 0) {
        logger.debug("[BottomSpotLP] pool rejected", { pool: poolName(pool), reasons });
        continue;
      }
      accepted.push({ pool, tvl: tvl ?? 0 });
    }

    accepted.sort((a, b) => b.tvl - a.tvl);
    return accepted[0]?.pool || null;
  } catch (error) {
    logger.error("[BottomSpotLP] selectBestPool failed", error);
    return null;
  }
}

export function calculateBinRange(currentPrice, binStep, strategyConfig = {}) {
  try {
    const price = numberOrNull(currentPrice);
    const step = numberOrNull(binStep);
    if (price == null || price <= 0) {
      return { valid: false, reason: "invalid_current_price" };
    }
    if (step == null || step <= 0) {
      return { valid: false, reason: "invalid_bin_step" };
    }

    const cfg = { ...DEFAULT_CONFIG, ...strategyConfig };
    const rangePct = clampRangePct(cfg.rangePct);
    const lowerPrice = price * (1 - Math.abs(rangePct) / 100);
    const upperPrice = price;
    if (lowerPrice <= 0 || upperPrice <= lowerPrice) {
      return { valid: false, reason: "invalid_price_range" };
    }

    const binRatio = 1 + step / 10_000;
    const totalBins = Math.ceil(Math.log(upperPrice / lowerPrice) / Math.log(binRatio));
    const activeBinId = Number.isInteger(cfg.activeBinId) ? cfg.activeBinId : 0;
    const warnings = [];
    if (totalBins > GAS_HEAVY_BIN_COUNT) warnings.push("gas_heavy_range");
    if (totalBins < TOO_NARROW_BIN_COUNT) warnings.push("range_too_narrow");

    const result = {
      valid: true,
      lowerBinId: activeBinId - totalBins,
      upperBinId: activeBinId,
      binsBelow: totalBins,
      binsAbove: 0,
      lowerPrice,
      upperPrice,
      totalBins,
      expectedILAtLower: Math.abs(rangePct),
      shape: "spot",
      singleSidedAsset: "SOL",
      warnings,
    };
    logger.debug("[BottomSpotLP] bin range calculated", result);
    return result;
  } catch (error) {
    logger.error("[BottomSpotLP] calculateBinRange failed", error);
    return { valid: false, reason: "error", error: error.message };
  }
}

export function calculateRsi(candles, period = RSI_PERIOD) {
  const closes = normalizeCandles(candles).map((candle) => candle.close);
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gains += delta;
    else losses += Math.abs(delta);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? Math.abs(delta) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Number((100 - 100 / (1 + rs)).toFixed(4));
}

export function calculateMacd(candles) {
  const closes = normalizeCandles(candles).map((candle) => candle.close);
  if (closes.length < MACD_SLOW + MACD_SIGNAL) {
    return {
      macd: null,
      signal: null,
      histogram: null,
      bullishCross: false,
      bearishCross: false,
    };
  }

  const fast = emaSeries(closes, MACD_FAST);
  const slow = emaSeries(closes, MACD_SLOW);
  const macdPoints = [];
  for (let i = 0; i < closes.length; i++) {
    if (fast[i] == null || slow[i] == null) continue;
    macdPoints.push({ index: i, value: fast[i] - slow[i] });
  }

  const signalValues = emaSeries(macdPoints.map((point) => point.value), MACD_SIGNAL);
  const latestIdx = macdPoints.length - 1;
  const prevIdx = macdPoints.length - 2;
  const macd = macdPoints[latestIdx]?.value ?? null;
  const signal = signalValues[latestIdx] ?? null;
  const prevMacd = macdPoints[prevIdx]?.value ?? null;
  const prevSignal = signalValues[prevIdx] ?? null;
  const histogram = macd != null && signal != null ? macd - signal : null;
  const bullishCross = prevMacd != null && prevSignal != null && macd != null && signal != null &&
    prevMacd <= prevSignal && macd > signal;
  const bearishCross = prevMacd != null && prevSignal != null && macd != null && signal != null &&
    prevMacd >= prevSignal && macd < signal;

  return {
    macd: macd == null ? null : Number(macd.toFixed(8)),
    signal: signal == null ? null : Number(signal.toFixed(8)),
    histogram: histogram == null ? null : Number(histogram.toFixed(8)),
    bullishCross,
    bearishCross,
  };
}

export function calculateBollingerBands(candles, period = BB_PERIOD, multiplier = BB_STD_DEV) {
  const normalized = normalizeCandles(candles);
  const closes = normalized.map((candle) => candle.close);
  if (closes.length < period) {
    return {
      upper: null,
      mid: null,
      lower: null,
      breakingUpper: false,
      breakingLower: false,
    };
  }
  const window = closes.slice(-period);
  const mid = average(window);
  const deviation = stdDev(window, mid);
  const upper = mid + deviation * multiplier;
  const lower = mid - deviation * multiplier;
  const close = closes[closes.length - 1];
  return {
    upper: Number(upper.toFixed(8)),
    mid: Number(mid.toFixed(8)),
    lower: Number(lower.toFixed(8)),
    breakingUpper: close > upper,
    breakingLower: close < lower,
  };
}

export function evaluateExitSignal(candles, position = {}, strategyConfig = {}) {
  try {
    const cfg = { ...DEFAULT_CONFIG, ...strategyConfig };
    const normalized = normalizeCandles(candles);
    if (normalized.length < MIN_CANDLES) {
      return {
        shouldExit: false,
        reason: null,
        urgency: "low",
        details: { reason: "insufficient_data" },
      };
    }

    const currentPrice = normalized[normalized.length - 1].close;
    const feesPct = numberOrNull(
      position.accumulatedFeesPct ??
      position.feesPct ??
      position.fees_pct ??
      position.fee_pct,
    ) ?? 0;
    const ilPct = numberOrNull(
      position.ilPct ??
      position.il_pct ??
      position.impermanentLossPct ??
      position.impermanent_loss_pct,
    ) ?? 0;
    const upperPrice = numberOrNull(position.upperPrice ?? position.upper_price);
    const rsi = cfg.enableTAExit === false ? null : calculateRsi(normalized);
    const macd = cfg.enableTAExit === false ? calculateMacd([]) : calculateMacd(normalized);
    const bb = cfg.enableTAExit === false ? calculateBollingerBands([]) : calculateBollingerBands(normalized);
    const details = { rsi, macd, bollinger: bb, currentPrice, feesPct, ilPct };
    logger.debug("[BottomSpotLP] TA values", details);

    let reason = null;
    if (rsi != null && rsi > cfg.rsiExitThreshold) reason = "rsi_overbought";
    else if (macd.bearishCross) reason = "macd_bearish_cross";
    else if (bb.breakingUpper) reason = "bb_upper_break";
    else if (feesPct >= cfg.takeProfitFeePct) reason = "fees_target_hit";
    else if (upperPrice != null && currentPrice > upperPrice) reason = "price_above_range";
    else if (ilPct > cfg.maxILPct && feesPct < cfg.minFeesToOverrideStopLoss) reason = "il_stop_loss";

    const highUrgency = new Set(["rsi_overbought", "price_above_range", "il_stop_loss"]);
    const mediumUrgency = new Set(["macd_bearish_cross", "bb_upper_break"]);
    const urgency = !reason
      ? "low"
      : highUrgency.has(reason)
        ? "high"
        : mediumUrgency.has(reason)
          ? "medium"
          : "low";

    if (reason) logger.info("[BottomSpotLP] exit decision", { reason, urgency, details });
    return { shouldExit: !!reason, reason, urgency, details };
  } catch (error) {
    logger.error("[BottomSpotLP] evaluateExitSignal failed", error);
    return { shouldExit: false, reason: null, urgency: "low", details: { error: error.message } };
  }
}

export function handleOutOfRangeLower(position = {}, accumulatedFees = {}, strategyConfig = {}) {
  try {
    const cfg = { ...DEFAULT_CONFIG, ...strategyConfig };
    const activeBin = numberOrNull(position.active_bin ?? position.activeBin);
    const lowerBin = numberOrNull(position.lower_bin ?? position.lowerBin ?? position.bin_range?.min);
    const currentPrice = numberOrNull(position.currentPrice ?? position.current_price);
    const lowerPrice = numberOrNull(position.lowerPrice ?? position.lower_price);
    const explicitLower = String(position.outOfRangeSide || position.out_of_range_side || "").toLowerCase() === "lower";
    const outLower = explicitLower ||
      (activeBin != null && lowerBin != null && activeBin < lowerBin) ||
      (currentPrice != null && lowerPrice != null && currentPrice < lowerPrice);
    const minutesOut = numberOrNull(position.minutes_out_of_range ?? position.minutesOutOfRange) ??
      minutesSince(position.out_of_range_since ?? position.outOfRangeSince) ??
      0;
    const accumulatedFeesPct = numberOrNull(
      accumulatedFees.accumulatedFeesPct ??
      accumulatedFees.feesPct ??
      accumulatedFees.fees_pct ??
      accumulatedFees,
    ) ?? 0;

    if (!outLower || minutesOut <= cfg.outOfRangeTolerance) {
      return { action: "hold", reason: "in_range" };
    }
    logger.warn("[BottomSpotLP] lower out-of-range", { minutesOut, accumulatedFeesPct });

    if (accumulatedFeesPct >= cfg.feesForReposition) {
      return { action: "reposition", useAccumulatedFees: true };
    }
    if (minutesOut < cfg.outOfRangeWaitMinutes) {
      return { action: "hold", reason: "waiting_for_rebound" };
    }
    return { action: "close", reason: "oor_timeout_exceeded" };
  } catch (error) {
    logger.error("[BottomSpotLP] handleOutOfRangeLower failed", error);
    return { action: "hold", reason: "error", error: error.message };
  }
}

function minutesSince(value) {
  if (!value) return null;
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.floor((Date.now() - ts) / 60_000));
}

export class BottomSpotLPStrategy {
  constructor(strategyConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...(strategyConfig || {}) };
  }

  /**
   * Check whether the Bottom Spot LP strategy should deploy.
   *
   * @param {Array<Object>} priceHistory - OHLCV candles ordered oldest to newest.
   * @param {Array<Object>} pools - Candidate pools for the token.
   * @returns {Promise<Object>} Deploy decision with pool and bin range when valid.
   */
  async shouldDeploy(priceHistory, pools) {
    try {
      if (!this.config.enabled) return { deploy: false, reason: "disabled" };
      if (!Array.isArray(priceHistory)) return { deploy: false, reason: "invalid_price_history" };
      if (!Array.isArray(pools) || pools.length === 0) return { deploy: false, reason: "no_pools" };

      const entry = detectDumpAndRetrace(priceHistory, this.config);
      if (!entry.triggered) return { deploy: false, reason: entry.reason, entry };

      const pool = selectBestPool(pools, this.config);
      if (!pool) return { deploy: false, reason: "no_pool_passed_filters", entry };

      const binStep = getPoolBinStep(pool);
      const activeBinId = numberOrNull(pool.active_bin ?? pool.activeBin);
      const binRange = calculateBinRange(entry.currentPrice, binStep, {
        ...this.config,
        activeBinId: Number.isInteger(activeBinId) ? activeBinId : undefined,
      });
      if (!binRange.valid) return { deploy: false, reason: binRange.reason, pool, entry };

      const decision = {
        deploy: true,
        pool,
        binRange,
        reason: "dump_and_retrace_confirmed",
        entry,
      };
      logger.info("[BottomSpotLP] deploy signal triggered", {
        pool: poolName(pool),
        dumpPct: entry.dumpPct,
        retracePct: entry.retracePct,
        binsBelow: binRange.binsBelow,
      });
      return decision;
    } catch (error) {
      logger.error("[BottomSpotLP] shouldDeploy failed", error);
      return { deploy: false, reason: "error", error: error.message };
    }
  }

  /**
   * Build deploy parameters for the existing DLMM deploy tool.
   *
   * @param {Object} pool - Selected pool.
   * @param {Object} binRange - Range output from calculateBinRange.
   * @param {number} amountSol - SOL amount to deploy.
   * @returns {Object} Deploy params for executeTool("deploy_position").
   */
  buildDeployParams(pool, binRange, amountSol) {
    try {
      const poolAddress = getPoolAddress(pool);
      const amount = numberOrNull(amountSol ?? this.config.deployAmountSol);
      if (!poolAddress || amount == null || amount <= 0 || !binRange?.valid) {
        return { valid: false, reason: "invalid_deploy_params" };
      }
      return {
        valid: true,
        pool_address: poolAddress,
        pool_name: poolName(pool),
        base_mint: getPoolBaseMint(pool),
        amount_y: amount,
        amount_x: 0,
        strategy: "spot",
        downside_pct: Math.abs(clampRangePct(this.config.rangePct)),
        bins_above: 0,
        bin_step: getPoolBinStep(pool),
        base_fee: getPoolBaseFee(pool),
        volatility: numberOrNull(pool?.volatility),
        fee_tvl_ratio: numberOrNull(pool?.fee_active_tvl_ratio),
        organic_score: getPoolOrganic(pool),
        price_5m_change: numberOrNull(pool?.price_5m_change),
        price_1h_change: numberOrNull(pool?.price_1h_change),
        fee_change_pct: numberOrNull(pool?.fee_change_pct),
        volume_change_pct: numberOrNull(pool?.volume_change_pct),
        price_trend: pool?.price_trend ?? null,
        fees_paid_sol: getFeesPaidSol(pool),
        bottom_spot_lp: {
          lowerPrice: binRange.lowerPrice,
          upperPrice: binRange.upperPrice,
          binsBelow: binRange.binsBelow,
          warnings: binRange.warnings,
        },
      };
    } catch (error) {
      logger.error("[BottomSpotLP] buildDeployParams failed", error);
      return { valid: false, reason: "error", error: error.message };
    }
  }

  /**
   * Evaluate an existing Bottom Spot LP position for close/reposition/stay.
   *
   * @param {Object} position - Position state/PnL object.
   * @param {Array<Object>} candles - Recent OHLCV candles.
   * @param {Object|number} accumulatedFees - Accumulated fee percentage data.
   * @returns {Promise<Object>} Position action recommendation.
   */
  async evaluatePosition(position, candles, accumulatedFees = {}) {
    try {
      const feesPct = numberOrNull(
        accumulatedFees.accumulatedFeesPct ??
        accumulatedFees.feesPct ??
        accumulatedFees.fees_pct ??
        accumulatedFees,
      ) ?? 0;
      const enrichedPosition = { ...(position || {}), accumulatedFeesPct: feesPct };
      const exit = evaluateExitSignal(candles, enrichedPosition, this.config);
      if (exit.shouldExit) {
        return { action: "close", reason: exit.reason, urgency: exit.urgency, details: exit.details };
      }
      const oor = handleOutOfRangeLower(position, accumulatedFees, this.config);
      if (oor.action === "close" || oor.action === "reposition") {
        return { action: oor.action, reason: oor.reason, urgency: "medium", details: oor };
      }
      return { action: "stay", reason: oor.reason || "no_exit_signal", urgency: "low", details: exit.details };
    } catch (error) {
      logger.error("[BottomSpotLP] evaluatePosition failed", error);
      return { action: "stay", reason: "error", urgency: "low", details: { error: error.message } };
    }
  }

  /**
   * Format a compact status report for Telegram/logs.
   *
   * @param {Object} position - Position object.
   * @param {Array<Object>} candles - Recent OHLCV candles.
   * @param {Object|number} fees - Accumulated fee data.
   * @returns {string} Human-readable status report.
   */
  formatStatusReport(position, candles, fees = {}) {
    try {
      const normalized = normalizeCandles(candles);
      const latest = normalized[normalized.length - 1];
      const feesPct = numberOrNull(fees.accumulatedFeesPct ?? fees.feesPct ?? fees.fees_pct ?? fees) ?? 0;
      const exit = evaluateExitSignal(candles, { ...(position || {}), accumulatedFeesPct: feesPct }, this.config);
      return [
        "Bottom Spot LP",
        `Pool: ${position?.pool_name || position?.pool || "unknown"}`,
        `Price: ${latest?.close ?? "unknown"}`,
        `Fees: ${feesPct.toFixed(2)}%`,
        `Exit: ${exit.shouldExit ? `${exit.reason} (${exit.urgency})` : "none"}`,
      ].join("\n");
    } catch (error) {
      logger.error("[BottomSpotLP] formatStatusReport failed", error);
      return "Bottom Spot LP\nStatus unavailable";
    }
  }
}

export { DEFAULT_CONFIG as BOTTOM_SPOT_LP_DEFAULTS };
