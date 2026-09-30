// DANGO BATTLE サーバーの動作確認テスト(npm test)
// サーバーを別ポートで起動し、socket.io-client で2〜3人の接続をまねて確認する。
process.env.QUEUE_TIMEOUT_MS = process.env.QUEUE_TIMEOUT_MS || '3000';
process.env.RECONNECT_GRACE_MS = process.env.RECONNECT_GRACE_MS || '2000';
const assert = require('assert');
const { io: ioc } = require('socket.io-client');
const { server, rooms } = require('../server/server');

const PORT = 3999;
const URL = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clients = [];
function client() {
  const s = ioc(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
  s.events = [];
  s.onAny((ev, d) => s.events.push({ ev, d }));
  clients.push(s);
  return new Promise(r => s.on('connect', () => r(s)));
}
const ack = (s, ev, data) => new Promise(r => s.emit(ev, data || {}, r));
function waitFor(s, ev, ms = 4000) {
  const hit = s.events.find(e => e.ev === ev);
  if (hit) { s.events.splice(s.events.indexOf(hit), 1); return Promise.resolve(hit.d); }
  return new Promise((ok, ng) => {
    const t = setTimeout(() => ng(new Error(`timeout waiting ${ev}`)), ms);
    s.onAny(function h(e, d) { if (e === ev) { clearTimeout(t); s.offAny(h); s.events.splice(s.events.findIndex(x => x.ev === ev), 1); ok(d); } });
  });
}
const tok = n => ('player' + n).padEnd(12, 'x');
const results = [];
async function test(name, fn) {
  try { await fn(); results.push(['OK  ', name]); }
  catch (e) { results.push(['FAIL', name + ' → ' + e.message]); }
  clients.splice(0).forEach(s => s.disconnect());
  await sleep(150);
}

(async () => {
  await new Promise(r => server.listen(PORT, r));

  await test('ランダムマッチ → キャラ選択 → 対戦 → 決着', async () => {
    const a = await client(), b = await client();
    const ra = await ack(a, 'match:quick', { playerToken: tok(1) });
    assert.strictEqual(ra.waiting, true);
    const lc = await waitFor(a, 'lobby:count');
    assert.ok(lc.online >= 2 && lc.waiting === 1);
    const rb = await ack(b, 'match:quick', { playerToken: tok(2) });
    assert.strictEqual(rb.waiting, false); assert.ok(rb.code && rb.isQuick);
    const ma = await waitFor(a, 'room:matched'); await waitFor(b, 'room:matched');
    assert.strictEqual(ma.code, rb.code);
    await ack(a, 'player:character', { charIndex: 2 });
    assert.strictEqual((await waitFor(b, 'opponent:character')).charIndex, 2);
    await ack(b, 'player:character', { charIndex: 5 });
    await waitFor(a, 'match:start'); await waitFor(b, 'match:start');
    a.emit('game:snapshot', { stack: [{ x: 1, width: 40, color: '#fff', evil: 'x' }], skill: 50, charIndex: 2, combo: 1, timeLeft: 40 });
    const snap = await waitFor(b, 'opponent:snapshot');
    assert.deepStrictEqual(snap.stack[0], { x: 1, width: 40, color: '#fff' }); // 余計な項目は落とされる
    a.emit('game:motion', { x: 10, width: 40, color: '#f00', vx: 2, height: 3 });
    await waitFor(b, 'opponent:motion');
    const w = await ack(a, 'game:win', { reason: 'height20' });
    assert.ok(w.ok);
    const fin = await waitFor(b, 'match:finished');
    assert.strictEqual(fin.winnerId, a.id);
  });

  await test('同じ playerToken 同士はマッチしない', async () => {
    const a = await client(), b = await client(), c = await client();
    await ack(a, 'match:quick', { playerToken: tok(7) });
    const rb = await ack(b, 'match:quick', { playerToken: tok(7) });
    assert.strictEqual(rb.waiting, true);
    const rc = await ack(c, 'match:quick', { playerToken: tok(8) });
    assert.strictEqual(rc.waiting, false); // 別トークンの c とはマッチする
    assert.strictEqual(rooms.queue.length, 1);
  });

  await test('待機中キャンセルでキューから消える', async () => {
    const a = await client(), b = await client();
    await ack(a, 'match:quick', { playerToken: tok(1) });
    const c1 = await ack(a, 'match:cancel');
    assert.strictEqual(c1.removed, true);
    const rb = await ack(b, 'match:quick', { playerToken: tok(2) });
    assert.strictEqual(rb.waiting, true); // a とはマッチしない
  });

  await test('待機中に切断してもキューに残らない', async () => {
    const a = await client(), b = await client();
    await ack(a, 'match:quick', { playerToken: tok(1) });
    a.disconnect(); await sleep(150);
    assert.strictEqual(rooms.queue.length, 0);
    const rb = await ack(b, 'match:quick', { playerToken: tok(2) });
    assert.strictEqual(rb.waiting, true);
  });

  await test('待機が上限時間を超えると match:timeout', async () => {
    const a = await client();
    await ack(a, 'match:quick', { playerToken: tok(1) });
    await waitFor(a, 'match:timeout', 6000);
    assert.strictEqual(rooms.queue.length, 0);
  });

  await test('対戦中に切断 → 復帰で再開(room:resume)', async () => {
    const a = await client(), b = await client();
    await ack(a, 'match:quick', { playerToken: tok(1) });
    const r = await ack(b, 'match:quick', { playerToken: tok(2) });
    await ack(a, 'player:character', { charIndex: 0 }); await ack(b, 'player:character', { charIndex: 1 });
    await waitFor(b, 'match:start');
    a.disconnect();
    await waitFor(b, 'opponent:reconnecting');
    const a2 = await client();
    const res = await ack(a2, 'room:resume', { code: r.code, playerToken: tok(1) });
    assert.ok(res.ok);
    await waitFor(b, 'opponent:resumed'); await waitFor(b, 'match:resume'); await waitFor(a2, 'match:resume');
    a2.emit('game:snapshot', { stack: [], skill: 0, charIndex: 0, combo: 0, timeLeft: 30 });
    await waitFor(b, 'opponent:snapshot');
  });

  await test('切断のまま猶予を過ぎると opponent:left', async () => {
    const a = await client(), b = await client();
    await ack(a, 'match:quick', { playerToken: tok(1) });
    await ack(b, 'match:quick', { playerToken: tok(2) });
    a.disconnect();
    await waitFor(b, 'opponent:left', 4000);
  });

  await test('再戦の成立と、相手が抜けたときの opponent:left', async () => {
    const a = await client(), b = await client();
    await ack(a, 'match:quick', { playerToken: tok(1) });
    await ack(b, 'match:quick', { playerToken: tok(2) });
    await ack(a, 'player:character', { charIndex: 0 }); await ack(b, 'player:character', { charIndex: 1 });
    await ack(a, 'game:win', {});
    await ack(a, 'rematch:request');
    await waitFor(b, 'rematch:requested');
    await ack(b, 'rematch:request');
    await waitFor(a, 'rematch:start'); await waitFor(b, 'rematch:start');
    a.emit('room:leave');
    await waitFor(b, 'opponent:left');
  });

  await test('合言葉の部屋作成・参加が今まで通り動く', async () => {
    const a = await client(), b = await client(), c = await client();
    const r = await ack(a, 'room:create', { playerToken: tok(1) });
    assert.ok(r.ok && /^[A-Z0-9]{5}$/.test(r.code));
    const j = await ack(b, 'room:join', { code: r.code.toLowerCase(), playerToken: tok(2) });
    assert.ok(j.ok);
    await waitFor(a, 'room:matched');
    const full = await ack(c, 'room:join', { code: r.code, playerToken: tok(3) });
    assert.strictEqual(full.error, 'ROOM_FULL');
    const nf = await ack(c, 'room:join', { code: 'ZZZZZ', playerToken: tok(3) });
    assert.strictEqual(nf.error, 'ROOM_NOT_FOUND');
  });

  await test('不正な値・連打は無視される', async () => {
    const a = await client(), b = await client();
    await ack(a, 'match:quick', { playerToken: tok(1) });
    await ack(b, 'match:quick', { playerToken: tok(2) });
    const bad = await ack(a, 'player:character', 'not-an-object');
    assert.ok(bad.ok); // 形が違っても落ちない(charIndex は 0 扱い)
    a.emit('game:snapshot', { stack: 'x'.repeat(100) });
    let limited = 0;
    for (let i = 0; i < 30; i++) { const r = await ack(a, 'match:cancel'); if (r.error === 'RATE_LIMITED') limited++; }
    assert.ok(limited > 0, 'rate limit should kick in');
  });

  results.forEach(r => console.log(r[0], r[1]));
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
