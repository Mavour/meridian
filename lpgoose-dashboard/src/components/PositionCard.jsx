function fmtUsd(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

export default function PositionCard({ pos }) {
  const stopLoss = -10;
  const pnl = Number(pos.pnl_pct || 0);
  const peak = Number(pos.peak_pnl_pct || 0);
  const inRange = pos.in_range;
  const fillPct = Math.min(100, Math.max(0, ((pnl - stopLoss) / (Math.abs(stopLoss) + 10)) * 100));
  const zeroPct = (Math.abs(stopLoss) / (Math.abs(stopLoss) + 10)) * 100;

  return (
    <article className={`position-card ${inRange ? 'in-range' : 'out-range'}`}>
      <div className="position-head">
        <div>
          <h3>{pos.pair}</h3>
          <p>{pos.strategy} · {pos.bins_below || '?'} bins · step {pos.bin_step || '?'}</p>
        </div>
        <span className={`range-badge ${inRange ? 'ok' : 'risk'}`}>
          {inRange ? 'IN RANGE' : `OOR ${pos.minutes_oor || 0}m`}
        </span>
      </div>

      <div className="position-metrics">
        <div><span>Value</span><b>{fmtUsd(pos.total_value_usd)}</b></div>
        <div><span>Fees</span><b className="positive">{fmtUsd(pos.unclaimed_fees_usd)}</b></div>
        <div><span>Age</span><b>{pos.age_minutes || 0}m</b></div>
        <div><span>Yield</span><b>{Number(pos.yield_pct || 0).toFixed(1)}%</b></div>
      </div>

      <div className="range-lane" aria-label="Position PnL lane">
        <span className={pnl >= 0 ? 'lane-fill positive-bg' : 'lane-fill negative-bg'} style={{ width: `${fillPct}%` }} />
        <i style={{ left: `${zeroPct}%` }} />
      </div>

      <div className="pnl-row">
        <span>SL {stopLoss}%</span>
        <strong className={pnl >= 0 ? 'positive' : 'negative'}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}%</strong>
        <span>Peak {peak >= 0 ? '+' : ''}{peak.toFixed(2)}%</span>
      </div>
    </article>
  );
}
