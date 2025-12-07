import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { Server } from 'socket.io';
import { randomUUID, randomBytes } from 'crypto';
import selfsigned from 'selfsigned';

type ParticipantInfo = { socketId: string; name: string; lastSeen: number };

const PORT = Number(process.env.PORT || 3001);
const DEV_SSL = process.env.DEV_SSL === 'true';
const ROOM_LIMIT = 4;
const ROOM_TTL_MS = 5 * 60 * 1000;
const ROOM_CODE_LENGTH = 8;

const allowedOrigins =
  process.env.ALLOWED_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) || [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://192.168.0.6:5173',
    'http://192.168.56.1:5173',
    'http://198.18.0.1:5173',
    'https://localhost:5173',
    'https://127.0.0.1:5173',
    'https://192.168.0.6:5173',
    'https://192.168.56.1:5173',
    'https://198.18.0.1:5173'
  ];

const app = express();
app.disable('x-powered-by');
app.enable('trust proxy');
app.use(express.json({ limit: '128kb' }));
app.use(
  cors({
    origin: allowedOrigins,
    credentials: false
  })
);

const enforceHttps = process.env.ENFORCE_HTTPS === 'true';
if (enforceHttps) {
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.secure) return next();
    return res.redirect(`https://${req.headers.host}${req.originalUrl}`);
  });
}

let httpServer: ReturnType<typeof createServer> | ReturnType<typeof createHttpsServer>;
if (DEV_SSL) {
  try {
    // Prefer mkcert certs if available
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const rootCertDir = fs.existsSync(path.join(process.cwd(), '.certs'))
      ? path.join(process.cwd(), '.certs')
      : path.join(process.cwd(), '..', '.certs');
    const keyPath = path.join(rootCertDir, 'dev-key.pem');
    const certPath = path.join(rootCertDir, 'dev-cert.pem');
    const key = fs.readFileSync(keyPath);
    const cert = fs.readFileSync(certPath);
    httpServer = createHttpsServer({ key, cert }, app);
    console.log('DEV_SSL enabled: running HTTPS locally with mkcert certs');
  } catch (err) {
    console.warn('DEV_SSL enabled but certs not found, falling back to selfsigned');
    const attrs = [{ name: 'commonName', value: 'localhost' }];
    const pems = selfsigned.generate(attrs, { days: 1, keySize: 2048 });
    httpServer = createHttpsServer(
      {
        key: pems.private,
        cert: pems.cert
      },
      app
    );
  }
} else {
  httpServer = createServer(app);
}
const io = new Server(httpServer, {
  cors: { origin: allowedOrigins }
});

const rooms: Map<string, Set<string>> = new Map();
const participants: Map<string, Map<string, ParticipantInfo>> = new Map();
const roomActivity: Map<string, number> = new Map();

const generateRoomCode = () => {
  return randomBytes(ROOM_CODE_LENGTH)
    .toString('base64url')
    .slice(0, ROOM_CODE_LENGTH)
    .toUpperCase();
};

const sanitizeCode = (code: string) => code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

const ensureRoom = (code: string) => {
  if (!rooms.has(code)) {
    rooms.set(code, new Set());
    participants.set(code, new Map());
  }
  roomActivity.set(code, Date.now());
};

const touchRoom = (code: string) => roomActivity.set(code, Date.now());

// Simple in-memory rate limiter for REST (per IP)
const rateLimitStore = new Map<
  string,
  {
    count: number;
    resetAt: number;
  }
>();
const RATE_LIMIT = 60; // requests
const RATE_WINDOW_MS = 60_000; // per minute
const rateLimitMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const entry = rateLimitStore.get(ip);
  if (!entry || entry.resetAt < now) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return next();
  }
  if (entry.count >= RATE_LIMIT) {
    return res.status(429).json({ ok: false, reason: 'Too many requests' });
  }
  entry.count += 1;
  return next();
};

const cleanupRooms = () => {
  const now = Date.now();
  Array.from(rooms.keys()).forEach((code) => {
    const lastSeen = roomActivity.get(code) || 0;
    const size = rooms.get(code)?.size || 0;
    if (size === 0 && now - lastSeen > ROOM_TTL_MS) {
      rooms.delete(code);
      participants.delete(code);
      roomActivity.delete(code);
    }
  });
};

setInterval(cleanupRooms, 60_000);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.post('/api/room', rateLimitMiddleware, (_req: Request, res: Response) => {
  let code = generateRoomCode();
  while (rooms.has(code)) {
    code = generateRoomCode();
  }
  ensureRoom(code);
  res.json({ code });
});

app.get('/api/room/:code/exists', rateLimitMiddleware, (req: Request, res: Response) => {
  const code = sanitizeCode(req.params.code || '');
  const exists = rooms.has(code);
  const full = exists ? (rooms.get(code)?.size || 0) >= ROOM_LIMIT : false;
  res.json({ exists, full });
});

const leaveRoom = (roomCode?: string, userId?: string) => {
  if (!roomCode || !userId) return;
  const roomSet = rooms.get(roomCode);
  const meta = participants.get(roomCode);
  if (!roomSet || !meta) return;
  roomSet.delete(userId);
  meta.delete(userId);
  touchRoom(roomCode);
  io.to(roomCode).emit('user-left', { userId });
};

io.on('connection', (socket) => {
  socket.on(
    'join-room',
    (
      payload: { roomCode?: string; userId?: string },
      callback: (res: JoinResponse) => void
    ) => {
      const code = sanitizeCode(payload.roomCode || '');
      const userId = payload.userId || randomUUID();
      if (!code) {
        callback({ ok: false, reason: 'Room code required' });
        return;
      }
      if (!rooms.has(code)) {
        callback({ ok: false, reason: 'Room not found' });
        return;
      }
      const roomSet = rooms.get(code)!;
      if (roomSet.size >= ROOM_LIMIT) {
        callback({ ok: false, reason: 'Room full' });
        return;
      }

      const meta = participants.get(code) || new Map<string, ParticipantInfo>();
      participants.set(code, meta);
      const name = `User${meta.size + 1}`;

      roomSet.add(userId);
      meta.set(userId, { socketId: socket.id, name, lastSeen: Date.now() });
      socket.join(code);
      socket.data.roomCode = code;
      socket.data.userId = userId;
      touchRoom(code);

      const others = Array.from(meta.entries())
        .filter(([id]) => id !== userId)
        .map(([id, info]) => ({ userId: id, name: info.name }));

      callback({ ok: true, participants: others, name });
      socket.to(code).emit('user-joined', { userId, name });
    }
  );

  socket.on(
    'offer',
    ({ roomCode, to, description }: { roomCode?: string; to?: string; description: RTCSessionDescriptionInit }) => {
      const code = sanitizeCode(roomCode || socket.data.roomCode || '');
      const meta = participants.get(code);
      const from = socket.data.userId as string | undefined;
      if (!meta || !from || !to) return;
      const target = meta.get(to);
      if (target) {
        if (!description || typeof description.type !== 'string') return;
        if (JSON.stringify(description).length > 120_000) return;
        io.to(target.socketId).emit('offer', { from, description });
      }
    }
  );

  socket.on(
    'answer',
    ({ roomCode, to, description }: { roomCode?: string; to?: string; description: RTCSessionDescriptionInit }) => {
      const code = sanitizeCode(roomCode || socket.data.roomCode || '');
      const meta = participants.get(code);
      const from = socket.data.userId as string | undefined;
      if (!meta || !from || !to) return;
      const target = meta.get(to);
      if (target) {
        if (!description || typeof description.type !== 'string') return;
        if (JSON.stringify(description).length > 120_000) return;
        io.to(target.socketId).emit('answer', { from, description });
      }
    }
  );

  socket.on(
    'ice-candidate',
    ({ roomCode, to, candidate }: { roomCode?: string; to?: string; candidate: RTCIceCandidateInit }) => {
      const code = sanitizeCode(roomCode || socket.data.roomCode || '');
      const meta = participants.get(code);
      const from = socket.data.userId as string | undefined;
      if (!meta || !from || !to || !candidate) return;
      const target = meta.get(to);
      if (target) {
        if (JSON.stringify(candidate).length > 5_000) return;
        io.to(target.socketId).emit('ice-candidate', { from, candidate });
      }
    }
  );

  socket.on('leave-room', ({ roomCode, userId }: { roomCode?: string; userId?: string }) => {
    const code = sanitizeCode(roomCode || socket.data.roomCode || '');
    leaveRoom(code, userId || socket.data.userId);
    socket.leave(code);
  });

  socket.on('disconnect', () => {
    leaveRoom(socket.data.roomCode, socket.data.userId);
  });
});

httpServer.listen(PORT, () => {
  console.log(`VibeME signaling server listening on :${PORT}`);
});

type JoinResponse =
  | { ok: true; participants: { userId: string; name: string }[]; name: string }
  | { ok: false; reason?: string };

