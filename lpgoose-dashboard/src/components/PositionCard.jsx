import { useEffect, useMemo, useState } from 'react';

const POSITION_STORE_KEY = 'lpgoose.positionCardState.v1';

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
  if (![min, max, current].every(Number.isFinite) || max <= min) {
    if (Number.isFinite(current) && Number.isFinite(min) && current < min) return 0;
    if (Number.isFinite(current) && Number.isFinite(max) && current > max) return 100;
    return 50;
  }
  return clamp(((current - min) / (max - min)) * 100, 0, 100);
}

function readPositionStore() {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(window.localStorage.getItem(POSITION_STORE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writePositionStore(store) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(POSITION_STORE_KEY, JSON.stringify(store));
}

function loadStoredPosition(positionId) {
  if (!positionId) return null;
  return readPositionStore()[positionId] || null;
}

function saveStoredPosition(positionId, next) {
  if (!positionId) return;
  const store = readPositionStore();
  store[positionId] = { ...(store[positionId] || {}), ...next };
  writePositionStore(store);
}

function computedPnlPct(currentValue, initialValue) {
  const current = Number(currentValue);
  const initial = Number(initialValue);
  if (!Number.isFinite(current) || !Number.isFinite(initial) || initial <= 0) return null;
  return ((current - initial) / initial) * 100;
}

export default function PositionCard({ pos }) {
  const positionId = pos.position || pos.position_address || pos.id;
  const currentValue = Number(pos.total_value_usd);
  const [stored, setStored] = useState(() => loadStoredPosition(positionId));
  const range = pos.price_range || {};
  const markerPct = rangeMarkerPct(range);
  const lowerBin = Number(pos.lower_bin);
  const upperBin = Number(pos.upper_bin);
  const activeBin = Number(pos.active_bin);
  const activeBinKnown = [lowerBin, upperBin, activeBin].every(Number.isFinite);
  const activeInRange = activeBinKnown ? activeBin >= lowerBin && activeBin <= upperBin : !!pos.in_range;
  const minutesOor = Number(pos.minutes_oor ?? pos.minutes_out_of_range ?? 0);
  const confirmedOor = !activeInRange && minutesOor > 0;
  const inRange = activeInRange || !confirmedOor;
  const oorSide = confirmedOor && activeBinKnown && activeBin < lowerBin ? 'left' : 'right';
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
  const initialValue = stored?.initialValue;
  const pnl = computedPnlPct(currentValue, initialValue);
  const peak = Number.isFinite(Number(stored?.peakPnl)) ? Number(stored.peakPnl) : pnl;
  const pnlDisplay = pnl == null ? '-' : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`;
  const peakDisplay = peak == null || !Number.isFinite(peak) ? '-' : `${peak >= 0 ? '+' : ''}${peak.toFixed(2)}%`;

  useEffect(() => {
    if (!positionId || !Number.isFinite(currentValue) || currentValue <= 0) return;
    const latest = loadStoredPosition(positionId);
    if (!latest?.initialValue || latest.initialValue <= 0) {
      const next = { initialValue: currentValue, peakPnl: 0, openedAt: Date.now() };
      saveStoredPosition(positionId, next);
      setStored(next);
      return;
    }

    const nextPnl = computedPnlPct(currentValue, latest.initialValue);
    const nextPeak = nextPnl == null
      ? latest.peakPnl
      : Math.max(Number(latest.peakPnl ?? nextPnl), nextPnl);
    if (nextPeak !== latest.peakPnl) {
      const next = { ...latest, peakPnl: nextPeak };
      saveStoredPosition(positionId, next);
      setStored(next);
    } else {
      setStored(latest);
    }
  }, [positionId, currentValue]);

  const sliderClass = useMemo(() => {
    const classes = ['price-slider'];
    if (confirmedOor) classes.push('confirmed-oor', oorSide === 'left' ? 'oor-left' : 'oor-right');
    return classes.join(' ');
  }, [confirmedOor, oorSide]);

  return (
    <article className={`position-card ${inRange ? 'in-range' : 'out-range'}`}>
      <div className="position-head">
        <div>
          <h3>{pos.pair}</h3>
          <p>{pos.strategy || 'DLMM'} | {totalBins || '-'} bins | step {pos.bin_step || '-'}</p>
        </div>
        <span className={`range-badge ${inRange ? 'ok' : 'risk'}`}>
          {inRange ? 'IN RANGE' : `OOR ${minutesOor}m`}
        </span>
      </div>

      <div className="position-summary-row">
        <div>
          <span>Value</span>
          <b>{fmtUsd(pos.total_value_usd)}</b>
        </div>
        <div>
          <span>PnL</span>
          <b className={pnl == null ? '' : pnl >= 0 ? 'positive' : 'negative'}>{pnlDisplay}</b>
        </div>
        <div>
          <span>Peak</span>
          <b>{peakDisplay}</b>
        </div>
      </div>

      <div className="price-range-block">
        <div className="range-values">
          <span>{fmtPrice(range.min)}</span>
          <span>{fmtPrice(range.max)}</span>
        </div>
        <div className={sliderClass} aria-label="Position price range">
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
