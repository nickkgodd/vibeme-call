import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Home from './pages/Home';
import Room from './pages/Room';

const isLocalHostLike = (hostname: string) => {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  if (hostname.startsWith('192.168.') || hostname.startsWith('10.')) return true;
  const match172 = hostname.match(/^172\.(\d{1,2})\./);
  if (match172) {
    const second = Number(match172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
};

export default function App() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const isLocal = isLocalHostLike(window.location.hostname);
    if (!isLocal && window.location.protocol !== 'https:') {
      window.location.replace(
        `https://${window.location.host}${window.location.pathname}${window.location.search}${window.location.hash}`
      );
    }
  }, []);

  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/home" element={<Home />} />
      <Route path="/room/:code" element={<Room />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

