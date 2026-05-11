function renderPositionCard(pos) {
  const pnl = pos.pnl_pct != null ? pos.pnl_pct : 0;
  const peak = pos.peak_pnl_pct || pnl;
  const ageMin = pos.deployed_at
    ? (Date.now() - new Date(pos.deployed_at).getTime()) / 60000
    : 0;
  const isOor = !!pos.out_of_range_since;
  const statusText = isOor ? `OOR ${fmtDuration((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000)}` : "IN RANGE";
  const statusClass = isOor ? "oor" : "in-range";
  const cardClass = pnl > 0 ? "profit" : pnl < -1 ? "loss" : isOor ? "oor" : "profit";
  const pnlClass = pnl > 0 ? "pos" : pnl < 0 ? "neg" : "neu";

  // Yield approx = fee_tvl_ratio * age_hours (very rough)
  const ageHours = ageMin / 60;
  const yieldPct = pos.fee_tvl_ratio && ageHours > 0
    ? (pos.fee_tvl_ratio * ageHours).toFixed(2)
    : "0.00";

  // Unclaimed estimate
  const unclaimed = pos.total_fees_claimed_usd != null && pos.initial_value_usd != null
    ? Math.max(0, (pos.pnl_usd || 0) - pos.total_fees_claimed_usd)
    : 0;

  return `
    <div class="pos-card ${cardClass}" data-position="${pos.position}">
      <div class="pos-header">
        <div class="pos-name">${pos.pool_name || pos.pool?.slice(0, 8)}</div>
        <div class="pos-status ${statusClass}">
          <span class="pos-status-dot"></span>
          ${statusText}
        </div>
      </div>
      <div class="pos-subtitle">${pos.strategy} · ${pos.bin_range?.bins_below || 0} bins · step ${pos.bin_step}</div>

      <div class="pos-metrics">
        <div class="metric">
          <div class="metric-label">Val</div>
          <div class="metric-value">${fmtSol(pos.amount_sol || 0)}</div>
        </div>
        <div class="metric">
          <div class="metric-label">Unclaimed</div>
          <div class="metric-value ${unclaimed >= 0 ? 'pos' : 'neg'}">${fmtSol(unclaimed / 150)}</div>
        </div>
        <div class="metric">
          <div class="metric-label">Age</div>
          <div class="metric-value">${fmtDuration(ageMin)}</div>
        </div>
        <div class="metric">
          <div class="metric-label">Yield</div>
          <div class="metric-value">${yieldPct}%</div>
        </div>
      </div>

      <div class="pos-bar-wrap">
        <div class="pos-bar-fill" style="width:${Math.min(Math.max(pnl + 10, 0) * 5, 100)}%"></div>
      </div>

      <div class="pos-footer">
        <div class="pos-sl">SL ${fmtPct(pos.stopLossPct || -12)}</div>
        <div class="pos-pnl-big ${pnlClass}">${fmtPct(pnl)}</div>
        <div class="pos-peak">Peak ${fmtPct(peak)}</div>
      </div>
    </div>
  `;
}
