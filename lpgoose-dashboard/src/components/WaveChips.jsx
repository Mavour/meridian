export default function WaveChips({ waves = {} }) {
  const sorted = Object.entries(waves)
    .filter(([, v]) => v.wins > 0)
    .sort((a, b) => (b[1].wins||0) - (a[1].wins||0));

  return (
    <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
      {sorted.map(([key, w]) => {
        const hasLoss = (w.losses||0) > 0;
        const style = hasLoss
          ? { background:'#1c1400', color:'#fbbf24', border:'0.5px solid #78350f' }
          : { background:'#052e16', color:'#4ade80', border:'0.5px solid #166534' };
        return (
          <span key={key} style={{ fontSize:11, padding:'3px 10px', borderRadius:20, fontWeight:500, ...style }}>
            {w.symbol||key} ×{w.wins} {hasLoss ? `⚠ ${w.losses}L` : '✓'}
          </span>
        );
      })}
    </div>
  );
}
