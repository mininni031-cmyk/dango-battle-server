// DANGO BATTLE - 部屋とランダムマッチ待ち行列の管理
// 合言葉の部屋もランダムマッチの部屋も、同じ「部屋」の仕組みで扱う。
// プレイヤーは socket.id ではなく playerToken で識別する(再接続で socket.id が変わるため)。

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_IDLE_TTL_MS = 10 * 60 * 1000;   // 対戦中以外で10分放置された部屋は片付ける
const ROOM_HARD_TTL_MS = 60 * 60 * 1000;   // どんな状態でも1時間を超えた部屋は片付ける
const QUEUE_TIMEOUT_MS = Number(process.env.QUEUE_TIMEOUT_MS) || 60 * 1000; // ランダムマッチの待ち時間の上限(テスト用に環境変数で短くできる)

class RoomManager {
  constructor() {
    this.rooms = new Map();   // code -> room
    this.queue = [];          // ランダムマッチ待ち行列 [{socketId, token, since}]
  }

  // ---------- 部屋 ----------
  newCode() {
    let c = '';
    do {
      c = '';
      for (let i = 0; i < 5; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    } while (this.rooms.has(c));
    return c;
  }

  newPlayer(socketId, token) {
    return { socketId, token, connected: true, charIndex: null, rematch: false, graceTimer: null };
  }

  create(socketId, token, isQuick = false) {
    const now = Date.now();
    const room = {
      code: this.newCode(),
      status: 'waiting',        // waiting / selecting / playing / finished
      isQuick,                  // ランダムマッチで作られた部屋か
      createdAt: now,
      lastActivityAt: now,
      players: [this.newPlayer(socketId, token)],
    };
    this.rooms.set(room.code, room);
    return room;
  }

  join(code, socketId, token) {
    const room = this.rooms.get(String(code || '').toUpperCase());
    if (!room || room.isQuick) return { error: 'ROOM_NOT_FOUND' }; // ランダムマッチの部屋には合言葉で入れない
    if (room.players.some(p => p.socketId === socketId)) return { room };
    if (room.players.length >= 2) return { error: 'ROOM_FULL' };
    room.players.push(this.newPlayer(socketId, token));
    room.status = 'selecting';
    this.touch(room);
    return { room };
  }

  // ランダムマッチで2人そろったときに部屋を作る
  createQuickRoom(a, b) {
    const room = this.create(a.socketId, a.token, true);
    room.players.push(this.newPlayer(b.socketId, b.token));
    room.status = 'selecting';
    return room;
  }

  get(code) { return this.rooms.get(String(code || '').toUpperCase()); }
  touch(room) { if (room) room.lastActivityAt = Date.now(); }

  findBySocket(room, socketId) { return room ? room.players.find(p => p.socketId === socketId) || null : null; }
  opponentOf(room, player) { return room ? room.players.find(p => p !== player) || null : null; }

  // 部屋からプレイヤーを取り除く。空になったら部屋ごと消す。
  removePlayer(room, player) {
    if (!room || !player) return;
    if (player.graceTimer) { clearTimeout(player.graceTimer); player.graceTimer = null; }
    room.players = room.players.filter(p => p !== player);
    room.players.forEach(p => { p.charIndex = null; p.rematch = false; });
    this.touch(room);
    if (room.players.length === 0) this.deleteRoom(room.code);
    else room.status = 'waiting';
  }

  deleteRoom(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    room.players.forEach(p => { if (p.graceTimer) clearTimeout(p.graceTimer); });
    this.rooms.delete(code);
  }

  // ---------- ランダムマッチ待ち行列 ----------
  inQueue(socketId) { return this.queue.some(e => e.socketId === socketId); }

  // 相手が見つかればその人を行列から外して返す。見つからなければ自分を行列に入れて null。
  enqueueOrMatch(socketId, token, isAlive) {
    this.dequeue(socketId);
    // 同じ playerToken 同士(同じ端末の2タブなど)はマッチさせない
    const idx = this.queue.findIndex(e => e.token !== token && e.socketId !== socketId && isAlive(e.socketId));
    if (idx >= 0) {
      const partner = this.queue[idx];
      this.queue.splice(idx, 1);
      return partner;
    }
    this.queue.push({ socketId, token, since: Date.now() });
    return null;
  }

  dequeue(socketId) {
    const before = this.queue.length;
    this.queue = this.queue.filter(e => e.socketId !== socketId);
    return before !== this.queue.length;
  }

  // 待ち時間が60秒を超えた人を取り出す(呼び出し側で match:timeout を送る)
  takeTimedOut(now = Date.now()) {
    const expired = this.queue.filter(e => now - e.since >= QUEUE_TIMEOUT_MS);
    if (expired.length) this.queue = this.queue.filter(e => now - e.since < QUEUE_TIMEOUT_MS);
    return expired;
  }

  // ---------- 後片付け ----------
  cleanup(isAlive, now = Date.now()) {
    for (const [code, room] of this.rooms) {
      const idle = now - room.lastActivityAt;
      const age = now - room.createdAt;
      const nobodyHere = room.players.every(p => !p.connected || !isAlive(p.socketId));
      if (nobodyHere && idle > 30 * 1000) { this.deleteRoom(code); continue; }
      if (room.status !== 'playing' && idle > ROOM_IDLE_TTL_MS) { this.deleteRoom(code); continue; }
      if (age > ROOM_HARD_TTL_MS && idle > ROOM_IDLE_TTL_MS / 2) { this.deleteRoom(code); continue; }
    }
    // 行列に残った切断済みの人も念のため外す
    this.queue = this.queue.filter(e => isAlive(e.socketId));
  }
}

module.exports = { RoomManager, ROOM_IDLE_TTL_MS, QUEUE_TIMEOUT_MS };
