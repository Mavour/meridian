async function renderConfig(container) {
  container.innerHTML = `<div class="page-title">Configuration</div><div class="config-grid" id="config-grid"></div>`;

  try {
    const cfg = await api("/api/config");
    const grid = document.getElementById("config-grid");

    const groups = {
      Screening: ["screeningSource", "minTvl", "maxTvl", "minVolume", "minOrganic", "minQuoteOrganic", "minHolders", "minMcap", "maxMcap", "minBinStep", "maxBinStep", "timeframe", "category", "minTokenFeesSol", "maxBotHoldersPct", "maxTop10Pct", "maxBundlePct", "blockedLaunchpads", "allowedLaunchpads", "minTokenAgeHours", "maxTokenAgeHours", "athFilterPct", "maxVolatility", "minFeeActiveTvlRatio"],
      Management: ["deployAmountSol", "maxDeployAmount", "gasReserve", "positionSizePct", "minSolToOpen", "stopLossPct", "emergencyPriceDropPct", "takeProfitPct", "takeProfitFeePct", "trailingTakeProfit", "trailingTriggerPct", "trailingDropPct", "outOfRangeWaitMinutes", "outOfRangeBinsToClose", "maxHoldMinutes", "maxHoldMinPnlPct", "slowBleedMinAge", "slowBleedMaxPnl", "autoSwapAfterClaim", "minClaimAmount"],
      Schedule: ["managementIntervalMin", "screeningIntervalMin", "healthCheckIntervalMin"],
      Risk: ["maxPositions", "maxWavesPerToken", "maxLossesPerToken", "waveBlockHours", "postCloseReentryCooldownMin"],
      LLM: ["llmModel", "managementModel", "screeningModel", "generalModel", "temperature", "maxTokens", "maxSteps"],
      Misc: ["solMode", "xSentimentEnabled", "minSentimentScore", "xLookbackDays", "chartIndicators", "darwinEnabled"],
    };

    for (const [group, keys] of Object.entries(groups)) {
      const rows = keys
        .filter((k) => cfg[k] !== undefined)
        .map((k) => {
          let v = cfg[k];
          if (typeof v === "boolean") v = v ? "true" : "false";
          if (typeof v === "object") v = JSON.stringify(v);
          return `<div class="config-row"><span class="config-key">${k}</span><span class="config-val">${v}</span></div>`;
        }).join("");

      if (rows) {
        const div = document.createElement("div");
        div.className = "card";
        div.innerHTML = `<div class="card-header">${group}</div>${rows}`;
        grid.appendChild(div);
      }
    }
  } catch (err) {
    container.innerHTML = `<div style="color:var(--red)">Error loading config: ${err.message}</div>`;
  }
}
