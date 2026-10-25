// Turbo Clash multiplayer room server.
// Plain relay: players meet in rooms by a 4-letter code; the host starts races;
// car states and game events are forwarded to everyone else in the room.
// Each client simulates its own car (and the host also the bots).

import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8080;
const MAX_PLAYERS = 8;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O to avoid confusion

const rooms = new Map(); // code -> room
let nextId = 1;

const server = http.createServer((req, res) => {
  // Health check + "wake up" endpoint (Render free instances sleep when idle).
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ ok: true, game: 'turbo-clash', rooms: rooms.size }));
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

function makeCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };

function roster(room) {
  return [...room.players.values()].map((p) => ({ id: p.id, name: p.name, car: p.car, host: p.id === room.host }));
}

function broadcast(room, msg, exceptId = null) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) if (p.id !== exceptId && p.ws.readyState === 1) p.ws.send(data);
}

function sendRoom(room) {
  broadcast(room, { t: 'room', code: room.code, host: room.host, players: roster(room), lobby: room.lobby, racing: room.racing });
}

function cleanName(n) {
  return String(n || 'Oyuncu').replace(/[<>&"']/g, '').trim().slice(0, 14) || 'Oyuncu';
}

function cleanCar(c) {
  c = c || {};
  return { type: ['red', 'blue', 'yellow'].includes(c.type) ? c.type : 'red', color: Number.isFinite(c.color) ? c.color : 0xe8423b };
}

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  room.players.delete(ws.id);
  ws.room = null;
  if (room.players.size === 0) { rooms.delete(room.code); return; }
  if (room.host === ws.id) room.host = room.players.keys().next().value; // next player becomes host
  broadcast(room, { t: 'left', id: ws.id });
  sendRoom(room);
}

wss.on('connection', (ws) => {
  ws.id = nextId++;
  ws.room = null;
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  send(ws, { t: 'hello', id: ws.id });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const room = ws.room;
    switch (m.t) {
      case 'create': {
        if (room) leave(ws);
        const code = makeCode();
        const r = { code, host: ws.id, players: new Map(), lobby: { laps: 2, bots: 1, abilities: true }, racing: false };
        rooms.set(code, r);
        r.players.set(ws.id, { id: ws.id, ws, name: cleanName(m.name), car: cleanCar(m.car) });
        ws.room = r;
        sendRoom(r);
        break;
      }
      case 'join': {
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!r) { send(ws, { t: 'error', msg: 'Oda bulunamadı. Kodu kontrol et.' }); break; }
        if (r.players.size >= MAX_PLAYERS) { send(ws, { t: 'error', msg: 'Oda dolu (en fazla 8 oyuncu).' }); break; }
        if (room) leave(ws);
        r.players.set(ws.id, { id: ws.id, ws, name: cleanName(m.name), car: cleanCar(m.car) });
        ws.room = r;
        sendRoom(r);
        break;
      }
      case 'profile': { // name / car changed while in the lobby
        if (!room) break;
        const p = room.players.get(ws.id);
        p.name = cleanName(m.name); p.car = cleanCar(m.car);
        sendRoom(room);
        break;
      }
      case 'lobby': { // host changes race settings
        if (!room || room.host !== ws.id) break;
        const l = m.lobby || {};
        room.lobby = {
          laps: Math.min(5, Math.max(1, Number(l.laps) || 2)),
          bots: Math.min(6, Math.max(0, Number(l.bots) || 0)),
          abilities: l.abilities !== false,
        };
        sendRoom(room);
        break;
      }
      case 'start': {
        if (!room || room.host !== ws.id) break;
        room.racing = true;
        // the host builds the grid (players + its bots); the server just stamps a seed and relays it
        broadcast(room, { t: 'start', grid: m.grid, lobby: room.lobby, seed: Math.floor(Math.random() * 1e9), host: room.host });
        sendRoom(room);
        break;
      }
      case 'end': {
        if (!room || room.host !== ws.id) break;
        room.racing = false;
        sendRoom(room);
        break;
      }
      case 's': // car states
      case 'e': // game events
        if (room) broadcast(room, { ...m, from: ws.id }, ws.id);
        break;
      case 'leave':
        leave(ws);
        send(ws, { t: 'left-ok' });
        break;
      case 'ping':
        send(ws, { t: 'pong', at: m.at });
        break;
    }
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

// drop dead connections so rooms don't fill with ghosts
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 20000);

server.listen(PORT, () => console.log(`Turbo Clash sunucusu ${PORT} portunda çalışıyor`));
