import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked, getBlockedDevs } from "../dev-blocklist.js";
import { log } from "../logger.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { isTokenWaveBlocked } from "../state.js";
import { confirmEntrySupertrendBreak } from "./chart-indicators.js";
import { discoverGmgnPools, fetchGmgnPriceAction, fetchGmgnTokenFees } from "./gmgn.js";
import { fetchDexScreenerBoosts } from "./dexscreener.js";
import { evaluatePaidPromotionRisk } from "./paid-promotion.js";

const DATAPI_JUP = "https://datapi.jup.ag/v1";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = {
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};
const PVP_SHORTLIST_LIMIT = 2;
const PVP_RIVAL_LIMIT = 2;
const PVP_MIN_ACTIVE_TVL = 5_000;
const PVP_MIN_HOLDERS = 500;
const PVP_MIN_GLOBAL_FEES_SOL = 30;

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function scoreCandidate(pool) {
  if (Number.isFinite(Number(pool.gmgn_score))) {
    return Number(pool.gmgn_score) + Number(pool.fee_active_tvl_ratio || 0) * 500;
  }
  const feeTvl = Number(pool.fee_active_tvl_ratio || 0);
  const organic = Number(pool.organic_score || 0);
  const volume = Number(pool.volume_window || 0);
  const holders = Number(pool.holders || 0);
  return feeTvl * 1000 + organic * 10 + volume / 100 + holders / 100;
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isUsableVolatility(value) {
  const n = numeric(value);
  return n != null && n > 0;
}

function getPoolShortChange(pool) {
  return numeric(pool?.price_5m_change ?? pool?.price_change_pct ?? pool?.pool_price_change_pct);
}

function getPoolOneHourChange(pool) {
  return numeric(
    pool?.price_1h_change ??
    pool?.gmgn_price_action?.priceChangePct ??
    pool?.gmgn_price_action?.price_1h_change,
  );
}

function getPoolSixHourChange(pool) {
  return numeric(pool?.price_6h_change ?? pool?.gmgn_price_action?.price_6h_change);
}

function getPoolTwentyFourHourChange(pool) {
  return numeric(pool?.price_24h_change ?? pool?.gmgn_price_action?.price_24h_change);
}

export function evaluateSingleSideSolEntry(pool, options = {}) {
  if (config.screening.singleSideSolEntryGateEnabled === false) {
    return { pass: true, reason: "single-side SOL entry gate disabled" };
  }

  const price1h = getPoolOneHourChange(pool);
  const price5m = getPoolShortChange(pool);
  const price6h = getPoolSixHourChange(pool);
  const price24h = getPoolTwentyFourHourChange(pool);
  const feeTvl = numeric(pool?.fee_active_tvl_ratio);
  const feeChange = numeric(pool?.fee_change_pct);
  const volumeChange = numeric(pool?.volume_change_pct);
  const trend = String(pool?.price_trend || "").toLowerCase();
  const isGmgn = !!pool?.gmgn;

  const min1h = numeric(options.min1hChange ?? config.screening.singleSideSolMin1hChange) ?? 0;
  const minRetest1h = numeric(options.minRetest1hChange ?? config.screening.singleSideSolMinRetest1hChange) ?? -7;
  const maxRetest1h = numeric(options.maxRetest1hChange ?? config.screening.singleSideSolMaxRetest1hChange) ?? 6;
  const max5mPullback = numeric(options.max5mPullback ?? config.screening.singleSideSolMax5mPullback) ?? -2;
  const weakTrendMax1h = numeric(options.weakTrendMax1h ?? config.screening.singleSideSolWeakTrendMax1h) ?? 3;
  const maxWeakBounce5m = numeric(options.maxWeakBounce5m ?? config.screening.singleSideSolMaxWeakBounce5m) ?? 8;
  const minWeakFeeTvl = numeric(options.minWeakFeeTvl ?? config.screening.singleSideSolMinFeeActiveTvlRatio) ?? 0.3;

  const isSmartWalletRetest =
    price24h != null &&
    price6h != null &&
    price1h != null &&
    price24h < 0 &&
    price6h > 0 &&
    price1h >= minRetest1h &&
    price1h <= maxRetest1h &&
    price5m > 0 &&
    price5m <= maxWeakBounce5m;

  if (price1h == null && !isGmgn) {
    return { pass: false, reason: "single-side SOL timing reject: missing 1h price change" };
  }
  if (price5m == null) {
    return { pass: false, reason: "single-side SOL timing reject: missing short-term price change" };
  }
  if (price1h != null && !isSmartWalletRetest && price1h < min1h) {
    return { pass: false, reason: `single-side SOL timing reject: 1h ${price1h}% < ${min1h}% (no reclaim yet)` };
  }
  if (price1h != null && !isSmartWalletRetest && price1h > maxRetest1h && price5m > 0) {
    return { pass: false, reason: `single-side SOL timing reject: 1h ${price1h}% > ${maxRetest1h}% with green short-term price (too extended for support retest)` };
  }
  if (price5m < max5mPullback) {
    return { pass: false, reason: `single-side SOL timing reject: short-term ${price5m}% < ${max5mPullback}% (still falling)` };
  }
  if (price5m > maxWeakBounce5m) {
    return { pass: false, reason: `single-side SOL timing reject: short-term ${price5m}% > ${maxWeakBounce5m}% (chasing pump, wait for support retest)` };
  }
  if (
    !isSmartWalletRetest &&
    price24h != null &&
    price6h != null &&
    price24h < 0 &&
    price6h <= 0 &&
    price1h != null &&
    price1h >= min1h &&
    price5m > 0
  ) {
    return { pass: false, reason: `single-side SOL timing reject: 24h red but 6h ${price6h}% has not reclaimed` };
  }
  if (price1h != null && price1h < weakTrendMax1h && price5m > maxWeakBounce5m) {
    return { pass: false, reason: `single-side SOL timing reject: weak 1h ${price1h}% with hot bounce ${price5m}% (dead-cat/lower-high risk)` };
  }
  if (price1h != null && price1h < weakTrendMax1h && price5m <= 0) {
    return { pass: false, reason: `single-side SOL timing reject: weak 1h ${price1h}% and short-term ${price5m}% not positive` };
  }
  if (price1h != null && trend.includes("down") && price1h < weakTrendMax1h) {
    return { pass: false, reason: `single-side SOL timing reject: price trend ${trend} with weak 1h ${price1h}%` };
  }
  if (
    (price1h == null || price1h <= weakTrendMax1h) &&
    price5m <= 1 &&
    feeTvl != null &&
    feeTvl < minWeakFeeTvl
  ) {
    return { pass: false, reason: `single-side SOL timing reject: weak trend with fee/TVL ${feeTvl} < ${minWeakFeeTvl}` };
  }
  if ((price1h == null || price1h <= weakTrendMax1h) && price5m <= 1 && feeChange != null && feeChange < -20) {
    return { pass: false, reason: `single-side SOL timing reject: weak trend and fees fading ${feeChange}%` };
  }
  if ((price1h == null || price1h <= weakTrendMax1h) && price5m <= 1 && volumeChange != null && volumeChange < -30) {
    return { pass: false, reason: `single-side SOL timing reject: weak trend and volume fading ${volumeChange}%` };
  }

  return {
    pass: true,
    reason: isSmartWalletRetest
      ? `single-side SOL timing ok: smart-wallet retest 24h=${price24h}%, 6h=${price6h}%, 1h=${price1h}%, short=${price5m}%`
      : `single-side SOL timing ok: 1h=${price1h ?? "n/a"}%, short=${price5m}%`,
    price_1h_change: price1h,
    price_6h_change: price6h,
    price_24h_change: price24h,
    price_5m_change: price5m,
  };
}

function includesCaseInsensitive(values, value) {
  if (!Array.isArray(values) || values.length === 0 || !value) return false;
  const needle = String(value).toLowerCase();
  return values.some((entry) => String(entry).toLowerCase() === needle);
}

function getPoolLaunchpad(pool) {
  const base = pool?.token_x || {};
  return base?.launchpad ||
    base?.launchpad_platform ||
    pool?.base_token_launchpad ||
    pool?.launchpad ||
    pool?.launchpad_platform ||
    null;
}

function getPoolBaseMint(pool) {
  return pool?.token_x?.address ||
    pool?.base_token_address ||
    pool?.base_mint ||
    pool?.base?.mint ||
    null;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

function getRawPoolScreeningRejectReason(pool, s) {
  const base = pool?.token_x || {};
  const quote = pool?.token_y || {};
  const binStep = numeric(pool?.dlmm_params?.bin_step);
  const tvl = numeric(pool?.tvl ?? pool?.active_tvl);
  const feeActiveTvlRatio = numeric(pool?.fee_active_tvl_ratio);
  const volatility = numeric(pool?.volatility);
  const volume = numeric(pool?.volume);
  const holders = numeric(pool?.base_token_holders);
  const mcap = numeric(base?.market_cap);
  const baseOrganic = numeric(base?.organic_score);
  const quoteOrganic = numeric(quote?.organic_score);
  const launchpad = getPoolLaunchpad(pool);
  const createdAt = numeric(base?.created_at);

  if (s.excludeHighSupplyConcentration && pool?.base_token_has_high_supply_concentration === true) {
    return "base token has high supply concentration";
  }
  if (pool?.base_token_has_critical_warnings === true) return "base token has critical warnings";
  if (pool?.quote_token_has_critical_warnings === true) return "quote token has critical warnings";
  if (pool?.base_token_has_high_single_ownership === true) return "base token has high single ownership";
  if (pool?.pool_type && pool.pool_type !== "dlmm") return `pool_type ${pool.pool_type} is not dlmm`;

  if (mcap == null || mcap < s.minMcap) return `mcap ${mcap ?? "unknown"} below minMcap ${s.minMcap}`;
  if (mcap > s.maxMcap) return `mcap ${mcap} above maxMcap ${s.maxMcap}`;
  if (holders == null || holders < s.minHolders) return `holders ${holders ?? "unknown"} below minHolders ${s.minHolders}`;
  if (volume == null || volume < s.minVolume) return `volume ${volume ?? "unknown"} below minVolume ${s.minVolume}`;
  if (tvl == null || tvl < s.minTvl) return `TVL ${tvl ?? "unknown"} below minTvl ${s.minTvl}`;
  if (s.maxTvl != null && tvl > s.maxTvl) return `TVL ${tvl} above maxTvl ${s.maxTvl}`;
  if (binStep == null || binStep < s.minBinStep) return `bin_step ${binStep ?? "unknown"} below minBinStep ${s.minBinStep}`;
  if (binStep > s.maxBinStep) return `bin_step ${binStep} above maxBinStep ${s.maxBinStep}`;
  if (!isUsableVolatility(volatility)) return `volatility ${volatility ?? "unknown"} unusable`;
  if (feeActiveTvlRatio == null || feeActiveTvlRatio < s.minFeeActiveTvlRatio) {
    return `fee/active-TVL ${feeActiveTvlRatio ?? "unknown"} below minFeeActiveTvlRatio ${s.minFeeActiveTvlRatio}`;
  }
  if (baseOrganic == null || baseOrganic < s.minOrganic) {
    return `base organic ${baseOrganic ?? "unknown"} below minOrganic ${s.minOrganic}`;
  }
  if (quoteOrganic == null || quoteOrganic < s.minQuoteOrganic) {
    return `quote organic ${quoteOrganic ?? "unknown"} below minQuoteOrganic ${s.minQuoteOrganic}`;
  }
  if (
    pool?.discord_signal &&
    Array.isArray(s.allowedLaunchpads) &&
    s.allowedLaunchpads.length > 0 &&
    launchpad &&
    !includesCaseInsensitive(s.allowedLaunchpads, launchpad)
  ) {
    return `launchpad ${launchpad} not in allow-list`;
  }
  if (includesCaseInsensitive(s.blockedLaunchpads, launchpad)) {
    return `blocked launchpad (${launchpad})`;
  }
  if (s.minTokenAgeHours != null) {
    const maxCreatedAt = Date.now() - s.minTokenAgeHours * 3_600_000;
    if (createdAt == null || createdAt > maxCreatedAt) return `token age below minTokenAgeHours ${s.minTokenAgeHours}`;
  }
  if (s.maxTokenAgeHours != null) {
    const minCreatedAt = Date.now() - s.maxTokenAgeHours * 3_600_000;
    if (createdAt == null || createdAt < minCreatedAt) return `token age above maxTokenAgeHours ${s.maxTokenAgeHours}`;
  }
  return null;
}

async function fetchDiscordSignalCandidates() {
  if (!config.api.url) return [];
  const res = await fetch(`${config.api.url}/signals/discord/candidates`);
  if (!res.ok) throw new Error(`discord signal candidates ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.candidates) ? data.candidates : [];
}

async function fetchPoolDiscoveryPage({ page_size, filters, timeframe, category }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${timeframe}` +
    `&category=${category}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

async function fetchPoolDiscoveryDetail({ poolAddress, timeframe }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}` +
    `&timeframe=${timeframe}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return (data.data || [])[0] ?? null;
}

async function applyVolatilityTimeframe(rawPools, sourceTimeframe) {
  if (!Array.isArray(rawPools) || rawPools.length === 0) return rawPools;
  const volatilityTimeframe = getVolatilityTimeframe(sourceTimeframe);
  if (sourceTimeframe === volatilityTimeframe) {
    for (const pool of rawPools) {
      if (pool) pool.volatility_timeframe = volatilityTimeframe;
    }
    return rawPools;
  }

  const uniquePoolAddresses = [...new Set(rawPools.map((pool) => pool?.pool_address).filter(Boolean))];
  const volatilityResults = await Promise.allSettled(
    uniquePoolAddresses.map((poolAddress) =>
      fetchPoolDiscoveryDetail({ poolAddress, timeframe: volatilityTimeframe })
        .then((pool) => ({ poolAddress, volatility: numeric(pool?.volatility) }))
    )
  );

  const volatilityByPool = new Map();
  for (const result of volatilityResults) {
    if (result.status !== "fulfilled") continue;
    if (result.value.volatility == null) continue;
    volatilityByPool.set(result.value.poolAddress, result.value.volatility);
  }

  for (const pool of rawPools) {
    if (!pool?.pool_address || !volatilityByPool.has(pool.pool_address)) continue;
    pool.volatility = volatilityByPool.get(pool.pool_address);
    pool.volatility_timeframe = volatilityTimeframe;
  }

  return rawPools;
}

async function searchAssetsBySymbol(symbol) {
  const res = await fetch(`${DATAPI_JUP}/assets/search?query=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`assets/search ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [data];
}

async function enrichDiscordSignalLaunchpads(rawPools) {
  const missing = rawPools.filter((pool) =>
    pool?.discord_signal &&
    !getPoolLaunchpad(pool) &&
    getPoolBaseMint(pool)
  );
  if (missing.length === 0) return;

  const uniqueMints = [...new Set(missing.map(getPoolBaseMint).filter(Boolean))];
  const results = await Promise.allSettled(
    uniqueMints.map(async (mint) => {
      const assets = await searchAssetsBySymbol(mint);
      const asset = assets.find((item) => item?.id === mint) || assets[0] || null;
      return { mint, asset };
    })
  );

  const byMint = new Map();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const launchpad = result.value.asset?.launchpad || result.value.asset?.launchpadPlatform || null;
    if (!launchpad) continue;
    byMint.set(result.value.mint, {
      launchpad,
      dev: result.value.asset?.dev || null,
      holderCount: numeric(result.value.asset?.holderCount),
      organicScore: numeric(result.value.asset?.organicScore),
      marketCap: numeric(result.value.asset?.mcap ?? result.value.asset?.fdv),
      createdAt: result.value.asset?.createdAt ? Date.parse(result.value.asset.createdAt) : null,
    });
  }

  for (const pool of missing) {
    const mint = getPoolBaseMint(pool);
    const asset = byMint.get(mint);
    if (!asset) continue;
    pool.token_x ||= {};
    pool.token_x.launchpad = asset.launchpad;
    pool.base_token_launchpad = asset.launchpad;
    if (asset.dev && !pool.token_x.dev) pool.token_x.dev = asset.dev;
    if (asset.holderCount != null && pool.base_token_holders == null) pool.base_token_holders = asset.holderCount;
    if (asset.organicScore != null && pool.token_x.organic_score == null) pool.token_x.organic_score = asset.organicScore;
    if (asset.marketCap != null && pool.token_x.market_cap == null) pool.token_x.market_cap = asset.marketCap;
    if (asset.createdAt != null && pool.token_x.created_at == null) pool.token_x.created_at = asset.createdAt;
    log("screening", `Discord signal launchpad enriched from Jupiter: ${pool.name || mint} — ${asset.launchpad}`);
  }
}

async function findRivalPool(mint) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent("tvl:desc")}&filter_by=${encodeURIComponent(`tvl>${PVP_MIN_ACTIVE_TVL}`)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`rival pool search ${res.status}`);
  const data = await res.json();
  const pools = Array.isArray(data?.data) ? data.data : [];
  return pools.find((pool) => pool?.token_x?.address === mint || pool?.token_y?.address === mint) || null;
}

async function enrichPvpRisk(pools) {
  const shortlist = [...pools]
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, PVP_SHORTLIST_LIMIT);

  if (shortlist.length === 0) return;

  const symbolCache = new Map();

  await Promise.all(shortlist.map(async (pool) => {
    const symbol = normalizeSymbol(pool.base?.symbol);
    const ownMint = pool.base?.mint;
    if (!symbol || !ownMint) return;

    let assets = symbolCache.get(symbol);
    if (!assets) {
      assets = await searchAssetsBySymbol(symbol).catch(() => []);
      symbolCache.set(symbol, assets);
    }

    const rivalAssets = assets
      .filter((asset) => normalizeSymbol(asset?.symbol) === symbol && asset?.id && asset.id !== ownMint)
      .sort((a, b) => Number(b?.liquidity || 0) - Number(a?.liquidity || 0))
      .slice(0, PVP_RIVAL_LIMIT);

    for (const rival of rivalAssets) {
      const rivalHolders = Number(rival?.holderCount || 0);
      const rivalFees = Number(rival?.fees || 0);
      if (rivalHolders < PVP_MIN_HOLDERS || rivalFees < PVP_MIN_GLOBAL_FEES_SOL) continue;

      const rivalPool = await findRivalPool(rival.id).catch(() => null);
      if (!rivalPool) continue;

      pool.is_pvp = true;
      pool.pvp_risk = "high";
      pool.pvp_symbol = pool.base?.symbol || symbol;
      pool.pvp_rival_name = rival?.name || pool.pvp_symbol;
      pool.pvp_rival_mint = rival.id;
      pool.pvp_rival_pool = rivalPool.address;
      pool.pvp_rival_tvl = round(Number(rivalPool.tvl || 0));
      pool.pvp_rival_holders = rivalHolders;
      pool.pvp_rival_fees = Number(rivalFees.toFixed(2));
      log("screening", `PVP guard: ${pool.name} has active rival ${pool.pvp_rival_name} (${rival.id.slice(0, 8)})`);
      break;
    }
  }));
}

async function enrichGmgnPriceActionForPools(pools) {
  const candidates = (Array.isArray(pools) ? pools : [])
    .filter((pool) => pool?.base?.mint)
    .slice(0, 30);
  if (candidates.length === 0) return;

  const uniqueMints = [...new Set(candidates.map((pool) => pool.base.mint))];
  const results = await Promise.allSettled(
    uniqueMints.map(async (mint) => ({ mint, priceAction: await fetchGmgnPriceAction(mint) })),
  );

  const byMint = new Map();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    if (!result.value.priceAction) continue;
    byMint.set(result.value.mint, result.value.priceAction);
  }

  for (const pool of candidates) {
    const priceAction = byMint.get(pool.base.mint);
    if (!priceAction) continue;
    pool.gmgn_price_action = priceAction;
    pool.price_5m_change = priceAction.price_5m_change ?? pool.price_5m_change;
    pool.price_1h_change = priceAction.price_1h_change ?? pool.price_1h_change;
    pool.price_6h_change = priceAction.price_6h_change ?? pool.price_6h_change;
    pool.price_24h_change = priceAction.price_24h_change ?? pool.price_24h_change;
    pool.price_change_pct = priceAction.price_5m_change ?? pool.price_change_pct;
  }
}



/**
 * Fetch pools from the Meteora Pool Discovery API.
 * Returns condensed data optimized for LLM consumption (saves tokens).
 */
export async function discoverPools({
  page_size = 50,
} = {}) {
  const s = config.screening;
  const filters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    s.excludeHighSupplyConcentration ? "base_token_has_high_supply_concentration=false" : null,
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_market_cap<=${s.maxMcap}`,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${s.minVolume}`,
    `tvl>=${s.minTvl}`,
    s.maxTvl != null ? `tvl<=${s.maxTvl}` : null,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    `base_token_organic_score>=${s.minOrganic}`,
    `quote_token_organic_score>=${s.minQuoteOrganic}`,
    s.minTokenAgeHours != null ? `base_token_created_at<=${Date.now() - s.minTokenAgeHours * 3_600_000}` : null,
    s.maxTokenAgeHours != null ? `base_token_created_at>=${Date.now() - s.maxTokenAgeHours * 3_600_000}` : null,
    Array.isArray(s.allowedLaunchpads) && s.allowedLaunchpads.length > 0
      ? `base_token_launchpad=[${s.allowedLaunchpads.join(",")}]`
      : null,
  ].filter(Boolean).join("&&");

  const data = await fetchPoolDiscoveryPage({
    page_size,
    filters,
    timeframe: s.timeframe,
    category: s.category,
  });

  let rawPools = Array.isArray(data.data) ? data.data : [];

  if (config.screening.useDiscordSignals) {
    const signalCandidates = await fetchDiscordSignalCandidates().catch((error) => {
      log("screening", `Discord signal fetch failed: ${error.message}`);
      return [];
    });
    const signalPools = signalCandidates
      .map((candidate) => {
        const discoveryPool = candidate.discovery_pool;
        if (!discoveryPool?.pool_address) return null;
        return {
          ...discoveryPool,
          discord_signal: true,
          discord_signal_count: candidate.source_count || 1,
          discord_signal_seen_count: candidate.seen_count || 1,
          discord_signal_first_seen_at: candidate.first_seen_at || null,
          discord_signal_last_seen_at: candidate.last_seen_at || null,
        };
      })
      .filter(Boolean);

    if (config.screening.discordSignalMode === "only") {
      rawPools = signalPools;
    } else if (signalPools.length > 0) {
      const byPool = new Map(rawPools.map((pool) => [pool.pool_address, pool]));
      for (const signalPool of signalPools) {
        if (byPool.has(signalPool.pool_address)) {
          byPool.set(signalPool.pool_address, {
            ...byPool.get(signalPool.pool_address),
            discord_signal: true,
            discord_signal_count: signalPool.discord_signal_count,
            discord_signal_seen_count: signalPool.discord_signal_seen_count,
            discord_signal_first_seen_at: signalPool.discord_signal_first_seen_at,
            discord_signal_last_seen_at: signalPool.discord_signal_last_seen_at,
          });
        } else {
          byPool.set(signalPool.pool_address, signalPool);
        }
      }
      rawPools = Array.from(byPool.values());
    }
  }

  rawPools = await applyVolatilityTimeframe(rawPools, s.timeframe);

  // Fetch only the timing fields still needed by enabled gates.
  // 5m is already in the active screen window; 1h feeds dump protection.
  // 6h/24h are only needed by the optional single-side retest gate.
  const timingFrames = [
    ["1h", "price_1h_change"],
    ...(s.singleSideSolEntryGateEnabled === false ? [] : [
      ["6h", "price_6h_change"],
      ["24h", "price_24h_change"],
    ]),
  ];
  for (const [timeframe, field] of timingFrames) {
    try {
      const dataTf = await fetchPoolDiscoveryPage({
        page_size,
        filters,
        timeframe,
        category: s.category,
      });
      const poolsTf = Array.isArray(dataTf.data) ? dataTf.data : [];
      const priceChangeByPool = new Map();
      for (const p of poolsTf) {
        const addr = p?.pool_address;
        const pct = numeric(p?.pool_price_change_pct);
        if (addr != null && pct != null) priceChangeByPool.set(addr, pct);
      }
      for (const pool of rawPools) {
        if (pool?.pool_address && priceChangeByPool.has(pool.pool_address)) {
          pool[field] = priceChangeByPool.get(pool.pool_address);
        }
      }
    } catch (err) {
      log("screening", `${timeframe} price change bulk fetch failed: ${err.message}`);
    }
  }

  await enrichDiscordSignalLaunchpads(rawPools);

  const filteredExamples = [];
  const thresholdedRawPools = rawPools.filter((pool) => {
    const reason = getRawPoolScreeningRejectReason(pool, s);
    if (!reason) return true;
    filteredExamples.push({ name: pool.name || pool.pool_address || "unknown pool", reason });
    if (pool.discord_signal) log("screening", `Discord signal filtered: ${pool.name || pool.pool_address} — ${reason}`);
    return false;
  });

  const condensed = thresholdedRawPools.map(condensePool);

  // Hard-filter blacklisted tokens and blocked deployers (what pool discovery already gave us)
  let pools = condensed.filter((p) => {
    if (isBlacklisted(p.base?.mint)) {
      log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
      return false;
    }
    if (p.dev && isDevBlocked(p.dev)) {
      log("dev_blocklist", `Filtered blocked deployer ${p.dev?.slice(0, 8)} token ${p.base?.symbol} in pool ${p.name}`);
      return false;
    }
    return true;
  });

  const filtered = condensed.length - pools.length;
  if (filtered > 0) log("blacklist", `Filtered ${filtered} pool(s) with blacklisted tokens/devs`);

  // If pool discovery didn't supply dev field, batch-fetch from Jupiter for any pools
  // where dev is null — but only if the dev blocklist is non-empty (avoid useless calls)
  const blockedDevs = getBlockedDevs();
  if (Object.keys(blockedDevs).length > 0) {
    const missingDev = pools.filter((p) => !p.dev && p.base?.mint);
    if (missingDev.length > 0) {
      const devResults = await Promise.allSettled(
        missingDev.map((p) =>
          fetch(`${DATAPI_JUP}/assets/search?query=${p.base.mint}`)
            .then((r) => r.ok ? r.json() : null)
            .then((d) => {
              const t = Array.isArray(d) ? d[0] : d;
              return { pool: p.pool, dev: t?.dev || null, tags: t?.tags || [] };
            })
            .catch(() => ({ pool: p.pool, dev: null, tags: [] }))
        )
      );
      const devMap = {};
      const tagMap = {};
      for (const r of devResults) {
        if (r.status === "fulfilled") {
          devMap[r.value.pool] = r.value.dev;
          tagMap[r.value.pool] = r.value.tags || [];
        }
      }
      pools = pools.filter((p) => {
        const dev = devMap[p.pool];
        const tags = tagMap[p.pool] || [];
        if (dev) p.dev = dev; // enrich in-place

        if (dev && isDevBlocked(dev)) {
          log("dev_blocklist", `Filtered blocked deployer (jup) ${dev.slice(0, 8)} token ${p.base?.symbol}`);
          return false;
        }
        return true;
      });
    }
  }

  await enrichGmgnPriceActionForPools(pools);

  return {
    total: data.total,
    pools,
    filtered_examples: filteredExamples,
  };
}

/**
 * Returns eligible pools for the agent to evaluate and pick from.
 * Hard filters applied in code, agent decides which to deploy into.
 */
export async function getTopCandidates({ limit = 10 } = {}) {
  const { config } = await import("../config.js");
  const source = String(config.screening.source || "meteora").toLowerCase();
  if (!["meteora", "gmgn"].includes(source)) {
    throw new Error(`Invalid screeningSource: ${config.screening.source}. Use meteora or gmgn.`);
  }
  const discovery = source === "gmgn"
    ? await discoverGmgnPools({ limit: Math.max(limit, config.gmgn.enrichLimit || 20) })
    : await discoverPools({ page_size: 50 });
  let { pools } = discovery;
  const filteredOut = Array.isArray(discovery.filtered_examples) ? [...discovery.filtered_examples] : [];

  // Token blacklist + dev blocklist (Meteora path runs these inside discoverPools; GMGN path does not)
  if (source === "gmgn") {
    const before = pools.length;
    pools = pools.filter((p) => {
      if (isBlacklisted(p.base?.mint)) {
        log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "blacklisted token");
        return false;
      }
      if (p.dev && isDevBlocked(p.dev)) {
        log("dev_blocklist", `Filtered blocked deployer ${p.dev?.slice(0, 8)} token ${p.base?.symbol}`);
        pushFilteredReason(filteredOut, p, "blocked deployer");
        return false;
      }
      return true;
    });
    if (pools.length < before) log("blacklist", `GMGN: filtered ${before - pools.length} blacklisted/blocked pool(s)`);
  }

  // Exclude pools where the wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));
  const minTvl = source === "gmgn"
    ? Number(config.gmgn.minTvl ?? config.screening.minTvl ?? 0)
    : Number(config.screening.minTvl ?? 0);
  const maxTvl = config.screening.maxTvl == null ? null : Number(config.screening.maxTvl);
  const minFeeActiveTvlRatio = Number(config.screening.minFeeActiveTvlRatio ?? 0);

  const eligible = pools
    .filter((p) => {
      const tvl = Number(p.tvl ?? p.active_tvl ?? 0);
      if (Number.isFinite(minTvl) && minTvl > 0 && tvl < minTvl) {
        pushFilteredReason(filteredOut, p, `TVL $${tvl} below minTvl $${minTvl}`);
        return false;
      }
      if (Number.isFinite(maxTvl) && maxTvl > 0 && tvl > maxTvl) {
        pushFilteredReason(filteredOut, p, `TVL $${tvl} above maxTvl $${maxTvl}`);
        return false;
      }
      const feeActiveTvlRatio = Number(p.fee_active_tvl_ratio);
      if (Number.isFinite(minFeeActiveTvlRatio) && minFeeActiveTvlRatio > 0 && (!Number.isFinite(feeActiveTvlRatio) || feeActiveTvlRatio < minFeeActiveTvlRatio)) {
        pushFilteredReason(filteredOut, p, `fee/active-TVL ${Number.isFinite(feeActiveTvlRatio) ? feeActiveTvlRatio : "unknown"} below minFeeActiveTvlRatio ${minFeeActiveTvlRatio}`);
        return false;
      }
      if (!isUsableVolatility(p.volatility)) {
        pushFilteredReason(filteredOut, p, `volatility ${p.volatility ?? "unknown"} unusable`);
        return false;
      }
      if (occupiedPools.has(p.pool)) {
        pushFilteredReason(filteredOut, p, "already have an open position in this pool");
        return false;
      }
      if (occupiedMints.has(p.base?.mint)) {
        pushFilteredReason(filteredOut, p, "already holding this base token in another pool");
        return false;
      }
      if (isPoolOnCooldown(p.pool)) {
        log("screening", `Filtered cooldown pool ${p.name} (${p.pool.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "pool cooldown active");
        return false;
      }
      if (isBaseMintOnCooldown(p.base?.mint)) {
        log("screening", `Filtered cooldown token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "token cooldown active");
        return false;
      }
      if (isTokenWaveBlocked(p.base?.mint) || isTokenWaveBlocked(p.base?.symbol)) {
        log("screening", `Filtered wave-blocked token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "wave blocked (max profitable exits in 24h)");
        return false;
      }
      // Max volatility filter
      if (config.screening.maxVolatility && p.volatility != null && p.volatility > config.screening.maxVolatility) {
        log("screening", `Filtered high volatility ${p.name}: ${p.volatility} > ${config.screening.maxVolatility}`);
        pushFilteredReason(filteredOut, p, `volatility too high (${p.volatility} > max ${config.screening.maxVolatility})`);
        return false;
      }
      // Bin step filter (GMGN path safety — Meteora API already enforces this)
      const binStep = numeric(p.bin_step);
      if (binStep == null || binStep < config.screening.minBinStep) {
        log("screening", `Filtered bin_step ${p.name}: ${binStep ?? "unknown"} below minBinStep ${config.screening.minBinStep}`);
        pushFilteredReason(filteredOut, p, `bin_step ${binStep ?? "unknown"} below minBinStep ${config.screening.minBinStep}`);
        return false;
      }
      if (binStep > config.screening.maxBinStep) {
        log("screening", `Filtered bin_step ${p.name}: ${binStep} above maxBinStep ${config.screening.maxBinStep}`);
        pushFilteredReason(filteredOut, p, `bin_step ${binStep} above maxBinStep ${config.screening.maxBinStep}`);
        return false;
      }
      // Trend filter — avoid falling knife (downtrend still accelerating)
      const price1h = numeric(p.price_1h_change);
      const price5m = numeric(p.price_5m_change);
      const fk5m = config.screening.fallingKnife5mThreshold ?? -20;
      const fk1h = config.screening.fallingKnife1hThreshold ?? -25;
      // Accelerating dump: both negative and 5m is deeper than 1h
      if (price1h != null && price5m != null && price1h < 0 && price5m < 0 && price5m < price1h - 1) {
        log("screening", `Filtered accelerating dump ${p.name}: 1h=${price1h}% 5m=${price5m}% (dump accelerating)`);
        pushFilteredReason(filteredOut, p, `accelerating dump 1h=${price1h}% 5m=${price5m}%`);
        return false;
      }
      // Falling knife (Gemini spec): crash instant for potential quick rebound
      if (price1h != null && price5m != null && price5m < fk5m && price1h < fk1h) {
        log("screening", `Filtered falling knife ${p.name}: 5m=${price5m}% 1h=${price1h}%`);
        pushFilteredReason(filteredOut, p, `falling knife 5m=${price5m}% 1h=${price1h}%`);
        return false;
      }
      // If both 1h and 5m are deeply red = no stabilization yet
      if (price1h != null && price1h < -5 && price5m != null && price5m < -3) {
        log("screening", `Filtered deepening downtrend ${p.name}: 1h=${price1h}% 5m=${price5m}%`);
        pushFilteredReason(filteredOut, p, `deepening downtrend 1h=${price1h}% 5m=${price5m}%`);
        return false;
      }
      if (price1h != null && price1h < -15) {
        log("screening", `Filtered deep dump ${p.name}: ${price1h}% in 1h`);
        pushFilteredReason(filteredOut, p, `deep dump ${price1h}% in 1h`);
        return false;
      }
      const singleSideEntry = evaluateSingleSideSolEntry(p);
      p.single_side_entry = singleSideEntry;
      if (!singleSideEntry.pass) {
        log("screening", `Filtered ${p.name}: ${singleSideEntry.reason}`);
        pushFilteredReason(filteredOut, p, singleSideEntry.reason);
        return false;
      }
      return true;
    })
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, limit);

  if (config.screening.avoidPvpSymbols && eligible.length > 0) {
    await enrichPvpRisk(eligible);
    if (config.screening.blockPvpSymbols) {
      const before = eligible.length;
      const pvpRemoved = eligible.filter((p) => p.is_pvp);
      pvpRemoved.forEach((p) => pushFilteredReason(filteredOut, p, "PVP hard filter"));
      eligible.splice(0, eligible.length, ...eligible.filter((p) => !p.is_pvp));
      if (eligible.length < before) {
        log("screening", `PVP hard filter removed ${before - eligible.length} pool(s)`);
      }
    }
  }

  // Enrich with OKX data — advanced info (risk/bundle/sniper) + ATH price (no API key required)
  // Skipped for GMGN: bundler/bot/wash data already sourced from GMGN pipeline
  if (source !== "gmgn" && eligible.length > 0) {
    const { getAdvancedInfo, getPriceInfo, getClusterList, getRiskFlags } = await import("./okx.js");
    const okxResults = await Promise.allSettled(
      eligible.map(async (p) => {
        if (!p.base?.mint) return { adv: null, price: null, clusters: [], risk: null };
        const [adv, price, clusters, risk] = await Promise.allSettled([
          getAdvancedInfo(p.base.mint),
          getPriceInfo(p.base.mint),
          getClusterList(p.base.mint),
          getRiskFlags(p.base.mint),
        ]);

        const mintShort = p.base.mint.slice(0, 8);
        if (adv.status !== "fulfilled")      log("okx", `advanced-info unavailable for ${p.name} (${mintShort})`);
        if (price.status !== "fulfilled")    log("okx", `price-info unavailable for ${p.name} (${mintShort})`);
        if (clusters.status !== "fulfilled") log("okx", `cluster-list unavailable for ${p.name} (${mintShort})`);
        if (risk.status !== "fulfilled")     log("okx", `risk-check unavailable for ${p.name} (${mintShort})`);

        return {
          adv: adv.status === "fulfilled" ? adv.value : null,
          price: price.status === "fulfilled" ? price.value : null,
          clusters: clusters.status === "fulfilled" ? clusters.value : [],
          risk: risk.status === "fulfilled" ? risk.value : null,
        };
      })
    );
    for (let i = 0; i < eligible.length; i++) {
      const r = okxResults[i];
      if (r.status !== "fulfilled") continue;
      const { adv, price, clusters, risk } = r.value;
      if (adv) {
        eligible[i].risk_level      = adv.risk_level;
        eligible[i].bundle_pct      = adv.bundle_pct;
        eligible[i].sniper_pct      = adv.sniper_pct;
        eligible[i].suspicious_pct  = adv.suspicious_pct;
        eligible[i].smart_money_buy = adv.smart_money_buy;
        eligible[i].dev_sold_all    = adv.dev_sold_all;
        eligible[i].dex_boost       = adv.dex_boost;
        eligible[i].dex_screener_paid = adv.dex_screener_paid;
        eligible[i].global_fees_sol = adv.total_fee_sol ?? null; // Map OKX total_fee_sol to global_fees_sol for hard filter
        if (adv.creator && !eligible[i].dev) eligible[i].dev = adv.creator;
      }
      if (risk) {
        eligible[i].is_rugpull = risk.is_rugpull;
        eligible[i].is_wash    = risk.is_wash;
      }
      if (price) {
        eligible[i].price_vs_ath_pct = price.price_vs_ath_pct;
        eligible[i].ath              = price.ath;
      }
      if (clusters?.length) {
        // Surface KOL presence and top cluster trend for LLM
        eligible[i].kol_in_clusters      = clusters.some((c) => c.has_kol);
        eligible[i].top_cluster_trend    = clusters[0]?.trend ?? null;      // buy|sell|neutral
        eligible[i].top_cluster_hold_pct = clusters[0]?.holding_pct ?? null;
      }
    }
    // Wash trading hard filter — fake volume = misleading fee yield
    eligible.splice(0, eligible.length, ...eligible.filter((p) => {
      if (p.is_wash) {
        log("screening", `Risk filter: dropped ${p.name} — wash trading flagged`);
        pushFilteredReason(filteredOut, p, "wash trading flagged");
        return false;
      }
      return true;
    }));

    // Enrich fees with GMGN token total_fee for non-GMGN sources (meteora/okx).
    // OKX total_fee_sol is pool-specific and often lower than the GMGN chart value.
    // GMGN total_fee covers all pools for the token — this is what users configure against.
    if (source !== "gmgn" && eligible.length > 0 && config.gmgn?.apiKey) {
      await Promise.allSettled(
        eligible.map(async (p) => {
          if (!p.base?.mint) return;
          const gmgnFees = await fetchGmgnTokenFees(p.base.mint);
          if (gmgnFees != null) p.gmgn_total_fee_sol = gmgnFees;
        })
      );
    }

    // Min token fees SOL filter (hard gate - cannot be overridden)
    // Must be AFTER OKX enrichment where global_fees_sol is populated
    const minFeesSol = config.screening.minTokenFeesSol;
    if (minFeesSol) {
      const before = eligible.length;
      eligible.splice(0, eligible.length, ...eligible.filter((p) => {
        const poolGlobalFeesSol = p.gmgn_total_fee_sol ?? p.global_fees_sol ?? null; // GMGN token total fees take priority over OKX pool-specific fees
        if (poolGlobalFeesSol != null && poolGlobalFeesSol < minFeesSol) {
          log("screening", `Filtered low fees ${p.name}: ${poolGlobalFeesSol} SOL < ${minFeesSol} SOL`);
          pushFilteredReason(filteredOut, p, `fees ${poolGlobalFeesSol} SOL < min ${minFeesSol} SOL`);
          return false;
        }
        return true;
      }));
      if (eligible.length < before) log("screening", `Min fees filter removed ${before - eligible.length} pool(s)`);
    }

    // ATH filter — drop pools where price is too close to ATH
    const athFilter = config.screening.athFilterPct;
    if (athFilter != null) {
      const threshold = 100 + athFilter; // e.g. -20 → threshold = 80 (price must be <= 80% of ATH)
      const before = eligible.length;
      eligible.splice(0, eligible.length, ...eligible.filter((p) => {
        if (p.price_vs_ath_pct == null) return true; // no data → don't filter
        if (p.price_vs_ath_pct > threshold) {
          log("screening", `ATH filter: dropped ${p.name} — ${p.price_vs_ath_pct}% of ATH (limit: ${threshold}%)`);
          pushFilteredReason(filteredOut, p, `${p.price_vs_ath_pct}% of ATH > ${threshold}% limit`);
          return false;
        }
        return true;
      }));
      if (eligible.length < before) log("screening", `ATH filter removed ${before - eligible.length} pool(s)`);
    }

    // Drop any pools whose creator is on the dev blocklist (caught via advanced-info)
    const before = eligible.length;
    const filtered = eligible.filter((p) => {
      if (p.dev && isDevBlocked(p.dev)) {
        log("dev_blocklist", `Filtered blocked deployer (okx) ${p.dev.slice(0, 8)} token ${p.base?.symbol}`);
        pushFilteredReason(filteredOut, p, "blocked deployer");
        return false;
      }
      return true;
    });
    eligible.splice(0, eligible.length, ...filtered);
    if (eligible.length < before) log("dev_blocklist", `Filtered ${before - eligible.length} pool(s) via OKX creator check`);
  }

  // ── DexScreener boost enrichment + hard filter ───────────────────────────
  if (eligible.length > 0) {
    const boostResults = await Promise.allSettled(
      eligible.map(async (p) => {
        if (!p.base?.mint) return null;
        return fetchDexScreenerBoosts(p.base.mint);
      })
    );
    for (let i = 0; i < eligible.length; i++) {
      const r = boostResults[i];
      if (r.status === "fulfilled" && r.value != null) {
        eligible[i].dex_boosts = r.value;
      }
    }
    const maxDexBoosts = config.screening.maxDexBoosts;
    if (config.screening.paidPromotionBlockEnabled === false && maxDexBoosts != null && maxDexBoosts >= 0) {
      const before = eligible.length;
      eligible.splice(0, eligible.length, ...eligible.filter((p) => {
        if (p.dex_boosts != null && p.dex_boosts > maxDexBoosts) {
          log("screening", `Filtered high DexScreener boosts ${p.name}: ${p.dex_boosts} > max ${maxDexBoosts}`);
          pushFilteredReason(filteredOut, p, `DexScreener boosts ${p.dex_boosts} > max ${maxDexBoosts}`);
          return false;
        }
        return true;
      }));
      if (eligible.length < before) log("screening", `DexScreener boost filter removed ${before - eligible.length} pool(s)`);
    }
  }

  if (eligible.length > 0 && config.screening.paidPromotionBlockEnabled !== false) {
    const paidPromotionResults = await Promise.allSettled(
      eligible.map((p) => evaluatePaidPromotionRisk({
        poolAddress: p.pool,
        baseMint: p.base?.mint,
        symbol: p.base?.symbol,
        name: p.name,
        dexBoosts: p.dex_boosts,
      }))
    );
    const paidRiskByPool = new Map();
    for (let i = 0; i < eligible.length; i++) {
      const result = paidPromotionResults[i];
      if (result.status !== "fulfilled") continue;
      eligible[i].paid_promotion_risk = result.value;
      paidRiskByPool.set(eligible[i].pool, result.value);
    }
    const before = eligible.length;
    eligible.splice(0, eligible.length, ...eligible.filter((p) => {
      const risk = paidRiskByPool.get(p.pool);
      if (!risk?.blocked) return true;
      log("screening", `Filtered paid promotion ${p.name}: ${risk.reason}`);
      pushFilteredReason(filteredOut, p, risk.reason);
      return false;
    }));
    if (eligible.length < before) log("screening", `Paid promotion filter removed ${before - eligible.length} pool(s)`);
  }

  if (eligible.length > 0) {
    const confirmations = await Promise.all(
      eligible.map(async (pool) => {
        try {
          const confirmation = await confirmEntrySupertrendBreak({
            mint: pool.base?.mint,
          });
          return { pool: pool.pool, confirmation };
        } catch (error) {
          return {
            pool: pool.pool,
            confirmation: {
              enabled: true,
              confirmed: false,
              skipped: false,
              reason: `Supertrend 5m confirmation unavailable: ${error.message}`,
              intervals: [],
            },
          };
        }
      }),
    );
    const confirmationByPool = new Map(confirmations.map((entry) => [entry.pool, entry.confirmation]));
    const before = eligible.length;
    const confirmedEligible = eligible.filter((pool) => {
      const confirmation = confirmationByPool.get(pool.pool);
      pool.indicator_confirmation = confirmation || null;
      if (!confirmation || confirmation.confirmed) return true;
      pushFilteredReason(filteredOut, pool, `supertrend 5m reject: ${confirmation.reason}`);
      log("screening", `Supertrend 5m rejected ${pool.name} (${pool.pool.slice(0, 8)}): ${confirmation.reason}`);
      return false;
    });
    eligible.splice(0, eligible.length, ...confirmedEligible);
    if (eligible.length < before) {
      log("screening", `Supertrend 5m hard gate removed ${before - eligible.length} candidate(s)`);
    }
  }

  return {
    candidates: eligible,
    total_screened: discovery.total ?? pools.length,
    source,
    filtered_examples: filteredOut.slice(0, 3),
    stage_counts: discovery.stage_counts ? { ranked: discovery.total, ...discovery.stage_counts } : null,
    all_filtered: filteredOut,
  };
}

/**
 * Get full raw details for a specific pool.
 * Fetches top 50 pools from discovery API and finds the matching address.
 * Returns the full unfiltered API object (all fields, not condensed).
 */
export async function getPoolDetail({ pool_address, timeframe = "5m" }) {
  const pool = await fetchPoolDiscoveryDetail({ poolAddress: pool_address, timeframe });

  if (!pool) {
    throw new Error(`Pool ${pool_address} not found`);
  }

  return pool;
}

/**
 * Condense a pool object for LLM consumption.
 * Raw API returns ~100+ fields per pool. The LLM only needs ~20.
 */
function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
    },
    pool_type: p.pool_type,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,

    // Core metrics (the numbers that matter)
    tvl: round(p.tvl),
    active_tvl: round(p.active_tvl),
    fee_window: round(p.fee),
    volume_window: round(p.volume),
    fee_active_tvl_ratio: p.fee_active_tvl_ratio != null ? fix(p.fee_active_tvl_ratio, 4) : null,
    volatility: fix(p.volatility, 4),
    volatility_timeframe: p.volatility_timeframe || getVolatilityTimeframe(config.screening.timeframe),


    // Token health
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),
    token_age_hours: p.token_x?.created_at
      ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
      : null,
    dev: p.token_x?.dev || null,
    launchpad: getPoolLaunchpad(p),

    // Position health
    active_positions: p.active_positions,
    active_pct: fix(p.active_positions_pct, 1),
    open_positions: p.open_positions,
    discord_signal: Boolean(p.discord_signal),
    discord_signal_count: p.discord_signal_count || 0,
    discord_signal_seen_count: p.discord_signal_seen_count || 0,
    discord_signal_last_seen_at: p.discord_signal_last_seen_at || null,

    // Price action
    price: p.pool_price,
    price_5m_change: fix(p.pool_price_change_pct, 1),
    price_1h_change: fix(p.price_1h_change, 1),
    price_6h_change: fix(p.price_6h_change, 1),
    price_24h_change: fix(p.price_24h_change, 1),
    price_change_pct: fix(p.pool_price_change_pct, 1), // legacy alias
    price_trend: p.price_trend,
    single_side_entry: p.single_side_entry ?? null,
    min_price: p.min_price,
    max_price: p.max_price,

    // Activity trends
    volume_change_pct: fix(p.volume_change_pct, 1),
    fee_change_pct: fix(p.fee_change_pct, 1),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,
  };
}

function round(n) {
  return n != null ? Math.round(n) : null;
}

function fix(n, decimals) {
  const value = numeric(n);
  return value != null ? Number(value.toFixed(decimals)) : null;
}

function pushFilteredReason(list, pool, reason) {
  if (!list || !pool) return;
  list.push({
    name: pool.name || `${pool.base?.symbol || "?"}-${pool.quote?.symbol || "?"}`,
    reason,
  });
}
