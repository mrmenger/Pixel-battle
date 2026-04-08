'use strict';

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const pako    = require('pako');

const CANVAS  = 4096;
const CD_MS   = 3000;

// ─── Board: один плоский Uint8Array (RGB) ────────────────
const board = new Uint8Array(CANVAS * CANVAS * 3).fill(255);

function idx(x,y){ return (y*CANVAS+x)*3; }
function setpx(x,y,r,g,b){
  if(x<0||x>=CANVAS||y<0||y>=CANVAS) return false;
  const i=idx(x,y);
  board[i]=r; board[i+1]=g; board[i+2]=b;
  return true;
}

// ─── Express ──────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server,{
  cors:{origin:'*'},
  maxHttpBufferSize:1e8,
  pingTimeout:60000,
  pingInterval:25000,
});

app.use(express.static(path.join(__dirname,'public')));
app.get('/',(_,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

// Сжатая доска по HTTP — эффективнее чем через сокет
app.get('/api/board',(_,res)=>{
  const c=pako.deflate(board,{level:6});
  res.set({'Content-Type':'application/octet-stream',
           'Content-Length':c.length,
           'Cache-Control':'no-store'});
  res.end(Buffer.from(c));
});

// ─── Cooldowns ────────────────────────────────────────────
const cds=new Map();
function hasCd(id){const t=cds.get(id);return !!t&&(Date.now()-t)<CD_MS;}
function remCd(id){const t=cds.get(id);return t?Math.max(0,CD_MS-(Date.now()-t)):0;}

function bcastOnline(){ io.emit('stats:online',io.engine.clientsCount); }

// ─── Socket ───────────────────────────────────────────────
io.on('connection',socket=>{
  console.log(`[+] ${socket.id}  total=${io.engine.clientsCount}`);
  bcastOnline();

  socket.emit('board:meta',{canvasSize:CANVAS,cooldownMs:CD_MS});
  socket.emit('board:load_via_rest',{url:'/api/board'});

  socket.on('pixel:place',data=>{
    if(!data||typeof data!=='object') return;
    const{x,y,r,g,b}=data;
    const ok=
      Number.isInteger(x)&&Number.isInteger(y)&&
      Number.isInteger(r)&&Number.isInteger(g)&&Number.isInteger(b)&&
      x>=0&&x<CANVAS&&y>=0&&y<CANVAS&&
      r>=0&&r<=255&&g>=0&&g<=255&&b>=0&&b<=255;
    if(!ok){socket.emit('pixel:rejected',{reason:'invalid'});return;}

    if(hasCd(socket.id)){
      socket.emit('pixel:rejected',{reason:'cooldown',remaining:remCd(socket.id)});
      return;
    }

    setpx(x,y,r,g,b);
    cds.set(socket.id,Date.now());

    // ── мгновенный ack отправителю ──
    socket.emit('pixel:accepted',{x,y,r,g,b,cooldownMs:CD_MS});
    // ── broadcast всем остальным ──
    socket.broadcast.emit('pixel:update',{x,y,r,g,b});

    console.log(`[px] (${x},${y}) #${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`);
  });

  socket.on('disconnect',reason=>{
    cds.delete(socket.id);
    console.log(`[-] ${socket.id} ${reason}`);
    bcastOnline();
  });
});

// ─── Start ────────────────────────────────────────────────
const PORT=process.env.PORT||3000;
server.listen(PORT,()=>{
  console.log(`\n🎨 Pixel Battle on http://localhost:${PORT}`);
  console.log(`   Board: ${CANVAS}×${CANVAS}  Buffer: ${(board.length/1024/1024).toFixed(0)}MB`);
  console.log(`   Cooldown: ${CD_MS}ms\n`);
});