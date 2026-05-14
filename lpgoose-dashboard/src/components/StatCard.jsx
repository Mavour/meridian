export default function StatCard({ label, value, tone = 'neutral', sub }) {
  return (
    <section className={`stat-card ${tone}`}>
      <div className="card-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </section>
  );
}
