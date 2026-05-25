function formatHold(minutes) {
  if (!minutes) return '-';
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

export default function ClosedTable({ rows = [] }) {
  const unit = rows[0]?.pnl_display_unit || 'USD';
  return (
    <div className="table-card">
      <table>
        <thead>
          <tr>
            {['Token', 'PnL%', unit, 'Hold', 'Reason'].map((h) => <th key={h}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const pnlPct = Number(r.pnl_pct || 0);
            const pnlValue = Number(r.pnl_display_value ?? r.pnl_amount ?? r.pnl_usd ?? 0);
            const prefix = (r.pnl_display_unit || unit) === 'USD' ? '$' : '';
            const suffix = (r.pnl_display_unit || unit) === 'USD' ? '' : ' SOL';
            return (
              <tr key={`${r.position || r.pool_name || 'row'}-${i}`}>
                <td className="token-cell">{r.pool_name || '-'}</td>
                <td className={pnlPct >= 0 ? 'positive' : 'negative'}>{pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%</td>
                <td className={pnlValue >= 0 ? 'positive' : 'negative'}>{pnlValue >= 0 ? '+' : ''}{prefix}{Math.abs(pnlValue).toFixed((r.pnl_display_unit || unit) === 'USD' ? 2 : 4)}{suffix}</td>
                <td>{formatHold(r.minutes_held)}</td>
                <td className="reason-cell">{r.close_reason || '-'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
