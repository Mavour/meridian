import { useEffect, useRef } from 'react';

const TAG_COLORS = {
  DEPLOY: 'tag-green',
  CLOSE: 'tag-blue',
  STATE: 'tag-amber',
  SCREENING: 'tag-violet',
  AGENT: 'tag-cyan',
  CRON: 'tag-muted',
  WARN: 'tag-orange',
  CLOSE_WARN: 'tag-orange',
  SAFETY_BLOCK: 'tag-red',
  WAVE_DEBUG: 'tag-violet',
  EXECUTOR: 'tag-muted',
  LESSONS: 'tag-green',
  POOL_MEMORY: 'tag-muted',
  SHUTDOWN: 'tag-red',
  SWAP: 'tag-muted',
};

export default function LogTerminal({ lines = [], maxHeight = 260, compact = false }) {
  const containerRef = useRef(null);
  const autoScroll = useRef(true);

  useEffect(() => {
    const el = containerRef.current;
    if (autoScroll.current && el) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, [lines]);

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    autoScroll.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
  };

  return (
    <div ref={containerRef} onScroll={onScroll} className={`log-terminal ${compact ? 'compact' : ''}`} style={{ maxHeight }}>
      {lines.length === 0 && <div className="empty-state">No log lines yet</div>}
      {lines.map((l, i) => (
        <div key={`${l.time || 'line'}-${i}`} className="log-row">
          <span className="log-time">{l.time}</span>
          <span className={`log-tag ${TAG_COLORS[l.tag] || 'tag-muted'}`}>{l.tag}</span>
          <span className="log-msg">{l.msg}</span>
        </div>
      ))}
    </div>
  );
}
