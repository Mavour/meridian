function fmtUsd(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '-';
}

function fmtAmount(value, symbol) {
  const n = Number(value);
  if (!Number.isFinite(n)) return `- ${symbol || ''}`.trim();
  const digits = n >= 100 ? 2 : n >= 1 ? 4 : 6;
  return `${n.toFixed(digits)} ${symbol || ''}`.trim();
}

function fmtPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(6);
  return n.toPrecision(5);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function rangeMarkerPct(range) {
  const min = Number(range?.min);
  const max = Number(range?.max);
  const current = Number(range?.current);
  if (![min, max, current].every(Number.isFinite) || max <= min) return 50;
  return clamp(((current - min) / (max - min)) * 100, 0, 100);
}

export default function PositionCard({ pos }) {
  const pnl = Number(pos.pnl_pct || 0);
  const peak = Number(pos.peak_pnl_pct || 0);
  const inRange = pos.in_range;
  const range = pos.price_range || {};
  const markerPct = rangeMarkerPct(range);
  const tokenX = pos.holdings?.tokenX || {};
  const tokenY = pos.holdings?.tokenY || {};
  const totalBins = pos.total_bins || (
    Number.isFinite(Number(pos.lower_bin)) && Number.isFinite(Number(pos.upper_bin))
      ? Math.abs(Number(pos.upper_bin) - Number(pos.lower_bin)) + 1
      : pos.bins_below
  );
  const unclaimedUsd = pos.fees?.unclaimed_usd ?? pos.unclaimed_fees_usd;
  const feePct = pos.fees?.pct_of_input ?? pos.fee_pct_of_input;
  const claimedUsd = pos.fees?.claimed_usd ?? pos.claimed_fees_usd;
  const feeDetail = [
    pos.fees?.unclaimed_x_amount != null ? fmtAmount(pos.fees.unclaimed_x_amount, tokenX.symbol) : null,
    pos.fees?.unclaimed_y_amount != null ? fmtAmount(pos.fees.unclaimed_y_amount, tokenY.symbol) : null,
  ].filter(Boolean).join(' + ');

  return (
    <article className={`position-card ${inRange ? 'in-range' : 'out-range'}`}>
      <div className="position-head">
        <div>
          <h3>{pos.pair}</h3>
          <p>{pos.strategy || 'DLMM'} | {totalBins || '-'} bins | step {pos.bin_step || '-'}</p>
        </div>
        <span className={`range-badge ${inRange ? 'ok' : 'risk'}`}>
          {inRange ? 'IN RANGE' : `OOR ${pos.minutes_oor || 0}m`}
        </span>
      </div>

      <div className="position-summary-row">
        <div>
          <span>Value</span>
          <b>{fmtUsd(pos.total_value_usd)}</b>
        </div>
        <div>
          <span>PnL</span>
          <b className={pnl >= 0 ? 'positive' : 'negative'}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}%</b>
        </div>
        <div>
          <span>Peak</span>
          <b>{peak >= 0 ? '+' : ''}{peak.toFixed(2)}%</b>
        </div>
      </div>

      <div className="price-range-block">
        <div className="range-values">
          <span>{fmtPrice(range.min)}</span>
          <span>{fmtPrice(range.max)}</span>
        </div>
        <div className="price-slider" aria-label="Position price range">
          <span className="price-slider-fill" />
          <i className="price-marker" style={{ left: `${markerPct}%` }} />
        </div>
        <div className="range-meta">
          <span>Active {fmtPrice(range.current)}</span>
          <span>{pos.lower_bin ?? '-'} to {pos.upper_bin ?? '-'}</span>
        </div>
      </div>

      <div className="holdings-grid">
        <div>
          <span>{tokenX.symbol || 'Token'}</span>
          <b>{fmtAmount(tokenX.amount, tokenX.symbol)}</b>
        </div>
        <div>
          <span>{tokenY.symbol || 'SOL'}</span>
          <b>{fmtAmount(tokenY.amount, tokenY.symbol || 'SOL')}</b>
        </div>
        <div>
          <span>Unclaimed fees</span>
          <b className="positive">{fmtUsd(unclaimedUsd)}</b>
          <em>{Number.isFinite(Number(feePct)) ? `${Number(feePct).toFixed(2)}% of input` : feeDetail || '-'}</em>
        </div>
        <div>
          <span>Claimed total</span>
          <b>{fmtUsd(claimedUsd)}</b>
          <em>{feeDetail || 'Harvested fees'}</em>
        </div>
      </div>
    </article>
  );
}
