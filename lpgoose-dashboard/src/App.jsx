import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { useState, useEffect, useRef, createContext, useContext } from 'react';
import Topbar from './components/Topbar';
import Dashboard from './pages/Dashboard';
import Logs from './pages/Logs';
import Performance from './pages/Performance';
import Pools from './pages/Pools';
import Config from './pages/Config';

export const WSContext = createContext(null);

export default function App() {
  const [events, setEvents] = useState([]);
  const [botAlive, setBotAlive] = useState(true);
  const ws = useRef(null);

  useEffect(() => {
    function connect() {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws.current = new WebSocket(`${proto}://${window.location.host}/ws`);
      ws.current.onmessage = (e) => {
        const ev = JSON.parse(e.data);
        if (ev.type === 'bot_status') { setBotAlive(ev.data.alive); return; }
        setEvents(prev => [...prev.slice(-800), ev]);
      };
      ws.current.onclose = () => { setBotAlive(false); setTimeout(connect, 3000); };
    }
    connect();
    return () => ws.current?.close();
  }, []);

  return (
    <WSContext.Provider value={{ events, botAlive }}>
      <BrowserRouter>
        <Topbar botAlive={botAlive} />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/performance" element={<Performance />} />
          <Route path="/pools" element={<Pools />} />
          <Route path="/config" element={<Config />} />
        </Routes>
      </BrowserRouter>
    </WSContext.Provider>
  );
}
