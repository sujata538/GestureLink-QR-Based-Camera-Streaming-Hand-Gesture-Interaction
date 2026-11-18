'use strict';
/* ===========================================================
   LIVING GARDEN - signaling + static server
   ===========================================================
   Zero dependencies (Node >= 18). It does two things:

   1. Serves ./public (the desktop app and the phone page).
   2. Pairs a desktop with a phone using a 6-digit PIN and relays
      WebRTC signaling messages between them. Video normally flows
      phone -> desktop peer-to-peer (or via TURN). If the direct
      WebRTC media transport stalls, the phone can send bounded JPEG
      preview frames over authenticated HTTP POST + desktop SSE.

   Transport: Server-Sent Events (server -> client) + HTTP POST
   (client -> server). Works through proxies/CDNs and needs no
   WebSocket library.
   =========================================================== */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------
// Config (all via environment variables)
// ---------------------------------------------------------------
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');

const ROOM_UNCLAIMED_TTL_MS = num('ROOM_UNCLAIMED_TTL_MS', 10 * 60 * 1000); // code valid until a phone joins
const ROOM_MAX_AGE_MS = num('ROOM_MAX_AGE_MS', 4 * 60 * 60 * 1000);        // hard cap on a session
const GRACE_MS = num('GRACE_MS', 12 * 1000);                                // tolerate brief network drops (host)
const PHONE_GRACE_MS = num('PHONE_GRACE_MS', 60 * 1000);                    // longer grace for phone (mobile networks)
const FIRST_CONNECT_MS = num('FIRST_CONNECT_MS', 30 * 1000);                // time allowed to open the event stream
const MAX_ROOMS = num('MAX_ROOMS', 1000);
const MAX_BODY = 64 * 1024;

const JOIN_FAIL_LIMIT = num('JOIN_FAIL_LIMIT', 10);          // wrong PINs per IP per window
const JOIN_FAIL_WINDOW_MS = num('JOIN_FAIL_WINDOW_MS', 10 * 60 * 1000);
const CREATE_LIMIT = num('CREATE_LIMIT', 30);                // rooms per IP per window
const CREATE_WINDOW_MS = num('CREATE_WINDOW_MS', 10 * 60 * 1000);

function num(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// ---------------------------------------------------------------
// ICE servers (STUN always; TURN if configured)
// ---------------------------------------------------------------
function buildIceServers() {
  if (process.env.ICE_SERVERS_JSON) {
    try {
      const parsed = JSON.parse(process.env.ICE_SERVERS_JSON);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      console.warn('ICE_SERVERS_JSON is not valid JSON, ignoring.');
    }
  }
  const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const turnUrls = (process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (turnUrls.length) {
    if (process.env.TURN_SECRET) {
      // coturn "use-auth-secret" time-limited credentials
      const username = String(Math.floor(Date.now() / 1000) + 6 * 3600) + ':living-garden';
      const credential = crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
      servers.push({ urls: turnUrls, username, credential });
    } else if (process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
      servers.push({ urls: turnUrls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
    } else {
      console.warn('TURN_URLS set but no TURN_SECRET or TURN_USERNAME/TURN_CREDENTIAL - ignoring TURN.');
    }
  }
  return servers;
}

// ---------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------
/** @type {Map<string, any>} */
const rooms = new Map();

const FROM_HOST = new Set(['answer', 'ice', 'command', 'bye']);
const FROM_PHONE = new Set(['offer', 'ice', 'camera-info', 'video-frame', 'bye']);

function newPeer() {
  return { res: null, queue: [], timer: null };
}

function makeCode() {
  for (let i = 0; i < 50; i++) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (!rooms.has(code)) return code;
  }
  return null;
}

// Logging helper
function log(...args) {
  console.log('[SERVER]', new Date().toISOString(), ...args);
}

function token() {
  return crypto.randomBytes(24).toString('base64url');
}

function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function createRoom() {
  const code = makeCode();
  if (!code) return null;
  const room = {
    code,
    hostToken: token(),
    phoneToken: null,
    phoneJoined: false,
    createdAt: Date.now(),
    lastActive: Date.now(),
    peers: { host: newPeer(), phone: newPeer() },
  };
  armTimer(room, 'host', FIRST_CONNECT_MS);
  rooms.set(code, room);
  log('Room created:', code, '(rooms:', rooms.size, ')');
  return room;
}

function armTimer(room, role, ms) {
  const peer = room.peers[role];
  clearTimeout(peer.timer);
  peer.timer = setTimeout(() => onGonePeer(peer, room, role, 'timeout'), ms);
}

function onGonePeer(peer, room, role, reason) {
  if (rooms.get(room.code) !== room) return;
  // If a new peer has replaced this one (e.g., phone rejoined), don't process this timeout
  if (room.peers[role] !== peer) return;
  onGone(room, role, reason);
}

function writeEvent(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify(data === undefined ? {} : data)}\n\n`);
}

function sendTo(room, role, type, data) {
  const peer = room.peers[role];
  if (peer.res) {
    writeEvent(peer.res, type, data);
  } else if (peer.queue.length < 200) {
    peer.queue.push({ type, data });
  }
}

function onGone(room, role, reason) {
  if (rooms.get(room.code) !== room) return;
  const peer = room.peers[role];
  clearTimeout(peer.timer);
  peer.timer = null;
  if (peer.res) {
    try { peer.res.end(); } catch (e) { /* ignore */ }
    peer.res = null;
  }
  log('Peer gone:', room.code, 'role:', role, 'reason:', reason);
  if (role === 'host') {
    // Only destroy the room if phone is not connected (or not joined)
    // If phone is still connected, keep the room alive so phone can continue/reconnect
    if (!room.phoneJoined || !room.peers.phone.res) {
      destroyRoom(room, 'host-left');
    } else {
      log('Host SSE disconnected but phone still connected, keeping room alive:', room.code);
      // Send phone-left to phone so it knows host is gone
      sendTo(room, 'phone', 'room-closed', { reason: 'host-left' });
    }
  } else if (room.phoneJoined) {
    if (reason === 'timeout') {
      // Grace period expired - clear phone state so a new phone can join
      log('Phone grace period expired, clearing phone state:', room.code);
      room.phoneJoined = false;
      room.phoneToken = null;
      peer.queue = [];
      room.lastActive = Date.now();
      sendTo(room, 'host', 'phone-left', { reason });
    } else {
      // Explicit leave or other reason - clear immediately
      log('Phone left explicitly, clearing phone state:', room.code);
      room.phoneJoined = false;
      room.phoneToken = null;
      peer.queue = [];
      room.lastActive = Date.now();
      sendTo(room, 'host', 'phone-left', { reason });
    }
  }
}

function destroyRoom(room, reason) {
  if (rooms.get(room.code) !== room) return;
  log('Room destroyed:', room.code, 'reason:', reason, '(rooms:', rooms.size - 1, ')');
  rooms.delete(room.code);
  for (const role of ['host', 'phone']) {
    const peer = room.peers[role];
    clearTimeout(peer.timer);
    if (peer.res) {
      try {
        if (role === 'phone' || reason !== 'host-left') writeEvent(peer.res, 'room-closed', { reason });
        peer.res.end();
      } catch (e) { /* ignore */ }
      peer.res = null;
    }
  }
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (now - room.createdAt > ROOM_MAX_AGE_MS) destroyRoom(room, 'expired');
    else if (!room.phoneJoined && now - room.lastActive > ROOM_UNCLAIMED_TTL_MS) destroyRoom(room, 'expired');
  }
  for (const [k, v] of limiter) if (v.resetAt <= now) limiter.delete(k);
}, num('SWEEP_MS', 5000)).unref();

// SSE keep-alive so proxies do not close idle streams
setInterval(() => {
  for (const room of rooms.values()) {
    for (const role of ['host', 'phone']) {
      const res = room.peers[role].res;
      if (res) { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } }
    }
  }
}, 20000).unref();

// ---------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------
const limiter = new Map();

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function hit(key, limit, windowMs) {
  const now = Date.now();
  let e = limiter.get(key);
  if (!e || e.resetAt <= now) {
    e = { count: 0, resetAt: now + windowMs };
    limiter.set(key, e);
  }
  e.count++;
  return e.count <= limit;
}

function isBlocked(key, limit) {
  const e = limiter.get(key);
  return !!(e && e.resetAt > Date.now() && e.count >= limit);
}

// ---------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function baseHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer', // the PIN may be in the URL
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    ...baseHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...baseHeaders(), Allow: 'GET, HEAD' });
    return res.end();
  }
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { rel = null; }
  if (rel === null || rel.includes('\0')) {
    res.writeHead(400, baseHeaders());
    return res.end('Bad request');
  }
  if (rel === '/') rel = '/index.html';
  if (rel === '/phone') rel = '/phone.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  const withinRoot = filePath.startsWith(PUBLIC_DIR + path.sep);
  const hasDotSegment = rel.split('/').some((s) => s.startsWith('.'));
  if (!withinRoot || hasDotSegment) {
    res.writeHead(404, baseHeaders());
    return res.end('Not found');
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { ...baseHeaders(), 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      ...baseHeaders(),
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------------------------------------------------------------
// API
// ---------------------------------------------------------------
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const ip = clientIp(req);

  // GET /api/config
  if (req.method === 'GET' && parts.length === 2 && parts[1] === 'config') {
    return sendJson(res, 200, { iceServers: buildIceServers(), publicUrl: PUBLIC_URL || null });
  }

  // POST /api/rooms   -> create room (desktop)
  if (req.method === 'POST' && parts.length === 2 && parts[1] === 'rooms') {
    if (!hit('create:' + ip, CREATE_LIMIT, CREATE_WINDOW_MS)) return sendJson(res, 429, { error: 'Too many requests. Try again later.' });
    if (rooms.size >= MAX_ROOMS) return sendJson(res, 503, { error: 'Server is busy. Try again shortly.' });
    const room = createRoom();
    if (!room) return sendJson(res, 503, { error: 'Could not allocate a code.' });
    return sendJson(res, 201, { code: room.code, token: room.hostToken, role: 'host' });
  }

  if (parts[1] !== 'rooms' || parts.length < 4 || !/^\d{6}$/.test(parts[2])) {
    return sendJson(res, 404, { error: 'Not found' });
  }
  const code = parts[2];
  const action = parts[3];

  // POST /api/rooms/:code/join   -> phone claims the room (or reconnects during grace period)
  if (req.method === 'POST' && action === 'join') {
    const failKey = 'joinfail:' + ip;
    if (isBlocked(failKey, JOIN_FAIL_LIMIT)) return sendJson(res, 429, { error: 'Too many wrong codes. Wait a few minutes and try again.' });
    const room = rooms.get(code);
    const body = await readJson(req);
    const providedToken = body.token;
    if (!room) {
      hit(failKey, JOIN_FAIL_LIMIT, JOIN_FAIL_WINDOW_MS);
      log('Join failed - room not found:', code, 'from IP:', ip);
      return sendJson(res, 404, { error: 'That code is not valid or has expired.' });
    }

    // Allow reconnection with the same token during grace period
    if (room.phoneJoined && room.phoneToken && providedToken && safeEq(providedToken, room.phoneToken)) {
      log('Phone reconnection with valid token during grace period:', code);
      room.lastActive = Date.now();
      room.peers.phone = newPeer();
      armTimer(room, 'phone', FIRST_CONNECT_MS);
      // Don't send phone-joined again - host already knows
      return sendJson(res, 200, { code, token: room.phoneToken, role: 'phone' });
    }

    if (room.phoneJoined) {
      log('Join failed - phone already joined (different token):', code);
      return sendJson(res, 409, { error: 'Another phone is already connected to this code.' });
    }
    room.phoneJoined = true;
    room.phoneToken = token();
    room.lastActive = Date.now();
    room.peers.phone = newPeer();
    armTimer(room, 'phone', FIRST_CONNECT_MS);
    sendTo(room, 'host', 'phone-joined', {});
    log('Phone joined room:', code, '(phoneJoined:', room.phoneJoined, ')');
    return sendJson(res, 200, { code, token: room.phoneToken, role: 'phone' });
  }

  // GET /api/rooms/:code/events?role=&token=   (SSE)
  if (req.method === 'GET' && action === 'events') {
    const role = url.searchParams.get('role');
    const tok = url.searchParams.get('token');
    const room = rooms.get(code);
    if (!room || (role !== 'host' && role !== 'phone')) {
      log('SSE rejected - room not found or invalid role:', code, role);
      return sendJson(res, 404, { error: 'Room not found' });
    }
    const expected = role === 'host' ? room.hostToken : room.phoneToken;
    if (!safeEq(tok, expected)) {
      log('SSE rejected - invalid token for room:', code, 'role:', role);
      return sendJson(res, 403, { error: 'Forbidden' });
    }

    const peer = room.peers[role];
    if (peer.res) { try { peer.res.end(); } catch (e) { /* ignore */ } }
    clearTimeout(peer.timer);
    peer.timer = null;
    peer.res = res;

    log('SSE connected:', code, 'role:', role, '(phoneJoined:', room.phoneJoined, ')');

    res.writeHead(200, {
      ...baseHeaders(),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Send initial comment to prevent proxy buffering (especially Cloudflare)
    res.write(':ok\n\n');
    res.write('retry: 2000\n\n');
    writeEvent(res, 'ready', { role, phoneJoined: room.phoneJoined });
    const queued = peer.queue.splice(0);
    for (const m of queued) writeEvent(res, m.type, m.data);

    req.on('close', () => {
      if (peer.res !== res) return; // replaced by a newer connection
      peer.res = null;
      log('SSE closed:', code, 'role:', role);
      if (rooms.get(room.code) === room) {
        const graceMs = role === 'phone' ? PHONE_GRACE_MS : GRACE_MS;
        armTimer(room, role, graceMs);
      }
    });
    return; // keep open
  }

  // POST /api/rooms/:code/send   -> relay a message to the other side
  if (req.method === 'POST' && action === 'send') {
    const body = await readJson(req);
    const room = rooms.get(code);
    if (!room) return sendJson(res, 404, { error: 'Room not found' });
    const role = body.role;
    if (role !== 'host' && role !== 'phone') return sendJson(res, 400, { error: 'Bad role' });
    const expected = role === 'host' ? room.hostToken : room.phoneToken;
    if (!safeEq(body.token, expected)) return sendJson(res, 403, { error: 'Forbidden' });
    const allowed = role === 'host' ? FROM_HOST : FROM_PHONE;
    if (typeof body.type !== 'string' || !allowed.has(body.type)) return sendJson(res, 400, { error: 'Message type not allowed' });

    // When direct WebRTC media cannot complete (for example, DTLS remains
    // connecting across restrictive mobile networks), the phone can relay
    // small JPEG preview frames over the already-established HTTPS/SSE path.
    // Keep frames bounded and never queue them while the host is offline.
    if (body.type === 'video-frame') {
      const jpeg = body.data && body.data.jpeg;
      if (role !== 'phone' || !room.phoneJoined || typeof jpeg !== 'string' ||
          !jpeg.startsWith('data:image/jpeg;base64,')) {
        return sendJson(res, 400, { error: 'Invalid video frame' });
      }
      if (jpeg.length > 48000) return sendJson(res, 413, { error: 'Video frame is too large' });
      if (!room.peers.host.res) return sendJson(res, 503, { error: 'Desktop is not connected' });
      // A valid incoming frame also proves the phone is still active if its
      // EventSource transport briefly dropped. Refresh the phone grace timer.
      if (!room.peers.phone.res) armTimer(room, 'phone', PHONE_GRACE_MS);
    }

    room.lastActive = Date.now();
    // Do not log every preview frame; the stream can send several per second.
    if (body.type !== 'video-frame') log('Message relayed:', code, 'from:', role, 'type:', body.type);
    sendTo(room, role === 'host' ? 'phone' : 'host', body.type, body.data);
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/rooms/:code/leave
  if (req.method === 'POST' && action === 'leave') {
    const body = await readJson(req);
    const room = rooms.get(code);
    if (!room) return sendJson(res, 200, { ok: true });
    const role = body.role;
    if (role !== 'host' && role !== 'phone') return sendJson(res, 400, { error: 'Bad role' });
    const expected = role === 'host' ? room.hostToken : room.phoneToken;
    if (!safeEq(body.token, expected)) return sendJson(res, 403, { error: 'Forbidden' });
    log('Leave request:', code, 'role:', role);
    if (role === 'host') {
      destroyRoom(room, 'host-left');
    } else {
      // tell the phone's own stream we are done, then free the slot for a new phone
      onGone(room, 'phone', 'left');
    }
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

// ---------------------------------------------------------------
// Server
// ---------------------------------------------------------------
function handler(req, res) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) {
    res.writeHead(400, baseHeaders());
    return res.end('Bad request');
  }
  if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, rooms: rooms.size });
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      if (res.headersSent) return;
      sendJson(res, err.status || 500, { error: err.status ? err.message : 'Server error' });
      if (!err.status) console.error(err);
    });
    return;
  }
  serveStatic(req, res, url.pathname);
}

function createServer() {
  if (process.env.SSL_KEY && process.env.SSL_CERT) {
    return https.createServer({ key: fs.readFileSync(process.env.SSL_KEY), cert: fs.readFileSync(process.env.SSL_CERT) }, handler);
  }
  return http.createServer(handler);
}

if (require.main === module) {
  const server = createServer();
  const scheme = process.env.SSL_KEY && process.env.SSL_CERT ? 'https' : 'http';
  server.listen(PORT, HOST, () => {
    console.log(`Living Garden running on ${scheme}://localhost:${PORT}`);
    if (PUBLIC_URL) console.log(`Phone links will use PUBLIC_URL = ${PUBLIC_URL}`);
    else console.log('Tip: phones need HTTPS. Set PUBLIC_URL (or open this app via your https tunnel/deployment URL).');
  });
  const shutdown = () => { server.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createServer, rooms };
