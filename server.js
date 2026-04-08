'use strict';

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const pako    = require('pako');

// ─── Конфигурация ────────────────────────────────────────
const CANVAS_SIZE  = 4096;
const COOLDOWN_MS  = 3000;
const CHUNK_SIZE   = 64;
const CHUNKS_ROW   = CANVAS_SIZE / CHUNK_SIZE;
const TOTAL_CHUNKS = CHUNKS_ROW * CHUNKS_ROW;

// ─── Буфер доски (RGB) ───────────────────────────────────
// 4096 * 4096 * 3 байта ≈ 48 MB. Только одна копия.
const board = new Uint8Array(CANVAS_SIZE * CANVAS_SIZE * 3).fill(255);

function getIdx(x, y) { return (y * CANVAS_SIZE + x) * 3; }
function setPx(x, y, r, g, b) {
  if (x < 0 || x >= CANVAS_SIZE || y < 0 || y >= CANVAS_SIZE) return false;
  const i = getIdx(x, y);
  board[i]     = r;
  board[i + 1] = g;
  board[i + 2] = b;
  return true;
}

// ─── Сервер Express & Socket.io ───────────────────────────
const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' }, // Важно для работы с любого хоста
  transports: ['websocket', 'polling'], // Принудительно оба протокола
  pingTimeout: 60000,   // Тайм-аут ответа: 60 сек
  pingInterval: 25000,  // Опрос каждые 25 сек (чтобы держать пинг живым)
  maxHttpBufferSize: 1e8, // Размер пакетов 100 МБ
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Загружаем весь сжатый файл доски по HTTP (быстрее чем сокеты)
app.get('/api/board', (_, res) => {
  const compressed = pako.deflate(board, { level: 6 });
  res.set({
    'Content-Type':     'application/octet-stream',
    'Content-Encoding': 'deflate',
    'Cache-Control':    'no-store',
  });
  res.end(Buffer.from(compressed));
});

// ─── Отслеживание кулдаунов ──────────────────────────────
const cooldownMap = new Map();

function hasCooldown(socketId) {
  const t = cooldownMap.get(socketId);
  return t && (Date.now() - t) < COOLDOWN_MS;
}

function getRemainder(socketId) {
  const t = cooldownMap.get(socketId);
  return t ? Math.max(0, COOLDOWN_MS - (Date.now() - t)) : 0;
}

// ─── Логика подключений ───────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id} | Total Clients: ${io.engine.clientsCount}`);
  
  // Отправляем метаданные сразу при подключении
  socket.emit('board:meta', {
    canvasSize: CANVAS_SIZE,
    chunkSize: CHUNK_SIZE,
    chunksPerRow: CHUNKS_ROW,
    totalChunks: TOTAL_CHUNKS,
    cooldownMs: COOLDOWN_MS,
  });

  // Уведомляем загрузить основную доску
  socket.emit('board:load_via_rest', { url: '/api/board' });

  // ─── Получение пикселя ────────────────────────────────────
  socket.on('pixel:place', (data) => {
    if (!data || typeof data !== 'object') return;

    const { x, y, r, g, b } = data;

    // Валидация данных
    const valid = 
      Number.isInteger(x) && Number.isInteger(y) &&
      Number.isInteger(r) && Number.isInteger(g) && Number.isInteger(b) &&
      x >= 0 && x < CANVAS_SIZE && y >= 0 && y < CANVAS_SIZE &&
      r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255;

    if (!valid) {
      console.log(`[REJECT Invalid] (${x},${y}) ${JSON.stringify(data)}`);
      socket.emit('pixel:rejected', { reason: 'invalid_data' });
      return;
    }

    // Проверка кулдауна
    if (hasCooldown(socket.id)) {
      console.log(`[REJECT Cooldown] ${socket.id}`);
      socket.emit('pixel:rejected', {
        reason: 'cooldown',
        remaining: getRemainder(socket.id),
      });
      return;
    }

    // ─── УСПЕХ ────────────────────────────────────────────
    setPx(x, y, r, g, b);
    cooldownMap.set(socket.id, Date.now());

    console.log(`[SUCCESS] (${x},${y}) @ ${socket.id}`);

    // 1. Подтверждаем самому поставщику (он увидит пиксель сразу)
    socket.emit('pixel:accepted', { x, y, r, g, b, cooldownMs: COOLDOWN_MS });

    // 2. Бродкаст всем остальным (важно для синхронизации)
    socket.broadcast.emit('pixel:update', { x, y, r, g, b });
  });

  socket.on('disconnect', () => {
    cooldownMap.delete(socket.id);
    console.log(`[DISCONNECT] ${socket.id}`);
  });
});

// ─── Старт ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║      PIXEL BATTLE SERVER READY       ║
║  http://localhost:${PORT}                          ║
║  Buffer: ${(board.length / 1024 / 1024).toFixed(0)} MB         ║
║  Ping Interval: 25s                   ║
╚══════════════════════════════════════╝`);
});
