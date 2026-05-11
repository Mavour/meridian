/**
 * DexScreener API helpers — public endpoints (no key required)
 * Docs: https://docs.dexscreener.com/
 */

const BASE = "https://api.dexscreener.com/latest";

/**
 * Fetch the active boost count for a token from DexScreener.
 * Returns the highest `boosts.active` value across all pairs for the mint,
 * or null if unavailable.
 */
export async function fetchDexScreenerBoosts(tokenAddress) {
  try {
    const res = await fetch(`${BASE}/dex/tokens/${encodeURIComponent(tokenAddress)}`);
    if (!res.ok) throw new Error(`DexScreener ${res.status}`);
    const data = await res.json();
    const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
    if (pairs.length === 0) return null;

    const maxBoosts = pairs
      .map((p) => {
        const active = p?.boosts?.active;
        return Number.isFinite(Number(active)) ? Number(active) : null;
      })
      .filter((n) => n != null && n >= 0);

    return maxBoosts.length > 0 ? Math.max(...maxBoosts) : null;
  } catch (error) {
    return null;
  }
}
