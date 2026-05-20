import { useEffect, useState, useContext, useRef } from 'react';
import { WSContext } from '../App';

const TAG_COLORS = {
  DEPLOY:'#4ade80', CLOSE:'#60a5fa', STATE:'#fbbf24',
  SCREENING:'#c084fc', AGENT:'#22d3ee', CRON:'#475569',
  POSITIONS:'#60a5fa',
  WARN:'#fb923c', CLOSE_WARN:'#fb923c',
  SAFETY_BLOCK:'#f87171', WAVE_DEBUG:'#818cf8',
  EXECUTOR:'#94a3b8', LESSONS:'#86efac',
  POOL_MEMORY:'#64748b', SHUTDOWN:'#ef4444', SWAP:'#94a3b8',
};

export default function Logs() {
  const { events, botAlive } = useContext(WSContext);
  const [logLines, setLogLines] = useState([]);
  const [tagFilter, setTagFilter] = useState(null);
  const [search, setSearch] = useState('');
  const bottomRef = useRef(null);
  const autoScroll = useRef(true);

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const params = new URLSearchParams({ n: '500' });
        if (tagFilter) params.set('tag', tagFilter);
        const r = await fetch(`/api/logs?${params}`);
        const d = await r.json();
        setLogLines(d.lines || []);
      } catch {}
    };
    fetchLogs();
  }, [tagFilter]);

  useEffect(() => {
    const last = events[events.length - 1];
    if (last && last.type === 'log') {
      if (tagFilter && last.data?.tag !== tagFilter) return;
      setLogLines(prev => [...prev.slice(-1000), last.data]);
    }
  }, [events, tagFilter]);

  useEffect(() => {
    if (autoScroll.current) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logLines]);

  const filtered = search
    ? logLines.filter(l => l.msg?.toLowerCase().includes(search.toLowerCase()))
    : logLines;

  const tags = ['DEPLOY','CLOSE','STATE','POSITIONS','SCREENING','AGENT','WARN','SAFETY_BLOCK','EXECUTOR','LESSONS','SHUTDOWN','SWAP'];

  return (
    <div style={{ padding:'12px 16px', maxWidth:1400, minHeight:'calc(100vh - 58px)', overflow:'visible' }}>
      <div style={{ display:'flex', gap:8, marginBottom:12, flexWrap:'wrap', alignItems:'center' }}>
        <input
          placeholder="Search logs..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ background:'#161616', border:'0.5px solid #222', borderRadius:5, padding:'6px 10px', fontSize:12, color:'#f1f5f9', width:200, outline:'none' }}
        />
        <button onClick={() => { setTagFilter(null); setSearch(''); }}
          style={{ background: !tagFilter ? '#1e1b4b' : 'transparent', border:'0.5px solid #333', borderRadius:5, padding:'4px 10px', fontSize:11, color: !tagFilter ? '#a5b4fc' : '#64748b', cursor:'pointer' }}>
          All
        </button>
        {tags.map(t => (
          <button key={t} onClick={() => setTagFilter(tagFilter === t ? null : t)}
            style={{ background: tagFilter === t ? '#1e1b4b' : 'transparent', border:'0.5px solid #333', borderRadius:5, padding:'4px 10px', fontSize:11, color: tagFilter === t ? '#a5b4fc' : '#64748b', cursor:'pointer' }}>
            {t}
          </button>
        ))}
        <span style={{ fontSize:11, color:'#475569', marginLeft:'auto' }}>{filtered.length} lines</span>
      </div>

      <div style={{
        background:'#0d0d0d',
        border:'0.5px solid #1a1a1a',
        borderRadius:8,
        padding:'10px 12px',
        maxHeight:'calc(100vh - 120px)',
        overflowY:'scroll',
        WebkitOverflowScrolling:'touch',
        overscrollBehavior:'contain',
        scrollbarWidth:'thin',
        scrollbarColor:'#222 transparent',
      }}
        onScroll={e => { const el = e.currentTarget; autoScroll.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40; }}>
        {filtered.map((l, i) => (
          <div key={i} style={{ display:'grid', gridTemplateColumns:'80px 130px 1fr', gap:10, padding:'2px 0', borderBottom:'0.5px solid #111', fontSize:11, lineHeight:1.7 }}>
            <span style={{ color:'#334155' }}>{l.time}</span>
            <span style={{ color: TAG_COLORS[l.tag]||'#64748b', fontWeight: ['DEPLOY','CLOSE','SCREENING','SAFETY_BLOCK','SHUTDOWN'].includes(l.tag) ? 600 : 400 }}>
              [{l.tag}]
            </span>
            <span style={{ color:'#64748b', wordBreak:'break-word' }}>{l.msg}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
