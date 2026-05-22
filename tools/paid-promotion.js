import { config } from "../config.js";
import { log } from "../logger.js";
import { addToBlacklist } from "../token-blacklist.js";
import { setPaidPromotionCooldown } from "../pool-memory.js";
import { fetchDexScreenerBoosts } from "./dexscreener.js";
import { fetchGmgnPaidPromotionSignal } from "./gmgn.js";
import { getTokenInfo, getTokenNarrative } from "./token.js";

const NARRATIVE_PROMOTION_RE = /\b(paid|kol|promotion|promoted|shill|shilled|dspaid|ds\s*paid)\b/i;

function percentOrNull(value) {
  if (value == null) return null;
  const n = Number(String(value).replace("%", ""));
  return Number.isFinite(n) ? n : null;
}

function exactTokenFromInfo(info, mint) {
  if (!info) return null;
  if (info.mint) return info;
  const results = Array.isArray(info.results) ? info.results : [];
  return results.find((token) => token?.mint === mint) || results[0] || null;
}

function promotionTextMatched(text) {
  return typeof text === "string" && NARRATIVE_PROMOTION_RE.test(text);
}

function addSignal(signals, source, detail, { blacklist = false } = {}) {
  signals.push({ source, detail, blacklist });
}

export async function evaluatePaidPromotionRisk({
  poolAddress,
  baseMint,
  symbol,
  name,
  dexBoosts = undefined,
  tokenInfo = null,
  narrative = undefined,
  blacklist = true,
  cooldown = true,
} = {}) {
  if (config.screening.paidPromotionBlockEnabled === false) {
    return { enabled: false, blocked: false, signals: [] };
  }
  if (!baseMint) {
    return { enabled: true, blocked: false, signals: [], reason: "missing base mint" };
  }

  const signals = [];
  const maxDexBoosts = config.screening.maxDexBoosts == null
    ? null
    : Number(config.screening.maxDexBoosts);

  let resolvedDexBoosts = dexBoosts;
  if (resolvedDexBoosts === undefined) {
    resolvedDexBoosts = await fetchDexScreenerBoosts(baseMint).catch(() => null);
  }
  const dexBoostCount = Number(resolvedDexBoosts);
  if (Number.isFinite(dexBoostCount) && maxDexBoosts != null && Number.isFinite(maxDexBoosts) && dexBoostCount > maxDexBoosts) {
    addSignal(signals, "dexscreener", `boosts ${dexBoostCount} > max ${maxDexBoosts}`);
  }

  let resolvedToken = exactTokenFromInfo(tokenInfo, baseMint);

  if (config.gmgn?.apiKey) {
    const gmgnSignal = await fetchGmgnPaidPromotionSignal(baseMint).catch(() => null);
    if (gmgnSignal?.detected) {
      addSignal(signals, "gmgn", gmgnSignal.reason, { blacklist: true });
    }
  }

  let resolvedNarrative = narrative;
  if (resolvedNarrative === undefined) {
    const narrativeData = await getTokenNarrative({ mint: baseMint }).catch(() => null);
    resolvedNarrative = narrativeData?.narrative ?? null;
  }
  if (promotionTextMatched(resolvedNarrative)) {
    addSignal(signals, "narrative", "Jupiter ChainInsight narrative mentions paid/KOL/promotion/shill");
  }

  if (!resolvedToken && signals.length > 0) {
    const info = await getTokenInfo({ query: baseMint }).catch(() => null);
    resolvedToken = exactTokenFromInfo(info, baseMint);
  }

  const botPct = percentOrNull(resolvedToken?.audit?.bot_holders_pct);
  const botComboBlock = botPct != null && botPct > 15 && signals.length > 0;
  const shouldBlacklist = signals.some((signal) => signal.blacklist) || botComboBlock;
  const blocked = signals.length > 0;

  if (!blocked) {
    return {
      enabled: true,
      blocked: false,
      signals,
      bot_holders_pct: botPct,
      dex_boosts: Number.isFinite(dexBoostCount) ? dexBoostCount : null,
    };
  }

  const reason = botComboBlock
    ? `paid promotion risk with bot holders ${botPct}% > 15%: ${signals.map((s) => s.detail).join("; ")}`
    : `paid promotion risk: ${signals.map((s) => s.detail).join("; ")}`;

  let blacklistResult = null;
  if (blacklist && shouldBlacklist) {
    blacklistResult = addToBlacklist({
      mint: baseMint,
      symbol: symbol || resolvedToken?.symbol || "UNKNOWN",
      reason,
    });
  }

  let cooldownUntil = null;
  if (cooldown) {
    cooldownUntil = setPaidPromotionCooldown(
      poolAddress,
      baseMint,
      name || resolvedToken?.name || symbol || baseMint.slice(0, 8),
    );
  }

  log("paid_promotion", `Blocked ${symbol || baseMint.slice(0, 8)}: ${reason}`);
  return {
    enabled: true,
    blocked: true,
    reason,
    signals,
    bot_holders_pct: botPct,
    dex_boosts: Number.isFinite(dexBoostCount) ? dexBoostCount : null,
    blacklisted: !!blacklistResult?.blacklisted || !!blacklistResult?.already_blacklisted,
    cooldown_until: cooldownUntil,
  };
}
