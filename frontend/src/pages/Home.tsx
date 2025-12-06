import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import Icon from '../components/Icon';

const sanitizeCode = (code: string) => code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

export default function Home() {
  const navigate = useNavigate();
  const [isJoinOpen, setJoinOpen] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const accentShadow = useMemo(
    () => ({
      boxShadow: '0 20px 60px rgba(16,185,129,0.35)'
    }),
    []
  );

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await fetch('/api/room', { method: 'POST' });
      if (!res.ok) throw new Error('Unable to create room');
      const data = (await res.json()) as { code: string };
      const code = sanitizeCode(data.code);
      setCreatedCode(code);
      toast.success('Room created');
      navigate(`/room/${code}`);
    } catch (err) {
      console.error(err);
      toast.error('Failed to create room. Try again.');
    } finally {
      setCreating(false);
    }
  };

  const handleJoin = async () => {
    const code = sanitizeCode(joinCode);
    if (code.length < 4) {
      toast.error('Enter a valid room code');
      return;
    }
    setChecking(true);
    try {
      const res = await fetch(`/api/room/${code}/exists`);
      if (!res.ok) throw new Error('Room check failed');
      const data = (await res.json()) as { exists: boolean; full?: boolean };
      if (!data.exists) {
        toast.error('Room not found');
        return;
      }
      if (data.full) {
        toast('Room full, try another', { icon: '🚪' });
        return;
      }
      navigate(`/room/${code}`);
    } catch (err) {
      console.error(err);
      toast.error('Unable to join right now');
    } finally {
      setChecking(false);
      setJoinOpen(false);
    }
  };

  const copyCode = () => {
    if (!createdCode) return;
    navigator.clipboard.writeText(createdCode).then(
      () => toast.success('Copied'),
      () => toast.error('Copy failed')
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-[#0d1425] to-[#0b1220] flex items-center justify-center px-6">
      <div className="max-w-4xl w-full text-center fade-in space-y-10">
        <header className="space-y-3">
          <p className="text-sm uppercase tracking-[0.4em] text-white/60">VibeME Call</p>
          <h1 className="text-4xl md:text-5xl font-extrabold leading-tight">
            Privacy-first P2P voice calling with zero friction
          </h1>
          <p className="text-white/70 max-w-2xl mx-auto">
            No accounts. No history. Share a secure room code and talk directly over encrypted
            peer-to-peer connections.
          </p>
        </header>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <button
            className="button-primary w-full sm:w-auto"
            style={accentShadow}
            onClick={handleCreate}
            disabled={creating}
          >
            {creating ? 'Creating…' : 'Create Room'}
          </button>
          <button
            className="button-secondary w-full sm:w-auto"
            onClick={() => setJoinOpen(true)}
            disabled={checking}
          >
            Join Room
          </button>
        </div>

        <div className="grid sm:grid-cols-3 gap-4 text-left text-white/80">
          <div className="glass p-4 rounded-xl">
            <p className="font-semibold text-white mb-1">No registration</p>
            <p className="text-sm text-white/60">Ephemeral sessions, nothing stored or logged.</p>
          </div>
          <div className="glass p-4 rounded-xl">
            <p className="font-semibold text-white mb-1">Secure P2P</p>
            <p className="text-sm text-white/60">
              Direct WebRTC with STUN-only by default for privacy.
            </p>
          </div>
          <div className="glass p-4 rounded-xl">
            <p className="font-semibold text-white mb-1">Fast start</p>
            <p className="text-sm text-white/60">
              Share an 8-char code. Auto-join with a single tap.
            </p>
          </div>
        </div>
      </div>

      <Modal open={isJoinOpen} onClose={() => setJoinOpen(false)} title="Join Room">
        <div className="space-y-4">
          <label className="block text-sm text-white/70">Enter room code</label>
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(sanitizeCode(e.target.value))}
            className="w-full rounded-lg bg-surface border border-white/10 px-4 py-3 outline-none focus:border-accent"
            placeholder="e.g. 8-char code"
            autoFocus
            maxLength={12}
          />
          <button className="button-primary w-full" onClick={handleJoin} disabled={checking}>
            {checking ? 'Checking…' : 'Join'}
          </button>
        </div>
      </Modal>

      <Modal open={Boolean(createdCode)} onClose={() => setCreatedCode(null)} title="Room Ready">
        <div className="space-y-3">
          <p className="text-white/70">Share this code securely with your friend</p>
          <div className="flex items-center gap-3 bg-surface border border-white/10 rounded-xl px-4 py-3">
            <span className="text-2xl font-semibold tracking-wide">{createdCode}</span>
            <button className="ml-auto button-ghost" onClick={copyCode}>
              <div className="flex items-center gap-2">
                <Icon name="copy" size={18} />
                <span>Copy</span>
              </div>
            </button>
          </div>
          <p className="text-sm text-white/50">
            You&apos;ll auto-join as the creator. Keep this tab open to accept peers.
          </p>
        </div>
      </Modal>
    </div>
  );
}

