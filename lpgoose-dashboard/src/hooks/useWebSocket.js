import { useState, useEffect, useRef } from 'react';

export function useWebSocket(url) {
  const [events, setEvents] = useState([]);
  const ws = useRef(null);

  useEffect(() => {
    function connect() {
      ws.current = new WebSocket(url);
      ws.current.onmessage = (e) => {
        const event = JSON.parse(e.data);
        setEvents(prev => [...prev.slice(-500), event]);
      };
      ws.current.onclose = () => setTimeout(connect, 3000);
    }
    connect();
    return () => ws.current?.close();
  }, [url]);

  return events;
}
