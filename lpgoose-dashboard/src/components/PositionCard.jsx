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

function rangeSidePct(current, edge, direction) {
  if (!Number.isFinite(current) || !Number.isFinite(edge) || current <= 0) return null;
  const raw = direction === 'down'
    ? ((current - edge) / current) * 100
    : ((edge - current) / current) * 100;
  return Math.max(0, raw);
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

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 768px)').matches : false
  );

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const query = window.matchMedia('(max-width: 768px)');
    const onChange = () => setIsMobile(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}

export default function PositionCard({ pos, peakPnl = null }) {
  const positionId = pos.position || pos.position_address || pos.id;
  const currentValue = Number(pos.total_value_usd);
  const [stored, setStored] = useState(() => loadStoredPosition(positionId));
  const [now, setNow] = useState(() => Date.now());
  const isMobile = useIsMobile();
  const range = pos.price_range || {};
  const markerPct = rangeMarkerPct(range);
  const currentPrice = Number(range.current);
  const lowerPrice = Number(range.min);
  const upperPrice = Number(range.max);
  const downsideCover = Number.isFinite(upperPrice) && Number.isFinite(lowerPrice)
    ? upperPrice - lowerPrice
    : null;
  const downsidePct = downsideCover != null && Number.isFinite(upperPrice) && upperPrice > 0
    ? (downsideCover / upperPrice) * 100
    : null;
  const downsideTone = downsidePct == null ? '' : downsidePct > 30 ? 'good' : downsidePct >= 10 ? 'warn' : 'risk';
  const rangeDownPct = rangeSidePct(currentPrice, lowerPrice, 'down');
  const rangeUpPct = rangeSidePct(currentPrice, upperPrice, 'up');
  const splitRangeDisplay = rangeDownPct == null || rangeUpPct == null
    ? '- / -'
    : `-${rangeDownPct.toFixed(1)}% / +${rangeUpPct.toFixed(1)}%`;
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
  const downsideDisplay = downsideCover == null || downsidePct == null
    ? 'Downside cover: -'
    : `Downside cover: -${fmtPrice(Math.max(0, downsideCover))} (${Math.max(0, downsidePct).toFixed(1)}%)`;
  const downsideColor = downsideTone === 'good'
    ? '#22c55e'
    : downsideTone === 'warn'
      ? '#f59e0b'
      : downsideTone === 'risk'
        ? '#ef4444'
        : undefined;
  const ellipsis = {
    minWidth: 0,
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };
  const rangeMetaStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    gap: isMobile ? 2 : 12,
    flexDirection: isMobile ? 'column' : 'row',
    alignItems: isMobile ? 'flex-start' : 'center',
  };
  const rangeLabelStyle = {
    ...ellipsis,
    fontSize: isMobile ? 9 : undefined,
  };
  const activeLabelLeft = `${clamp(markerPct, isMobile ? 18 : 10, isMobile ? 82 : 90)}%`;
  const holdingsGridStyle = isMobile ? { gridTemplateColumns: '1fr 1fr', gap: 7 } : undefined;
  const holdingValueStyle = isMobile ? { ...ellipsis, fontSize: 12 } : ellipsis;
  const holdingDetailStyle = isMobile ? { ...ellipsis, fontSize: 11 } : ellipsis;

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
    <article className={`position-card ${inRange ? 'in-range' : 'out-range'}`} style={isMobile ? { padding: 10, maxWidth: '100%', overflow: 'hidden' } : undefined}>
      <div className="position-head">
        <div style={{ minWidth: 0, maxWidth: '100%' }}>
          <h3 className="pair-name" style={ellipsis}>{pos.pair}</h3>
          <p style={ellipsis}>{pos.strategy || 'DLMM'} | {totalBins || '-'} bins | step {pos.bin_step || '-'} | held {holdTime}</p>
        </div>
        <span className={`range-badge ${inRange ? 'ok' : 'risk'}`}>
          {inRange ? 'IN RANGE' : `OOR ${minutesOor}m`}
        </span>
      </div>

      <div className="position-summary-row" style={{ gridTemplateColumns: isMobile ? '1fr 1fr' : '1fr 1fr 1fr 1fr' }}>
        <div className="value-card">
          <span>Value</span>
          <b style={ellipsis}>{fmtUsd(pos.total_value_usd)}</b>
        </div>
        <div className="pnl-card">
          <span>PnL</span>
          <b className={pnl == null ? '' : pnl >= 0 ? 'positive' : 'negative'} style={ellipsis}>{pnlDisplay}</b>
        </div>
        <div className="peak-card">
          <span>Peak</span>
          <b className={peak == null ? '' : peak >= 0 ? 'positive' : 'negative'} style={ellipsis}>{peakDisplay}</b>
        </div>
        <div className="hold-time-card">
          <span>Hold time</span>
          <b style={{ ...ellipsis, color: '#f59e0b' }}>{holdTime}</b>
        </div>
      </div>

      <div className="price-range-block">
        <div className="range-values range-values-anchored">
          <span style={rangeLabelStyle}>{fmtPrice(range.min)}</span>
          <span className="range-current-label" style={{ left: activeLabelLeft }}>{fmtPrice(range.current)}</span>
          <span style={{ ...rangeLabelStyle, textAlign: 'right' }}>{fmtPrice(range.max)}</span>
        </div>
        <div className={sliderClass} aria-label="Position price range">
          <span className="price-slider-fill" />
          <i className="price-marker" style={{ left: `${markerPct}%` }} />
        </div>
        <div className="range-meta" style={rangeMetaStyle}>
          <span style={ellipsis}>Active {pos.active_bin ?? '-'} {'\u00b7'} {pos.lower_bin ?? '-'} to {pos.upper_bin ?? '-'}</span>
          <span style={{ ...ellipsis, color: downsideColor, textAlign: isMobile ? 'left' : 'right' }}>{downsideDisplay}</span>
        </div>
        <div className="range-split" aria-label="Downside and upside room">
          <span>{splitRangeDisplay}</span>
        </div>
      </div>

      <div className="holdings-grid" style={holdingsGridStyle}>
        <div>
          <span>{tokenX.symbol || 'Token'}</span>
          <b style={holdingValueStyle}>{fmtAmount(tokenX.amount, tokenX.symbol)}</b>
        </div>
        <div>
          <span>{tokenY.symbol || 'SOL'}</span>
          <b style={holdingValueStyle}>{fmtAmount(tokenY.amount, tokenY.symbol || 'SOL')}</b>
        </div>
        <div style={isMobile ? { gridColumn: '1 / -1' } : undefined}>
          <span>Unclaimed fees</span>
          <b className="positive" style={holdingValueStyle}>{fmtUsd(unclaimedUsd)}</b>
          <em style={holdingDetailStyle}>{Number.isFinite(Number(feePct)) ? `${Number(feePct).toFixed(2)}% of input` : feeDetail || '-'}</em>
        </div>
        <div style={isMobile ? { gridColumn: '1 / -1' } : undefined}>
          <span>Claimed total</span>
          <b style={holdingValueStyle}>{fmtUsd(claimedUsd)}</b>
          <em style={holdingDetailStyle}>{feeDetail || 'Harvested fees'}</em>
        </div>
      </div>
    </article>
  );
}
