import { useEffect, useRef } from 'react';

const TAG_COLORS = {
  DEPLOY:'#4ade80', CLOSE:'#60a5fa', STATE:'#fbbf24',
  SCREENING:'#c084fc', AGENT:'#22d3ee', CRON:'#475569',
  WARN:'#fb923c', CLOSE_WARN:'#fb923c',
  SAFETY_BLOCK:'#f87171', WAVE_DEBUG:'#818cf8',
  EXECUTOR:'#94a3b8', LESSONS:'#86efac',
  POOL_MEMORY:'#64748b', SHUTDOWN:'#ef4444', SWAP:'#94a3b8',
};

export default function LogTerminal({ lines = [], maxHeight = 260 }) {
  const bottomRef = useRef(null);
  const containerRef = useRef(null);
  const autoScroll = useRef(true);

  useEffect(() => {
    if (autoScroll.current) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    autoScroll.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
  };

  return (
    <div ref={containerRef} onScroll={onScroll} style={{
      background:'#0d0d0d', border:'0.5px solid #1a1a1a', borderRadius:8,
      padding:'10px 12px', maxHeight, overflowY:'auto',
      scrollbarWidth:'thin', scrollbarColor:'#222 transparent',
    }}>
      {lines.map((l, i) => (
        <div key={i} style={{ display:'grid', gridTemplateColumns:'70px 120px 1fr', gap:10, padding:'2px 0', borderBottom:'0.5px solid #111', fontSize:11, lineHeight:1.7 }}>
          <span style={{ color:'#334155' }}>{l.time}</span>
          <span style={{ color: TAG_COLORS[l.tag]||'#64748b', fontWeight: ['DEPLOY','CLOSE','SCREENING','SAFETY_BLOCK','SHUTDOWN'].includes(l.tag) ? 600 : 400 }}>
            [{l.tag}]
          </span>
          <span style={{ color:'#64748b', wordBreak:'break-word' }}>{l.msg}</span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
