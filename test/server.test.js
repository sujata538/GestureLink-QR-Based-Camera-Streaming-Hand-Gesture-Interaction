'use strict';
// Run: node test/server.test.js   (Node >= 18, no dependencies)
process.env.GRACE_MS = '400';
process.env.PHONE_GRACE_MS = '400';
process.env.FIRST_CONNECT_MS = '1500';
process.env.ROOM_UNCLAIMED_TTL_MS = '1200';
process.env.SWEEP_MS = '200';
process.env.JOIN_FAIL_LIMIT = '4';
process.env.CREATE_LIMIT = '1000';
process.env.TRUST_PROXY = '1';
process.env.PUBLIC_URL = 'https://example.test/';
process.env.TURN_URLS = 'turn:turn.example.test:3478';
process.env.TURN_USERNAME = 'u';
process.env.TURN_CREDENTIAL = 'c';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createServer, rooms } = require('../server');

let base, server;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.closeAllConnections?.(); server.close(); setTimeout(() => process.exit(0), 50); });

const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

/** Minimal SSE client collecting events */
function sse(p) {
  const events = [];
  const waiters = [];
  let req;
  const ready = new Promise((resolve, reject) => {
    req = http.get(base + p, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve({ status: res.statusCode, events, close() {}, next: async () => null }); }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const m = /^event: (.+)\ndata: (.*)$/m.exec(chunk);
          if (m) { const ev = { type: m[1], data: JSON.parse(m[2]) }; events.push(ev); waiters.splice(0).forEach((w) => w()); }
        }
      });
      res.on('close', () => { events.closed = true; waiters.splice(0).forEach((w) => w()); });
      resolve({
        status: 200, events, close: () => req.destroy(),
        async next(type, timeout = 2000) {
          const t0 = Date.now();
          for (;;) {
            const idx = events.findIndex((e) => e.type === type);
            if (idx >= 0) return events.splice(idx, 1)[0];
            if (Date.now() - t0 > timeout) return null;
            await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
          }
        },
      });
    });
    req.on('error', reject);
  });
  return ready;
}

async function pair() {
  const created = await (await post('/api/rooms')).json();
  const host = await sse(`/api/rooms/${created.code}/events?role=host&token=${created.token}`);
  const j = await post(`/api/rooms/${created.code}/join`);
  const joined = await j.json();
  const phone = await sse(`/api/rooms/${created.code}/events?role=phone&token=${joined.token}`);
  return { code: created.code, hostTok: created.token, phoneTok: joined.token, host, phone };
}

test('config exposes ICE servers (STUN + TURN) and normalised public URL', async () => {
  const cfg = await (await fetch(base + '/api/config')).json();
  assert.equal(cfg.publicUrl, 'https://example.test');
  assert.ok(cfg.iceServers.some((s) => JSON.stringify(s.urls).includes('stun:')));
  const turn = cfg.iceServers.find((s) => JSON.stringify(s.urls).includes('turn:'));
  assert.equal(turn.username, 'u');
});

test('creates a 6-digit room code and pairs a phone', async () => {
  const { code, host, phone } = await pair();
  assert.match(code, /^\d{6}$/);
  assert.ok((await host.next('ready')));
  assert.ok((await host.next('phone-joined')), 'host is told the phone joined');
  assert.ok((await phone.next('ready')));
  host.close(); phone.close();
});

test('a second phone cannot join an occupied room (409)', async () => {
  const p = await pair();
  const r = await post(`/api/rooms/${p.code}/join`);
  assert.equal(r.status, 409);
  p.host.close(); p.phone.close();
});

test('relays offer/ice phone->host and answer/command host->phone, nothing else', async () => {
  const p = await pair();
  await p.host.next('phone-joined');
  let r = await post(`/api/rooms/${p.code}/send`, { role: 'phone', token: p.phoneTok, type: 'offer', data: { sdp: 'x' } });
  assert.equal(r.status, 200);
  const offer = await p.host.next('offer');
  assert.deepEqual(offer.data, { sdp: 'x' });

  r = await post(`/api/rooms/${p.code}/send`, { role: 'host', token: p.hostTok, type: 'answer', data: { sdp: 'y' } });
  assert.equal(r.status, 200);
  assert.deepEqual((await p.phone.next('answer')).data, { sdp: 'y' });

  r = await post(`/api/rooms/${p.code}/send`, { role: 'host', token: p.hostTok, type: 'command', data: { action: 'switch-camera' } });
  assert.equal(r.status, 200);
  assert.equal((await p.phone.next('command')).data.action, 'switch-camera');

  // direction rules: phone cannot send 'command' or 'answer'; host cannot send 'offer'
  for (const [role, tok, type] of [['phone', p.phoneTok, 'command'], ['phone', p.phoneTok, 'answer'], ['host', p.hostTok, 'offer'], ['host', p.hostTok, 'bogus']]) {
    const bad = await post(`/api/rooms/${p.code}/send`, { role, token: tok, type, data: {} });
    assert.equal(bad.status, 400, `${role} must not send ${type}`);
  }
  p.host.close(); p.phone.close();
});

test('relays bounded phone JPEG frames to the connected desktop over SSE', async () => {
  const p = await pair();
  await p.host.next('phone-joined');
  const frame = { sequence: 1, jpeg: 'data:image/jpeg;base64,' + 'a'.repeat(256) };
  const r = await post(`/api/rooms/${p.code}/send`, {
    role: 'phone', token: p.phoneTok, type: 'video-frame', data: frame,
  });
  assert.equal(r.status, 200);
  assert.deepEqual((await p.host.next('video-frame')).data, frame);

  const invalid = await post(`/api/rooms/${p.code}/send`, {
    role: 'phone', token: p.phoneTok, type: 'video-frame', data: { sequence: 2, jpeg: 'not-a-jpeg' },
  });
  assert.equal(invalid.status, 400);

  const oversized = await post(`/api/rooms/${p.code}/send`, {
    role: 'phone', token: p.phoneTok, type: 'video-frame', data: {
      sequence: 3, jpeg: 'data:image/jpeg;base64,' + 'a'.repeat(48001),
    },
  });
  assert.equal(oversized.status, 413);
  p.host.close(); p.phone.close();
});

test('incoming phone video frames refresh the phone SSE grace timer', async () => {
  const p = await pair();
  p.phone.close();
  await sleep(250);
  const frame = { sequence: 1, jpeg: 'data:image/jpeg;base64,AAAA' };
  const r = await post(`/api/rooms/${p.code}/send`, {
    role: 'phone', token: p.phoneTok, type: 'video-frame', data: frame,
  });
  assert.equal(r.status, 200);
  assert.deepEqual((await p.host.next('video-frame')).data, frame);
  await sleep(250);
  assert.equal(rooms.get(p.code)?.phoneJoined, true, 'active frame relay keeps the phone slot alive');
  p.host.close();
});

test('phone JPEG frames are not queued when the desktop SSE is offline', async () => {
  const created = await (await post('/api/rooms')).json();
  const joined = await (await post(`/api/rooms/${created.code}/join`)).json();
  const r = await post(`/api/rooms/${created.code}/send`, {
    role: 'phone', token: joined.token, type: 'video-frame',
    data: { sequence: 1, jpeg: 'data:image/jpeg;base64,AAAA' },
  });
  assert.equal(r.status, 503);
});

test('wrong / swapped tokens are rejected', async () => {
  const p = await pair();
  let r = await post(`/api/rooms/${p.code}/send`, { role: 'host', token: p.phoneTok, type: 'ice', data: {} });
  assert.equal(r.status, 403);
  r = await post(`/api/rooms/${p.code}/send`, { role: 'phone', token: 'nope', type: 'ice', data: {} });
  assert.equal(r.status, 403);
  const bad = await sse(`/api/rooms/${p.code}/events?role=host&token=${p.phoneTok}`);
  assert.equal(bad.status, 403);
  p.host.close(); p.phone.close();
});

test('messages sent before the receiver opens its stream are queued, not lost', async () => {
  const created = await (await post('/api/rooms')).json();
  const joined = await (await post(`/api/rooms/${created.code}/join`)).json();
  await post(`/api/rooms/${created.code}/send`, { role: 'phone', token: joined.token, type: 'offer', data: { n: 1 } });
  const host = await sse(`/api/rooms/${created.code}/events?role=host&token=${created.token}`);
  assert.ok(await host.next('phone-joined'));
  assert.deepEqual((await host.next('offer')).data, { n: 1 });
  host.close();
});

test('invalid code returns 404; repeated wrong codes get rate-limited (429) per client IP', async () => {
  const fromIp = (ip, p) => fetch(base + p, { method: 'POST', headers: { 'x-forwarded-for': ip } });
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await fromIp('9.9.9.9', '/api/rooms/000000/join')).status);
  assert.equal(statuses[0], 404);
  assert.ok(statuses.includes(429), 'brute-force is throttled: ' + statuses);
  // even a correct code is refused while throttled (prevents guess-then-confirm)
  const created = await (await post('/api/rooms')).json();
  assert.equal((await fromIp('9.9.9.9', `/api/rooms/${created.code}/join`)).status, 429);
  // a different client is unaffected
  assert.equal((await fromIp('8.8.8.8', `/api/rooms/${created.code}/join`)).status, 200);
});

test('malformed codes and bodies are handled', async () => {
  assert.equal((await post('/api/rooms/abc/join')).status, 404);
  const created = await (await post('/api/rooms')).json();
  const r = await fetch(`${base}/api/rooms/${created.code}/send`, { method: 'POST', body: '{not json' });
  assert.equal(r.status, 400);
  const big = await fetch(`${base}/api/rooms/${created.code}/send`, { method: 'POST', body: 'x'.repeat(70000) }).catch(() => ({ status: 413 }));
  assert.ok([413].includes(big.status));
});

test('phone drop: short blip is tolerated, long drop notifies host and frees the slot', async () => {
  const p = await pair();
  await p.host.next('phone-joined');
  // blip: reconnect within grace
  p.phone.close();
  await sleep(150);
  const again = await sse(`/api/rooms/${p.code}/events?role=phone&token=${p.phoneTok}`);
  assert.equal(again.status, 200);
  await sleep(600);
  assert.equal(await p.host.next('phone-left', 100), null, 'no phone-left after quick reconnect');
  // real drop
  again.close();
  const left = await p.host.next('phone-left', 2000);
  assert.ok(left, 'host told phone left');
  // slot freed: a new phone can join the same code
  const r = await post(`/api/rooms/${p.code}/join`);
  assert.equal(r.status, 200);
  p.host.close();
});

test('explicit leave by phone notifies host immediately', async () => {
  const p = await pair();
  await p.host.next('phone-joined');
  await post(`/api/rooms/${p.code}/leave`, { role: 'phone', token: p.phoneTok });
  assert.ok(await p.host.next('phone-left', 500));
  p.host.close();
});

test('host leaving closes the room and tells the phone', async () => {
  const p = await pair();
  await post(`/api/rooms/${p.code}/leave`, { role: 'host', token: p.hostTok });
  const closed = await p.phone.next('room-closed', 1000);
  assert.ok(closed);
  assert.equal(closed.data.reason, 'host-left');
  assert.equal(rooms.has(p.code), false);
  assert.equal((await post(`/api/rooms/${p.code}/join`)).status, 404);
});

test('unclaimed rooms expire and the waiting host is told', async () => {
  const created = await (await post('/api/rooms')).json();
  const host = await sse(`/api/rooms/${created.code}/events?role=host&token=${created.token}`);
  const closed = await host.next('room-closed', 3000);
  assert.ok(closed, 'room-closed delivered');
  assert.equal(closed.data.reason, 'expired');
});

// Regression test: host SSE disconnect does not destroy room if phone still connected
test('host SSE disconnect keeps room alive when phone is connected', async () => {
  const p = await pair();
  await p.host.next('phone-joined');
  // Close host SSE (simulates host tab refresh or network blip)
  p.host.close();
  await sleep(100);
  // Room should still exist, phone should still be able to send messages
  const r = await post(`/api/rooms/${p.code}/send`, { role: 'phone', token: p.phoneTok, type: 'ice', data: { test: true } });
  assert.equal(r.status, 200);
  // Host can reconnect with same token
  const host2 = await sse(`/api/rooms/${p.code}/events?role=host&token=${p.hostTok}`);
  assert.equal(host2.status, 200);
  host2.close();
  p.phone.close();
});

// Regression test: phone POST /join reconnection with same token during grace period
test('phone POST /join reconnection with same token during grace period', async () => {
  const p = await pair();
  await p.host.next('phone-joined');
  // Close phone SSE
  p.phone.close();
  await sleep(150); // within grace period (400ms)
  // Rejoin via POST /join with same token
  const r = await post(`/api/rooms/${p.code}/join`, { token: p.phoneTok });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.token, p.phoneTok); // same token returned
  // Host should not receive phone-joined again
  assert.equal(await p.host.next('phone-joined', 100), null);
  // Phone can open new SSE
  const phone2 = await sse(`/api/rooms/${p.code}/events?role=phone&token=${p.phoneTok}`);
  assert.equal(phone2.status, 200);
  phone2.close();
  p.host.close();
});

// Regression test: phone POST /join after grace period expires allows new phone to join
test('phone POST /join after grace period expires allows new phone to join', async () => {
  const p = await pair();
  await p.host.next('phone-joined');
  // Close phone SSE
  p.phone.close();
  // Wait for grace period to expire (400ms + buffer)
  await sleep(500);
  // After grace period expires, phone state is cleared, so a NEW phone can join
  // (without providing the old token, or with any token - it will get a new token)
  const r = await post(`/api/rooms/${p.code}/join`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.notEqual(body.token, p.phoneTok); // new token issued
  p.host.close();
});

test('static files: app is served, traversal and dotfiles are blocked, security headers set', async () => {
  let r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(r.headers.get('content-type'), /text\/html/);
  for (const bad of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/.env', '/%00', '/../package.json']) {
    r = await fetch(base + bad);
    assert.ok([400, 404].includes(r.status), `${bad} -> ${r.status}`);
    const t = await r.text();
    assert.ok(!t.includes('createServer') && !t.includes('"scripts"'), `${bad} must not leak`);
  }
  assert.equal((await fetch(base + '/server.js')).status, 404);
  assert.equal((await fetch(base + '/healthz')).status, 200);
});
