// DANGO BATTLE - オンライン対戦サーバー (Express + Socket.IO)
// 合言葉の部屋 / ランダムマッチ / 再接続(20秒) / 再戦 に対応。
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager } = require('./roomManager');

const PROJECT_ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 20 * 1000; // 切断後に復帰を待つ時間
const LOBBY_COUNT_INTERVAL_MS = 10 * 1000;  // 待機中の人に人数を送る間隔
const MAX_CHAR_INDEX = 63;

const app = express();
app.use(express.static(PROJECT_ROOT));
app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

const server = http.createServer(app);
// 巨大なデータは受け取らない(1メッセージ16KBまで)
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 16 * 1024 });
const rooms = new RoomManager();

const isAlive = id => io.sockets.sockets.has(id);
const socketOf = id => io.sockets.sockets.get(id) || null;

// ================= 受け取るデータの検証 =================
const num = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined);
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : undefined);
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
function cleanToken(v) { return typeof v === 'string' && /^[a-z0-9]{8,64}$/i.test(v) ? v : null; }
function cleanCharIndex(v) { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= MAX_CHAR_INDEX ? n : null; }
function cleanDango(d) {
  d = obj(d); if (!d) return null;
  const x = num(d.x, -1000, 1000), width = num(d.width, 0, 1000);
  if (x === undefined || width === undefined) return null;
  return { x, width, color: str(d.color, 40) };
}
function cleanMoving(m) {
  m = obj(m); if (!m) return undefined;
  const base = cleanDango(m); if (!base) return undefined;
  return { ...base, vx: num(m.vx, -1000, 1000), height: num(m.height, 0, 999) };
}
// 盤面スナップショット:決まった項目だけを取り出して相手へ中継する
function cleanSnapshot(d) {
  d = obj(d); if (!d) return null;
  const out = {};
  if (d.kind === 'drop' || d.kind === 'motion') { out.kind = d.kind; out.moving = cleanMoving(d.moving); return out; }
  if (Array.isArray(d.stack)) { if (d.stack.length > 200) return null; out.stack = d.stack.map(cleanDango).filter(Boolean); }
  out.skill = num(d.skill, 0, 1000);
  const ci = cleanCharIndex(d.charIndex); if (ci !== null) out.charIndex = ci;
  out.combo = num(d.combo, 0, 100000) || 0;
  out.timeLeft = num(d.timeLeft, -10, 10000);
  if (d.broken === true) out.broken = true;
  return out;
}

// ================= 送信回数の上限(連打・いたずら対策) =================
// 対戦同期(motion/snapshot)は多め、部屋操作は少なめのバケツで数える。
const LIMITS = {
  game: { capacity: 90, perSec: 60 },
  control: { capacity: 12, perSec: 1.5 },
};
function allow(socket, kind) {
  const lim = LIMITS[kind];
  const now = Date.now();
  const b = socket.data.buckets[kind] || (socket.data.buckets[kind] = { tokens: lim.capacity, at: now });
  b.tokens = Math.min(lim.capacity, b.tokens + ((now - b.at) / 1000) * lim.perSec);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// ================= 部屋まわりの共通処理 =================
function roomState(room) {
  return { code: room.code, status: room.status, playerCount: room.players.length, isQuick: !!room.isQuick };
}
function currentRoom(socket) {
  const room = rooms.get(socket.data.roomCode);
  const me = rooms.findBySocket(room, socket.id);
  return me ? { room, me } : { room: null, me: null };
}
function attach(socket, room) {
  socket.join(room.code);
  socket.data.roomCode = room.code;
  rooms.touch(room);
}
function toOpponent(room, me, ev, data) {
  const opp = rooms.opponentOf(room, me);
  if (opp && opp.connected) io.to(opp.socketId).emit(ev, data);
}

// 自分から部屋を抜ける(戻るボタンなど)。相手にはすぐ opponent:left を送る。
function leaveCurrent(socket) {
  rooms.dequeue(socket.id);
  socket.leave('lobby');
  const { room, me } = currentRoom(socket);
  if (room && me) {
    socket.leave(room.code);
    toOpponent(room, me, 'opponent:left');
    rooms.removePlayer(room, me);
  }
  socket.data.roomCode = null;
}

// 2人そろった部屋に「マッチ成立」を知らせる(合言葉と同じ room:matched)
function announceMatched(room) {
  io.to(room.code).emit('room:matched', roomState(room));
}

function sendLobbyCount(target) {
  const payload = { waiting: rooms.queue.length, online: io.engine.clientsCount };
  (target || io.to('lobby')).emit('lobby:count', payload);
}

// ================= 接続ごとの処理 =================
io.on('connection', socket => {
  socket.data.buckets = {};
  socket.data.token = null;
  const rememberToken = data => {
    const t = cleanToken(obj(data)?.playerToken);
    if (t) socket.data.token = t;
    return socket.data.token || socket.id; // トークンが無い古いクライアントは socket.id で代用
  };
  // 部屋操作系:回数制限 + ack は必ず関数のときだけ呼ぶ
  const onControl = (ev, fn) => socket.on(ev, (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!allow(socket, 'control')) return reply({ ok: false, error: 'RATE_LIMITED' });
    try { fn(data, reply); } catch (e) { console.error('[DANGO]', ev, e); reply({ ok: false, error: 'SERVER_ERROR' }); }
  });
  const onGame = (ev, fn) => socket.on(ev, (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!allow(socket, 'game')) return reply({ ok: false, error: 'RATE_LIMITED' });
    try { fn(data, reply); } catch (e) { console.error('[DANGO]', ev, e); }
  });

  socket.on('ping-check', (p, ack) => { if (typeof ack === 'function') ack({ ok: true, serverTime: Date.now() }); });

  // ---- 合言葉の部屋 ----
  onControl('room:create', (data, reply) => {
    const token = rememberToken(data);
    leaveCurrent(socket);
    const room = rooms.create(socket.id, token, false);
    attach(socket, room);
    reply({ ok: true, ...roomState(room) });
  });

  onControl('room:join', (data, reply) => {
    const token = rememberToken(data);
    const code = str(obj(data)?.code, 10);
    if (!code) return reply({ ok: false, error: 'ROOM_NOT_FOUND' });
    leaveCurrent(socket);
    const r = rooms.join(code, socket.id, token);
    if (r.error) return reply({ ok: false, error: r.error });
    attach(socket, r.room);
    reply({ ok: true, ...roomState(r.room) });
    announceMatched(r.room);
  });

  // ---- ランダムマッチ(追加) ----
  onControl('match:quick', (data, reply) => {
    const token = rememberToken(data);
    leaveCurrent(socket);
    const partner = rooms.enqueueOrMatch(socket.id, token, isAlive);
    if (!partner) {
      // 相手がいないので待機。待機中の人には lobby:count を定期的に送る
      socket.join('lobby');
      reply({ ok: true, waiting: true });
      sendLobbyCount(socket);
      return;
    }
    const partnerSocket = socketOf(partner.socketId);
    if (!partnerSocket) { // 念のため:相手がちょうど切れていたら自分が待機に回る
      rooms.dequeue(partner.socketId);
      rooms.enqueueOrMatch(socket.id, token, isAlive);
      socket.join('lobby');
      reply({ ok: true, waiting: true });
      return;
    }
    partnerSocket.leave('lobby');
    const room = rooms.createQuickRoom(partner, { socketId: socket.id, token });
    attach(partnerSocket, room);
    attach(socket, room);
    reply({ ok: true, waiting: false, ...roomState(room) });
    announceMatched(room);
  });

  onControl('match:cancel', (data, reply) => {
    const removed = rooms.dequeue(socket.id);
    socket.leave('lobby');
    reply({ ok: true, removed });
  });

  // ---- 再接続 ----
  onControl('room:resume', (data, reply) => {
    const token = rememberToken(data);
    const room = rooms.get(str(obj(data)?.code, 10));
    if (!room) return reply({ ok: false, error: 'ROOM_NOT_FOUND' });
    // 同じトークンで、切断中の席を優先して取り戻す
    const me = room.players.find(p => p.token === token && !p.connected) || room.players.find(p => p.token === token);
    if (!me) return reply({ ok: false, error: 'NOT_IN_ROOM' });
    if (me.graceTimer) { clearTimeout(me.graceTimer); me.graceTimer = null; }
    const oldSocket = me.socketId !== socket.id ? socketOf(me.socketId) : null;
    if (oldSocket) { oldSocket.leave(room.code); oldSocket.data.roomCode = null; }
    me.socketId = socket.id;
    me.connected = true;
    attach(socket, room);
    reply({ ok: true, ...roomState(room) });
    toOpponent(room, me, 'opponent:resumed');
    if (room.status === 'playing' && room.players.every(p => p.connected)) io.to(room.code).emit('match:resume');
  });

  onControl('room:leave', () => leaveCurrent(socket));

  // ---- キャラ選択 → 対戦開始 ----
  onControl('player:character', (data, reply) => {
    const { room, me } = currentRoom(socket);
    if (!room) return reply({ ok: false, error: 'NOT_IN_ROOM' });
    if (room.status !== 'selecting') return reply({ ok: false, error: 'BAD_STATE' });
    const charIndex = cleanCharIndex(obj(data)?.charIndex) ?? 0;
    me.charIndex = charIndex;
    rooms.touch(room);
    toOpponent(room, me, 'opponent:character', { charIndex });
    reply({ ok: true });
    if (room.players.length === 2 && room.players.every(p => p.charIndex !== null)) {
      room.status = 'playing';
      io.to(room.code).emit('match:start', { startAt: Date.now() + 1200 });
    }
  });

  // ---- 対戦中の同期(中身を検証してから相手へ中継) ----
  onGame('game:snapshot', data => {
    const { room, me } = currentRoom(socket); if (!room || room.status !== 'playing') return;
    const clean = cleanSnapshot(data); if (!clean) return;
    rooms.touch(room);
    toOpponent(room, me, 'opponent:snapshot', clean);
  });
  onGame('game:motion', data => {
    const { room, me } = currentRoom(socket); if (!room || room.status !== 'playing') return;
    const clean = cleanMoving(data); if (!clean) return;
    toOpponent(room, me, 'opponent:motion', clean);
  });
  onGame('game:skill', data => {
    const { room, me } = currentRoom(socket); if (!room || room.status !== 'playing') return;
    const charIndex = cleanCharIndex(obj(data)?.charIndex); if (charIndex === null) return;
    rooms.touch(room);
    toOpponent(room, me, 'opponent:skill', { charIndex, self: obj(data)?.self === true });
  });
  onControl('game:win', (data, reply) => {
    const { room } = currentRoom(socket);
    if (!room || room.status !== 'playing') return reply({ ok: false, error: 'BAD_STATE' });
    room.status = 'finished';
    room.players.forEach(p => { p.rematch = false; });
    rooms.touch(room);
    io.to(room.code).emit('match:finished', { winnerId: socket.id, reason: str(obj(data)?.reason, 20) || 'height20' });
    reply({ ok: true });
  });

  // ---- 再戦 ----
  onControl('rematch:request', (data, reply) => {
    const { room, me } = currentRoom(socket);
    if (!room || room.status !== 'finished') return reply({ ok: false, error: 'BAD_STATE' });
    me.rematch = true;
    rooms.touch(room);
    toOpponent(room, me, 'rematch:requested');
    if (room.players.length === 2 && room.players.every(p => p.rematch)) {
      room.players.forEach(p => { p.rematch = false; p.charIndex = null; });
      room.status = 'selecting';
      io.to(room.code).emit('rematch:start');
    }
    reply({ ok: true });
  });

  // ---- 切断:行列からは即削除、部屋は20秒だけ復帰を待つ ----
  socket.on('disconnect', () => {
    rooms.dequeue(socket.id);
    const { room, me } = currentRoom(socket);
    if (!room || !me) return;
    me.connected = false;
    rooms.touch(room);
    toOpponent(room, me, 'opponent:reconnecting');
    me.graceTimer = setTimeout(() => {
      me.graceTimer = null;
      if (me.connected || !rooms.get(room.code)) return;
      toOpponent(room, me, 'opponent:left');
      rooms.removePlayer(room, me);
    }, RECONNECT_GRACE_MS);
  });
});

// ================= 定期処理 =================
// 1秒ごと:待ち時間60秒を超えた人に match:timeout
setInterval(() => {
  for (const e of rooms.takeTimedOut()) {
    const s = socketOf(e.socketId);
    if (s) { s.leave('lobby'); s.emit('match:timeout'); }
  }
}, 1000).unref();
// 10秒ごと:待機中の人に人数を送る(待機中の人がいるときだけ)
setInterval(() => { if (rooms.queue.length) sendLobbyCount(); }, LOBBY_COUNT_INTERVAL_MS).unref();
// 1分ごと:放置された部屋の後片付け
setInterval(() => rooms.cleanup(isAlive), 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`[DANGO SERVER] listening on ${PORT}`));
}
module.exports = { app, server, io, rooms };
