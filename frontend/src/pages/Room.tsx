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
type QualityLevel = 'good' | 'warn' | 'bad';

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

const computeSignalingUrl = () => {
  const envUrl = import.meta.env.VITE_SIGNALING_URL;
  const hostname = typeof window !== 'undefined' ? window.location.hostname : '';
  const pagesFallback = hostname.includes('pages.dev')
    ? 'https://vibeme-call.onrender.com'
    : undefined;
  return (envUrl || pagesFallback || (typeof window !== 'undefined'
    ? `${window.location.origin.replace(/\/$/, '')}`
    : '')
  ).replace(/\/$/, '');
};

const SIGNALING_URL = computeSignalingUrl();

const STUN_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: true },
    autoGainControl: { ideal: true },
    googEchoCancellation: true,
    googAutoGainControl: true,
    googNoiseSuppression: true,
    googNoiseSuppression2: true,
    sampleRate: 48000,
    channelCount: 1
  }
};
const ROOM_LIMIT = 4;
const LAST_ROOM_KEY = 'vibeme-last-room';
const REJOIN_WINDOW_MS = 10_000;
const SPEAKING_THRESHOLD_DB = -40;
const SPEAKING_DEBOUNCE_MS = 200;

const buzz = (duration = 50) => {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate(duration);
  }
};

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
  const [noiseCancelOn, setNoiseCancelOn] = useState(true);
  const [isLeaving, setIsLeaving] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [requestingMedia, setRequestingMedia] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'waiting' | 'in-call' | 'reconnecting'>('connecting');
  const [showRejoin, setShowRejoin] = useState(false);
  const [quality, setQuality] = useState<{ level: QualityLevel; jitter: number; loss: number }>({
    level: 'good',
    jitter: 0,
    loss: 0
  });
  const [showQualityTip, setShowQualityTip] = useState(false);
  const [speakingMap, setSpeakingMap] = useState<Record<string, boolean>>({});

  const socketRef = useRef<Socket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnections = useRef(new Map<string, RTCPeerConnection>());
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());
  const userIdRef = useRef<string>('');
  const joinedRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const vadNodesRef = useRef<Map<string, AnalyserNode>>(new Map());
  const vadDataRef = useRef<Map<string, Float32Array>>(new Map());
  const vadTimersRef = useRef<Map<string, number>>(new Map());
  const vadActiveRef = useRef<Map<string, number>>(new Map());
  const statsIntervalRef = useRef<number | null>(null);
  const qualityTipTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (!roomCode) {
      navigate('/');
      return;
    }

    let cancelled = false;
    const socket = io(SIGNALING_URL, {
      transports: ['websocket'],
      reconnectionAttempts: 10,
      reconnectionDelay: 800,
      reconnectionDelayMax: 6000
    });
    socketRef.current = socket;
    setConnectionStatus('connecting');

    const handleDisconnect = (reason: string) => {
      if (isLeaving) return;
      setConnectionStatus('reconnecting');
      setShowRejoin(true);
      sessionStorage.setItem(LAST_ROOM_KEY, JSON.stringify({ code: roomCode, ts: Date.now() }));
      toast.error(`Disconnected (${reason}). Reconnecting…`);
      setTimeout(() => setShowRejoin(false), REJOIN_WINDOW_MS);
    };
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', () => {
      setConnectionStatus('reconnecting');
      toast.error('Signaling unreachable');
    });
    socket.on('reconnect', () => {
      if (!isLeaving) {
        setConnectionStatus('connecting');
        toast('Reconnected', { icon: '🔄' });
      }
    });

    const emitJoin = (socketInstance: Socket) => {
      socketInstance.emit(
        'join-room',
        { roomCode, userId: userIdRef.current },
        (res: JoinResponse) => {
          if (!res?.ok) {
            setMediaError(res?.reason || 'Unable to join room');
            toast.error(res?.reason || 'Unable to join room');
            return;
          }
          joinedRef.current = true;
          setConnectionStatus(res.participants.length ? 'in-call' : 'waiting');
          setSelf({ userId: userIdRef.current, name: res.name });
          peerConnections.current.forEach((_, id) => closePeer(id));
          setRemoteStreams({});
          setSpeakingMap({});
          setParticipants([{ userId: userIdRef.current, name: res.name }, ...res.participants]);
          sessionStorage.setItem(LAST_ROOM_KEY, JSON.stringify({ code: roomCode, ts: Date.now() }));
          if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
            Notification.requestPermission().catch(() => undefined);
          }
          res.participants.forEach((p) => {
            createPeerConnection(p.userId, p.name, true);
          });
        }
      );
    };

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

        const stream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
        if (cancelled) return;
        localStreamRef.current = stream;
        stream.getAudioTracks().forEach((track) => (track.enabled = !muted));
        userIdRef.current = userIdRef.current || uuidv4();

        emitJoin(socket);
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
    socket.on('reconnect', () => emitJoin(socket));
    socket.on('connect', () => {
      if (joinedRef.current) {
        emitJoin(socket);
      }
    });

    return () => {
      cancelled = true;
      socket.off('reconnect');
      socket.off('connect');
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
      setConnectionStatus('in-call');
      if (
        typeof document !== 'undefined' &&
        document.hidden &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted'
      ) {
        new Notification('Peer joined', { body: `In room ${roomCode}` });
      }
    };

    const onUserLeft = ({ userId }: { userId: string }) => {
      closePeer(userId);
      setParticipants((prev) => {
        const next = prev.filter((p) => p.userId !== userId);
        if (next.filter((p) => p.userId !== self?.userId).length === 0) {
          setConnectionStatus('waiting');
        }
        return next;
      });
      setRemoteStreams((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
      setSpeakingMap((prev) => {
        const copy = { ...prev };
        delete copy[userId];
        return copy;
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
    const handleUnload = () => leaveRoom();
    const handleVisibility = () => {
      if (!document.hidden) {
        const socket = socketRef.current;
        if (socket && !socket.connected) {
          socket.connect();
          setConnectionStatus('reconnecting');
        }
      }
    };
    window.addEventListener('beforeunload', handleUnload);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('beforeunload', handleUnload);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const collect = async () => {
      let totalJitter = 0;
      let count = 0;
      let lost = 0;
      let received = 0;
      await Promise.all(
        Array.from(peerConnections.current.values()).map(async (pc) => {
          const stats = await pc.getStats();
          stats.forEach((report) => {
            if (
              report.type === 'inbound-rtp' &&
              ((report as any).kind === 'audio' || (report as any).mediaType === 'audio')
            ) {
              const inbound = report as any;
              if (typeof inbound.jitter === 'number') {
                totalJitter += inbound.jitter * 1000; // s -> ms
                count += 1;
              }
              if (typeof inbound.packetsLost === 'number') lost += inbound.packetsLost;
              if (typeof inbound.packetsReceived === 'number') received += inbound.packetsReceived;
            }
          });
        })
      );
      const jitter = count ? totalJitter / count : 0;
      const loss = received ? (lost / (lost + received)) * 100 : 0;
      let level: QualityLevel = 'good';
      if (loss > 5 || jitter > 60) level = 'bad';
      else if (loss > 2 || jitter > 30) level = 'warn';
      setQuality({ level, jitter: Number(jitter.toFixed(1)), loss: Number(loss.toFixed(1)) });
      if ((level === 'warn' || level === 'bad') && !showQualityTip) {
        setShowQualityTip(true);
        if (qualityTipTimeoutRef.current) clearTimeout(qualityTipTimeoutRef.current);
        qualityTipTimeoutRef.current = window.setTimeout(() => setShowQualityTip(false), 4000);
      }
    };
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
    }
    statsIntervalRef.current = window.setInterval(collect, 3000);
    return () => {
      if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
    };
  }, [showQualityTip]);

  useEffect(() => {
    if (connectionStatus === 'in-call' || connectionStatus === 'waiting') {
      setShowRejoin(false);
    }
  }, [connectionStatus]);

  const participantName = (userId: string) =>
    participants.find((p) => p.userId === userId)?.name || 'Guest';

  const ensureAudioContext = () => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }
    return audioCtxRef.current;
  };

  const attachVAD = (peerId: string, stream: MediaStream) => {
    const ctx = ensureAudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.65;
    source.connect(analyser);
    const data = new Float32Array(analyser.frequencyBinCount);
    vadNodesRef.current.set(peerId, analyser);
    vadDataRef.current.set(peerId, data);

    const tick = () => {
      const node = vadNodesRef.current.get(peerId);
      const buffer = vadDataRef.current.get(peerId);
      if (!node || !buffer) return;
      node.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        sum += buffer[i] * buffer[i];
      }
      const rms = Math.sqrt(sum / buffer.length) || 1e-8;
      const db = 20 * Math.log10(rms);
      const now = performance.now();
      const last = vadActiveRef.current.get(peerId) || 0;
      if (db > SPEAKING_THRESHOLD_DB) {
        if (!last) vadActiveRef.current.set(peerId, now);
        if (now - (vadActiveRef.current.get(peerId) || now) > SPEAKING_DEBOUNCE_MS) {
          setSpeakingMap((prev) => {
            if (prev[peerId]) return prev;
            return { ...prev, [peerId]: true };
          });
        }
      } else {
        vadActiveRef.current.set(peerId, 0);
        setSpeakingMap((prev) => {
          if (!prev[peerId]) return prev;
          const copy = { ...prev };
          copy[peerId] = false;
          return copy;
        });
      }
      vadTimersRef.current.set(peerId, requestAnimationFrame(tick));
    };
    vadTimersRef.current.set(peerId, requestAnimationFrame(tick));
  };

  const clearVAD = (peerId: string) => {
    const timer = vadTimersRef.current.get(peerId);
    if (timer) cancelAnimationFrame(timer);
    vadTimersRef.current.delete(peerId);
    vadNodesRef.current.delete(peerId);
    vadDataRef.current.delete(peerId);
    vadActiveRef.current.delete(peerId);
  };

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
      attachVAD(peerId, stream);
      setConnectionStatus('in-call');
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        setConnectionStatus('reconnecting');
        restartIce(peerId, pc);
      }
      if (pc.connectionState === 'closed') {
        closePeer(peerId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        setConnectionStatus('reconnecting');
        restartIce(peerId, pc);
      }
      if (pc.iceConnectionState === 'connected') {
        setConnectionStatus('in-call');
      }
    };

    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    // Enable opus DTX to reduce background noise without extra latency
    pc.getSenders()
      .filter((s) => s.track?.kind === 'audio')
      .forEach((sender) => {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].dtx = 'enabled';
        sender.setParameters(params).catch(() => undefined);
      });
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

  const restartIce = (peerId: string, pc: RTCPeerConnection) => {
    if (!pc) return;
    pc.createOffer({ iceRestart: true })
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        socketRef.current?.emit('offer', {
          roomCode,
          to: peerId,
          description: pc.localDescription
        });
      })
      .catch((err) => console.error('ICE restart failed', err));
  };

  const closePeer = (peerId: string) => {
    const pc = peerConnections.current.get(peerId);
    if (pc) {
      pc.close();
      peerConnections.current.delete(peerId);
    }
    clearVAD(peerId);
    const audio = audioRefs.current.get(peerId);
    if (audio) {
      audio.srcObject = null;
      audioRefs.current.delete(peerId);
    }
  };

  const leaveRoom = () => {
    if (isLeaving) return;
    setIsLeaving(true);
    sessionStorage.setItem(LAST_ROOM_KEY, JSON.stringify({ code: roomCode, ts: Date.now() }));
    socketRef.current?.emit('leave-room', { roomCode, userId: userIdRef.current });
    peerConnections.current.forEach((_, id) => closePeer(id));
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    socketRef.current?.disconnect();
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => undefined);
      audioCtxRef.current = null;
    }
    if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    setBooleanPref('vibeme-mute', next);
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    buzz();
  };

  const toggleNoiseCancel = async () => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !noiseCancelOn;
    setNoiseCancelOn(next);
    buzz();
    const tasks = stream.getAudioTracks().map((t) =>
      t
        .applyConstraints({
          echoCancellation: next,
          noiseSuppression: next,
          autoGainControl: next,
          googEchoCancellation: next,
          googAutoGainControl: next,
          googNoiseSuppression: next,
          googNoiseSuppression2: next
        })
        .catch(() => {
          toast.error('Noise cancel not supported');
        })
    );
    await Promise.all(tasks);
  };

  const handleLeave = () => {
    leaveRoom();
    navigate('/');
  };

  const gridClass =
    participants.length <= 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-2 sm:grid-cols-2';

  return (
    <div className="min-h-screen flex flex-col bg-background text-white">
      {connectionStatus !== 'in-call' && (
        <div className="status-overlay">
          {connectionStatus === 'connecting' || connectionStatus === 'waiting' ? (
            <span className="spinner" />
          ) : (
            <span className="pulse" />
          )}
          <span>
            {connectionStatus === 'connecting' && 'Подключаемся...'}
            {connectionStatus === 'waiting' && 'Ждем собеседника...'}
            {connectionStatus === 'reconnecting' && 'Переподключаемся...'}
          </span>
        </div>
      )}
      {showRejoin && (
        <div className="fixed top-4 right-4 z-50">
          <button
            className="button-primary"
            onClick={() => {
              buzz();
              socketRef.current?.connect();
              setShowRejoin(false);
              setConnectionStatus('reconnecting');
            }}
          >
            Rejoin last room
          </button>
        </div>
      )}
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
                  const stream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
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
                        setConnectionStatus(res.participants.length ? 'in-call' : 'waiting');
                        setSelf({ userId: userIdRef.current, name: res.name });
                        peerConnections.current.forEach((_, id) => closePeer(id));
                        setRemoteStreams({});
                        setSpeakingMap({});
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
                className={`relative rounded-2xl glass p-4 flex flex-col justify-end overflow-hidden min-h-[200px] ${
                  speakingMap[p.userId] ? 'speaking' : ''
                }`}
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
          <button className="button-ghost flex items-center gap-2" onClick={toggleNoiseCancel}>
            <Icon name="mic" />
            <span>Noise Cancel: {noiseCancelOn ? 'On' : 'Off'}</span>
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

      <div className="quality-badge">
        <span
          className="quality-dot"
          style={{
            background:
              quality.level === 'good' ? '#10b981' : quality.level === 'warn' ? '#f59e0b' : '#ef4444'
          }}
        />
        <span>
          Quality: {quality.level.toUpperCase()} · jitter {quality.jitter} ms · loss {quality.loss}%
        </span>
        {showQualityTip && (
          <div className="tooltip">
            Проверьте интернет, вас может не слышно. Перейдите ближе к роутеру или включите relay/TURN.
          </div>
        )}
      </div>
    </div>
  );
}

