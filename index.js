import "./envcrypt.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";
import readline from "readline";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions, getActiveBin } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { formatGmgnCandidateForPrompt } from "./tools/gmgn.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import { evolveThresholds, getPerformanceSummary } from "./lessons.js";
import { computeBinsBelow, executeTool, registerCronRestarter } from "./tools/executor.js";
import { decideCloseAction } from "./tools/close-decider.js";
import { checkCookieHealth, analyzeSentiment, isCookieExpired } from "./tools/x.js";
import {
  startPolling,
  stopPolling,
  sendMessage,
  sendMessageWithButtons,
  sendHTML,
  editMessage,
  editMessageWithButtons,
  answerCallbackQuery,
  notifyOutOfRange,
  isEnabled as telegramEnabled,
  createLiveMessage,
} from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, getTrackedPositions, setPositionInstruction, updatePnlAndCheckExits, queuePeakConfirmation, resolvePendingPeak, queueTrailingDropConfirmation, resolvePendingTrailingDrop, isTokenWaveBlocked } from "./state.js";
import { getActiveStrategy } from "./strategy-library.js";
import { recordPositionSnapshot, recallForPool, addPoolNote, isBaseMintOnCooldown, isPoolOnCooldown } from "./pool-memory.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "./tools/token.js";
import { checkMeteoraWhaleGuard } from "./tools/whale-guard.js";
import { fetchChartIndicatorsForMint } from "./tools/chart-indicators.js";
import { BottomSpotLPStrategy } from "./strategies/index.js";
import { extractCandlesFromIndicatorPayload } from "./strategies/bottomSpotLP.js";
import { stageSignals, getAndClearStagedSignals } from "./signal-tracker.js";
import { getWeightsSummary } from "./signal-weights.js";
import { appendDecision } from "./decision-log.js";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(APP_DIR, "user-config.json");
const entrypointPath = process.env.pm_exec_path || process.argv[1];
const isMain = entrypointPath
  ? path.resolve(entrypointPath) === fileURLToPath(import.meta.url)
  : false;

const LOCK_FILE = path.join(process.cwd(), ".agent.lock");
function acquireInstanceLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, "utf8").trim(), 10);
      if (!Number.isNaN(pid)) {
        try {
          process.kill(pid, 0); // check if process is still alive
          console.error(`Another instance is already running (PID ${pid}). Exiting.`);
          process.exit(1);
        } catch (_) {
          // stale lock — previous process died
        }
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "w" });
    process.on("exit", () => {
      try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
    });
    process.on("SIGINT", () => {
      try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
      process.exit(0);
    });
  } catch (e) {
    console.error(`Lock file error: ${e.message}`);
  }
}
acquireInstanceLock();

log("startup", "DLMM LP Agent starting...");
log("startup", `PID: ${process.pid} | Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);
log("startup", `Lock file: ${LOCK_FILE} | exists: ${fs.existsSync(LOCK_FILE)}`);
// Check X sentiment on startup
if (config.xSentiment?.enabled) {
  log("startup", "Checking X sentiment cookies...");
  checkCookieHealth().then((r) => {
    if (r.healthy) {
      log("startup", "X sentiment: ready");
    } else {
      log("startup", `X sentiment: ${r.reason}`);
    }
  }).catch((e) => log("x_sentiment_error", `Health check failed: ${e.message}`));
}

const TP_PCT = config.management.takeProfitPct;
const DEPLOY = config.management.deployAmountSol;

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
let _managementBusy = false; // prevents overlapping management cycles
let _screeningBusy = false;  // prevents overlapping screening cycles
let _screeningLastTriggered = 0; // epoch ms - prevents management from spamming screening
let _pollTriggeredAt = 0; // epoch ms - cooldown for poller-triggered management
const _closingPositions = new Set(); // prevents double-close race
const _peakConfirmTimers = new Map();
const _trailingDropConfirmTimers = new Map();
const _recentlyClosedPools = new Map(); // tracks recently closed pools for ATH re-entry guard
const TRAILING_PEAK_CONFIRM_DELAY_MS = 15_000;
const TRAILING_PEAK_CONFIRM_TOLERANCE = 0.85;
const TRAILING_DROP_CONFIRM_DELAY_MS = 15_000;
const TRAILING_DROP_CONFIRM_TOLERANCE_PCT = 1.0;

/** Strip <think>...</think> reasoning blocks that some models leak into output */
function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function sanitizeUntrustedPromptText(text, maxLen = 500) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned ? JSON.stringify(cleaned) : null;
}

function shouldUsePnlRecheck() {
  return true;
}

function schedulePeakConfirmation(positionAddress) {
  if (!positionAddress || _peakConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    _peakConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      resolvePendingPeak(positionAddress, position?.pnl_pct ?? null, TRAILING_PEAK_CONFIRM_TOLERANCE);
    } catch (error) {
      log("state_warn", "Peak confirmation failed for " + positionAddress + ": " + error.message);
    }
  }, TRAILING_PEAK_CONFIRM_DELAY_MS);

  _peakConfirmTimers.set(positionAddress, timer);
}

/**
 * Resolve the best strategy (spot vs bid_ask) for a single pool candidate.
 * Priority:
 *  1. Market heuristic (price action + volatility)
 *  2. Active strategy fallback
 */
function resolveStrategyForPool(pool) {
  const activeStrategy = getActiveStrategy();
  const globalStrategy = activeStrategy?.lp_strategy || config.strategy.strategy;

  if (config.strategy.dynamicStrategyEnabled === false) {
    return { strategy: globalStrategy, reason: "dynamic strategy disabled" };
  }

  const price1h  = pool.price_1h_change ?? null;
  const price5m  = pool.price_5m_change ?? null;
  const volatility = pool.volatility ?? null;
  const gmgnPrice = pool.gmgn_price_action || {};

  const minPrice1h = config.strategy.spotMinPrice1hChange ?? 5;
  const minVol     = config.strategy.spotMinVolatility      ?? 3;
  const min5m      = config.strategy.spotMinPrice5mFloor   ?? config.strategy.spotMinPrice30mFloor ?? -2;

  const isUptrend =
    price1h != null && price1h > minPrice1h &&
    price5m != null && price5m >= min5m;

  const isVolatilePump =
    volatility != null && volatility > minVol &&
    price1h != null && price1h > (minPrice1h - 2);

  const supertrendUp = gmgnPrice.supertrend?.direction === "UP" && price1h != null && price1h > 0;

  if (isUptrend || isVolatilePump || supertrendUp) {
    return {
      strategy: "spot",
      reason: "market heuristic: uptrend (1h=" + price1h + "%, 5m=" + price5m + "%, vol=" + volatility + (supertrendUp ? ", supertrend=UP" : "") + ")",
    };
  }

  return {
    strategy: "bid_ask",
    reason: "market heuristic: sideways/consolidation (1h=" + price1h + "%, 5m=" + price5m + "%, vol=" + volatility + ")",
  };
}
function scheduleTrailingDropConfirmation(positionAddress) {
  if (!positionAddress || _trailingDropConfirmTimers.has(positionAddress)) return;

  const confirmDelayMs = (config.management.trailingConfirmDelaySec ?? 10) * 1000;
  const timer = setTimeout(async () => {
    _trailingDropConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      const resolved = resolvePendingTrailingDrop(
        positionAddress,
        position?.pnl_pct ?? null,
        config.management.trailingDropPct,
        TRAILING_DROP_CONFIRM_TOLERANCE_PCT,
      );
      if (resolved?.confirmed) {
        log("state", `[Trailing recheck] Confirmed trailing exit for ${positionAddress} — triggering management`);
        runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Trailing recheck management failed: ${e.message}`));
      }
    } catch (error) {
      log("state_warn", `Trailing drop confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, confirmDelayMs);

  _trailingDropConfirmTimers.set(positionAddress, timer);
}

/**
 * Execute instant close without LLM — used for hard stops and trailing exits.
 * This bypasses the management cycle for speed.
 */
async function executeInstantClose(position, reason) {
  const startTime = Date.now();
  log("state", `[Instant Close] Executing immediate close for ${position.pair} — ${reason}`);

  try {
    // Use the same non-LLM tool path as Telegram /close so post-close hooks
    // run consistently, especially auto-swapping the base token back to SOL.
    const result = await executeTool("close_position", {
      position_address: position.position,
      reason: reason,
      _suppress_close_notify: true,
    });

    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    if (success) {
      log("state", `[Instant Close] ✅ Closed ${position.pair} in ${duration}ms — PnL: ${result.pnl_pct ?? "?"}%`);

      // Telegram notification
      if (telegramEnabled()) {
        const pnlText = result.pnl_pct != null ? `${Number(result.pnl_pct).toFixed(2)}%` : "?";
        const swapText = result.auto_swapped ? "DONE" : (result.auto_swap_skipped || result.auto_swap_error || "not confirmed");
        const shortPosition = `${String(position.position).slice(0, 8)}...${String(position.position).slice(-6)}`;
        const msg = [
          "🚨 INSTANT CLOSE EXECUTED",
          "",
          `${position.pair}`,
          `Position: ${shortPosition}`,
          `Reason: ${reason}`,
          `PnL: ${pnlText}`,
          `Auto-swap: ${swapText}`,
          `Duration: ${(duration / 1000).toFixed(1)}s`,
          "",
          "Closed instantly without LLM delay",
        ].join("\n");
        sendMessage(msg).catch(() => {});
      }

      // Track closed pool
      if (result?.pool) {
        _recentlyClosedPools.set(result.pool, { closedAt: Date.now(), baseMint: result.base_mint ?? null, pnlPct: result.pnl_pct ?? null });
        if (result.base_mint) {
          _recentlyClosedPools.set(`mint:${result.base_mint}`, { closedAt: Date.now(), pool: result.pool, pnlPct: result.pnl_pct ?? null });
        }
      }

      return result;
    } else {
      log("state_warn", `[Instant Close] ❌ Failed to close ${position.pair}: ${result?.error || "unknown error"}`);
      return result;
    }
  } catch (error) {
    log("state_error", `[Instant Close] Error closing ${position.pair}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendHTML(briefing);
    }
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  _cronTasks = [];
}

export async function runManagementCycle({ silent = false } = {}) {
  if (_managementBusy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("cron", `Starting management cycle [PID ${process.pid}]`);
  let mgmtReport = null;
  let positions = [];
  let liveMessage = null;
  const screeningCooldownMs = 5 * 60 * 1000;

  try {
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("🔄 Management Cycle", "Evaluating positions...");
    }
    const livePositions = await getMyPositions({ force: true }).catch(() => null);
    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      log("cron", "No open positions — triggering screening cycle");
      mgmtReport = "No open positions. Triggering screening cycle.";
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      return mgmtReport;
    }

    // Snapshot + load pool memory
    const positionData = positions.map((p) => {
      recordPositionSnapshot(p.pool, p);
      return { ...p, recall: recallForPool(p.pool) };
    });

    // ── X Sentiment check for each position ────────────────────────
    const sentimentByPosition = new Map();
    if (config.xSentiment?.enabled && !isCookieExpired()) {
      const sentimentResults = await Promise.allSettled(
        positionData.filter(p => p.base_mint).map(async (p) => {
          const xs = await analyzeSentiment({ mint: p.base_mint });
          return { position: p.position, xs };
        })
      );
      for (const r of sentimentResults) {
        if (r.status === "fulfilled" && r.value?.xs) {
          sentimentByPosition.set(r.value.position, r.value.xs);
          // Get position name for logging
          const pos = positionData.find(p => p.position === r.value.position);
          if (r.value.xs.sentiment === "NEGATIVE" && r.value.xs.score < (config.xSentiment.minScore ?? -30)) {
            log("x_sentiment", `⚠️ Negative sentiment for ${pos?.pair}: ${r.value.xs.sentiment} (${r.value.xs.score})`);
          }
        }
      }
    }

    // ── Deterministic rule checks (no LLM) ──────────────────────────
    const actionMap = new Map();
    const bottomSpotStrategy = config.bottomSpotLP?.enabled
      ? new BottomSpotLPStrategy(config.bottomSpotLP)
      : null;
    for (const p of positionData) {
      // Instruction-set — pass to LLM, can't parse in JS
      if (p.instruction) {
        actionMap.set(p.position, { action: "INSTRUCTION" });
        continue;
      }

      const tracked = getTrackedPosition(p.position);
      if (bottomSpotStrategy && isBottomSpotPosition(p, tracked)) {
        const candles = await fetchBottomSpotCandles(p.base_mint || tracked?.token_mint);
        const feesPct = bottomSpotFeesPct(p, tracked);
        const bottomSpotAction = await bottomSpotStrategy.evaluatePosition({
          ...p,
          upperPrice: p.upper_price ?? p.price_range?.max ?? p.max_price,
          lowerPrice: p.lower_price ?? p.price_range?.min ?? p.min_price,
          ilPct: p.il_pct ?? p.impermanent_loss_pct,
        }, candles, { accumulatedFeesPct: feesPct });
        if (bottomSpotAction.action === "close" || bottomSpotAction.action === "reposition") {
          actionMap.set(p.position, {
            action: "CLOSE",
            rule: "BOTTOM_SPOT_LP",
            reason: `Bottom Spot LP ${bottomSpotAction.action}: ${bottomSpotAction.reason}`,
          });
          continue;
        }
      }

      const closeRule = getDeterministicCloseRule(p, config.management);
      if (closeRule) {
        actionMap.set(p.position, closeRule);
        continue;
      }

      // 6. Negative X sentiment from trusted accounts (fetch once, show warning every cycle)
      let xs = sentimentByPosition.get(p.position);
      let xsWarning = null;

      if (config.xSentiment.enabled && !isCookieExpired() && p.base_mint) {
        if (tracked?.x_sentiment_result) {
          // Already checked before - use cached result
          xs = tracked.x_sentiment_result;
        } else if (xs && xs.score != null && xs.score < config.xSentiment.minSentimentScore) {
          // First time negative - save to state
          saveXSentimentResult(p.position, xs);
        }
      }

      // Add warning to report if negative sentiment (from cache or fresh)
      if (xs && xs.score != null && xs.score < config.xSentiment.minSentimentScore) {
        xsWarning = `⚠️ X Sentiment: ${xs.sentiment} (${xs.score}) — ${xs.post_count} posts`;
      }

      // Claim rule
      if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
        actionMap.set(p.position, { action: "CLAIM" });
        continue;
      }
      actionMap.set(p.position, { action: "STAY" });
    }

    // ── Build JS report ──────────────────────────────────────────────
    const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

    const cur = config.management.solMode ? "◎" : "$";
    const reportLines = positionData.map((p) => {
      const act = actionMap.get(p.position);
      const inRange = p.in_range ? "🟢 IN" : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
      const val = config.management.solMode ? `◎${(p.total_value_usd ?? 0).toFixed(4)}` : `$${(p.total_value_usd ?? 0).toFixed(4)}`;
      const unclaimed = config.management.solMode ? `◎${(p.unclaimed_fees_usd ?? 0).toFixed(4)}` : `$${(p.unclaimed_fees_usd ?? 0).toFixed(4)}`;
      const statusLabel = act.action === "INSTRUCTION" ? "HOLD (instruction)" : act.action;
      let line = `**${p.pair}** | Age: ${p.age_minutes ?? "?"}m | Val: ${val} | Unclaimed: ${unclaimed} | PnL: ${p.pnl_pct ?? "?"}% | Yield: ${p.fee_per_tvl_24h ?? "?"}% | ${inRange} | ${statusLabel}`;
      if (p.instruction) line += `\nNote: "${p.instruction}"`;
      // Add X sentiment warning if negative
      const xs = sentimentByPosition.get(p.position);
      if (xs && xs.sentiment !== "DISABLED" && xs.sentiment !== "COOKIE_EXPIRED" && xs.sentiment !== "NO_ACCOUNTS") {
        line += `\n⚠️ X Sentiment: ${xs.sentiment} (${xs.score}) | ${xs.post_count} posts`;
      }
      if (act.action === "CLAIM") line += `\n→ Claiming fees`;
      return line;
    });

    const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
    const actionSummary = needsAction.length > 0
      ? needsAction.map(a => a.action === "INSTRUCTION" ? "EVAL instruction" : `${a.action}${a.reason ? ` (${a.reason})` : ""}`).join(", ")
      : "no action";

    mgmtReport = reportLines.join("\n\n") +
      `\n\nSummary: 💼 ${positions.length} positions | ${cur}${totalValue.toFixed(4)} | fees: ${cur}${totalUnclaimed.toFixed(4)} | ${actionSummary}`;

    // ── Call LLM only if action needed ──────────────────────────────
    const actionPositions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a.action !== "STAY";
    });

    if (actionPositions.length > 0) {
      log("cron", `Management: ${actionPositions.length} action(s) needed — invoking LLM [model: ${config.llm.managementModel}]`);

      const actionBlocks = actionPositions.map((p) => {
        const act = actionMap.get(p.position);
        return [
          `POSITION: ${p.pair} (${p.position})`,
          `  pool: ${p.pool}`,
          `  action: ${act.action}${act.reason ? ` — ${act.reason}` : ""}`,
          `  pnl_pct: ${p.pnl_pct}% | unclaimed_fees: ${cur}${p.unclaimed_fees_usd} | value: ${cur}${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
          `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
          p.instruction ? `  instruction: "${p.instruction}"` : null,
        ].filter(Boolean).join("\n");
      }).join("\n\n");

      const { content } = await agentLoop(`
MANAGEMENT ACTION REQUIRED — ${actionPositions.length} position(s)

${actionBlocks}

RULES:
- CLOSE: call close_position with position address and reason
- CLAIM: call claim_fees with position address
- INSTRUCTION: evaluate the instruction condition. If met → close_position. If not → HOLD, do nothing.

Execute the required actions. Just execute.
After executing, write a brief one-line result per position.
      `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 2048, {
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result, success }) => {
          await liveMessage?.toolFinish(name, result, success);
          // Track closed pools for ATH re-entry prevention in next screening cycle
          if (name === "close_position" && success && result?.pool) {
            _recentlyClosedPools.set(result.pool, { closedAt: Date.now(), baseMint: result.base_mint ?? null, pnlPct: result.pnl_pct ?? null });
            if (result.base_mint) _recentlyClosedPools.set(`mint:${result.base_mint}`, { closedAt: Date.now(), pool: result.pool, pnlPct: result.pnl_pct ?? null });
            log("cron", `Tracking closed pool ${result.pool_name || result.pool?.slice(0,8)} for ATH re-entry guard`);
          }
        },
      });

      mgmtReport += `\n\n${content}`;
    } else {
      log("cron", "Management: all positions STAY — skipping LLM");
      await liveMessage?.note("No tool actions needed.");
    }

    // Trigger screening after management
    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    if (afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > screeningCooldownMs) {
      log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
      // Pass recently closed pool info so screening can do fresh ATH/price check
      const closedPools = Array.from(_recentlyClosedPools.entries())
        .filter(([, v]) => Date.now() - v.closedAt < 60 * 60 * 1000) // last 1 hour
        .map(([pool, v]) => ({ pool, ...v }));
      runScreeningCycle({ recentlyClosed: closedPools }).catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
    }
  } catch (error) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    if (!silent && telegramEnabled()) {
      if (mgmtReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(mgmtReport)).catch(() => {});
        else sendMessage(`🔄 Management Cycle\n\n${stripThink(mgmtReport)}`).catch(() => { });
      }
      for (const p of positions) {
        if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
          notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => { });
        }
      }
    }
  }
  return mgmtReport;
}

function countBottomSpotPositions(positionsResult) {
  const positions = Array.isArray(positionsResult?.positions) ? positionsResult.positions : [];
  return positions.filter((position) =>
    isBottomSpotPosition(position) ||
    position?.strategy_tag === "bottom_spot_lp" ||
    /bottom spot/i.test(String(position?.instruction || position?.note || "")),
  ).length;
}

function isBottomSpotPosition(position, tracked = null) {
  return position?.signal_snapshot?.bottom_spot_lp === true ||
    tracked?.signal_snapshot?.bottom_spot_lp === true ||
    position?.strategy_tag === "bottom_spot_lp" ||
    tracked?.signal_snapshot?.strategy_tag === "bottom_spot_lp";
}

function bottomSpotFeesPct(position, tracked = null) {
  const initial = Number(position?.initial_value_usd ?? tracked?.initial_value_usd ?? 0);
  const fees = Number(position?.unclaimed_fees_true_usd ?? position?.unclaimed_fees_usd ?? 0) +
    Number(position?.collected_fees_true_usd ?? position?.collected_fees_usd ?? 0) +
    Number(tracked?.total_fees_claimed_usd ?? 0);
  return initial > 0 && Number.isFinite(fees) ? (fees / initial) * 100 : 0;
}

async function fetchBottomSpotCandles(mint) {
  if (!mint) return [];
  try {
    const lookback = Number(config.bottomSpotLP?.athLookbackCandles ?? 48);
    const candles = Math.max(lookback + 30, 80);
    const payload = await fetchChartIndicatorsForMint(mint, {
      interval: config.bottomSpotLP?.candleInterval || "15_MINUTE",
      candles,
      rsiLength: 14,
      refresh: false,
    });
    return extractCandlesFromIndicatorPayload(payload);
  } catch (error) {
    log("bottom_spot_lp_warn", `Candle fetch failed for ${mint.slice(0, 8)}: ${error.message}`);
    return [];
  }
}

function mergeBottomSpotPoolData(pool, tokenInfo) {
  return {
    ...pool,
    token_info: tokenInfo || null,
    fees_paid_sol: tokenInfo?.global_fees_sol ?? pool.gmgn_total_fee_sol ?? pool.global_fees_sol ?? null,
  };
}

function bottomSpotTvl(pool) {
  const tvl = Number(pool?.tvl ?? pool?.active_tvl ?? 0);
  return Number.isFinite(tvl) ? tvl : 0;
}

async function tryBottomSpotDeploy({ passing, prePositions, deployAmount, liveMessage }) {
  if (!config.bottomSpotLP?.enabled) return null;
  const maxOpen = Number(config.bottomSpotLP.maxOpenPositions ?? 1);
  if (maxOpen >= 0 && countBottomSpotPositions(prePositions) >= maxOpen) {
    log("bottom_spot_lp", `Skipped â€” max Bottom Spot positions reached (${maxOpen})`);
    return null;
  }

  const strategy = new BottomSpotLPStrategy(config.bottomSpotLP);
  const signals = [];
  for (const entry of passing) {
    const mint = entry.pool?.base?.mint;
    const candles = await fetchBottomSpotCandles(mint);
    const pool = mergeBottomSpotPoolData(entry.pool, entry.ti);
    const evaluation = await strategy.shouldDeploy(candles, [pool]);
    if (evaluation.deploy) signals.push({ ...evaluation, source: entry, candles });
  }

  if (signals.length === 0) return null;
  signals.sort((a, b) => bottomSpotTvl(b.pool) - bottomSpotTvl(a.pool));
  const selected = signals[0];
  const amountSol = Math.min(
    Number(config.bottomSpotLP.deployAmountSol ?? deployAmount),
    Number(deployAmount),
  );
  const params = strategy.buildDeployParams(selected.pool, selected.binRange, amountSol);
  if (!params.valid) {
    log("bottom_spot_lp_warn", `Deploy params invalid: ${params.reason}`);
    return null;
  }
  if (params.fees_paid_sol == null && Number(config.screening.minTokenFeesSol ?? 0) > 0) {
    log("bottom_spot_lp_warn", `Skipped ${params.pool_name} â€” missing fees_paid_sol`);
    return null;
  }

  stageSignals(params.pool_address, {
    base_mint: params.base_mint,
    bottom_spot_lp: true,
    bottom_spot_dump_pct: selected.entry.dumpPct,
    bottom_spot_retrace_pct: selected.entry.retracePct,
    bottom_spot_range_pct: Math.abs(Number(config.bottomSpotLP.rangePct ?? -45)),
    strategy_tag: "bottom_spot_lp",
    organic_score: params.organic_score ?? null,
    fee_tvl_ratio: params.fee_tvl_ratio ?? null,
    volume: params.volume ?? null,
    volatility: params.volatility ?? null,
  });

  await liveMessage?.toolStart("deploy_position");
  const result = await executeTool("deploy_position", params);
  const success = result?.success !== false && !result?.error && !result?.blocked;
  await liveMessage?.toolFinish("deploy_position", result, success);

  if (!success) {
    getAndClearStagedSignals(params.pool_address, params.base_mint);
    appendDecision({
      type: "skip",
      actor: "SCREENER",
      pool: params.pool_address,
      pool_name: params.pool_name,
      summary: "Bottom Spot LP deploy blocked",
      reason: result?.reason || result?.error || "deploy_position failed",
      metrics: {
        dump_pct: selected.entry.dumpPct,
        retrace_pct: selected.entry.retracePct,
      },
    });
    return null;
  }
  if (result?.dry_run) getAndClearStagedSignals(params.pool_address, params.base_mint);

  appendDecision({
    type: "deploy",
    actor: "SCREENER",
    pool: params.pool_address,
    pool_name: params.pool_name,
    summary: `Bottom Spot LP deployed ${amountSol} SOL`,
    reason: `Dump ${selected.entry.dumpPct}% from ATH with ${selected.entry.retracePct}% retrace`,
    metrics: {
      dump_pct: selected.entry.dumpPct,
      retrace_pct: selected.entry.retracePct,
      bins_below: selected.binRange.binsBelow,
      range_pct: Math.abs(Number(config.bottomSpotLP.rangePct ?? -45)),
      volume: params.volume ?? null,
      fee_tvl_ratio: params.fee_tvl_ratio ?? null,
    },
  });

  const dryRunLine = result?.dry_run ? "DRY RUN - no transaction sent" : "DEPLOYED";
  return [
    "Bottom Spot LP",
    dryRunLine,
    "",
    `${params.pool_name}`,
    `${params.pool_address}`,
    "",
    `SOL: ${amountSol}`,
    `Strategy: spot | single-side SOL | downside ${Math.abs(Number(config.bottomSpotLP.rangePct ?? -45))}%`,
    `Dump: ${selected.entry.dumpPct}% | Retrace: ${selected.entry.retracePct}%`,
    `Flow: volume $${params.volume ?? "?"} | fee/TVL ${params.fee_tvl_ratio ?? "?"}%`,
    `Range bins: ${selected.binRange.binsBelow} below | warnings: ${selected.binRange.warnings.join(", ") || "none"}`,
    result?.position ? `Position: ${result.position}` : null,
    result?.txs?.length ? `Tx: ${result.txs[0]}` : null,
  ].filter(Boolean).join("\n");
}

function fmtDeployValue(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number.toLocaleString("en-US", {
    maximumFractionDigits: digits,
  });
}

function fmtDeployPct(value, digits = 2) {
  const formatted = fmtDeployValue(value, digits);
  return formatted == null ? null : `${formatted}%`;
}

function fmtDeployUsd(value, digits = 0) {
  const formatted = fmtDeployValue(value, digits);
  return formatted == null ? null : `$${formatted}`;
}

function buildAuthoritativeDeployReport({ args = {}, result = {}, decision = {} }) {
  const wouldDeploy = result.would_deploy || {};
  const poolName = result.pool_name || args.pool_name || "Selected pool";
  const poolAddress = result.pool || args.pool_address || wouldDeploy.pool_address || null;
  const strategy = result.strategy || args.strategy || wouldDeploy.strategy || config.strategy.strategy;
  const amountSol = result.amount_y ?? args.amount_y ?? args.amount_sol ?? wouldDeploy.amount_y;
  const binRange = result.bin_range || {};
  const range = result.range_coverage || {};
  const prices = result.price_range || {};
  const dryRun = result.dry_run === true;
  const selectionReason = decision.selection_reason || args.selection_reason || null;

  const rangeLine = prices.min != null && prices.max != null
    ? `Range: ${fmtDeployValue(prices.min, 8)} -> ${fmtDeployValue(prices.max, 8)}`
    : (binRange.min != null && binRange.max != null ? `Range bins: ${binRange.min} -> ${binRange.max}` : null);
  const coverageParts = [
    range.downside_pct != null ? `${fmtDeployPct(range.downside_pct)} downside` : null,
    range.upside_pct != null ? `${fmtDeployPct(range.upside_pct)} upside` : null,
    range.width_pct != null ? `${fmtDeployPct(range.width_pct)} total` : null,
  ].filter(Boolean);
  const marketLines = [
    args.fee_tvl_ratio != null ? `Fee/TVL: ${fmtDeployPct(args.fee_tvl_ratio)}` : null,
    args.volume != null ? `Volume: ${fmtDeployUsd(args.volume)}` : null,
    args.volatility != null ? `Volatility: ${fmtDeployValue(args.volatility)}` : null,
    args.organic_score != null ? `Organic: ${fmtDeployValue(args.organic_score, 0)}` : null,
    args.initial_value_usd != null ? `Initial value: ${fmtDeployUsd(args.initial_value_usd)}` : null,
  ].filter(Boolean);
  const auditLines = [
    args.fees_paid_sol != null ? `Fees paid: ${fmtDeployValue(args.fees_paid_sol)} SOL` : null,
    args.base_mint ? `Base mint: ${args.base_mint}` : null,
  ].filter(Boolean);
  const tx = result.txs?.[0] || result.tx || null;

  return [
    dryRun ? "DRY RUN - DEPLOY SIMULATED" : "DEPLOYED",
    "",
    poolName,
    poolAddress,
    "",
    amountSol != null ? `${fmtDeployValue(amountSol, 4)} SOL | ${strategy}${binRange.active != null ? ` | bin ${binRange.active}` : ""}` : `${strategy}${binRange.active != null ? ` | bin ${binRange.active}` : ""}`,
    result.position ? `Position: ${result.position}` : null,
    rangeLine,
    coverageParts.length ? `Range cover: ${coverageParts.join(" | ")}` : null,
    result.bin_step != null ? `Bin step: ${result.bin_step}${result.base_fee != null ? ` | base fee ${fmtDeployPct(result.base_fee, 4)}` : ""}` : null,
    selectionReason ? `\nWHY THIS WON\n${selectionReason}` : null,
    marketLines.length ? `\nMARKET\n${marketLines.join("\n")}` : null,
    auditLines.length ? `\nAUDIT\n${auditLines.join("\n")}` : null,
    tx ? `\nTx: ${tx}` : null,
    dryRun ? "\nNo transaction was sent because DRY_RUN=true." : null,
  ].filter(Boolean).join("\n");
}

function extractDecisionSection(text, heading) {
  const source = String(text || "");
  const pattern = new RegExp(
    `\\b${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b\\s*\\n+([\\s\\S]*?)(?=\\n\\s*(?:WHY SKIPPED|WHY THIS WON|BEST LOOKING CANDIDATE|REJECTED|ACTION:|POOL_ADDRESS:|STRATEGY:|MARKET|AUDIT)\\b|$)`,
    "i",
  );
  const match = source.match(pattern);
  if (!match) return null;
  return match[1].replace(/\s+\n/g, "\n").trim().slice(0, 700) || null;
}

function parseScreeningDeployDecision(content) {
  const text = stripThink(String(content || ""));
  if (/\bNO_DEPLOY\b|\bNO DEPLOY\b/i.test(text)) {
    return { action: "NO_DEPLOY" };
  }
  const actionMatch = text.match(/\bACTION\s*:\s*(DEPLOY|NO_DEPLOY|NO DEPLOY)\b/i);
  if (actionMatch && /NO/i.test(actionMatch[1])) return { action: "NO_DEPLOY" };
  if (actionMatch && /DEPLOY/i.test(actionMatch[1])) {
    const poolMatch = text.match(/\bPOOL_ADDRESS\s*:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/i);
    const strategyMatch = text.match(/\bSTRATEGY\s*:\s*(spot|bid_ask)\b/i);
    return {
      action: "DEPLOY",
      pool_address: poolMatch?.[1] || null,
      strategy: strategyMatch?.[1]?.toLowerCase() || null,
      selection_reason: extractDecisionSection(text, "WHY THIS WON"),
    };
  }
  return { action: "NO_DEPLOY" };
}

function buildScreenerDeployParams({ decision, candidateEntry, deployAmount }) {
  const pool = candidateEntry.pool;
  const tokenInfo = candidateEntry.ti;
  const strategyRec = resolveStrategyForPool(pool);
  const strategy = decision.strategy || strategyRec.strategy || config.strategy.strategy;
  const binsBelow = computeBinsBelow(pool.volatility, config);

  return {
    pool_address: pool.pool,
    pool_name: pool.name,
    base_mint: pool.base?.mint || pool.base_mint || tokenInfo?.mint,
    amount_y: deployAmount,
    amount_x: 0,
    strategy,
    bins_below: binsBelow,
    bins_above: 0,
    bin_step: pool.bin_step,
    base_fee: pool.fee_pct,
    volatility: pool.volatility,
    fee_tvl_ratio: pool.fee_active_tvl_ratio,
    volume: pool.volume_window,
    organic_score: pool.organic_score,
    initial_value_usd: pool.initial_value_usd,
    price_5m_change: pool.price_5m_change ?? pool.price_change_pct,
    price_1h_change: pool.price_1h_change,
    price_6h_change: pool.price_6h_change,
    price_24h_change: pool.price_24h_change,
    fee_change_pct: pool.fee_change_pct,
    volume_change_pct: pool.volume_change_pct,
    price_trend: pool.price_trend,
    fees_paid_sol: tokenInfo?.global_fees_sol,
    selection_reason: decision.selection_reason,
  };
}

export async function runScreeningCycle({ silent = false, recentlyClosed = [] } = {}) {
  if (_screeningBusy) {
    log("cron", "Screening skipped — previous cycle still running");
    if (!silent && telegramEnabled()) {
      sendMessage("🔍 Screening Cycle\n\nScreening skipped — previous cycle still running.").catch(() => {});
    }
    return null;
  }
  _screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  _screeningLastTriggered = Date.now();

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  let liveMessage = null;
  let screenReport = null;
  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      screenReport = `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions}).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`,
      });
      _screeningBusy = false;
      return screenReport;
    }
    const minRequired = config.management.deployAmountSol + config.management.gasReserve;
    const isDryRun = process.env.DRY_RUN === "true";
    if (!isDryRun && preBalance.sol < minRequired) {
      log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      screenReport = `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired})`,
      });
      _screeningBusy = false;
      return screenReport;
    }
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    screenReport = `Screening pre-check failed: ${e.message}`;
    _screeningBusy = false;
    return screenReport;
  }
  if (!silent && telegramEnabled()) {
    liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...");
  }
  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
  try {
    // Reuse pre-fetched balance — no extra RPC call needed
    const currentBalance = preBalance;
    const deployAmount = computeDeployAmount(currentBalance.sol);
    log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`);

    // Load active strategy
    const activeStrategy = getActiveStrategy();
    const strategyBlock = activeStrategy
      ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${activeStrategy.lp_strategy} | bins_above: ${activeStrategy.range?.bins_above ?? 0} (FIXED — never change) | deposit: ${activeStrategy.entry?.single_side === "sol" ? "SOL only (amount_y, amount_x=0)" : "dual-sided"} | best for: ${activeStrategy.best_for}`
      : `No active strategy — use strategy=${config.strategy.strategy}, bins_above=0, SOL only.`;

    // Fetch top candidates, then recon each sequentially with a small delay to avoid 429s
    const topCandidates = await getTopCandidates({ limit: 10 }).catch((e) => ({ _error: e.message }));
    if (topCandidates?._error) {
      screenReport = `Screening failed: ${topCandidates._error}`;
      return screenReport;
    }
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);
    const earlyFilteredExamples = topCandidates?.filtered_examples || [];
    const gmgnStageCounts = topCandidates?.stage_counts ?? null;
    const gmgnAllFiltered = topCandidates?.all_filtered ?? [];

    const allCandidates = [];
    for (const pool of candidates) {
      const mint = pool.base?.mint;
      const [smartWallets, narrative, tokenInfo, xSentiment] = await Promise.allSettled([
        checkSmartWalletsOnPool({ pool_address: pool.pool }),
        mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
        mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
        (config.xSentiment?.enabled && mint && !isCookieExpired()) ? analyzeSentiment({ mint }) : Promise.resolve(null),
      ]);
      allCandidates.push({
        pool,
        sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
        n: narrative.status === "fulfilled" ? narrative.value : null,
        ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
        mem: recallForPool(pool.pool),
        xs: xSentiment.status === "fulfilled" ? xSentiment.value : null,
      });
      await new Promise(r => setTimeout(r, 150)); // avoid 429s
    }

    // Hard filters after token recon — block launchpads and excessive Jupiter bot holders
    // Skipped for GMGN: platforms already filtered upstream; bundler/bot data from GMGN pipeline
    const filteredOut = [];
    const passing = allCandidates.filter(({ pool, n, ti, xs }) => {
      // Wave block is LOCAL state — must check even for GMGN candidates
      const narrativeText = n?.narrative || null;
      if (isTokenWaveBlocked(pool.base?.mint, null, narrativeText) || isTokenWaveBlocked(pool.base?.symbol, null, narrativeText)) {
        log("screening", `Filtered wave-blocked token ${pool.name} (${pool.base?.mint?.slice(0, 8)})`);
        filteredOut.push({ name: pool.name, reason: "wave blocked (max profitable exits in window)" });
        return false;
      }
      if (isBaseMintOnCooldown(pool.base?.mint)) {
        log("screening", `Filtered cooldown token ${pool.name} (${pool.base?.mint?.slice(0, 8)})`);
        filteredOut.push({ name: pool.name, reason: "token cooldown active" });
        return false;
      }
      if (isPoolOnCooldown(pool.pool)) {
        log("screening", `Filtered cooldown pool ${pool.name} (${pool.pool?.slice(0, 8)})`);
        filteredOut.push({ name: pool.name, reason: "pool cooldown active" });
        return false;
      }
      if (config.screening.maxVolatility && pool.volatility != null && pool.volatility > config.screening.maxVolatility) {
        log("screening", `Filtered high volatility ${pool.name}: ${pool.volatility} > ${config.screening.maxVolatility}`);
        filteredOut.push({ name: pool.name, reason: `volatility too high (${pool.volatility} > max ${config.screening.maxVolatility})` });
        return false;
      }

      // GMGN upstream already filters platforms/bundlers/bots; skip Jupiter-only filters
      if (pool.gmgn) return true;

      // X Sentiment hard filter - reject if negative
      if (config.xSentiment?.enabled && xs?.score != null && xs.score < config.xSentiment.minScore) {
        log("screening", `Skipping ${pool.name} — negative X sentiment (${xs.score})`);
        filteredOut.push({ name: pool.name, reason: `negative X sentiment (${xs.score})` });
        return false;
      }

      const launchpad = ti?.launchpad ?? null;
      if (launchpad && config.screening.allowedLaunchpads?.length > 0 && !config.screening.allowedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — launchpad ${launchpad} not in allow-list`);
        filteredOut.push({ name: pool.name, reason: `launchpad ${launchpad} not in allow-list` });
        return false;
      }
      if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — blocked launchpad (${launchpad})`);
        filteredOut.push({ name: pool.name, reason: `blocked launchpad (${launchpad})` });
        return false;
      }
      const botPct = ti?.audit?.bot_holders_pct;
      const maxBotHoldersPct = config.screening.maxBotHoldersPct;
      if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
        log("screening", `Bot-holder filter: dropped ${pool.name} — bots ${botPct}% > ${maxBotHoldersPct}%`);
        filteredOut.push({ name: pool.name, reason: `bot holders ${botPct}% > ${maxBotHoldersPct}%` });
        return false;
      }
      return true;
    });

    if (passing.length === 0) {
      const combined = filteredOut.length > 0 ? filteredOut : earlyFilteredExamples;
      const combinedExamples = combined.slice(0, 5)
        .map((entry) => `- ${entry.name}: ${entry.reason}`)
        .join("\n");
      const funnelBlock = buildGmgnFunnelReport(gmgnStageCounts, gmgnAllFiltered, { fromStage: 2 });
      const thresholds = `Thresholds: tvl>$${config.screening.minTvl} | vol>$${config.screening.minVolume} | organic>${config.screening.minOrganic}% | holders>${config.screening.minHolders} | fee/tvl>${config.screening.minFeeActiveTvlRatio}%`;
      screenReport = funnelBlock
        ? `No candidates available.\n\n${funnelBlock}`
        : combinedExamples
          ? `No candidates available.\nFiltered examples:\n${combinedExamples}`
          : `No candidates available (all filtered).\n${thresholds}`;
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "No candidates available",
        reason: funnelBlock || combinedExamples || "All candidates filtered before deploy",
        rejected: combined.slice(0, 5).map((entry) => `${entry.name}: ${entry.reason}`),
      });
      return screenReport;
    }

    if (passing.length <= 1 && gmgnStageCounts) {
      const funnelBlock = buildGmgnFunnelReport(gmgnStageCounts, gmgnAllFiltered, { fromStage: 2 });
      if (funnelBlock) log("screening", `GMGN funnel (sparse):\n${funnelBlock}`);
    }

    const bottomSpotReport = await tryBottomSpotDeploy({
      passing,
      prePositions,
      deployAmount,
      liveMessage,
    });
    if (bottomSpotReport) {
      screenReport = bottomSpotReport;
      return screenReport;
    }

    // Pre-fetch active_bin for all passing candidates in parallel
    const activeBinResults = await Promise.allSettled(
      passing.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
    );

    // Build compact candidate blocks
    const hardFilteredBlock = earlyFilteredExamples.length > 0
      ? `\n\nREJECTED BY HARD FILTERS (${earlyFilteredExamples.length} pool${earlyFilteredExamples.length !== 1 ? 's' : ''} — do NOT deploy into these):\n${earlyFilteredExamples.slice(0, 5).map((e) => `- ${e.name}: ${e.reason}`).join('\n')}`
      : "";

    const candidateBlocks = passing.map(({ pool, sw, n, ti, mem, xs }, i) => {
      const botPct = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct = ti?.audit?.top_holders_pct ?? "?";
      const feesSol = ti?.global_fees_sol ?? "?";
      const launchpad = ti?.launchpad ?? null;
      const priceChange = ti?.stats_1h?.price_change;
      const netBuyers = ti?.stats_1h?.net_buyers;
      const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;
      const strategyRec = resolveStrategyForPool(pool);
      const minFeeTvl = Number(config.screening.minFeeActiveTvlRatio ?? 0);
      const feeTvl = Number(pool.fee_active_tvl_ratio);
      const feeTvlStatus = Number.isFinite(feeTvl) && feeTvl >= minFeeTvl ? "PASS" : "FAIL";

      // OKX signals
      const okxParts = [
        pool.risk_level     != null ? `risk=${pool.risk_level}`               : null,
        pool.bundle_pct     != null ? `bundle=${pool.bundle_pct}%`            : null,
        pool.sniper_pct     != null ? `sniper=${pool.sniper_pct}%`            : null,
        pool.suspicious_pct != null ? `suspicious=${pool.suspicious_pct}%`    : null,
        pool.new_wallet_pct != null ? `new_wallets=${pool.new_wallet_pct}%`   : null,
        pool.is_rugpull != null ? `rugpull=${pool.is_rugpull ? "YES" : "NO"}` : null,
        pool.is_wash != null ? `wash=${pool.is_wash ? "YES" : "NO"}` : null,
      ].filter(Boolean).join(", ");
      const okxUnavailable = !okxParts && pool.price_vs_ath_pct == null;

      const okxTags = [
        pool.smart_money_buy    ? "smart_money_buy"    : null,
        pool.kol_in_clusters    ? "kol_in_clusters"    : null,
        pool.dex_boost          ? "dex_boost"          : null,
        pool.dex_screener_paid  ? "dex_screener_paid"  : null,
        pool.dev_sold_all       ? "dev_sold_all(bullish)" : null,
      ].filter(Boolean).join(", ");
      const pvpLine = pool.is_pvp
        ? `  pvp: HIGH — rival ${pool.pvp_rival_name || pool.pvp_symbol} (${pool.pvp_rival_mint?.slice(0, 8)}...) has pool ${pool.pvp_rival_pool?.slice(0, 8)}..., tvl=$${pool.pvp_rival_tvl}, holders=${pool.pvp_rival_holders}, fees=${pool.pvp_rival_fees}SOL`
        : null;
      let block;
      if (pool.gmgn) {
        block = [
          `POOL: ${pool.name} (${pool.pool})`,
          formatGmgnCandidateForPrompt(pool),
          `  fee_tvl_threshold: ${feeTvlStatus} (${Number.isFinite(feeTvl) ? feeTvl : "unknown"} >= ${minFeeTvl})`,
          `  recommended_strategy: ${strategyRec.strategy} (${strategyRec.reason})`,
          pvpLine,
          pool.single_side_entry?.reason ? `  single_side_sol_entry: ${pool.single_side_entry.reason}` : null,
          `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
          activeBin != null ? `  active_bin: ${activeBin}` : null,
          n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
          mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
          // X Sentiment
          xs && xs.sentiment !== "DISABLED" && xs.sentiment !== "COOKIE_EXPIRED" && xs.sentiment !== "NO_ACCOUNTS" 
            ? `  Sentiment: ${xs.sentiment} — ${xs.post_count} post${xs.post_count !== 1 ? "s" : ""} (${xs.positive_count} pos, ${xs.negative_count} neg)` 
            : null,
        ].filter(Boolean).join("\n");
      } else {
        const gmgnPriceLine = pool.gmgn_price_action
          ? `  gmgn_price: 5m=${pool.gmgn_price_action.price_5m_change ?? "?"}%, 1h=${pool.gmgn_price_action.price_1h_change ?? "?"}%, 6h=${pool.gmgn_price_action.price_6h_change ?? "?"}%, 24h=${pool.gmgn_price_action.price_24h_change ?? "?"}%`
          : null;
        block = [
          `POOL: ${pool.name} (${pool.pool})`,
          `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.tvl ?? pool.active_tvl}, volatility_${pool.volatility_timeframe || "30m"}=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}`,
          `  fee_tvl_threshold: ${feeTvlStatus} (${Number.isFinite(feeTvl) ? feeTvl : "unknown"} >= ${minFeeTvl})`,
          `  recommended_strategy: ${strategyRec.strategy} (${strategyRec.reason})`,
          `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
          gmgnPriceLine,
          pvpLine,
          okxParts ? `  okx: ${okxParts}` : okxUnavailable ? `  okx: unavailable` : null,
          okxTags  ? `  tags: ${okxTags}` : null,
          pool.dex_boosts != null ? `  dex_boosts: ${pool.dex_boosts}` : null,
          pool.price_vs_ath_pct != null ? `  ath: price_vs_ath=${pool.price_vs_ath_pct}%${pool.top_cluster_trend ? `, top_cluster=${pool.top_cluster_trend}` : ""}` : null,
          // X Sentiment
          xs && xs.sentiment !== "DISABLED" && xs.sentiment !== "COOKIE_EXPIRED" && xs.sentiment !== "NO_ACCOUNTS" 
            ? `  Sentiment: ${xs.sentiment} — ${xs.post_count} post${xs.post_count !== 1 ? "s" : ""} (${xs.positive_count} pos, ${xs.negative_count} neg)` 
            : null,
          `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
          activeBin != null ? `  active_bin: ${activeBin}` : null,
          pool.price_5m_change != null ? `  price_5m_change: ${pool.price_5m_change >= 0 ? "+" : ""}${pool.price_5m_change}%` : null,
          pool.price_1h_change != null ? `  price_1h_change: ${pool.price_1h_change >= 0 ? "+" : ""}${pool.price_1h_change}%` : null,
          pool.price_6h_change != null ? `  price_6h_change: ${pool.price_6h_change >= 0 ? "+" : ""}${pool.price_6h_change}%` : null,
          pool.price_24h_change != null ? `  price_24h_change: ${pool.price_24h_change >= 0 ? "+" : ""}${pool.price_24h_change}%` : null,
          pool.single_side_entry?.reason ? `  single_side_sol_entry: ${pool.single_side_entry.reason}` : null,
          priceChange != null ? `  jup_1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
          n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
          mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
        ].filter(Boolean).join("\n");
      }

      // Stage signals for Darwinian weighting — captured before LLM decides
      if (config.darwin?.enabled) {
        const baseMint = pool.base?.mint || pool.base_mint || ti?.mint || null;
        stageSignals(pool.pool, {
          base_mint:             baseMint,
          organic_score:         pool.organic_score         ?? null,
          fee_tvl_ratio:         pool.fee_active_tvl_ratio  ?? null,
          volume:                pool.volume_window         ?? null,
          mcap:                  pool.mcap                  ?? null,
          holder_count:          ti?.holders                ?? null,
          smart_wallets_present: (sw?.in_pool?.length ?? 0) > 0,
          narrative_quality:     n?.narrative ? "present" : "absent",
          volatility:            pool.volatility            ?? null,
        });
      }

      return block;
    });

    const weightsSummary = config.darwin?.enabled ? getWeightsSummary() : null;

    const recentlyClosedBlock = recentlyClosed.length > 0
      ? "\nWARNING — RECENTLY CLOSED POOLS (last 1h):\n" +
        recentlyClosed
          .filter(r => !r.pool?.startsWith("mint:"))
          .map(r => `- ${r.pool?.slice(0,8)} | closed ${Math.round((Date.now()-r.closedAt)/60000)}m ago | pnl: ${r.pnlPct?.toFixed(2) ?? "?"}%\n  ⚠️ Re-check ATH/risk context; do not reject solely because price is green after the previous close.`)
          .join("\n")
      : "";

const { content } = await agentLoop(`
SCREENING CYCLE
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL${recentlyClosedBlock}

PRE-LOADED CANDIDATES (${passing.length} pools):
${candidateBlocks.join("\n\n")}${hardFilteredBlock}

STEPS:
0. DECISION ONLY: do not call deploy_position. First output ACTION: DEPLOY with POOL_ADDRESS and STRATEGY, or ACTION: NO_DEPLOY. The system will execute deploy_position only after reading ACTION: DEPLOY.
1. Pick the best candidate based on narrative quality, smart wallets, and pool metrics.
2. Do not execute deploy_position. Only choose whether the system should deploy after your final answer.
   Use the candidate's recommended_strategy (spot or bid_ask). Override ONLY with strong justification.
3. If one pool qualifies, report in this exact format:
   ACTION: DEPLOY
   POOL_ADDRESS: <pool address>
   STRATEGY: <spot or bid_ask>

   WHY THIS WON
   <2-4 concise sentences on why this pool won, key risks, and why it still beat the alternatives>
4. If no pool qualifies, report in this exact format:
   ACTION: NO_DEPLOY

   Cycle finished with no valid entry.

   BEST LOOKING CANDIDATE
   <name or none>

   WHY SKIPPED
   <2-4 concise sentences explaining why nothing was good enough>

   REJECTED
   <short flat list of top candidate names and why they were skipped>
IMPORTANT:
- Never write "unknown" for OKX. Use real values, omit missing fields, or write exactly "OKX: unavailable".
- Keep the whole report compact and highly scannable for Telegram.
- Final action must be explicit: ACTION: DEPLOY or ACTION: NO_DEPLOY.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048, {
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result, success }) => {
          await liveMessage?.toolFinish(name, result, success);
        },
        blockedTools: ["deploy_position"],
        requireToolOnAction: false,
      });
    const funnelAppend = buildGmgnFunnelReport(gmgnStageCounts, gmgnAllFiltered, { fromStage: 2 });
    const decision = parseScreeningDeployDecision(content);
    let finalContent = content;
    if (decision.action === "DEPLOY") {
      const selectedIndex = passing.findIndex(({ pool }) => pool.pool === decision.pool_address);
      if (selectedIndex < 0) {
        finalContent = `ACTION: NO_DEPLOY\n\nCycle finished with no valid entry.\n\nWHY SKIPPED\nModel requested an invalid or missing POOL_ADDRESS, so no deploy was executed.`;
        appendDecision({
          type: "no_deploy",
          actor: "SCREENER",
          summary: "Deploy decision rejected",
          reason: `Invalid deploy pool address from model: ${decision.pool_address || "missing"}`,
        });
      } else {
        const params = buildScreenerDeployParams({
          decision,
          candidateEntry: passing[selectedIndex],
          deployAmount,
        });
        await liveMessage?.toolStart("deploy_position");
        const result = await executeTool("deploy_position", params);
        const success = result?.success !== false && !result?.error && !result?.blocked;
        await liveMessage?.toolFinish("deploy_position", result, success);
        finalContent = success
          ? buildAuthoritativeDeployReport({ args: params, result, decision })
          : `ACTION: NO_DEPLOY\n\nDeploy blocked by executor.\n\nWHY SKIPPED\n${result?.reason || result?.error || "deploy_position failed"}`;
        if (success && decision.selection_reason) {
          appendDecision({
            type: "deploy_reason",
            actor: "SCREENER",
            pool: params.pool_address,
            pool_name: params.pool_name,
            position: result?.position || null,
            summary: "LLM selection rationale",
            reason: decision.selection_reason,
            metrics: {
              strategy: params.strategy,
              volume: params.volume ?? null,
              fee_tvl_ratio: params.fee_tvl_ratio ?? null,
              volatility: params.volatility ?? null,
              organic_score: params.organic_score ?? null,
            },
          });
        }
        if (!success) {
          appendDecision({
            type: "no_deploy",
            actor: "SCREENER",
            summary: "Deploy blocked",
            reason: result?.reason || result?.error || "deploy_position failed",
          });
        }
      }
    }
    screenReport = funnelAppend ? `${finalContent}\n\n─────────────\n${funnelAppend}` : finalContent;
    if (hardFilteredBlock) {
      screenReport += `\n\n─────────────${hardFilteredBlock}`;
    }
    if (decision.action !== "DEPLOY") {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "LLM chose no deploy",
        reason: stripThink(content).slice(0, 500),
      });
    }
  } catch (error) {
    log("cron_error", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    _screeningBusy = false;
    if (!silent && telegramEnabled()) {
      if (screenReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(screenReport)).catch(() => {});
        else sendMessage(`🔍 Screening Cycle\n\n${stripThink(screenReport)}`).catch(() => { });
      }
    }
  }
  return screenReport;
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy) return;
    timers.managementLastRun = Date.now();
    await runManagementCycle();
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, runScreeningCycle);

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check");
    try {
      await agentLoop(`
HEALTH CHECK

Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
      `, config.llm.maxSteps, [], "MANAGER");
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      _managementBusy = false;
    }
  });

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  // Lightweight PnL poller — updates trailing TP state between management cycles, no LLM
  let _pnlPollBusy = false;
  const pollIntervalSec = config.management.pnlPollIntervalSec ?? 10;
  const pnlPollInterval = setInterval(async () => {
    if (_managementBusy || _screeningBusy || _pnlPollBusy) return;
    if (getTrackedPositions(true).length === 0) return;
    _pnlPollBusy = true;
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!result?.positions?.length) return;
      // Clean up _closingPositions for positions that no longer exist (close succeeded)
      const openPositionIds = new Set(result.positions.map((p) => p.position));
      for (const posId of _closingPositions) {
        if (!openPositionIds.has(posId)) _closingPositions.delete(posId);
      }
      for (const p of result.positions) {
        if (_closingPositions.has(p.position)) continue;
        const whaleExit = await checkMeteoraWhaleGuard(p);
        if (whaleExit) {
          _closingPositions.add(p.position);
          const reason = `${whaleExit.reason} | source=${whaleExit.source}`;
          log("state", `[PnL poll] ${reason} — fast close ${p.pair}`);
          executeTool("close_position", {
            position_address: p.position,
            reason,
          }).catch((e) => log("cron_error", `Whale guard close failed for ${p.pair}: ${e.message}`));
          break;
        }
        if (
          !p.pnl_pct_suspicious &&
          queuePeakConfirmation(p.position, p.pnl_pct, { immediate: !shouldUsePnlRecheck() }) &&
          shouldUsePnlRecheck()
        ) {
          schedulePeakConfirmation(p.position);
        }
        const exit = updatePnlAndCheckExits(p.position, p, config.management);
        if (exit) {
          // ── HARD STOP: Instant close without LLM ──────────────────
          if (exit.action === "HARD_STOP") {
            log("state", `[PnL poll] 🚨 HARD STOP triggered for ${p.pair} — ${exit.reason} — executing instantly`);
            await executeInstantClose(p, exit.reason);
            break; // stop checking other positions after hard stop
          }

          // ── TRAILING TP: Fast close without management cycle ──────
          if (exit.action === "TRAILING_TP" && exit.needs_confirmation) {
            if (_closingPositions.has(p.position)) continue;
            _closingPositions.add(p.position);
            log("state", `[PnL poll] Trailing TP triggered for ${p.pair} — fast close`);
            executeTool("close_position", {
              position_address: p.position,
              reason: exit.reason,
            }).catch((e) => log("cron_error", `Fast close failed for ${p.pair}: ${e.message}`));
            break;
          }

          // ── Regular exits: Fast close without management cycle ─────
          if (_closingPositions.has(p.position)) continue;
          _closingPositions.add(p.position);
          log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — fast close`);
          executeTool("close_position", {
            position_address: p.position,
            reason: exit.reason,
          }).catch((e) => log("cron_error", `Fast close failed for ${p.pair}: ${e.message}`));
          break;
        }
        const closeRule = getDeterministicCloseRule(p, config.management);
        if (closeRule) {
          if (_closingPositions.has(p.position)) continue;
          _closingPositions.add(p.position);
          log("state", `[PnL poll] Deterministic close rule: ${p.pair} — Rule ${closeRule.rule}: ${closeRule.reason} — fast close`);
          executeTool("close_position", {
            position_address: p.position,
            reason: closeRule.reason,
          }).catch((e) => log("cron_error", `Fast close failed for ${p.pair}: ${e.message}`));
          break;
        }
      }
    } finally {
      _pnlPollBusy = false;
    }
  }, Math.max(5, Number(pollIntervalSec || 10)) * 1000);

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog];
  // Store interval ref so stopCronJobs can clear it
  _cronTasks._pnlPollInterval = pnlPollInterval;
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
let _shuttingDown = false;

function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function shutdown(signal) {
  if (_shuttingDown) {
    log("shutdown", `Received ${signal} while shutdown is already in progress.`);
    return;
  }
  _shuttingDown = true;

  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  stopCronJobs();

  const positions = await withTimeout(
    getMyPositions({ force: true, silent: true }).catch((error) => {
      log("shutdown", `Position snapshot failed during shutdown: ${error.message}`);
      return null;
    }),
    5000
  );
  if (positions) {
    log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  } else {
    log("shutdown", "Open position snapshot skipped during shutdown timeout");
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name = (p.name || "unknown").padEnd(20);
    const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

function closeReasonText(decision) {
  switch (decision.reason) {
    case "empty_position":
      return "empty failed-deploy position cleanup";
    case "hard_stop":
      return "hard stop";
    case "stop_loss":
      return "stop loss";
    case "take_profit":
      return "take profit";
    case "trailing_stop":
      return `trailing stop${decision.peak != null ? ` from peak ${decision.peak}%` : ""}`;
    case "slow_bleed":
      return `slow bleed / slow rug - PnL ${decision.pnl}% fee/TVL ${decision.feePerTvl}%`;
    case "low_yield":
      return `low yield - fee/TVL ${decision.feePerTvl}%`;
    case "pumped_far_above_range":
      return "pumped far above range";
    case "oor":
      return "OOR";
    case "oor_recovery_profit":
      return `OOR recovery profit${decision.pnl != null ? ` - PnL ${decision.pnl}%` : ""}`;
    case "drawdown_recovery_profit":
      return `drawdown recovery profit${decision.pnl != null ? ` - PnL ${decision.pnl}%` : ""}${decision.minPnl != null ? ` after min ${decision.minPnl}%` : ""}`;
    case "oor_timeout":
      return `OOR timeout${decision.pnl != null ? ` - PnL ${decision.pnl}%` : ""}`;
    default:
      return decision.reason || "close rule";
  }
}

function getDeterministicCloseRule(position, managementConfig) {
  const tracked = getTrackedPosition(position.position);
  const pnlSuspect = (() => {
    if (position.pnl_pct == null) return false;
    if (position.pnl_pct > -90) return false;
    if (tracked?.amount_sol && (position.total_value_usd ?? 0) > 0.01) {
      log("cron_warn", `Suspect PnL for ${position.pair}: ${position.pnl_pct}% but position still has value — skipping PnL rules`);
      return true;
    }
    return false;
  })();

  const hardStopPct = Number(managementConfig.hardStopPct ?? managementConfig.stopLossPct);
  if (
    pnlSuspect &&
    managementConfig.hardStopBypassSuspicious === true &&
    Number.isFinite(hardStopPct) &&
    position.pnl_pct <= hardStopPct
  ) {
    return {
      action: "CLOSE",
      rule: 1,
      reason: "hard stop",
      decision: { action: "close", priority: 1, reason: "hard_stop", pnl: position.pnl_pct },
    };
  }

  const decision = decideCloseAction(
    pnlSuspect
      ? { ...position, pnl_pct: null, pnlPct: null, min_pnl_pct: tracked?.min_pnl_pct ?? null }
      : { ...position, min_pnl_pct: tracked?.min_pnl_pct ?? position.min_pnl_pct ?? null },
    managementConfig,
  );
  if (decision.action === "close") {
    return { action: "CLOSE", rule: decision.priority, reason: closeReasonText(decision), decision };
  }
  return null;
}

function buildGmgnFunnelReport(stageCounts, allFiltered = [], { fromStage = 1 } = {}) {
  if (!stageCounts) return null;
  const sc = stageCounts;
  const funnel = `GMGN funnel: ranked=${sc.ranked ?? "?"} → S1=${sc.s1 ?? "?"} → S2=${sc.s2 ?? "?"} → S3=${sc.s3 ?? "?"} → S4=${sc.s4 ?? "?"} → final=${sc.s5 ?? "?"}`;
  const byStage = {};
  for (const f of allFiltered) {
    if (f.stage < fromStage) continue;
    const key = `s${f.stage}`;
    if (!byStage[key]) byStage[key] = [];
    byStage[key].push(`${f.name}: ${f.reason}`);
  }
  const stageLabels = { s2: "S2 info", s3: "S3 pool", s4: "S4 indicators", s5: "S5 pick" };
  const details = Object.entries(byStage)
    .map(([key, items]) => `${stageLabels[key] || key}:\n${items.map(r => `  • ${r}`).join("\n")}`)
    .join("\n");
  return details ? `${funnel}\n\n${details}` : funnel;
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const _telegramQueue = []; // queued messages received while agent was busy
const sessionHistory = []; // persists conversation across REPL turns
const MAX_HISTORY = 20;    // keep last 20 messages (10 exchanges)
let _ttyInterface = null;
let _latestCandidates = [];
let _latestCandidatesAt = null;
let _pendingInput = null; // { key, page, menuMsgId } or { mode: "setKey", menuMsgId }

function setLatestCandidates(candidates = []) {
  _latestCandidates = Array.isArray(candidates) ? candidates : [];
  _latestCandidatesAt = new Date().toISOString();
}

function getLatestCandidatesMeta() {
  return {
    candidates: _latestCandidates,
    count: _latestCandidates.length,
    updatedAt: _latestCandidatesAt,
  };
}

function describeLatestCandidates(limit = 5) {
  if (!_latestCandidates.length) return "No cached candidates yet. Run /screen first.";
  const lines = _latestCandidates.slice(0, limit).map((pool, i) => {
    const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
    const vol = pool.volume_window ?? pool.volume_24h ?? "?";
    const active = pool.active_pct ?? "?";
    const organic = pool.organic_score ?? "?";
    return `${i + 1}. ${pool.name} | fee/aTVL ${feeTvl}% | vol $${vol} | in-range ${active}% | organic ${organic}`;
  });
  const age = _latestCandidatesAt ? new Date(_latestCandidatesAt).toLocaleString("en-US", { hour12: false }) : "unknown";
  return `Latest candidates (${_latestCandidates.length}) — updated ${age}\n\n${lines.join("\n")}`;
}

function formatWalletStatus(wallet, positions) {
  const deployAmount = computeDeployAmount(wallet.sol);
  return [
    `Wallet: ${wallet.sol} SOL ($${wallet.sol_usd})`,
    `SOL price: $${wallet.sol_price}`,
    `Open positions: ${positions.total_positions}/${config.risk.maxPositions}`,
    `Next deploy amount: ${deployAmount} SOL`,
    `Dry run: ${process.env.DRY_RUN === "true" ? "yes" : "no"}`,
  ].join("\n");
}

function formatConfigSnapshot() {
  return [
    "Config snapshot",
    "",
    `Screening source: ${config.screening.source}`,
    `Strategy: ${config.strategy.strategy} | bins: [${config.strategy.minBinsBelow}–${config.strategy.maxBinsBelow}] (volatility-scaled)`,
    `Deploy: ${config.management.deployAmountSol} SOL | gasReserve: ${config.management.gasReserve} | maxPositions: ${config.risk.maxPositions}`,
    `Stop loss: ${config.management.stopLossPct}% | take profit: ${config.management.takeProfitPct}%`,
    `Slow bleed: age >= ${config.management.slowBleedMinAge ?? 20}m | PnL ${config.management.slowBleedMinPnl ?? -1}% to ${config.management.slowBleedMaxPnl ?? 0.5}% | auto-close`,
    `Trailing: ${config.management.trailingTakeProfit ? "on" : "off"} | trigger ${config.management.trailingTriggerPct}% | drop ${config.management.trailingDropPct}%`,
    `OOR: ${config.management.outOfRangeWaitMinutes}m | cooldown ${config.management.oorCooldownTriggerCount}x / ${config.management.oorCooldownHours}h`,
    `Repeat deploy cooldown: ${config.management.repeatDeployCooldownEnabled ? "on" : "off"} | ${config.management.repeatDeployCooldownTriggerCount}x / ${config.management.repeatDeployCooldownHours}h | min fee earned ${config.management.repeatDeployCooldownMinFeeEarnedPct}% | ${config.management.repeatDeployCooldownScope}`,
    `Yield floor: ${config.management.minFeePerTvl24h}% | min age ${config.management.minAgeBeforeYieldCheck}m`,
    `Screening: ${config.screening.category} / ${config.screening.timeframe} | TVL ${config.screening.minTvl}-${config.screening.maxTvl}`,
    `GMGN interval: ${config.gmgn.interval} | OrderBy: ${config.gmgn.orderBy} | Dir: ${config.gmgn.direction}`,
    `Intervals: manage ${config.schedule.managementIntervalMin}m | screen ${config.schedule.screeningIntervalMin}m`,
  ].join("\n");
}

function parseConfigValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value.length) return "";
  if (/^(on|yes)$/i.test(value)) return true;
  if (/^(off|no)$/i.test(value)) return false;
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^null$/i.test(value)) return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return JSON.parse(value);
  }
  return value;
}

function readUserConfigSnapshot() {
  try {
    return fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
  } catch {
    return {};
  }
}

function settingValue(key) {
  const userConfig = readUserConfigSnapshot();
  const values = {
    dryRun: process.env.DRY_RUN === "true",
    preset: userConfig.preset,
    llmModel: userConfig.llmModel || process.env.LLM_MODEL,
    // ── Quick toggles ──
    solMode: config.management.solMode,
    trailingTakeProfit: config.management.trailingTakeProfit,
    // ── Quick numeric ──
    maxPositions: config.risk.maxPositions,
    deployAmountSol: config.management.deployAmountSol,
    gasReserve: config.management.gasReserve,
    positionSizePct: config.management.positionSizePct,
    takeProfitPct: config.management.takeProfitPct,
    stopLossPct: config.management.stopLossPct,
    trailingTriggerPct: config.management.trailingTriggerPct,
    trailingDropPct: config.management.trailingDropPct,
    managementIntervalMin: config.schedule.managementIntervalMin,
    screeningIntervalMin: config.schedule.screeningIntervalMin,
    healthCheckIntervalMin: config.schedule.healthCheckIntervalMin,
    // ── Screen ──
    screeningSource: config.screening.source,
    excludeHighSupplyConcentration: config.screening.excludeHighSupplyConcentration,
    minTvl: config.screening.minTvl,
    maxTvl: config.screening.maxTvl,
    minVolume: config.screening.minVolume,
    minOrganic: config.screening.minOrganic,
    minQuoteOrganic: config.screening.minQuoteOrganic,
    minHolders: config.screening.minHolders,
    minMcap: config.screening.minMcap,
    maxMcap: config.screening.maxMcap,
    minBinStep: config.screening.minBinStep,
    maxBinStep: config.screening.maxBinStep,
    timeframe: config.screening.timeframe,
    category: config.screening.category,
    minFeeActiveTvlRatio: config.screening.minFeeActiveTvlRatio,
    minTokenFeesSol: config.screening.minTokenFeesSol,
    maxBundlePct: config.screening.maxBundlePct,
    maxBotHoldersPct: config.screening.maxBotHoldersPct,
    maxTop10Pct: config.screening.maxTop10Pct,
    avoidPvpSymbols: config.screening.avoidPvpSymbols,
    blockPvpSymbols: config.screening.blockPvpSymbols,
    minTokenAgeHours: config.screening.minTokenAgeHours,
    maxTokenAgeHours: config.screening.maxTokenAgeHours,
    athFilterPct: config.screening.athFilterPct,
    maxVolatility: config.screening.maxVolatility,
    maxDexBoosts: config.screening.maxDexBoosts,
    blockedLaunchpads: config.screening.blockedLaunchpads,
    allowedLaunchpads: config.screening.allowedLaunchpads,
    cgBlockRank: config.screening.cgBlockRank,
    blockedSymbols: config.screening.blockedSymbols,
    postCloseReentryCooldownMin: config.screening.postCloseReentryCooldownMin,
    maxWavesPerToken: config.screening.maxWavesPerToken,
    maxLossesPerToken: config.screening.maxLossesPerToken,
    waveBlockHours: config.screening.waveBlockHours,
    fallingKnife5mThreshold: config.screening.fallingKnife5mThreshold,
    fallingKnife1hThreshold: config.screening.fallingKnife1hThreshold,
    singleSideSolEntryGateEnabled: config.screening.singleSideSolEntryGateEnabled,
    singleSideSolMin1hChange: config.screening.singleSideSolMin1hChange,
    singleSideSolMinRetest1hChange: config.screening.singleSideSolMinRetest1hChange,
    singleSideSolMaxRetest1hChange: config.screening.singleSideSolMaxRetest1hChange,
    singleSideSolMax5mPullback: config.screening.singleSideSolMax5mPullback,
    singleSideSolWeakTrendMax1h: config.screening.singleSideSolWeakTrendMax1h,
    singleSideSolMaxWeakBounce5m: config.screening.singleSideSolMaxWeakBounce5m,
    singleSideSolMinFeeActiveTvlRatio: config.screening.singleSideSolMinFeeActiveTvlRatio,
    useDiscordSignals: config.screening.useDiscordSignals,
    discordSignalMode: config.screening.discordSignalMode,
    // ── Strategy ──
    strategy: config.strategy.strategy,
    minBinsBelow: config.strategy.minBinsBelow,
    maxBinsBelow: config.strategy.maxBinsBelow,
    defaultBinsBelow: config.strategy.defaultBinsBelow,
    dynamicStrategyEnabled: config.strategy.dynamicStrategyEnabled,
    spotMinPrice1hChange: config.strategy.spotMinPrice1hChange,
    spotMinVolatility: config.strategy.spotMinVolatility,
    spotMinPrice5mFloor: config.strategy.spotMinPrice5mFloor,
    spotMinPrice30mFloor: config.strategy.spotMinPrice30mFloor,
    // ── Management ──
    outOfRangeWaitMinutes: config.management.outOfRangeWaitMinutes,
    outOfRangeBinsToClose: config.management.outOfRangeBinsToClose,
    minFeePerTvl24h: config.management.minFeePerTvl24h,
    minAgeBeforeYieldCheck: config.management.minAgeBeforeYieldCheck,
    minClaimAmount: config.management.minClaimAmount,
    autoSwapAfterClaim: config.management.autoSwapAfterClaim,
    oorCooldownTriggerCount: config.management.oorCooldownTriggerCount,
    oorCooldownHours: config.management.oorCooldownHours,
    repeatDeployCooldownScope: config.management.repeatDeployCooldownScope,
    minVolumeToRebalance: config.management.minVolumeToRebalance,
    slowBleedMinAge: config.management.slowBleedMinAge,
    slowBleedMinPnl: config.management.slowBleedMinPnl,
    slowBleedMaxPnl: config.management.slowBleedMaxPnl,
    recoveryExitEnabled: config.management.recoveryExitEnabled,
    recoveryExitDrawdownPct: config.management.recoveryExitDrawdownPct,
    hardStopPct: config.management.hardStopPct,
    hardStopBypassSuspicious: config.management.hardStopBypassSuspicious,
    trailingConfirmDelaySec: config.management.trailingConfirmDelaySec,
    pnlPollIntervalSec: config.management.pnlPollIntervalSec,
    pnlSanityMaxDiffPct: config.management.pnlSanityMaxDiffPct,
    minSolToOpen: config.management.minSolToOpen,
    repeatDeployCooldownEnabled: config.management.repeatDeployCooldownEnabled,
    repeatDeployCooldownTriggerCount: config.management.repeatDeployCooldownTriggerCount,
    repeatDeployCooldownHours: config.management.repeatDeployCooldownHours,
    repeatDeployCooldownMinFeeEarnedPct: config.management.repeatDeployCooldownMinFeeEarnedPct,
    whaleGuardEnabled: config.whaleGuard.enabled,
    whaleGuardSource: config.whaleGuard.source,
    whaleGuardWindowMinutes: config.whaleGuard.windowMinutes,
    whaleGuardCooldownMinutes: config.whaleGuard.cooldownMinutes,
    whaleGuardMinNetWithdrawUsd: config.whaleGuard.minNetWithdrawUsd,
    whaleGuardMinQuoteDrainUsd: config.whaleGuard.minQuoteDrainUsd,
    whaleGuardMinTvlDropUsd: config.whaleGuard.minTvlDropUsd,
    whaleGuardMinLiquidityDropPct: config.whaleGuard.minTvlDropPct,
    whaleGuardMinTvlDropPct: config.whaleGuard.minTvlDropPct,
    whaleGuardRequireBaseIncreaseForQuoteDrain: config.whaleGuard.requireBaseIncreaseForQuoteDrain,
    // ── GMGN ──
    gmgnRequireKol: config.gmgn.requireKol,
    gmgnInterval: config.gmgn.interval,
    gmgnIndicatorFilter: config.gmgn.indicatorFilter,
    gmgnMinVolume: config.gmgn.minVolume,
    gmgnMinTokenAgeHours: config.gmgn.minTokenAgeHours,
    gmgnMaxTokenAgeHours: config.gmgn.maxTokenAgeHours,
    gmgnMaxBundlerRate: config.gmgn.maxBundlerRate,
    gmgnMaxTop10HolderRate: config.gmgn.maxTop10HolderRate,
    gmgnPreferredKolNames: config.gmgn.preferredKolNames,
    gmgnPreferredKolMinHoldPct: config.gmgn.preferredKolMinHoldPct,
    gmgnDumpKolNames: config.gmgn.dumpKolNames,
    gmgnDumpKolMinHoldPct: config.gmgn.dumpKolMinHoldPct,
    gmgnIndicatorInterval: config.gmgn.indicatorInterval,
    gmgnRequireBullishSt: config.gmgn.indicatorRules?.requireBullishSupertrend,
    gmgnRejectAtBottom: config.gmgn.indicatorRules?.rejectAlreadyAtBottom,
    gmgnRequireAboveSt: config.gmgn.indicatorRules?.requireAboveSupertrend,
    gmgnMinRsi: config.gmgn.indicatorRules?.minRsi,
    gmgnMaxRsi: config.gmgn.indicatorRules?.maxRsi,
    gmgnMinKolCount: config.gmgn.minKolCount,
    gmgnMinTotalFeeSol: config.gmgn.minTotalFeeSol,
    gmgnMinHolders: config.gmgn.minHolders,
    gmgnMinMcap: config.gmgn.minMcap,
    gmgnMaxMcap: config.gmgn.maxMcap,
    // ── Indicators ──
    chartIndicatorsEnabled: config.indicators.enabled,
    indicatorEntryPreset: config.indicators.entryPreset,
    indicatorExitPreset: config.indicators.exitPreset,
    rsiLength: config.indicators.rsiLength,
    indicatorIntervals: config.indicators.intervals,
    requireAllIntervals: config.indicators.requireAllIntervals,
    indicatorCandles: config.indicators.candles,
    rsiOversold: config.indicators.rsiOversold,
    rsiOverbought: config.indicators.rsiOverbought,
    // ── Bottom Spot LP ──
    bottomSpotEnabled: config.bottomSpotLP.enabled,
    bottomSpotDeployAmountSol: config.bottomSpotLP.deployAmountSol,
    bottomSpotMinBaseFee: config.bottomSpotLP.minBaseFee,
    bottomSpotMinTvl: config.bottomSpotLP.minTvl,
    bottomSpotMaxTvl: config.bottomSpotLP.maxTvl,
    bottomSpotMinVolume: config.bottomSpotLP.minVolume,
    bottomSpotMinFeeActiveTvlRatio: config.bottomSpotLP.minFeeActiveTvlRatio,
    bottomSpotMinOrganic: config.bottomSpotLP.minOrganic,
    bottomSpotRangePct: config.bottomSpotLP.rangePct,
    bottomSpotMinDumpPct: config.bottomSpotLP.minDumpPct,
    bottomSpotMinRetracePct: config.bottomSpotLP.minRetracePct,
    bottomSpotAthLookbackCandles: config.bottomSpotLP.athLookbackCandles,
    bottomSpotCandleInterval: config.bottomSpotLP.candleInterval,
    bottomSpotRsiExitThreshold: config.bottomSpotLP.rsiExitThreshold,
    bottomSpotTakeProfitFeePct: config.bottomSpotLP.takeProfitFeePct,
    bottomSpotMaxILPct: config.bottomSpotLP.maxILPct,
    bottomSpotMinFeesToOverrideStopLoss: config.bottomSpotLP.minFeesToOverrideStopLoss,
    bottomSpotOutOfRangeWaitMinutes: config.bottomSpotLP.outOfRangeWaitMinutes,
    bottomSpotOutOfRangeTolerance: config.bottomSpotLP.outOfRangeTolerance,
    bottomSpotFeesForReposition: config.bottomSpotLP.feesForReposition,
    bottomSpotEnableTAExit: config.bottomSpotLP.enableTAExit,
    bottomSpotMaxOpenPositions: config.bottomSpotLP.maxOpenPositions,
    // ── Advanced ──
    darwinEnabled: config.darwin.enabled,
    darwinWindowDays: config.darwin.windowDays,
    darwinRecalcEvery: config.darwin.recalcEvery,
    darwinBoost: config.darwin.boostFactor,
    darwinDecay: config.darwin.decayFactor,
    darwinFloor: config.darwin.weightFloor,
    darwinCeiling: config.darwin.weightCeiling,
    darwinMinSamples: config.darwin.minSamples,
    xSentimentEnabled: config.xSentiment.enabled,
    minSentimentScore: config.xSentiment.minScore,
    xLookbackDays: config.xSentiment.lookbackDays,
    takeProfitFeePct: config.management.takeProfitPct,
    emergencyPriceDropPct: config.management.stopLossPct,
    spotMinVolume: config.strategy.spotMinVolume,
    spotMinFeeActiveTvlRatio: config.strategy.spotMinFeeActiveTvlRatio,
    maxBundlersPct: config.screening.maxBundlePct,
    tvlDropSkipPct: userConfig.tvlDropSkipPct,
    minBaseFeeSkipPct: userConfig.minBaseFeeSkipPct,
  };
  return values[key];
}

function fmtSettingValue(value) {
  if (Array.isArray(value)) return value.join(",");
  if (value == null) return "off";
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function settingButton(label, data) {
  const text = String(label);
  return { text: text.length > 60 ? `${text.slice(0, 57)}...` : text, callback_data: data };
}

function toggleButton(key, label) {
  return settingButton(`${label}: ${fmtSettingValue(settingValue(key))}`, `cfg:toggle:${key}`);
}

function stepButtons(key, label, step, { digits = 2 } = {}) {
  const value = Number(settingValue(key));
  const shown = Number.isFinite(value) ? value.toFixed(digits).replace(/\.?0+$/, "") : "?";
  return [
    settingButton(`- ${label}`, `cfg:step:${key}:${-step}`),
    settingButton(`${label}: ${shown}`, `cfg:noop`),
    settingButton(`+ ${label}`, `cfg:step:${key}:${step}`),
  ];
}

function inputButton(key, label, { digits = 0 } = {}) {
  const value = settingValue(key);
  const shown = value == null ? "off" : Number.isFinite(Number(value)) ? String(parseFloat(Number(value).toFixed(digits))) : String(value);
  return [settingButton(`${label}: ${shown} ✏`, `cfg:input:${key}`)];
}

const MENU_INTEGER_KEYS = new Set([
  "maxPositions",
  "managementIntervalMin",
  "screeningIntervalMin",
  "healthCheckIntervalMin",
  "minTvl",
  "maxTvl",
  "minVolume",
  "minOrganic",
  "minQuoteOrganic",
  "minHolders",
  "minMcap",
  "maxMcap",
  "minBinStep",
  "maxBinStep",
  "minTokenFeesSol",
  "maxBotHoldersPct",
  "maxTop10Pct",
  "maxBundlePct",
  "minTokenAgeHours",
  "maxTokenAgeHours",
  "maxDexBoosts",
  "minBinsBelow",
  "maxBinsBelow",
  "defaultBinsBelow",
  "outOfRangeWaitMinutes",
  "outOfRangeBinsToClose",
  "minAgeBeforeYieldCheck",
  "minClaimAmount",
  "slowBleedMinAge",
  "postCloseReentryCooldownMin",
  "maxWavesPerToken",
  "maxLossesPerToken",
  "waveBlockHours",
  "repeatDeployCooldownTriggerCount",
  "oorCooldownTriggerCount",
  "gmgnMinKolCount",
  "gmgnMinTotalFeeSol",
  "gmgnMinHolders",
  "gmgnMinVolume",
  "gmgnMinTokenAgeHours",
  "gmgnMaxTokenAgeHours",
  "rsiLength",
  "indicatorCandles",
  "rsiOversold",
  "rsiOverbought",
  "bottomSpotMinTvl",
  "bottomSpotMaxTvl",
  "bottomSpotMinVolume",
  "bottomSpotMinOrganic",
  "bottomSpotAthLookbackCandles",
  "bottomSpotRsiExitThreshold",
  "bottomSpotOutOfRangeWaitMinutes",
  "bottomSpotOutOfRangeTolerance",
  "bottomSpotMaxOpenPositions",
  "xLookbackDays",
  "pnlPollIntervalSec",
  "trailingConfirmDelaySec",
  "maxSteps",
  "maxTokens",
  "darwinWindowDays",
  "darwinRecalcEvery",
  "darwinMinSamples",
  "cgBlockRank",
]);

const MENU_NON_NEGATIVE_KEYS = new Set([
  "deployAmountSol",
  "gasReserve",
  "positionSizePct",
  "maxPositions",
  "maxDeployAmount",
  "managementIntervalMin",
  "screeningIntervalMin",
  "healthCheckIntervalMin",
  "minTvl",
  "maxTvl",
  "minVolume",
  "minOrganic",
  "minQuoteOrganic",
  "minHolders",
  "minMcap",
  "maxMcap",
  "minBinStep",
  "maxBinStep",
  "minFeeActiveTvlRatio",
  "minTokenFeesSol",
  "maxBotHoldersPct",
  "maxTop10Pct",
  "maxBundlePct",
  "minTokenAgeHours",
  "maxTokenAgeHours",
  "maxDexBoosts",
  "minBinsBelow",
  "maxBinsBelow",
  "defaultBinsBelow",
  "outOfRangeWaitMinutes",
  "outOfRangeBinsToClose",
  "minFeePerTvl24h",
  "minAgeBeforeYieldCheck",
  "minClaimAmount",
  "slowBleedMinAge",
  "postCloseReentryCooldownMin",
  "maxWavesPerToken",
  "maxLossesPerToken",
  "waveBlockHours",
  "repeatDeployCooldownTriggerCount",
  "oorCooldownTriggerCount",
  "repeatDeployCooldownHours",
  "repeatDeployCooldownMinFeeEarnedPct",
  "gmgnMinKolCount",
  "gmgnMinTotalFeeSol",
  "gmgnMinHolders",
  "gmgnMinVolume",
  "gmgnMinTokenAgeHours",
  "gmgnMaxTokenAgeHours",
  "gmgnMaxBundlerRate",
  "gmgnMaxTop10HolderRate",
  "rsiLength",
  "indicatorCandles",
  "rsiOversold",
  "rsiOverbought",
  "xLookbackDays",
  "pnlPollIntervalSec",
  "trailingConfirmDelaySec",
  "maxSteps",
  "maxTokens",
  "temperature",
  "darwinWindowDays",
  "darwinRecalcEvery",
  "darwinBoost",
  "darwinDecay",
  "darwinFloor",
  "darwinCeiling",
  "darwinMinSamples",
  "singleSideSolMinFeeActiveTvlRatio",
  "spotMinVolume",
  "spotMinFeeActiveTvlRatio",
  "minBaseFeeSkipPct",
  "bottomSpotDeployAmountSol",
  "bottomSpotMinBaseFee",
  "bottomSpotMinTvl",
  "bottomSpotMaxTvl",
  "bottomSpotMinVolume",
  "bottomSpotMinFeeActiveTvlRatio",
  "bottomSpotMinOrganic",
  "bottomSpotMinDumpPct",
  "bottomSpotMinRetracePct",
  "bottomSpotAthLookbackCandles",
  "bottomSpotRsiExitThreshold",
  "bottomSpotTakeProfitFeePct",
  "bottomSpotMaxILPct",
  "bottomSpotMinFeesToOverrideStopLoss",
  "bottomSpotOutOfRangeWaitMinutes",
  "bottomSpotOutOfRangeTolerance",
  "bottomSpotFeesForReposition",
  "bottomSpotMaxOpenPositions",
]);

function sanitizeMenuValue(key, value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (MENU_INTEGER_KEYS.has(key)) {
    const num = Number(value);
    if (!Number.isFinite(num)) throw new Error(`${key} must be a number`);
    value = Math.round(num);
  } else if (MENU_NON_NEGATIVE_KEYS.has(key) || typeof settingValue(key) === "number") {
    const num = Number(value);
    if (!Number.isFinite(num)) throw new Error(`${key} must be a number`);
    value = num;
  }
  if (MENU_NON_NEGATIVE_KEYS.has(key)) value = Math.max(0, value);
  if (key === "maxPositions") value = Math.max(1, value);
  if (key === "rsiLength") value = Math.max(2, value);
  if (["minBinsBelow", "maxBinsBelow", "defaultBinsBelow"].includes(key)) value = Math.max(35, value);
  if (key === "maxBinsBelow") value = Math.max(value, Number(config.strategy.minBinsBelow ?? 35));
  if (key === "defaultBinsBelow") {
    value = Math.max(Number(config.strategy.minBinsBelow ?? 35), Math.min(Number(config.strategy.maxBinsBelow ?? value), value));
  }
  if (key === "minBinStep" && Number(config.screening.maxBinStep) > 0) value = Math.min(value, Number(config.screening.maxBinStep));
  if (key === "maxBinStep") value = Math.max(value, Number(config.screening.minBinStep ?? 0));
  if (key === "minTvl" && Number(config.screening.maxTvl) > 0) value = Math.min(value, Number(config.screening.maxTvl));
  if (key === "maxTvl") value = Math.max(value, Number(config.screening.minTvl ?? 0));
  if (key === "bottomSpotDeployAmountSol") value = Math.max(0.1, value);
  if (key === "bottomSpotRangePct") value = Math.max(-55, Math.min(-30, -Math.abs(value)));
  if (key === "bottomSpotMinTvl" && Number(config.bottomSpotLP.maxTvl) > 0) {
    value = Math.min(value, Number(config.bottomSpotLP.maxTvl));
  }
  if (key === "bottomSpotMaxTvl") value = Math.max(value, Number(config.bottomSpotLP.minTvl ?? 0));
  return value;
}

function formatAppliedConfig(applied = {}) {
  const entries = Object.entries(applied);
  if (!entries.length) return "";
  return entries.map(([key, value]) => `${key} = ${fmtSettingValue(value)}`).join("\n");
}

const SETTINGS_PAGES = [
  {
    id: "quick",
    label: "Quick",
    fields: [
      { key: "preset", label: "Preset", type: "select", options: [["custom", "Custom"], ["degen", "Degen"], ["moderate", "Moderate"], ["safe", "Safe"]] },
      { key: "solMode", label: "SOL mode", type: "toggle" },
      { key: "dryRun", label: "Dry run", type: "toggle" },
      { key: "maxPositions", label: "Max positions", digits: 0 },
      { key: "deployAmountSol", label: "Deploy SOL", digits: 2 },
      { key: "minSolToOpen", label: "Min SOL open", digits: 2 },
      { key: "maxDeployAmount", label: "Max deploy SOL", digits: 2 },
      { key: "gasReserve", label: "Gas reserve", digits: 2 },
      { key: "positionSizePct", label: "Position size", digits: 2 },
    ],
  },
  {
    id: "screen",
    label: "Screen",
    fields: [
      { key: "screeningSource", label: "Source", type: "select", options: [["meteora", "Meteora"], ["gmgn", "GMGN"]] },
      { key: "timeframe", label: "Timeframe", type: "select", options: [["5m", "5m"], ["30m", "30m"], ["1h", "1h"], ["24h", "24h"]] },
      { key: "category", label: "Category", type: "select", options: [["trending", "Trending"], ["top", "Top"], ["new", "New"]] },
      { key: "minTvl", label: "Min TVL", digits: 0 },
      { key: "maxTvl", label: "Max TVL", digits: 0 },
      { key: "minVolume", label: "Min volume", digits: 0 },
      { key: "minOrganic", label: "Min organic", digits: 0 },
      { key: "minQuoteOrganic", label: "Min quote organic", digits: 0 },
      { key: "minHolders", label: "Min holders", digits: 0 },
      { key: "minMcap", label: "Min mcap", digits: 0 },
      { key: "maxMcap", label: "Max mcap", digits: 0 },
      { key: "minBinStep", label: "Min bin step", digits: 0 },
      { key: "maxBinStep", label: "Max bin step", digits: 0 },
      { key: "minFeeActiveTvlRatio", label: "Min fee/aTVL", digits: 2 },
      { key: "minTokenFeesSol", label: "Min fees SOL", digits: 0 },
    ],
  },
  {
    id: "risk",
    label: "Risk",
    fields: [
      { key: "excludeHighSupplyConcentration", label: "Supply concentration", type: "toggle" },
      { key: "maxBundlePct", label: "Max bundle %", digits: 0 },
      { key: "maxBotHoldersPct", label: "Max bot holders %", digits: 0 },
      { key: "maxTop10Pct", label: "Max top10 %", digits: 0 },
      { key: "avoidPvpSymbols", label: "Avoid PVP", type: "toggle" },
      { key: "blockPvpSymbols", label: "Hard block PVP", type: "toggle" },
      { key: "blockedLaunchpads", label: "Blocked launchpads" },
      { key: "allowedLaunchpads", label: "Allowed launchpads" },
      { key: "blockedSymbols", label: "Blocked symbols" },
      { key: "minTokenAgeHours", label: "Min age h", digits: 0 },
      { key: "maxTokenAgeHours", label: "Max age h", digits: 0 },
      { key: "athFilterPct", label: "ATH filter %", digits: 1 },
      { key: "fallingKnife5mThreshold", label: "Knife 5m %", digits: 1 },
      { key: "fallingKnife1hThreshold", label: "Knife 1h %", digits: 1 },
      { key: "maxVolatility", label: "Max volatility", digits: 1 },
      { key: "maxDexBoosts", label: "Max Dex boosts", digits: 0 },
      { key: "tvlDropSkipPct", label: "TVL drop skip %", digits: 1 },
      { key: "minBaseFeeSkipPct", label: "Min base fee skip", digits: 2 },
      { key: "cgBlockRank", label: "CG block rank", digits: 0 },
    ],
  },
  {
    id: "single",
    label: "Single SOL",
    fields: [
      { key: "singleSideSolEntryGateEnabled", label: "Entry gate", type: "toggle" },
    ],
  },
  {
    id: "strategy",
    label: "Strategy",
    fields: [
      { key: "strategy", label: "Strategy", type: "select", options: [["spot", "Spot"], ["bid_ask", "Bid-ask"], ["curve", "Curve"]] },
      { key: "dynamicStrategyEnabled", label: "Dynamic strategy", type: "toggle" },
      { key: "minBinsBelow", label: "Min bins", digits: 0 },
      { key: "maxBinsBelow", label: "Max bins", digits: 0 },
      { key: "defaultBinsBelow", label: "Default bins", digits: 0 },
      { key: "spotMinVolume", label: "Spot min volume", digits: 0 },
      { key: "spotMinFeeActiveTvlRatio", label: "Spot min fee/TVL", digits: 2 },
      { key: "spotMinPrice1hChange", label: "Spot min 1h %", digits: 1 },
      { key: "spotMinVolatility", label: "Spot min vol", digits: 1 },
      { key: "spotMinPrice5mFloor", label: "Spot 5m floor", digits: 1 },
      { key: "spotMinPrice30mFloor", label: "Spot 30m floor", digits: 1 },
    ],
  },
  {
    id: "mgmt",
    label: "Manage",
    fields: [
      { key: "minClaimAmount", label: "Min claim", digits: 1 },
      { key: "autoSwapAfterClaim", label: "Auto swap claim", type: "toggle" },
      { key: "minVolumeToRebalance", label: "Min rebalance vol", digits: 0 },
      { key: "outOfRangeBinsToClose", label: "OOR bins close", digits: 0 },
      { key: "outOfRangeWaitMinutes", label: "OOR wait min", digits: 0 },
      { key: "oorCooldownTriggerCount", label: "OOR cooldown count", digits: 0 },
      { key: "oorCooldownHours", label: "OOR cooldown h", digits: 2 },
      { key: "postCloseReentryCooldownMin", label: "Reentry cooldown", digits: 0 },
      { key: "maxWavesPerToken", label: "Max waves/token", digits: 0 },
      { key: "maxLossesPerToken", label: "Max losses/token", digits: 0 },
      { key: "waveBlockHours", label: "Wave block h", digits: 0 },
      { key: "repeatDeployCooldownEnabled", label: "Repeat cooldown", type: "toggle" },
      { key: "repeatDeployCooldownTriggerCount", label: "Repeat count", digits: 0 },
      { key: "repeatDeployCooldownHours", label: "Repeat cooldown h", digits: 2 },
      { key: "repeatDeployCooldownMinFeeEarnedPct", label: "Repeat min fee %", digits: 1 },
      { key: "repeatDeployCooldownScope", label: "Repeat scope", type: "select", options: [["token", "Token"], ["pool", "Pool"], ["both", "Both"]] },
      { key: "whaleGuardEnabled", label: "Whale guard", type: "toggle" },
      { key: "whaleGuardMinQuoteDrainUsd", label: "Whale quote $", digits: 0 },
      { key: "whaleGuardMinLiquidityDropPct", label: "Whale TVL drop %", digits: 1 },
      { key: "whaleGuardWindowMinutes", label: "Whale window m", digits: 0 },
    ],
  },
  {
    id: "exits",
    label: "Exits",
    fields: [
      { key: "takeProfitPct", label: "Take profit %", digits: 1 },
      { key: "takeProfitFeePct", label: "TP fee alias %", digits: 1 },
      { key: "stopLossPct", label: "Stop loss %", digits: 1 },
      { key: "emergencyPriceDropPct", label: "Emergency drop %", digits: 1 },
      { key: "hardStopPct", label: "Hard stop %", digits: 1 },
      { key: "hardStopBypassSuspicious", label: "Hard bypass suspicious", type: "toggle" },
      { key: "recoveryExitEnabled", label: "Recovery exit", type: "toggle" },
      { key: "recoveryExitDrawdownPct", label: "Recovery drawdown %", digits: 1 },
      { key: "trailingTakeProfit", label: "Trailing TP", type: "toggle" },
      { key: "trailingTriggerPct", label: "Trail trigger %", digits: 1 },
      { key: "trailingDropPct", label: "Trail drop %", digits: 1 },
      { key: "trailingConfirmDelaySec", label: "Trail confirm s", digits: 0 },
      { key: "pnlSanityMaxDiffPct", label: "PnL sanity diff %", digits: 1 },
      { key: "pnlPollIntervalSec", label: "PnL poll s", digits: 0 },
      { key: "minFeePerTvl24h", label: "Yield floor %", digits: 1 },
      { key: "minAgeBeforeYieldCheck", label: "Yield check age", digits: 0 },
      { key: "slowBleedMinAge", label: "Slow bleed age", digits: 0 },
      { key: "slowBleedMinPnl", label: "Slow bleed min", digits: 1 },
      { key: "slowBleedMaxPnl", label: "Slow bleed max", digits: 1 },
    ],
  },
  {
    id: "schedule",
    label: "Schedule",
    fields: [
      { key: "managementIntervalMin", label: "Manage interval", digits: 0 },
      { key: "screeningIntervalMin", label: "Screen interval", digits: 0 },
      { key: "healthCheckIntervalMin", label: "Health interval", digits: 0 },
    ],
  },
  {
    id: "llm",
    label: "LLM",
    fields: [
      { key: "llmModel", label: "Default model" },
      { key: "managementModel", label: "Manager model" },
      { key: "screeningModel", label: "Screener model" },
      { key: "generalModel", label: "General model" },
      { key: "temperature", label: "Temperature", digits: 3 },
      { key: "maxTokens", label: "Max tokens", digits: 0 },
      { key: "maxSteps", label: "Max steps", digits: 0 },
    ],
  },
  {
    id: "signals",
    label: "Signals",
    fields: [
      { key: "useDiscordSignals", label: "Discord signals", type: "toggle" },
      { key: "discordSignalMode", label: "Discord mode", type: "select", options: [["merge", "Merge"], ["only", "Only"]] },
      { key: "xSentimentEnabled", label: "X sentiment", type: "toggle" },
      { key: "minSentimentScore", label: "Min X score", digits: 0 },
      { key: "xLookbackDays", label: "X lookback days", digits: 0 },
      { key: "darwinEnabled", label: "Darwin signals", type: "toggle" },
      { key: "darwinWindowDays", label: "Darwin window d", digits: 0 },
      { key: "darwinRecalcEvery", label: "Darwin recalc every", digits: 0 },
      { key: "darwinBoost", label: "Darwin boost", digits: 2 },
      { key: "darwinDecay", label: "Darwin decay", digits: 2 },
      { key: "darwinFloor", label: "Darwin floor", digits: 2 },
      { key: "darwinCeiling", label: "Darwin ceiling", digits: 2 },
      { key: "darwinMinSamples", label: "Darwin min samples", digits: 0 },
    ],
  },
  {
    id: "indicators",
    label: "Indicators",
    fields: [
      { key: "chartIndicatorsEnabled", label: "Chart indicators", type: "toggle" },
      { key: "requireAllIntervals", label: "Require all TF", type: "toggle" },
      { key: "indicatorIntervals", label: "Intervals", type: "select", options: [["5_MINUTE", "5m"], ["15_MINUTE", "15m"], ["both", "Both"]] },
      { key: "indicatorEntryPreset", label: "Entry preset", type: "select", options: [["smart_wallet_retest", "Retest"], ["single_side_reclaim", "Reclaim"], ["supertrend_break", "Supertrend"], ["rsi_reversal", "RSI"]] },
      { key: "indicatorExitPreset", label: "Exit preset", type: "select", options: [["supertrend_break", "Supertrend"], ["rsi_reversal", "RSI"], ["bb_plus_rsi", "BB+RSI"]] },
      { key: "rsiLength", label: "RSI length", digits: 0 },
      { key: "indicatorCandles", label: "Candles", digits: 0 },
      { key: "rsiOversold", label: "RSI oversold", digits: 0 },
      { key: "rsiOverbought", label: "RSI overbought", digits: 0 },
    ],
  },
  {
    id: "bottom",
    label: "Bottom LP",
    fields: [
      { key: "bottomSpotEnabled", label: "Enabled", type: "toggle" },
      { key: "bottomSpotDeployAmountSol", label: "Deploy SOL", digits: 2 },
      { key: "bottomSpotEnableTAExit", label: "TA exit", type: "toggle" },
      { key: "bottomSpotMaxOpenPositions", label: "Max open", digits: 0 },
      { key: "bottomSpotRangePct", label: "Range down %", digits: 0 },
      { key: "bottomSpotMinDumpPct", label: "Min dump %", digits: 0 },
      { key: "bottomSpotMinRetracePct", label: "Min retrace %", digits: 0 },
      { key: "bottomSpotMinBaseFee", label: "Min base fee %", digits: 2 },
      { key: "bottomSpotMinTvl", label: "Min TVL", digits: 0 },
      { key: "bottomSpotMaxTvl", label: "Max TVL", digits: 0 },
      { key: "bottomSpotMinVolume", label: "Min volume", digits: 0 },
      { key: "bottomSpotMinFeeActiveTvlRatio", label: "Min fee/TVL %", digits: 2 },
      { key: "bottomSpotMinOrganic", label: "Min organic", digits: 0 },
      { key: "bottomSpotAthLookbackCandles", label: "ATH candles", digits: 0 },
      { key: "bottomSpotCandleInterval", label: "Candle TF", type: "select", options: [["5_MINUTE", "5m"], ["15_MINUTE", "15m"]] },
      { key: "bottomSpotRsiExitThreshold", label: "RSI exit", digits: 0 },
      { key: "bottomSpotTakeProfitFeePct", label: "Fee TP %", digits: 1 },
      { key: "bottomSpotMaxILPct", label: "Max IL %", digits: 0 },
      { key: "bottomSpotMinFeesToOverrideStopLoss", label: "IL fee override %", digits: 0 },
      { key: "bottomSpotOutOfRangeWaitMinutes", label: "OOR wait m", digits: 0 },
      { key: "bottomSpotOutOfRangeTolerance", label: "OOR tolerance m", digits: 0 },
      { key: "bottomSpotFeesForReposition", label: "Reposition fees %", digits: 1 },
    ],
  },
];

const SETTINGS_PAGE_BY_KEY = new Map(
  SETTINGS_PAGES.flatMap((page) => page.fields.map((field) => [field.key, page.id])),
);

function selectButtons(field) {
  const current = settingValue(field.key);
  const currentText = Array.isArray(current) ? current.join(",") : String(current);
  return field.options.map(([value, label]) => {
    const selected = value === "both"
      ? Array.isArray(current) && current.includes("5_MINUTE") && current.includes("15_MINUTE")
      : String(value) === currentText;
    return settingButton(`${selected ? "✓ " : ""}${label}`, `cfg:set:${field.key}:${value}`);
  });
}

function settingRowsForPage(page) {
  return page.fields.flatMap((field) => {
    if (field.type === "toggle") return [[toggleButton(field.key, field.label)]];
    if (field.type === "select") return [selectButtons(field)];
    return [inputButton(field.key, field.label, { digits: field.digits ?? 0 })];
  });
}

function renderSettingsMenu(page = "quick") {
  const selectedPage = SETTINGS_PAGES.find((item) => item.id === page) || SETTINGS_PAGES[0];

  const summary = [
    `Settings: ${selectedPage.label}`,
    "",
    `Mode: ${config.management.solMode ? "SOL" : "USD"} | Source: ${config.screening.source} | Strat: ${config.strategy.strategy}`,
    `Deploy: ${config.management.deployAmountSol} SOL | MaxPos: ${config.risk.maxPositions} | Gas: ${config.management.gasReserve}`,
    `TP/SL: ${config.management.takeProfitPct}% / ${config.management.stopLossPct}% | Trailing: ${config.management.trailingTakeProfit ? "ON" : "OFF"}`,
    `Bins: [${config.strategy.minBinsBelow}–${config.strategy.maxBinsBelow}] | Indicators: ${config.indicators.enabled ? "ON" : "OFF"}`,
    "",
    `${selectedPage.fields.length} editable settings. Tap a value to edit.`,
  ].join("\n");

  const nav = [];
  for (let i = 0; i < SETTINGS_PAGES.length; i += 3) {
    nav.push(SETTINGS_PAGES.slice(i, i + 3).map((item) => {
      const prefix = item.id === selectedPage.id ? "✓ " : "";
      return settingButton(`${prefix}${item.label}`, `cfg:page:${item.id}`);
    }));
  }

  const footer = [
    [
      settingButton("🔄 Refresh", `cfg:page:${selectedPage.id}`),
      settingButton("Set key", "cfg:setkey"),
      settingButton("📋 Raw cfg", "cfg:show"),
      settingButton("❌ Close", "cfg:close"),
    ],
  ];

  return { text: summary, keyboard: [...nav, ...settingRowsForPage(selectedPage), ...footer] };
}

async function showSettingsMenu({ messageId = null, page = "quick" } = {}) {
  const menu = renderSettingsMenu(page);
  if (messageId) {
    await editMessageWithButtons(menu.text, messageId, menu.keyboard);
  } else {
    await sendMessageWithButtons(menu.text, menu.keyboard);
  }
}

function normalizeMenuValue(key, raw) {
  if (key === "indicatorIntervals") {
    if (raw === "both") return ["5_MINUTE", "15_MINUTE"];
    return [raw];
  }
  if (key === "gmgnPreferredKolNames" || key === "gmgnDumpKolNames" || key === "blockedLaunchpads" || key === "allowedLaunchpads" || key === "blockedSymbols") {
    return String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  }
  return parseConfigValue(raw);
}

function resolveSettingPage(key) {
  return SETTINGS_PAGE_BY_KEY.get(key) || "quick";
}

async function applySettingsMenuCallback(msg) {
  const data = msg.callbackData || msg.text || "";
  const parts = data.split(":");
  const action = parts[1];

  if (action === "noop") {
    await answerCallbackQuery(msg.callbackQueryId);
    return;
  }
  if (action === "input") {
    const inputKey = parts[2];
    const currentVal = settingValue(inputKey);
    const inputPage = resolveSettingPage(inputKey);
    _pendingInput = { key: inputKey, page: inputPage, menuMsgId: msg.messageId };
    await answerCallbackQuery(msg.callbackQueryId);
    const examples = {
      deployAmountSol: "e.g. 0.5",
      gasReserve: "e.g. 0.1",
      maxPositions: "e.g. 3",
      takeProfitPct: "e.g. 10",
      stopLossPct: "e.g. -20",
      trailingTriggerPct: "e.g. 3.0",
      trailingDropPct: "e.g. 1.5",
      positionSizePct: "e.g. 0.35",
      managementIntervalMin: "e.g. 10",
      screeningIntervalMin: "e.g. 30",
      minTvl: "e.g. 10000",
      maxTvl: "e.g. 150000",
      minVolume: "e.g. 500",
      minOrganic: "e.g. 60",
      minHolders: "e.g. 500",
      minMcap: "e.g. 150000",
      maxMcap: "e.g. 10000000",
      minBinStep: "e.g. 80",
      maxBinStep: "e.g. 125",
      minFeeActiveTvlRatio: "e.g. 0.05",
      minTokenFeesSol: "e.g. 30",
      maxBotHoldersPct: "e.g. 30",
      maxTop10Pct: "e.g. 60",
      maxBundlePct: "e.g. 30",
      minTokenAgeHours: "e.g. 2",
      maxTokenAgeHours: "e.g. 168",
      athFilterPct: "e.g. -20",
      maxVolatility: "e.g. 7",
      maxDexBoosts: "e.g. 100",
      singleSideSolMin1hChange: "e.g. 0",
      singleSideSolMinRetest1hChange: "e.g. -5",
      singleSideSolMaxRetest1hChange: "e.g. 20",
      singleSideSolMax5mPullback: "e.g. -2",
      singleSideSolWeakTrendMax1h: "e.g. 3",
      singleSideSolMaxWeakBounce5m: "e.g. 10",
      singleSideSolMinFeeActiveTvlRatio: "e.g. 0.3",
      minBinsBelow: "e.g. 35",
      maxBinsBelow: "e.g. 69",
      defaultBinsBelow: "e.g. 45",
      outOfRangeWaitMinutes: "e.g. 30",
      minFeePerTvl24h: "e.g. 3.0",
      minAgeBeforeYieldCheck: "e.g. 60",
      minClaimAmount: "e.g. 5",
      slowBleedMinPnl: "e.g. -1.0",
      slowBleedMaxPnl: "e.g. 0.5",
      recoveryExitDrawdownPct: "e.g. -5",
      hardStopPct: "e.g. -15",
      minSentimentScore: "e.g. -30",
      blockedLaunchpads: `e.g. pump.fun,letsbonk.fun`,
      allowedLaunchpads: `e.g. moontok,deployer.fun`,
      bottomSpotDeployAmountSol: "e.g. 0.1",
      bottomSpotRangePct: "e.g. -45",
      bottomSpotMinDumpPct: "e.g. 30",
      bottomSpotMinRetracePct: "e.g. 5",
      bottomSpotMinBaseFee: "e.g. 2.0",
      bottomSpotMinTvl: "e.g. 10000",
      bottomSpotMaxTvl: "e.g. 150000",
      bottomSpotAthLookbackCandles: "e.g. 48",
      bottomSpotRsiExitThreshold: "e.g. 90",
      bottomSpotTakeProfitFeePct: "e.g. 5",
      bottomSpotMaxILPct: "e.g. 25",
    };
    const hint = examples[inputKey] ? ` (${examples[inputKey]})` : "";
    await sendMessage(`Enter new value for ${inputKey}\nCurrent: ${fmtSettingValue(currentVal)}${hint}\nSend "cancel" to abort. Use "null" to clear nullable fields.`);
    return;
  }
  if (action === "setkey") {
    _pendingInput = { mode: "setKey", menuMsgId: msg.messageId };
    await answerCallbackQuery(msg.callbackQueryId);
    await sendMessage([
      "Send config update as:",
      "key value",
      "",
      "Examples:",
      "deployAmountSol 0.5",
      "maxPositions 3",
      "blockedLaunchpads pump.fun,letsbonk.fun",
      "",
      'Send "cancel" to abort.',
    ].join("\n"));
    return;
  }
  if (action === "close") {
    await answerCallbackQuery(msg.callbackQueryId, "Closed");
    await editMessage("Settings menu closed.", msg.messageId);
    return;
  }
  if (action === "show") {
    await answerCallbackQuery(msg.callbackQueryId);
    await editMessageWithButtons(formatConfigSnapshot(), msg.messageId, [[settingButton("Back", "cfg:page:quick")]]);
    return;
  }
  if (action === "page") {
    const page = parts[2] || "quick";
    await answerCallbackQuery(msg.callbackQueryId);
    await showSettingsMenu({ messageId: msg.messageId, page });
    return;
  }

  const key = parts[2];
  let value;
  if (action === "toggle") {
    value = !Boolean(settingValue(key));
  } else if (action === "step") {
    const current = Number(settingValue(key));
    const delta = Number(parts[3]);
    if (!Number.isFinite(current) || !Number.isFinite(delta)) {
      await answerCallbackQuery(msg.callbackQueryId, "Invalid setting");
      return;
    }
    value = sanitizeMenuValue(key, Number((current + delta).toFixed(4)));
  } else if (action === "set") {
    value = sanitizeMenuValue(key, normalizeMenuValue(key, parts.slice(3).join(":")));
  } else {
    await answerCallbackQuery(msg.callbackQueryId, "Unknown action");
    return;
  }

  const result = await executeTool("update_config", {
    changes: { [key]: value },
    reason: "Telegram settings menu",
  });
  if (!result?.success) {
    await answerCallbackQuery(msg.callbackQueryId, `Config update failed: ${(result?.unknown || [key]).join(", ")}`);
    return;
  }
  const page = resolveSettingPage(key);
  await answerCallbackQuery(msg.callbackQueryId, `Updated ${key}`);
  await showSettingsMenu({ messageId: msg.messageId, page });
  const appliedText = formatAppliedConfig(result.applied);
  if (appliedText) await sendMessage(`Updated config:\n${appliedText}`).catch(() => {});
}

function formatHelpText() {
  return [
    "Telegram commands",
    "",
    "/help — show commands",
    "/status — wallet + positions snapshot",
    "/wallet — wallet and deploy amount",
    "/positions — list open positions",
    "/pool <n> — detailed info for one open position",
    "/close <n> — close one position by index",
    "/closeall — close all open positions",
    "/set <n> <note> — set note/instruction on position",
    "/config — show important runtime config",
    "/menu — button menu to edit config",
    "/settings — same as /menu",
    "/setcfg <key> <value> — update persisted config",
    "/screen — refresh deterministic candidate list",
    "/candidates — show latest cached candidates",
    "/deploy <n> — deploy candidate by cached index",
    "/briefing — morning briefing",
    "/pause — stop cron cycles",
    "/resume — start cron cycles again",
    "/stop — shut down agent",
  ].join("\n");
}

async function runDeterministicScreen(limit = 5) {
  const top = await getTopCandidates({ limit });
  const candidates = (top?.candidates || top?.pools || []).slice(0, limit);
  setLatestCandidates(candidates);
  if (candidates.length > 0) {
    const lines = candidates.map((pool, i) => {
      const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
      const vol = pool.volume_window ?? pool.volume_24h ?? "?";
      const source = pool.gmgn ? ` | GMGN smart ${pool.gmgn_smart_wallets ?? "?"}, KOL ${pool.gmgn_kol_wallets ?? "?"}, total fee ${pool.gmgn_total_fee_sol ?? "?"} SOL` : ` | organic ${pool.organic_score ?? "?"}`;
      return `${i + 1}. ${pool.name} | ${pool.pool}\n   fee/aTVL ${feeTvl}% | vol $${vol}${source}`;
    });
    return `Top candidates (${candidates.length})\n\n${lines.join("\n")}`;
  }
  const examples = (top?.filtered_examples || []).slice(0, 3)
    .map((entry) => `- ${entry.name}: ${entry.reason}`)
    .join("\n");
  return examples
    ? `No candidates available.\nFiltered examples:\n${examples}`
    : "No candidates available right now.";
}

async function deployLatestCandidate(index) {
  const candidate = _latestCandidates[index];
  if (!candidate) {
    throw new Error("Invalid candidate index. Run /screen first.");
  }
  const deployAmount = computeDeployAmount((await getWalletBalances()).sol);
  const binsBelow = computeBinsBelow(candidate.volatility);
  const result = await executeTool("deploy_position", {
    pool_address: candidate.pool,
    amount_y: deployAmount,
    strategy: config.strategy.strategy,
    bins_below: binsBelow,
    bins_above: 0,
    pool_name: candidate.name,
    base_mint: candidate.base?.mint || candidate.base_mint || null,
    bin_step: candidate.bin_step,
    base_fee: candidate.base_fee,
    volatility: candidate.volatility,
    fee_tvl_ratio: candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio,
    organic_score: candidate.organic_score,
    initial_value_usd: candidate.tvl ?? candidate.active_tvl ?? null,
    price_5m_change: candidate.price_5m_change ?? candidate.price_change_pct,
    price_1h_change: candidate.price_1h_change,
    fee_change_pct: candidate.fee_change_pct,
    volume_change_pct: candidate.volume_change_pct,
    price_trend: candidate.price_trend,
    fees_paid_sol: candidate.fees_paid_sol ?? candidate.global_fees_sol ?? candidate.token_info?.global_fees_sol,
  });
  if (result?.success === false || result?.error) {
    throw new Error(result.error || "Deploy failed");
  }
  return { result, candidate, deployAmount, binsBelow };
}

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

function refreshPrompt() {
  if (!_ttyInterface) return;
  _ttyInterface.setPrompt(buildPrompt());
  _ttyInterface.prompt(true);
}

async function drainTelegramQueue() {
  while (_telegramQueue.length > 0 && !_managementBusy && !_screeningBusy && !busy) {
    const queued = _telegramQueue.shift();
    await telegramHandler(queued);
  }
}

async function telegramHandler(msg) {
  const text = msg?.text?.trim();
  if (!text) return;

  if (_pendingInput && !msg.isCallback && !text.startsWith("/")) {
    if (/^cancel$/i.test(text)) {
      const { page = "quick", menuMsgId } = _pendingInput;
      _pendingInput = null;
      await sendMessage("Config edit cancelled.").catch(() => {});
      if (menuMsgId) await showSettingsMenu({ messageId: menuMsgId, page }).catch(() => {});
      return;
    }

    const pending = _pendingInput;
    _pendingInput = null;

    let key = pending.key;
    let page = pending.page || "quick";
    const menuMsgId = pending.menuMsgId;
    let rawValue = text;

    if (pending.mode === "setKey") {
      const match = text.match(/^([A-Za-z0-9_]+)(?:\s+|=)([\s\S]+)$/);
      if (!match) {
        await sendMessage('Invalid format. Send "key value", for example: deployAmountSol 0.5').catch(() => {});
        _pendingInput = pending;
        return;
      }
      key = match[1];
      rawValue = match[2].trim();
      page = resolveSettingPage(key);
    }

    let value;
    try {
      if (rawValue.toLowerCase() === "null") {
        value = null;
      } else {
        value = sanitizeMenuValue(key, normalizeMenuValue(key, rawValue));
      }
    } catch (e) {
      await sendMessage(`Invalid value for ${key}: ${e.message}`).catch(() => {});
      _pendingInput = pending;
      return;
    }

    const result = await executeTool("update_config", { changes: { [key]: value }, reason: "Telegram settings menu input" });
    if (!result?.success) {
      await sendMessage(`Failed to update ${key}.\nUnknown: ${(result?.unknown || []).join(", ") || "none"}`).catch(() => {});
      return;
    }
    const appliedText = formatAppliedConfig(result.applied);
    await sendMessage(`Updated config:\n${appliedText || `${key} = ${fmtSettingValue(value)}`}`).catch(() => {});
    if (menuMsgId) await showSettingsMenu({ messageId: menuMsgId, page }).catch(() => {});
    return;
  }
  if (msg?.isCallback && text.startsWith("cfg:")) {
    try {
      await applySettingsMenuCallback(msg);
    } catch (e) {
      await answerCallbackQuery(msg.callbackQueryId, e.message).catch(() => {});
    }
    return;
  }
  if (text === "/settings" || text === "/menu" || text === "/configmenu") {
    await showSettingsMenu().catch((e) => sendMessage(`Settings error: ${e.message}`).catch(() => {}));
    return;
  }
  if (_managementBusy || _screeningBusy || busy) {
    if (_telegramQueue.length < 5) {
      _telegramQueue.push(msg);
      sendMessage(`⏳ Queued (${_telegramQueue.length} in queue): "${text.slice(0, 60)}"`).catch(() => {});
    } else {
      sendMessage("Queue is full (5 messages). Wait for the agent to finish.").catch(() => {});
    }
    return;
  }

  if (text === "/briefing") {
    try {
      const briefing = await generateBriefing();
      await sendHTML(briefing);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/help") {
    await sendMessage(formatHelpText()).catch(() => {});
    return;
  }

  if (text === "/wallet" || text === "/status") {
    try {
      const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
      const suffix = text === "/status" && positions.total_positions
        ? `\n\nUse /positions for the numbered list.`
        : "";
      await sendMessage(`${formatWalletStatus(wallet, positions)}${suffix}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/config") {
    await sendMessage(formatConfigSnapshot()).catch(() => {});
    return;
  }

  if (text === "/positions") {
    try {
      const { positions, total_positions } = await getMyPositions({ force: true });
      if (total_positions === 0) { await sendMessage("No open positions."); return; }
      const cur = config.management.solMode ? "◎" : "$";
      const lines = positions.map((p, i) => {
        const pnl = p.pnl_usd >= 0 ? `+${cur}${p.pnl_usd}` : `-${cur}${Math.abs(p.pnl_usd)}`;
        const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
        const oor = !p.in_range ? " ⚠️OOR" : "";
        return `${i + 1}. ${p.pair} | ${cur}${p.total_value_usd} | PnL: ${pnl} | fees: ${cur}${p.unclaimed_fees_usd} | ${age}${oor}`;
      });
      await sendMessage(`📊 Open Positions (${total_positions}):\n\n${lines.join("\n")}\n\n/close <n> to close | /set <n> <note> to set instruction`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const poolMatch = text.match(/^\/pool\s+(\d+)$/i);
  if (poolMatch) {
    try {
      const idx = parseInt(poolMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage([
        `${idx + 1}. ${pos.pair}`,
        `Pool: ${pos.pool}`,
        `Position: ${pos.position}`,
        `Range: ${pos.lower_bin} → ${pos.upper_bin} | active ${pos.active_bin}`,
        `PnL: ${pos.pnl_pct ?? "?"}% | fees: ${config.management.solMode ? "◎" : "$"}${pos.unclaimed_fees_usd ?? "?"}`,
        `Value: ${config.management.solMode ? "◎" : "$"}${pos.total_value_usd ?? "?"}`,
        `Age: ${pos.age_minutes ?? "?"}m | ${pos.in_range ? "IN RANGE" : `OOR ${pos.minutes_out_of_range ?? 0}m`}`,
        pos.instruction ? `Note: ${pos.instruction}` : null,
      ].filter(Boolean).join("\n"));
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  // /close [symbol|n|all] — always direct, never LLM
  if (/^\/close(\s+.*)?$/i.test(text.trim())) {
    try {
      const { positions } = await getMyPositions({ force: true });
      if (!positions.length) { await sendMessage("No open positions."); return; }

      const arg = text.trim().replace(/^\/close\s*/i, "").trim().toLowerCase();

      // /close or /close all → close all
      if (!arg || arg === "all") {
        await sendMessage(`Closing ${positions.length} position(s)...`);
        for (const pos of positions) {
          const result = await executeTool("close_position", {
            position_address: pos.position,
            reason: "manual telegram /close all"
          });
          await sendMessage(result?.success
            ? `✅ ${pos.pair} closed${result.auto_swapped ? " & swapped to SOL" : ""}`
            : `❌ ${pos.pair} failed: ${result?.error || "unknown"}`);
        }
        return;
      }

      // /close <n> → by index
      const byIndex = parseInt(arg);
      if (!isNaN(byIndex)) {
        const pos = positions[byIndex - 1];
        if (!pos) { await sendMessage(`Invalid number. ${positions.length} position(s) open.`); return; }
        await sendMessage(`Closing ${pos.pair}...`);
        const result = await executeTool("close_position", {
          position_address: pos.position,
          reason: "manual telegram /close"
        });
        await sendMessage(result?.success
          ? `✅ ${pos.pair} closed${result.auto_swapped ? " & swapped to SOL" : ""}`
          : `❌ Failed: ${result?.error || "unknown"}`);
        return;
      }

      // /close <symbol> → match by name e.g. /close AGI
      const matched = positions.filter(p =>
        p.pair?.toLowerCase().includes(arg) ||
        p.base_symbol?.toLowerCase().includes(arg)
      );
      if (matched.length === 0) {
        const list = positions.map((p, i) => `${i+1}. ${p.pair}`).join("\n");
        await sendMessage(`No position matching "${arg}".\nOpen:\n${list}`);
        return;
      }
      if (matched.length > 1) {
        const list = matched.map((p, i) => `${i+1}. ${p.pair}`).join("\n");
        await sendMessage(`Multiple matches for "${arg}":\n${list}\nUse /close <n>.`);
        return;
      }
      const pos = matched[0];
      await sendMessage(`Closing ${pos.pair}...`);
      const result = await executeTool("close_position", {
        position_address: pos.position,
        reason: "manual telegram /close"
      });
      await sendMessage(result?.success
        ? `✅ ${pos.pair} closed${result.auto_swapped ? " & swapped to SOL" : ""}`
        : `❌ Failed: ${result?.error || "unknown"}`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/closeall") {
    try {
      const { positions } = await getMyPositions({ force: true });
      if (!positions.length) { await sendMessage("No open positions."); return; }
      await sendMessage(`Closing ${positions.length} position(s)...`);
      const results = [];
      for (const pos of positions) {
        try {
          const result = await executeTool("close_position", {
            position_address: pos.position,
            reason: "manual telegram /closeall"
          });
          results.push(`${pos.pair}: ${result?.success ? `closed${result.auto_swapped ? "+swap" : ""}` : `failed (${result?.error || "unknown"})`}`);
        } catch (error) {
          results.push(`${pos.pair}: failed (${error.message})`);
        }
      }
      await sendMessage(`Close-all finished.\n\n${results.join("\n")}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const idx = parseInt(setMatch[1]) - 1;
      const note = setMatch[2].trim();
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      setPositionInstruction(pos.position, note);
      await sendMessage(`✅ Note set for ${pos.pair}:\n"${note}"`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const setCfgMatch = text.match(/^\/setcfg\s+([A-Za-z0-9_]+)\s+(.+)$/i);
  if (setCfgMatch) {
    try {
      const key = setCfgMatch[1];
      const value = parseConfigValue(setCfgMatch[2]);
      const result = await executeTool("update_config", {
        changes: { [key]: value },
        reason: "Telegram slash command /setcfg",
      });
      if (!result?.success) {
        await sendMessage(`Config update failed.\nUnknown: ${(result?.unknown || []).join(", ") || "none"}`).catch(() => {});
        return;
      }
      await sendMessage(`✅ Updated ${key} = ${JSON.stringify(value)}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/screen") {
    try {
      await sendMessage(await runDeterministicScreen(5)).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/candidates") {
    await sendMessage(describeLatestCandidates(5)).catch(() => {});
    return;
  }

  const deployMatch = text.match(/^\/deploy\s+(\d+)$/i);
  if (deployMatch) {
    try {
      const idx = parseInt(deployMatch[1]) - 1;
      const { candidate, result, deployAmount, binsBelow } = await deployLatestCandidate(idx);
      const coverage = result.range_coverage
        ? `Range: ${fmtPct(result.range_coverage.downside_pct)} downside | ${fmtPct(result.range_coverage.upside_pct)} upside`
        : `Strategy: ${config.strategy.strategy} | binsBelow: ${binsBelow}`;
      await sendMessage([
        `✅ Deployed ${candidate.name}`,
        `Pool: ${candidate.pool}`,
        `Amount: ${deployAmount} SOL`,
        coverage,
        `Position: ${result.position || "n/a"}`,
        result.txs?.length ? `Tx: ${result.txs[0]}` : null,
      ].filter(Boolean).join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/pause") {
    stopCronJobs();
    cronStarted = false;
    await sendMessage("⏸ Paused autonomous cycles. Telegram control still works. Use /resume to start again.").catch(() => {});
    return;
  }

  if (text === "/resume") {
    if (!cronStarted) {
      cronStarted = true;
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      await sendMessage("▶️ Autonomous cycles resumed.").catch(() => {});
    } else {
      await sendMessage("Autonomous cycles are already running.").catch(() => {});
    }
    return;
  }

  if (text === "/hive" || text === "/hive pull") {
    await sendMessage("HiveMind has been retired in this build.").catch(() => {});
    return;
  }

  busy = true;
  let liveMessage = null;
  try {
    log("telegram", `Incoming: ${text}`);
    const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
    const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
    const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
    const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
    liveMessage = await createLiveMessage("🤖 Live Update", `Request: ${text.slice(0, 240)}`);
    const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, agentModel, null, {
      interactive: true,
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    appendHistory(text, content);
    if (liveMessage) await liveMessage.finalize(stripThink(content));
    else await sendMessage(stripThink(content));
  } catch (e) {
    if (liveMessage) await liveMessage.fail(e.message).catch(() => {});
    else await sendMessage(`Error: ${e.message}`).catch(() => {});
  } finally {
    busy = false;
    refreshPrompt();
    drainTelegramQueue().catch(() => {});
  }
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });
  _ttyInterface = rl;

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      // Seed timers so countdown starts from now
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }),
      getTopCandidates({ limit: 5 }),
    ]);

    setLatestCandidates(candidates);

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch(() => { });

  startPolling(telegramHandler);

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
  /briefing      Show morning briefing (last 24h)
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    const latest = getLatestCandidatesMeta().candidates;
    if (!isNaN(pick) && pick >= 1 && pick <= latest.length) {
      await runBusy(async () => {
        const pool = latest[pick - 1];
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates, pick the best one, get_active_bin, deploy_position with ${DEPLOY} SOL. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${config.management.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getTopCandidates({ limit: 5 });
        setLatestCandidates(candidates);
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBundlePct:         ${s.maxBundlePct}`);
      console.log(`  maxBotHoldersPct:     ${s.maxBotHoldersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel, null, { interactive: true });
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => { });
  startPolling(telegramHandler);
  (async () => {
    try {
      const startupStep3 = process.env.DRY_RUN === "true"
        ? `3. Ignore wallet SOL threshold in dry run: get_top_candidates then simulate deploy ${DEPLOY} SOL.`
        : `3. If SOL >= ${config.management.minSolToOpen}: get_top_candidates then deploy ${DEPLOY} SOL.`;
      await agentLoop(`
STARTUP CHECK
1. get_wallet_balance. 2. get_my_positions. ${startupStep3} 4. Report.
      `, config.llm.maxSteps, [], "SCREENER");
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
