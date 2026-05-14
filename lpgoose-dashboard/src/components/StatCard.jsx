export default function StatCard({ label, value, color, sub }) {
  return (
    <div style={{ background:'#111', border:'0.5px solid #222', borderRadius:8, padding:'14px 16px' }}>
      <div style={{ fontSize:10, color:'#475569', textTransform:'uppercase', letterSpacing:'0.8px', marginBottom:8 }}>{label}</div>
      <div style={{ fontSize:24, fontWeight:600, lineHeight:1, color: color||'#f1f5f9' }}>{value}</div>
      {sub && <div style={{ fontSize:11, color:'#475569', marginTop:4 }}>{sub}</div>}
    </div>
  );
}
