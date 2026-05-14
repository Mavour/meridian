import { useEffect, useState } from 'react';

export default function Config() {
  const [config, setConfig] = useState({});

  useEffect(() => {
    fetch('/api/config').then(r=>r.json()).then(setConfig).catch(()=>{});
  }, []);

  const groups = {};
  for (const [k, v] of Object.entries(config)) {
    const cat = 'general';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push({ key: k, val: v });
  }

  return (
    <div style={{ padding:'12px 16px', maxWidth:1400 }}>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(320px, 1fr))', gap:16 }}>
        {Object.entries(groups).map(([group, items]) => (
          <div key={group} style={{ background:'#111', border:'0.5px solid #222', borderRadius:8, padding:16 }}>
            <div style={{ fontSize:13, fontWeight:600, color:'#a5b4fc', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:10 }}>{group}</div>
            {items.map(item => (
              <div key={item.key} style={{ display:'flex', justifyContent:'space-between', padding:'6px 0', borderBottom:'0.5px solid #1a1a1a', fontSize:12 }}>
                <span style={{ color:'#94a3b8' }}>{item.key}</span>
                <span style={{ color:'#f1f5f9', fontFamily:'JetBrains Mono, monospace' }}>
                  {typeof item.val === 'string' ? item.val : JSON.stringify(item.val)}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
