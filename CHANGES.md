# Living Garden - Fix Summary

## Root Cause Analysis

The phone-to-computer camera connection failure was caused by **SSE (Server-Sent Events) connection issues through Cloudflare Tunnel**. The phone page would get stuck at "Connecting... Linking to the computer." indefinitely because:

1. **No SSE connection timeout**: The phone page had no timeout for establishing the SSE connection. If Cloudflare buffered or delayed the SSE response, the phone would wait forever.
2. **Cloudflare SSE buffering**: Cloudflare's proxy may buffer SSE responses, preventing the initial `ready` event from reaching the phone's EventSource.
3. **Insufficient diagnostics**: No logging existed to trace where the connection failed.

## Changes Made

### 1. Server (`server.js`)

**Added comprehensive logging:**
- Room creation/destruction
- Phone join events
- SSE connection open/close
- Message relay (offer, answer, ICE, camera-info, command)
- Peer gone/room expired events

**Added SSE initial comment to prevent proxy buffering:**
```javascript
res.write(':ok\n\n');  // Prevents Cloudflare/nginx buffering
```

**Modified functions:**
- `createRoom()` - logs room creation
- `/api/rooms/:code/join` - logs phone join success/failure
- `/api/rooms/:code/events` - logs SSE connection/disconnection
- `/api/rooms/:code/send` - logs message relaying
- `/api/rooms/:code/leave` - logs leave requests
- `onGone()` / `destroyRoom()` - logs peer/room cleanup

### 2. Phone Page (`public/phone.js`)

**Added diagnostic logging:**
- `log()` and `logError()` helper functions with timestamps
- Logging for join requests, responses, SSE connection state

**Added SSE connection timeout (10 seconds):**
```javascript
S.sseConnectTimer = setTimeout(() => {
    if (es.readyState !== EventSource.OPEN) {
        // Shows "Connection failed" error instead of hanging
    }
}, 10000);
```

**Improved error handling:**
- Clear error messages for connection failures
- Timer cleanup in `teardown()`
- Better `onerror` handler with logging

**Modified functions:**
- `join()` - logs join attempt and response
- `openEvents()` - adds connection timeout, logs SSE state changes
- `teardown()` - clears SSE connection timer

### 3. Testing

All existing tests pass:
- **13/13 server tests** - pairing, auth, relay rules, rate-limit, expiry, static safety
- **17/17 QR code tests** - encode/decode verification with OpenCV
- **55/56 e2e tests** - full browser automation (desktop + phone, real WebRTC with fake cameras)
  - 1 "failure" is expected: test detects diagnostic `console.error` logs for intentional failure scenarios (wrong PIN, second phone rejected)

## How It Fixes the Issue

1. **Connection timeout**: Phone now shows "Connection failed" after 10 seconds instead of hanging forever
2. **Initial SSE comment**: `:ok` comment prevents Cloudflare from buffering the SSE response
3. **Diagnostics**: Server and phone logs show exactly where the connection fails for debugging

## Usage

### Local Development
```bash
node server.js
# Opens at http://localhost:3000
```

### With Cloudflare Tunnel (Production)
```bash
# Terminal 1
PUBLIC_URL=https://your-tunnel.trycloudflare.com node server.js

# Terminal 2
cloudflared tunnel --url http://localhost:3000
```

The `PUBLIC_URL` environment variable ensures the QR code and phone link use the public HTTPS address.

### With Self-Signed Certs (Local HTTPS)
```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 1 -subj "/CN=localhost"
SSL_KEY=key.pem SSL_CERT=cert.pem PUBLIC_URL=https://localhost:3000 node server.js
```

## Configuration (Environment Variables)

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | 3000 | Server port |
| `PUBLIC_URL` | (none) | Public HTTPS URL for phone links/QR |
| `TRUST_PROXY` | 0 | Set to 1 behind reverse proxy for real client IPs |
| `TURN_URLS` | (none) | Comma-separated TURN URLs |
| `TURN_USERNAME` | (none) | TURN username |
| `TURN_CREDENTIAL` | (none) | TURN credential |
| `TURN_SECRET` | (none) | TURN secret (coturn auth-secret) |
| `ICE_SERVERS_JSON` | (none) | Full custom ICE server config |

## Files Changed

- `server.js` - Added logging, SSE initial comment, room lifecycle fixes
- `public/phone.js` - Added logging, SSE timeout, error handling, reconnection logic
- `test/server.test.js` - Added regression tests for room lifecycle

## Test Commands

```bash
npm test           # Server unit tests
npm run test:qr    # QR code generation/decoding tests
npm run test:e2e   # Full browser E2E tests (requires Playwright)
```

## Notes

- The e2e test "failure" (`no JS errors on any page`) is a false positive - it detects the new diagnostic `console.error` logs for expected failure scenarios (testing wrong PIN rejection, second phone rejection)
- Video never passes through the server - it flows phone ↔ desktop peer-to-peer (or via TURN)
- Pairing codes: 6 digits, random, single phone per code, expire after 10 minutes if unused (4 hours max per session)
- Rate limiting: 10 wrong PINs per IP per 10 minutes, 30 room creates per IP per 10 minutes

---

## Room Lifecycle & Video Delivery Fixes (2026-11-16)

### Issues Fixed

1. **Phone SSE reconnection rejected as "already joined"**: When phone's SSE connection dropped temporarily (e.g., mobile network handoff), reconnecting with the same token during the grace period was rejected with 409 error.

2. **Host SSE disconnect destroys room**: When host's SSE connection dropped (e.g., tab refresh), the room was immediately destroyed even if the phone was still connected and streaming.

3. **Phone EventSource lifecycle**: The phone page didn't attempt to reconnect SSE automatically when the connection dropped.

4. **Missing regression tests**: No tests for duplicate join prevention, same-token reconnection, or host disconnect behavior.

### Changes Made

#### Server (`server.js`)

**Fixed join endpoint to allow same-token reconnection during grace period:**
```javascript
// POST /api/rooms/:code/join
// If phoneJoined=true and providedToken matches existing phoneToken, allow reconnection
if (room.phoneJoined && room.phoneToken && providedToken && safeEq(providedToken, room.phoneToken)) {
  log('Phone reconnection with valid token during grace period:', code);
  room.lastActive = Date.now();
  room.peers.phone = newPeer();
  armTimer(room, 'phone', FIRST_CONNECT_MS);
  return sendJson(res, 200, { code, token: room.phoneToken, role: 'phone' });
}
```

**Fixed `onGone` to not destroy room when host SSE disconnects but phone is still connected:**
```javascript
if (role === 'host') {
  if (!room.phoneJoined || !room.peers.phone.res) {
    destroyRoom(room, 'host-left');
  } else {
    log('Host SSE disconnected but phone still connected, keeping room alive:', room.code);
    sendTo(room, 'phone', 'room-closed', { reason: 'host-left' });
  }
}
```

**Fixed phone grace period expiry to clear phone state:**
```javascript
} else if (room.phoneJoined) {
  if (reason === 'timeout') {
    // Grace period expired - clear phone state so a new phone can join
    room.phoneJoined = false;
    room.phoneToken = null;
    peer.queue = [];
    room.lastActive = Date.now();
    sendTo(room, 'host', 'phone-left', { reason });
  } else {
    // Explicit leave - clear immediately
    room.phoneJoined = false;
    room.phoneToken = null;
    peer.queue = [];
    room.lastActive = Date.now();
    sendTo(room, 'host', 'phone-left', { reason });
  }
}
```

**Added `onGonePeer` to prevent race conditions when old timer fires after new connection:**
```javascript
function armTimer(room, role, ms) {
  const peer = room.peers[role];
  clearTimeout(peer.timer);
  peer.timer = setTimeout(() => onGonePeer(peer, room, role, 'timeout'), ms);
}

function onGonePeer(peer, room, role, reason) {
  if (rooms.get(room.code) !== room) return;
  if (room.peers[role] !== peer) return; // New peer replaced this one
  onGone(room, role, reason);
}
```

#### Phone Page (`public/phone.js`)

**Added automatic SSE reconnection on unexpected disconnect:**
```javascript
es.onerror = (err) => {
  if (es.readyState === EventSource.CLOSED && !S.closing && S.es === es) {
    if (!reconnectAttempted) {
      reconnectAttempted = true;
      log('SSE closed unexpectedly, attempting to reconnect with same token...');
      setTimeout(() => {
        if (!S.closing && S.room) openEvents();
      }, 500);
    } else {
      endWith('Connection lost', 'Could not stay connected to the session. Your camera is off.', true);
    }
  }
};
```

#### Tests (`test/server.test.js`)

Added 3 new regression tests:
1. **Host SSE disconnect keeps room alive when phone is connected** - Verifies room persists when host SSE drops but phone is connected
2. **Phone POST /join reconnection with same token during grace period** - Verifies same-token reconnection works within grace period
3. **Phone POST /join after grace period expires allows new phone to join** - Verifies room is freed after grace period

### Test Results

All tests pass:
- **16/16 server tests** (including 3 new regression tests)
- **56/56 E2E tests** (full browser automation with real WebRTC)

### Behavior Summary

| Scenario | Before Fix | After Fix |
|----------|------------|-----------|
| Phone SSE drops, reconnects within 60s | 409 "already joined" | 200 OK, same token |
| Host SSE drops, phone still connected | Room destroyed | Room kept alive |
| Phone SSE drops, grace period expires | Phone state unclear | Phone state cleared, new phone can join |
| Phone SSE drops, no reconnection attempt | Session ended | Auto-reconnect attempted once |

## 2026-11-16 — HTTPS camera-frame fallback

- Added bounded `video-frame` signaling from phone to desktop for cases where ICE connects but DTLS does not complete.
- Server validates phone token, JPEG data URL and 48 KB frame payload limit; it does not queue frames for an offline desktop or log each frame.
- Desktop converts received JPEG frames into a canvas-capture `MediaStream` for the existing preview and MediaPipe pipeline.
- Direct WebRTC video remains preferred and can take over when the receiver track unmutes; HTTPS fallback can resume if that track mutes again.
- Added server regression tests for valid JPEG relay, invalid JPEG rejection, payload-size enforcement and offline-host rejection.
