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

function fmtHoldTime(openedAt, now = Date.now()) {
  const opened = Number(openedAt);
  if (!Number.isFinite(opened) || opened <= 0) return '-';
  const totalMinutes = Math.max(0, Math.floor((now - opened) / 60000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return `${totalHours}h ${minutes}m`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days}d ${hours}h`;
}

function getOpenedAt(pos, stored) {
  const direct = pos.openedAt ?? pos.opened_at ?? pos.deployed_at;
  if (direct != null) {
    const parsed = typeof direct === 'number' ? direct : new Date(direct).getTime();
    if (Number.isFinite(parsed) && parsed > 0) return parsed < 1e12 ? parsed * 1000 : parsed;
  }

  const createdAt = Number(pos.createdAt ?? pos.created_at);
  if (Number.isFinite(createdAt) && createdAt > 0) return createdAt < 1e12 ? createdAt * 1000 : createdAt;

  const ageMinutes = Number(pos.age_minutes);
  if (Number.isFinite(ageMinutes) && ageMinutes >= 0) return Date.now() - ageMinutes * 60000;

  return stored?.openedAt;
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

export default function PositionCard({ pos, peakPnl = null }) {
  const positionId = pos.position || pos.position_address || pos.id;
  const currentValue = Number(pos.total_value_usd);
  const [stored, setStored] = useState(() => loadStoredPosition(positionId));
  const [now, setNow] = useState(() => Date.now());
  const range = pos.price_range || {};
  const markerPct = rangeMarkerPct(range);
  const currentPrice = Number(range.current);
  const lowerPrice = Number(range.min);
  const downsideRoom = Number.isFinite(currentPrice) && Number.isFinite(lowerPrice)
    ? currentPrice - lowerPrice
    : null;
  const downsidePct = downsideRoom != null && Number.isFinite(currentPrice) && currentPrice > 0
    ? (downsideRoom / currentPrice) * 100
    : null;
  const downsideTone = downsidePct == null ? '' : downsidePct > 30 ? 'good' : downsidePct >= 10 ? 'warn' : 'risk';
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
  const peak = Number.isFinite(Number(peakPnl)) ? Number(peakPnl) : null;
  const pnlDisplay = pnl == null ? '-' : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`;
  const peakDisplay = peak == null || !Number.isFinite(peak) ? '-' : `${peak >= 0 ? '+' : ''}${peak.toFixed(2)}%`;
  const openedAt = getOpenedAt(pos, stored);
  const holdTime = fmtHoldTime(openedAt, now);
  const downsideDisplay = downsideRoom == null || downsidePct == null
    ? 'Downside: -'
    : `Downside: -${fmtPrice(Math.max(0, downsideRoom))} (${Math.max(0, downsidePct).toFixed(1)}% room)`;
  const downsideColor = downsideTone === 'good'
    ? '#22c55e'
    : downsideTone === 'warn'
      ? '#f59e0b'
      : downsideTone === 'risk'
        ? '#ef4444'
        : undefined;

  useEffect(() => {
    if (!positionId || !Number.isFinite(currentValue) || currentValue <= 0) return;
    const latest = loadStoredPosition(positionId);
    if (!latest?.initialValue || latest.initialValue <= 0) {
      const next = { initialValue: currentValue, openedAt: Date.now() };
      saveStoredPosition(positionId, next);
      setStored(next);
      return;
    }

    setStored(latest);
  }, [positionId, currentValue]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(id);
  }, []);

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
          <p>{pos.strategy || 'DLMM'} | {totalBins || '-'} bins | step {pos.bin_step || '-'} | held {holdTime}</p>
        </div>
        <span className={`range-badge ${inRange ? 'ok' : 'risk'}`}>
          {inRange ? 'IN RANGE' : `OOR ${minutesOor}m`}
        </span>
      </div>

      <div className="position-summary-row" style={{ gridTemplateColumns: '1fr 1fr 1fr 1fr' }}>
        <div className="value-card">
          <span>Value</span>
          <b>{fmtUsd(pos.total_value_usd)}</b>
        </div>
        <div className="pnl-card">
          <span>PnL</span>
          <b className={pnl == null ? '' : pnl >= 0 ? 'positive' : 'negative'}>{pnlDisplay}</b>
        </div>
        <div className="peak-card">
          <span>Peak</span>
          <b className={peak == null ? '' : peak >= 0 ? 'positive' : 'negative'}>{peakDisplay}</b>
        </div>
        <div className="hold-time-card">
          <span>Hold time</span>
          <b style={{ color: '#f59e0b' }}>{holdTime}</b>
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
        <div className="range-meta" style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Active {fmtPrice(range.current)} {'\u00b7'} {pos.lower_bin ?? '-'} to {pos.upper_bin ?? '-'}</span>
          <span style={{ color: downsideColor, textAlign: 'right' }}>{downsideDisplay}</span>
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
