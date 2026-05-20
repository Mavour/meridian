function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = numberOrNull(value);
    if (n != null) return n;
  }
  return null;
}

export function decideCloseAction(position, mgmtConfig = {}) {
  const pnlPct = firstNumber(position.pnlPct, position.pnl_pct);
  const minPnlPct = firstNumber(position.minPnlPct, position.min_pnl_pct, position.lowestPnlPct, position.lowest_pnl_pct);
  const peakPnlPct = firstNumber(position.peakPnlPct, position.peak_pnl_pct, position.peak_pnl);
  const unclaimedFees = firstNumber(position.unclaimedFees, position.unclaimed_fees_usd, position.unclaimed_fees);
  const ageMinutes = firstNumber(position.ageMinutes, position.age_minutes);
  const inRange = position.inRange ?? position.in_range;
  const oorMinutes = firstNumber(position.oorMinutes, position.minutes_out_of_range);
  const feePerTvl24h = firstNumber(position.feePerTvl24h, position.fee_per_tvl_24h);
  const activeBin = firstNumber(position.activeBin, position.active_bin);
  const upperBin = firstNumber(position.upperBin, position.upper_bin);

  const hardStopPct = numberOrNull(mgmtConfig.hardStopPct) ?? -15;
  const stopLossPct = numberOrNull(mgmtConfig.stopLossPct) ?? -12;
  const trailingTriggerPct = numberOrNull(mgmtConfig.trailingTriggerPct) ?? 5;
  const trailingDropPct = numberOrNull(mgmtConfig.trailingDropPct) ?? 2.5;
  const slowBleedMinAge = numberOrNull(mgmtConfig.slowBleedMinAge) ?? 30;
  const slowBleedMinPnl = numberOrNull(mgmtConfig.slowBleedMinPnl) ?? -2;
  const slowBleedMaxPnl = numberOrNull(mgmtConfig.slowBleedMaxPnl) ?? 1.5;
  const minFeePerTvl24h = numberOrNull(mgmtConfig.minFeePerTvl24h) ?? 5;
  const outOfRangeWaitMinutes = numberOrNull(mgmtConfig.outOfRangeWaitMinutes) ?? 25;
  const outOfRangeBinsToClose = numberOrNull(mgmtConfig.outOfRangeBinsToClose) ?? 10;
  const takeProfitPct = numberOrNull(mgmtConfig.takeProfitPct) ?? 8;
  const minClaimAmount = numberOrNull(mgmtConfig.minClaimAmount) ?? 5;
  const minAgeBeforeYieldCheck = numberOrNull(mgmtConfig.minAgeBeforeYieldCheck) ?? 60;
  const recoveryExitEnabled = mgmtConfig.recoveryExitEnabled !== false;
  const recoveryExitDrawdownPct = numberOrNull(mgmtConfig.recoveryExitDrawdownPct) ?? -4;

  // Priority 1: hard stop always wins, even during OOR recovery.
  if (pnlPct != null && pnlPct <= hardStopPct) {
    return { action: "close", priority: 1, reason: "hard_stop", pnl: pnlPct };
  }

  // Priority 2: stop loss always wins, even during OOR recovery.
  if (pnlPct != null && pnlPct <= stopLossPct) {
    return { action: "close", priority: 2, reason: "stop_loss", pnl: pnlPct };
  }

  // Priority 3: if an OOR position has recovered to breakeven/profit, exit.
  if (inRange === false && oorMinutes != null && oorMinutes >= outOfRangeWaitMinutes) {
    if (pnlPct != null && pnlPct >= 0) {
      return { action: "close", priority: 3, reason: "oor_recovery_profit", pnl: pnlPct, oorMinutes };
    }

    const recoveryWindowMinutes = 60;
    const recoveryMinLossPct = -3;
    if (
      pnlPct != null &&
      pnlPct <= recoveryMinLossPct &&
      oorMinutes < recoveryWindowMinutes
    ) {
      return { action: "stay", priority: 9, reason: "oor_hold_recovery", pnl: pnlPct, oorMinutes };
    }

    return { action: "close", priority: 8, reason: "oor_timeout", pnl: pnlPct, oorMinutes };
  }

  // Priority 3b: non-OOR recovery exit after meaningful drawdown.
  if (
    pnlPct != null &&
    pnlPct >= 0 &&
    minPnlPct != null &&
    recoveryExitEnabled &&
    minPnlPct <= recoveryExitDrawdownPct
  ) {
    return {
      action: "close",
      priority: 3,
      reason: "drawdown_recovery_profit",
      pnl: pnlPct,
      minPnl: minPnlPct,
    };
  }

  // Priority 4: take profit for positions that are not in OOR recovery flow.
  if (pnlPct != null && pnlPct >= takeProfitPct) {
    return { action: "close", priority: 4, reason: "take_profit", pnl: pnlPct };
  }

  // Priority 5: trailing stop for scalping.
  if (
    peakPnlPct != null &&
    pnlPct != null &&
    peakPnlPct >= trailingTriggerPct &&
    pnlPct <= peakPnlPct - trailingDropPct
  ) {
    return { action: "close", priority: 5, reason: "trailing_stop", pnl: pnlPct, peak: peakPnlPct };
  }

  // Priority 6: slow bleed while still technically in range.
  if (
    ageMinutes != null &&
    pnlPct != null &&
    feePerTvl24h != null &&
    ageMinutes >= slowBleedMinAge &&
    pnlPct >= slowBleedMinPnl &&
    pnlPct <= slowBleedMaxPnl &&
    inRange === true &&
    feePerTvl24h < minFeePerTvl24h
  ) {
    return { action: "close", priority: 6, reason: "slow_bleed", pnl: pnlPct, feePerTvl: feePerTvl24h };
  }

  // Priority 7: stale low-yield capital.
  if (
    ageMinutes != null &&
    feePerTvl24h != null &&
    ageMinutes >= minAgeBeforeYieldCheck &&
    feePerTvl24h < minFeePerTvl24h
  ) {
    return { action: "close", priority: 7, reason: "low_yield", feePerTvl: feePerTvl24h };
  }

  // Priority 8: price pumped far above the configured range.
  if (activeBin != null && upperBin != null && activeBin > upperBin + outOfRangeBinsToClose) {
    return { action: "close", priority: 8, reason: "pumped_far_above_range", activeBin, upperBin };
  }

  // Priority 9: claim fees when no close rule is active.
  if (unclaimedFees != null && unclaimedFees >= minClaimAmount) {
    return { action: "claim", priority: 9, reason: "fees_available", amount: unclaimedFees };
  }

  return { action: "stay", priority: 10, reason: "healthy", pnl: pnlPct };
}
