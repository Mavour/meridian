function renderPositionCard(pos) {
  const pnl = pos.pnl_pct != null ? pos.pnl_pct : 0;
  const peak = pos.peak_pnl_pct || pnl;
  const ageMin = pos.deployed_at
    ? (Date.now() - new Date(pos.deployed_at).getTime()) / 60000
    : 0;
  const isOor = !!pos.out_of_range_since;
  const status = isOor ? "OOR" : "LIVE";
  const statusClass = isOor ? "oor" : "live";
  const cardClass = pnl > 0 ? "profit" : pnl < -1 ? "loss" : isOor ? "oor" : "";

  return `
    <div class="position-card ${cardClass}" data-position="${pos.position}">
      <div class="pc-header">
        <div class="pc-name">${pos.pool_name || pos.pool?.slice(0, 8)}</div>
        <div class="pc-badge ${statusClass}">${status}</div>
      </div>
      <div class="pc-row"><span>Age</span><span class="val">${fmtDuration(ageMin)}</span></div>
      <div class="pc-row"><span>Strategy</span><span class="val">${pos.strategy}</span></div>
      <div class="pc-row"><span>Bins</span><span class="val">${pos.bin_range?.bins_below}↓ ${pos.bin_range?.bins_above}↑</span></div>
      <div class="pc-row"><span>Deposited</span><span class="val">${pos.amount_sol?.toFixed(3) || 0} SOL</span></div>
      <div class="pc-row"><span>PnL</span><span class="val ${pnl >= 0 ? 'pos' : 'neg'}">${fmtPct(pnl)}</span></div>
      <div class="pc-row"><span>Peak</span><span class="val ${peak >= 0 ? 'pos' : 'neg'}">${fmtPct(peak)}</span></div>
      <div class="pc-row"><span>Fee/TVL</span><span class="val">${pos.fee_tvl_ratio?.toFixed(4) || '-'}</span></div>
      <div class="pc-row"><span>Volatility</span><span class="val">${pos.volatility?.toFixed(2) || '-'}</span></div>
      <div class="pc-bar-wrap">
        <div class="pc-bar-fill" style="width:${Math.min(Math.abs(pnl) * 10, 100)}%"></div>
      </div>
    </div>
  `;
}
