import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { io, Socket } from 'socket.io-client';
import { v4 as uuidv4 } from 'uuid';
import Icon from '../components/Icon';
import { getBooleanPref, setBooleanPref } from '../utils/storage';

type Participant = { userId: string; name: string };

type JoinResponse =
  | { ok: true; participants: Participant[]; name: string }
  | { ok: false; reason?: string };

type SignalOffer = { from: string; description: RTCSessionDescriptionInit };
type SignalAnswer = { from: string; description: RTCSessionDescriptionInit };
type SignalCandidate = { from: string; candidate: RTCIceCandidateInit };

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

const SIGNALING_URL =
  import.meta.env.VITE_SIGNALING_URL ||
  (typeof window !== 'undefined' ? `${window.location.origin.replace(/\/$/, '')}` : '');

const STUN_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const ROOM_LIMIT = 4;

export default function Room() {
  const params = useParams<{ code: string }>();
  const navigate = useNavigate();
  const turnUrl = import.meta.env.VITE_TURN_URL;
  const turnUsername = import.meta.env.VITE_TURN_USERNAME;
  const turnPassword = import.meta.env.VITE_TURN_PASSWORD;

  const roomCode = useMemo(
    () => (params.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, ''),
    [params.code]
  );

  const iceServers = useMemo<RTCIceServer[]>(() => {
    const servers: RTCIceServer[] = [...STUN_SERVERS];
    if (turnUrl) {
      servers.push({
        urls: turnUrl,
        username: turnUsername,
        credential: turnPassword
      });
    }
    return servers;
  }, [turnPassword, turnUrl, turnUsername]);

  const [participants, setParticipants] = useState<Participant[]>([]);
  const [self, setSelf] = useState<Participant | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [muted, setMuted] = useState(getBooleanPref('vibeme-mute', false));
  const [speakerOn, setSpeakerOn] = useState(getBooleanPref('vibeme-speaker', false));
  const [isLeaving, setIsLeaving] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [requestingMedia, setRequestingMedia] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnections = useRef(new Map<string, RTCPeerConnection>());
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());
  const userIdRef = useRef<string>('');
  const sinkWarningShown = useRef(false);
  const joinedRef = useRef(false);

  useEffect(() => {
    if (!roomCode) {
      navigate('/');
      return;
    }

    let cancelled = false;
    const socket = io(SIGNALING_URL, {
      transports: ['websocket'],
      reconnectionAttempts: 3,
      reconnectionDelay: 1000
    });
    socketRef.current = socket;

    const handleDisconnect = (reason: string) => {
      if (isLeaving) return;
      toast.error(`Disconnected (${reason}). Reconnecting…`);
    };
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', () => toast.error('Signaling unreachable'));

    const requestMediaAndJoin = async () => {
      try {
        setRequestingMedia(true);
        setMediaError(null);

        const insecureContext =
          typeof window !== 'undefined' &&
          !window.isSecureContext &&
          !isLocalHostLike(window.location.hostname);
        if (insecureContext) {
          throw new Error(
            'Для доступа к микрофону нужен HTTPS (или localhost). Откройте страницу по HTTPS или через туннель.'
          );
        }

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) return;
        localStreamRef.current = stream;
        stream.getAudioTracks().forEach((track) => (track.enabled = !muted));
        userIdRef.current = userIdRef.current || uuidv4();

        if (!joinedRef.current) {
          socket.emit(
            'join-room',
            { roomCode, userId: userIdRef.current },
            (res: JoinResponse) => {
              if (!res?.ok) {
                setMediaError(res?.reason || 'Unable to join room');
                toast.error(res?.reason || 'Unable to join room');
                return;
              }
              joinedRef.current = true;
              setSelf({ userId: userIdRef.current, name: res.name });
              setParticipants([{ userId: userIdRef.current, name: res.name }, ...res.participants]);

              // Initiate offers to existing members
              res.participants.forEach((p) => {
                createPeerConnection(p.userId, p.name, true);
              });
            }
          );
        }
      } catch (err) {
        console.error(err);
        const message =
          err instanceof Error ? err.message : 'Allow mic for calling (разрешите микрофон)';
        setMediaError(message);
        toast.error('Allow mic for calling');
      } finally {
        setRequestingMedia(false);
      }
    };

    requestMediaAndJoin();

    return () => {
      cancelled = true;
      leaveRoom();
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;

    const onOffer = async ({ from, description }: SignalOffer) => {
      const pc = createPeerConnection(from, participantName(from), false);
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(description));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { roomCode, to: from, description: pc.localDescription });
    };

    const onAnswer = async ({ from, description }: SignalAnswer) => {
      const pc = peerConnections.current.get(from);
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(description));
    };

    const onCandidate = async ({ from, candidate }: SignalCandidate) => {
      const pc = peerConnections.current.get(from);
      if (!pc || !candidate) return;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('ICE add failed', err);
      }
    };

    const onUserJoined = ({ userId, name }: Participant) => {
      setParticipants((prev) => {
        if (prev.find((p) => p.userId === userId)) return prev;
        return [...prev, { userId, name }];
      });
    };

    const onUserLeft = ({ userId }: { userId: string }) => {
      closePeer(userId);
      setParticipants((prev) => prev.filter((p) => p.userId !== userId));
      setRemoteStreams((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
    };

    socket.on('offer', onOffer);
    socket.on('answer', onAnswer);
    socket.on('ice-candidate', onCandidate);
    socket.on('user-joined', onUserJoined);
    socket.on('user-left', onUserLeft);

    return () => {
      socket.off('offer', onOffer);
      socket.off('answer', onAnswer);
      socket.off('ice-candidate', onCandidate);
      socket.off('user-joined', onUserJoined);
      socket.off('user-left', onUserLeft);
    };
  }, [roomCode]);

  useEffect(() => {
    // Apply speaker preference when streams mount
    audioRefs.current.forEach((audio) => applySinkPreference(audio));
  }, [speakerOn, remoteStreams]);

  useEffect(() => {
    const handleUnload = () => leaveRoom();
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const participantName = (userId: string) =>
    participants.find((p) => p.userId === userId)?.name || 'Guest';

  const createPeerConnection = (peerId: string, peerName: string, initiator: boolean) => {
    if (peerConnections.current.has(peerId)) {
      return peerConnections.current.get(peerId)!;
    }
    const stream = localStreamRef.current;
    if (!stream) {
      toast.error('Mic not ready');
      return null;
    }

    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'all' });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current?.emit('ice-candidate', {
          roomCode,
          to: peerId,
          candidate: event.candidate.toJSON()
        });
      }
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams.length ? event.streams : [new MediaStream([event.track])];
      setRemoteStreams((prev) => ({ ...prev, [peerId]: stream }));
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        closePeer(peerId);
      }
    };

    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    peerConnections.current.set(peerId, pc);

    if (initiator) {
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          socketRef.current?.emit('offer', {
            roomCode,
            to: peerId,
            description: pc.localDescription
          });
        })
        .catch((err) => console.error('Offer failed', err));
    }

    return pc;
  };

  const closePeer = (peerId: string) => {
    const pc = peerConnections.current.get(peerId);
    if (pc) {
      pc.close();
      peerConnections.current.delete(peerId);
    }
    const audio = audioRefs.current.get(peerId);
    if (audio) {
      audio.srcObject = null;
      audioRefs.current.delete(peerId);
    }
  };

  const leaveRoom = () => {
    if (isLeaving) return;
    setIsLeaving(true);
    socketRef.current?.emit('leave-room', { roomCode, userId: userIdRef.current });
    peerConnections.current.forEach((_, id) => closePeer(id));
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    socketRef.current?.disconnect();
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    setBooleanPref('vibeme-mute', next);
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
  };

  const applySinkPreference = (audio: HTMLAudioElement) => {
    if (!audio || typeof (audio as any).setSinkId !== 'function') {
      if (!sinkWarningShown.current) {
        sinkWarningShown.current = true;
        toast.error('Speaker switch not supported on this device');
      }
      return;
    }
    const target = speakerOn ? 'communications' : 'default';
    (audio as any)
      .setSinkId(target)
      .catch(() => {
        if (!sinkWarningShown.current) {
          sinkWarningShown.current = true;
          toast.error('Speaker switch not supported on this device');
        }
      });
  };

  const toggleSpeaker = () => {
    const next = !speakerOn;
    setSpeakerOn(next);
    setBooleanPref('vibeme-speaker', next);
  };

  const handleLeave = () => {
    leaveRoom();
    navigate('/');
  };

  const gridClass =
    participants.length <= 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-2 sm:grid-cols-2';

  return (
    <div className="min-h-screen flex flex-col bg-background text-white">
      {mediaError && (
        <div className="p-4 bg-danger/20 text-white border-b border-danger/40 flex flex-col gap-2">
          <p className="font-semibold">Нужен доступ к микрофону</p>
          <p className="text-sm text-white/80">{mediaError}</p>
          <div className="flex flex-wrap gap-2 items-center">
            <button
              className="button-primary px-4 py-2"
              onClick={async () => {
                try {
                  setMediaError(null);
                  setRequestingMedia(true);
                  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                  localStreamRef.current = stream;
                  stream.getAudioTracks().forEach((t) => (t.enabled = !muted));
                  if (!joinedRef.current && socketRef.current) {
                    userIdRef.current = userIdRef.current || uuidv4();
                    socketRef.current.emit(
                      'join-room',
                      { roomCode, userId: userIdRef.current },
                      (res: JoinResponse) => {
                        if (!res?.ok) {
                          setMediaError(res?.reason || 'Unable to join room');
                          toast.error(res?.reason || 'Unable to join room');
                          return;
                        }
                        joinedRef.current = true;
                        setSelf({ userId: userIdRef.current, name: res.name });
                        setParticipants([
                          { userId: userIdRef.current, name: res.name },
                          ...res.participants
                        ]);
                        res.participants.forEach((p) => createPeerConnection(p.userId, p.name, true));
                      }
                    );
                  }
                } catch (e) {
                  const msg =
                    e instanceof Error
                      ? e.message
                      : 'Разрешите микрофон в браузере или используйте HTTPS';
                  setMediaError(msg);
                  toast.error('Allow mic for calling');
                } finally {
                  setRequestingMedia(false);
                }
              }}
              disabled={requestingMedia}
            >
              {requestingMedia ? 'Запрос…' : 'Запросить доступ к микрофону'}
            </button>
            <span className="text-xs text-white/70">
              Если вы на телефоне по Wi‑Fi, нужен HTTPS/secure context. Можно запустить через
              локальный туннель (ngrok/cloudflared) или собственный сертификат.
            </span>
          </div>
        </div>
      )}
      <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 p-4 border-b border-white/10">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-white/50">Room</p>
          <div className="flex items-center gap-2">
            <span className="text-2xl font-semibold tracking-wide">{roomCode}</span>
            <span className="text-xs text-white/50 border border-white/10 rounded-full px-2 py-1">
              max {ROOM_LIMIT}
            </span>
          </div>
        </div>
        <div className="flex -space-x-2">
          {participants.map((p) => (
            <div
              key={p.userId}
              className="w-10 h-10 rounded-full bg-accent/20 border border-accent/50 flex items-center justify-center text-sm font-semibold"
              title={p.name}
            >
              {p.name.slice(0, 2).toUpperCase()}
            </div>
          ))}
        </div>
      </header>

      <main className="flex-1 p-4">
        <div className={`grid ${gridClass} gap-4`}>
          {participants
            .filter((p) => p.userId !== self?.userId)
            .map((p) => (
              <div
                key={p.userId}
                className="relative rounded-2xl glass p-4 flex flex-col justify-end overflow-hidden min-h-[200px]"
              >
                <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent" />
                <div className="relative z-10">
                  <p className="text-lg font-semibold">{p.name}</p>
                  <p className="text-xs text-white/50">{p.userId.slice(0, 6)}</p>
                </div>
                <audio
                  ref={(node) => {
                    if (node && remoteStreams[p.userId]) {
                      node.srcObject = remoteStreams[p.userId];
                      node.autoplay = true;
                      node.playsInline = true;
                      node.muted = false;
                      audioRefs.current.set(p.userId, node);
                      applySinkPreference(node);
                    }
                  }}
                />
              </div>
            ))}

          {!participants.find((p) => p.userId !== self?.userId) && (
            <div className="rounded-2xl border border-dashed border-white/10 p-6 flex items-center justify-center text-white/60">
              Waiting for peers to join…
            </div>
          )}
        </div>
      </main>

      <footer className="p-4 border-t border-white/10 sticky bottom-0 bg-background/95 backdrop-blur">
        <div className="flex flex-wrap items-center justify-center gap-4">
          <button
            className={`button-ghost flex items-center gap-2 ${muted ? 'bg-danger/20 border-danger/40' : ''}`}
            onClick={toggleMute}
          >
            <Icon name={muted ? 'mic-off' : 'mic'} />
            <span>{muted ? 'Unmute' : 'Mute'}</span>
          </button>
          <button
            className="button-ghost flex items-center gap-2"
            onClick={toggleSpeaker}
            title="Toggle speaker mode"
          >
            <Icon name={speakerOn ? 'volume-off' : 'volume'} />
            <span>Speaker {speakerOn ? 'Off' : 'On'}</span>
          </button>
          <button
            className="button-primary bg-danger hover:bg-danger/90 flex items-center gap-2"
            onClick={handleLeave}
          >
            <Icon name="phone" />
            <span>Leave</span>
          </button>
        </div>
      </footer>
    </div>
  );
}

