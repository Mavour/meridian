import assert from "assert";
import {
  calculateBinRange,
  detectDumpAndRetrace,
  evaluateExitSignal,
  selectBestPool,
} from "../strategies/bottomSpotLP.js";

function candle(close, overrides = {}) {
  return {
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
    ...overrides,
  };
}

function generateDumpRetraceCandles() {
  const candles = [];
  for (let i = 0; i < 20; i++) candles.push(candle(1 + i * 0.01));
  candles.push(candle(2.0, { high: 2.0 }));
  for (let i = 0; i < 10; i++) candles.push(candle(2.0 - (i + 1) * 0.1));
  candles.push(candle(1.0, { low: 1.0 }));
  candles.push(candle(1.15));
  candles.push(candle(1.2));
  return candles;
}

function generateSineCandles(length = 80, base = 1, amplitude = 0.05) {
  return Array.from({ length }, (_, i) => {
    const close = base + Math.sin(i / 4) * amplitude;
    return candle(close, {
      high: close * 1.01,
      low: close * 0.99,
      volume: 1000 + i,
    });
  });
}

function generateRisingCandles(length = 80) {
  return Array.from({ length }, (_, i) => candle(1 + i * 0.03));
}

function generateMacdBearishCrossCandles() {
  const candles = [];
  for (let i = 0; i < 80; i++) candles.push(candle(1 + i * 0.01));
  candles.push(candle(1.78));
  return candles;
}

function testDetectDumpAndRetrace() {
  const valid = detectDumpAndRetrace(generateDumpRetraceCandles(), {
    minDumpPct: 30,
    minRetracePct: 5,
    athLookbackCandles: 48,
  });
  assert.equal(valid.triggered, true);
  assert.equal(valid.athPrice, 2);
  assert.equal(valid.dumpLow, 1);
  assert.ok(valid.dumpPct >= 30);
  assert.ok(valid.retracePct >= 5);

  const noDump = detectDumpAndRetrace(generateSineCandles(40, 1, 0.01), {
    minDumpPct: 30,
    minRetracePct: 5,
  });
  assert.equal(noDump.triggered, false);
  assert.equal(noDump.reason, "dump_threshold_not_met");

  const noRetrace = detectDumpAndRetrace([
    ...Array.from({ length: 20 }, () => candle(2)),
    ...Array.from({ length: 10 }, () => candle(1)),
  ], {
    minDumpPct: 30,
    minRetracePct: 5,
  });
  assert.equal(noRetrace.triggered, false);
  assert.equal(noRetrace.reason, "retrace_threshold_not_met");

  const insufficient = detectDumpAndRetrace([candle(1), candle(2)]);
  assert.equal(insufficient.triggered, false);
  assert.equal(insufficient.reason, "insufficient_data");

  const withGaps = detectDumpAndRetrace([
    null,
    ...generateDumpRetraceCandles(),
    { close: null },
  ], {
    minDumpPct: 30,
    minRetracePct: 5,
  });
  assert.equal(withGaps.triggered, true);
}

function testCalculateBinRange() {
  const valid = calculateBinRange(1, 100, { rangePct: -45 });
  assert.equal(valid.valid, true);
  assert.ok(valid.lowerPrice > 0);
  assert.ok(valid.upperPrice > valid.lowerPrice);
  assert.ok(valid.totalBins >= 20);
  assert.equal(valid.binsAbove, 0);

  const wide = calculateBinRange(1, 5, { rangePct: -55 });
  assert.equal(wide.valid, true);
  assert.ok(wide.totalBins > 200);
  assert.ok(wide.warnings.includes("gas_heavy_range"));

  const invalid = calculateBinRange(0, 100, { rangePct: -45 });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.reason, "invalid_current_price");
}

function testSelectBestPoolFlowFilters() {
  const basePool = {
    name: "GOOD-SOL",
    pool: "good",
    fee_pct: 2,
    tvl: 50_000,
    volume_window: 25_000,
    fee_active_tvl_ratio: 0.8,
    organic_score: 80,
  };

  const selected = selectBestPool([basePool], {
    minBaseFee: 2,
    minTvl: 10_000,
    maxTvl: 150_000,
    minVolume: 10_000,
    minFeeActiveTvlRatio: 0.5,
    minOrganic: 65,
  });
  assert.equal(selected?.pool, "good");

  assert.equal(selectBestPool([{ ...basePool, pool: "quiet", volume_window: 5_000 }], {
    minVolume: 10_000,
    minFeeActiveTvlRatio: 0.5,
  }), null);

  assert.equal(selectBestPool([{ ...basePool, pool: "weak-fee", fee_active_tvl_ratio: 0.2 }], {
    minVolume: 10_000,
    minFeeActiveTvlRatio: 0.5,
  }), null);
}

function testEvaluateExitSignal() {
  const rsiExit = evaluateExitSignal(generateRisingCandles(), {
    upperPrice: 999,
    accumulatedFeesPct: 0,
  }, {
    rsiExitThreshold: 90,
  });
  assert.equal(rsiExit.shouldExit, true);
  assert.equal(rsiExit.reason, "rsi_overbought");
  assert.equal(rsiExit.urgency, "high");

  const macdExit = evaluateExitSignal(generateMacdBearishCrossCandles(), {
    upperPrice: 999,
    accumulatedFeesPct: 0,
  }, {
    rsiExitThreshold: 101,
  });
  assert.equal(macdExit.shouldExit, true);
  assert.equal(macdExit.reason, "macd_bearish_cross");

  const bbCandles = [
    ...Array.from({ length: 25 }, () => candle(1)),
    candle(1.5),
  ];
  const bbExit = evaluateExitSignal(bbCandles, {
    upperPrice: 999,
    accumulatedFeesPct: 0,
  }, {
    rsiExitThreshold: 101,
  });
  assert.equal(bbExit.shouldExit, true);
  assert.equal(bbExit.reason, "bb_upper_break");

  const feeExit = evaluateExitSignal(generateSineCandles(), {
    upperPrice: 999,
    accumulatedFeesPct: 5,
  }, {
    enableTAExit: false,
    takeProfitFeePct: 5,
  });
  assert.equal(feeExit.shouldExit, true);
  assert.equal(feeExit.reason, "fees_target_hit");

  const rangeExit = evaluateExitSignal(generateSineCandles(80, 2, 0.01), {
    upperPrice: 1,
    accumulatedFeesPct: 0,
  }, {
    enableTAExit: false,
  });
  assert.equal(rangeExit.shouldExit, true);
  assert.equal(rangeExit.reason, "price_above_range");

  const ilExit = evaluateExitSignal(generateSineCandles(), {
    upperPrice: 999,
    accumulatedFeesPct: 1,
    ilPct: 30,
  }, {
    enableTAExit: false,
    maxILPct: 25,
    minFeesToOverrideStopLoss: 8,
  });
  assert.equal(ilExit.shouldExit, true);
  assert.equal(ilExit.reason, "il_stop_loss");
}

testDetectDumpAndRetrace();
testCalculateBinRange();
testSelectBestPoolFlowFilters();
testEvaluateExitSignal();

console.log("bottomSpotLP tests passed");
