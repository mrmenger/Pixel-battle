'use strict';

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const pako    = require('pako');

const CANVAS_SIZE = 4096;
const COOLDOWN_MS = 3000;

// ─── Буфер доски RGB (~48MB) ─────────────────────────────
const board = new Uint8Array(CANVAS_SIZE * CANVAS_SIZE * 3).fill(255);

function getIdx(x, y) { return (y * CANVAS_SIZE + x) * 3; }

function setPx(x, y, r, g, b) {
  if (x < 0 || x >= CANVAS_SIZE || y < 0 || y >= CANVAS_SIZE) return false;
  const i = getIdx(x, y);
  board[i] = r; board[i + 1] = g; board[i + 2] = b;
  return true;
}

// ─── Express + Socket.io ─────────────────────────────────
const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
  // ВАЖНО: разрешаем оба транспорта — сначала websocket, fallback polling
  transports: ['websocket', 'polling'],
  pingTimeout:        60000,
  pingInterval:       25000,
  maxHttpBufferSize:  1e8,
  // Увеличиваем буфер для стабильности
  perMessageDeflate: false,
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Endpoint для загрузки доски — сжимаем pako
app.get('/api/board', (_, res) => {
  try {
    const compressed = pako.deflate(board, { level: 6 });
    res.set({
      'Content-Type':   'application/octet-stream',
      'Cache-Control':  'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(Buffer.from(compressed));
  } catch (e) {
    console.error('[Board] Compress error:', e);
    res.status(500).end();
  }
});

// ─── Кулдауны ────────────────────────────────────────────
const cooldowns = new Map();

function hasCooldown(id) {
  const t = cooldowns.get(id);
  return t && (Date.now() - t) < COOLDOWN_MS;
}

function getRemaining(id) {
  const t = cooldowns.get(id);
  return t ? Math.max(0, COOLDOWN_MS - (Date.now() - t)) : 0;
}

// ─── Онлайн счётчик ──────────────────────────────────────
function broadcastOnline() {
  io.emit('stats:online', io.engine.clientsCount);
}

// ─── Socket.io подключения ───────────────────────────────
io.on('connection', (socket) => {
  const ip = socket.handshake.headers['x-forwarded-for']
    || socket.handshake.address;

  console.log(`[+] CONNECT  id=${socket.id}  ip=${ip}  total=${io.engine.clientsCount}`);
  broadcastOnline();

  // Отправляем метаданные сразу
  socket.emit('board:meta', {
    canvasSize:  CANVAS_SIZE,
    cooldownMs:  COOLDOWN_MS,
  });

  // Говорим клиенту загрузить доску через REST
  socket.emit('board:load_via_rest', { url: '/api/board' });

  // ── Постановка пикселя ──────────────────────────────
  socket.on('pixel:place', (data) => {
    if (!data || typeof data !== 'object') {
      console.log(`[!] INVALID packet from ${socket.id}`);
      return;
    }

    const { x, y, r, g, b } = data;

    // Валидация
    const valid =
      Number.isInteger(x) && Number.isInteger(y) &&
      Number.isInteger(r) && Number.isInteger(g) && Number.isInteger(b) &&
      x >= 0 && x < CANVAS_SIZE &&
      y >= 0 && y < CANVAS_SIZE &&
      r >= 0 && r <= 255 &&
      g >= 0 && g <= 255 &&
      b >= 0 && b <= 255;

    if (!valid) {
      console.log(`[!] REJECT invalid data from ${socket.id}:`, data);
      socket.emit('pixel:rejected', { reason: 'invalid_data' });
      return;
    }

    // Кулдаун
    if (hasCooldown(socket.id)) {
      const rem = getRemaining(socket.id);
      console.log(`[!] REJECT cooldown ${socket.id} rem=${rem}ms`);
      socket.emit('pixel:rejected', { reason: 'cooldown', remaining: rem });
      return;
    }

    // Записываем в буфер
    setPx(x, y, r, g, b);
    cooldowns.set(socket.id, Date.now());

    console.log(`[OK] PIXEL (${x},${y}) rgb(${r},${g},${b}) from=${socket.id} clients=${io.engine.clientsCount}`);

    // ── КРИТИЧНО: два отдельных emit ─────────────────
    // 1. Подтверждение автору
    socket.emit('pixel:accepted', {
      x, y, r, g, b,
      cooldownMs: COOLDOWN_MS,
    });

    // 2. Broadcast всем ОСТАЛЬНЫМ клиентам
    // socket.broadcast = все кроме отправителя
    socket.broadcast.emit('pixel:update', { x, y, r, g, b });

    // Логируем сколько клиентов получат update
    console.log(`[>>] broadcast pixel:update to ${io.engine.clientsCount - 1} other clients`);
  });

  // ── Отключение ────────────────────────────────────
  socket.on('disconnect', (reason) => {
    cooldowns.delete(socket.id);
    console.log(`[-] DISCONNECT id=${socket.id} reason=${reason} total=${io.engine.clientsCount}`);
    broadcastOnline();
  });

  // ── Обработка ошибок сокета ───────────────────────
  socket.on('error', (err) => {
    console.error(`[!] SOCKET ERROR id=${socket.id}:`, err);
  });
});

// ─── Статистика каждые 30 сек ────────────────────────────
setInterval(() => {
  const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  console.log(`[STATS] clients=${io.engine.clientsCount} heap=${mem}MB`);
}, 30_000);

// ─── Старт ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║         PIXEL BATTLE  —  READY           ║
║  http://localhost:${PORT}                     ║
║  Board  : ${CANVAS_SIZE}×${CANVAS_SIZE} pixels              ║
║  Buffer : ${(board.length/1024/1024).toFixed(0)} MB RAM                    ║
║  CD     : ${COOLDOWN_MS}ms                         ║
╚══════════════════════════════════════════╝`);
});
