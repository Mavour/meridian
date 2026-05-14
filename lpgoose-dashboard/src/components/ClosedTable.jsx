function formatHold(minutes) {
  if (!minutes) return '-';
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

export default function ClosedTable({ rows = [] }) {
  return (
    <div className="table-card">
      <table>
        <thead>
          <tr>
            {['Token', 'PnL%', 'USD', 'Hold', 'Reason'].map((h) => <th key={h}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const pnlPct = Number(r.pnl_pct || 0);
            const pnlUsd = Number(r.pnl_usd || 0);
            return (
              <tr key={`${r.position || r.pool_name || 'row'}-${i}`}>
                <td className="token-cell">{r.pool_name || '-'}</td>
                <td className={pnlPct >= 0 ? 'positive' : 'negative'}>{pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%</td>
                <td className={pnlUsd >= 0 ? 'positive' : 'negative'}>{pnlUsd >= 0 ? '+' : ''}${Math.abs(pnlUsd).toFixed(2)}</td>
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
