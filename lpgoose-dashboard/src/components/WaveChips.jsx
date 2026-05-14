export default function WaveChips({ waves = {} }) {
  const sorted = Object.entries(waves)
    .filter(([, v]) => v.wins > 0)
    .sort((a, b) => (b[1].wins || 0) - (a[1].wins || 0))
    .slice(0, 18);

  if (sorted.length === 0) return <div className="empty-state">No winning waves yet</div>;

  return (
    <div className="wave-list">
      {sorted.map(([key, w]) => {
        const hasLoss = (w.losses || 0) > 0;
        return (
          <span key={key} className={`wave-chip ${hasLoss ? 'watch' : 'clean'}`}>
            <b>{w.symbol || key}</b>
            <span>x{w.wins}</span>
            {hasLoss && <em>{w.losses}L</em>}
          </span>
        );
      })}
    </div>
  );
}
