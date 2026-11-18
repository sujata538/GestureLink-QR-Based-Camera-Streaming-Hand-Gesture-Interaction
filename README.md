# 🌸 Living Garden — Grow Flowers With Your Hands

A real-time experience where you plant, grow, and tend a generative
flower garden using nothing but hand gestures — MediaPipe Hands + Canvas 2D.

Unlike a typical "control a shape with your hand" demo, nothing here is
directly puppeted. You plant seeds; the garden grows on its own, keeps
living while your hands are out of frame, and responds to how you tend it.

**New in v3 — choose your camera:**

| Mode | When to use it |
|---|---|
| 💻 **This computer** | The computer has a webcam. Works exactly like before. |
| 📱 **A phone** | The computer has **no webcam**, or a friend wants to play from her own phone. The computer shows a **QR code + 6-digit PIN + link**; the phone opens it, taps **Allow camera**, and its video is streamed live to the computer, where the *same* hand-tracking and flower code processes it. |

## Quick start (Windows / macOS / Linux)

You need [Node.js 18+](https://nodejs.org). There is **nothing to `npm install`** — the server has zero dependencies.

```bash
cd living-garden
node server.js
```

Open **http://localhost:3000**, pick **This computer**, allow the camera. Done.

## Using a phone as the camera

Phone browsers only allow camera access on **https://** pages, and a phone
can't reach `localhost` on your computer. So for phone mode the app must be
reachable at a public **https://** address. Pick one:

### Option A — Instant tunnel (best for trying it today)

1. Start the app: `node server.js`
2. In a second terminal, start a tunnel:
   - Cloudflare (free, no account for quick tunnels): `cloudflared tunnel --url http://localhost:3000`
     (Windows install: `winget install Cloudflare.cloudflared`)
   - or ngrok: `ngrok http 3000`
3. It prints an `https://….trycloudflare.com` (or ngrok) address.
   **Open that address on your computer** (not localhost) and choose **A phone**.
   The QR code and link now point at the tunnel, and anyone you send the link to can connect — including your friend in her office.

   Alternatively keep using localhost on the computer and start the server with
   `PUBLIC_URL=https://….trycloudflare.com node server.js` (Windows PowerShell: `$env:PUBLIC_URL="https://…"; node server.js`).

### Option B — Deploy it (best for regular use)

Any host that runs Node works (Render, Railway, Fly.io, a VPS…). On Render, for example:
create a **Web Service** from this folder/repo, **Build command:** *(empty)*, **Start command:** `node server.js`,
and set the environment variables `TRUST_PROXY=1` and `PUBLIC_URL=https://<your-service>.onrender.com`.
The host supplies HTTPS for you.

### How a session works

1. Computer: **A phone** → shows QR + PIN `482 913` + link. (A code is valid for 10 minutes until a phone joins.)
2. Phone: scan the QR / open the link / type the PIN at `/phone`.
3. Phone: choose **Front** or **Rear** camera and tap **Allow camera & start sharing**.
4. The phone's video appears on the computer and the garden responds to the hands in it.
5. On the computer, **🔄 Phone camera** flips the phone between front/rear; **↔ Mirror** flips the picture; **Change camera** ends the session.
   On the phone, **Stop sharing** turns the camera off immediately.

Tip: hold the phone **sideways (landscape)**. Portrait video still works — it is letterboxed on the computer and hand positions stay correctly aligned.

### ⚠️ Office / corporate networks need a TURN server

WebRTC tries a direct peer-to-peer path between phone and computer using free
public STUN servers (this is built in). That works on most home networks, but
**many office networks block it** — and your friend is connecting from an office.
If the phone connects but no video appears (or it drops after a few seconds),
add a **TURN relay**, which forwards the (encrypted) video when a direct path is impossible.
Get TURN credentials from a provider (Metered, Twilio, Cloudflare…) or run your own
[coturn](https://github.com/coturn/coturn), then set `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`
(see `.env.example`). No code changes needed.

## Privacy & security

- **Consent is explicit.** The phone's camera starts only after the person taps *Allow camera & start sharing* and grants the browser permission. While sharing, the phone shows a red **LIVE** badge and a **Stop sharing** button; closing the page also stops it.
- **Video never touches the app server.** It flows phone → computer over an encrypted WebRTC connection (or via your TURN relay, still encrypted). The server only relays small signaling messages. Nothing is recorded or stored.
- **Pairing codes:** 6 digits, random, single phone per code, expire after 10 minutes if unused (4 hours max per session), and are destroyed when the computer leaves. Wrong-PIN guesses are rate-limited per IP (10 per 10 minutes) — set `TRUST_PROXY=1` behind a proxy so this sees real client IPs.
- Session tokens (separate for computer and phone) authenticate every message; a phone cannot impersonate the computer or vice versa.
- Only share the link/PIN with the person you want to connect. Anyone holding a valid unused code can claim it, just like a meeting link.
- The static server only serves `public/`, blocks path traversal and dotfiles, and sets `nosniff`, `Referrer-Policy: no-referrer` and `Permissions-Policy` headers.

## Controls (unchanged)

| Gesture | Effect |
|---|---|
| Pinch fingers together, then flick them open fast | Plants a seed at that hand's position — it sprouts and grows autonomously over the next several seconds |
| Hold an open palm near a grown flower | That specific flower blooms open (bloom is per-flower and proximity-based) |
| Bring both hands together fast (clap) | Fertilizer burst — every flower gets a growth/bloom boost, plus a particle explosion and a wind gust |
| Sway either hand side to side | Generates wind that bends every stem in the garden |
| Do nothing | Mature flowers keep gently swaying and pulsing on their own — the garden persists |

The garden holds up to 10 flowers; planting an 11th retires the oldest.

## Why this design

The original build (a single flower you puppet with two static pinches)
is a nice demo but a shallow interaction — the moment your hands stop
moving, the whole thing goes inert. This version is built around a
different idea: **the garden should feel alive independent of you.**
Growth runs on its own clock. Bloom depends on care (proximity), not a
knob. A clap is a discrete, satisfying "event" gesture rather than a
continuous control. The result is a system you *tend*, not a puppet
you *operate*.

## Architecture

```
 Phone (phone.html / phone.js)                 Computer (index.html + app.js)
 ─────────────────────────────                 ──────────────────────────────
 getUserMedia ─► RTCPeerConnection ═══ video (WebRTC, P2P or TURN) ═══► <video> ─► MediaPipe Hands ─► garden
        │                                                                  ▲
        └── HTTP POST ──►  server.js  ◄── Server-Sent Events ──────────────┘
                           (PIN pairing + WebRTC signaling relay, serves /public)
```

| File | Role |
|---|---|
| `server.js` | Zero-dependency Node server: static files, PIN pairing, signaling relay (SSE + POST), rate limiting |
| `public/index.html`, `style.css`, `app.js` | Your garden. `app.js` now consumes *any* `MediaStream`; gesture and drawing code is unchanged apart from landmark→screen mapping |
| `public/source.js` | Camera picker, QR/PIN panel, status bar; chooses webcam vs phone |
| `public/remote.js` | Desktop-side WebRTC receiver + signaling client |
| `public/qr.js` | Dependency-free QR generator |
| `public/phone.html`, `phone.css`, `phone.js` | The page opened on the phone |
| `test/` | Automated tests (see below) |

Two details worth knowing:

- **Landmark mapping.** Hand positions are mapped from the video frame to the canvas using the same math as CSS `object-fit`, so the overlay stays aligned even when the video's shape differs from the window (e.g. portrait phone video). When "cover" would crop too much, the video is letterboxed instead.
- **Mirroring.** Webcam and the phone's front camera are shown mirrored (selfie style). The rear camera is shown un-mirrored automatically; the **↔ Mirror** button overrides it.

URL shortcuts: `/?source=local` and `/?source=phone` skip the picker.

## Tech stack

- **MediaPipe Hands** (`@mediapipe/hands@0.4`) — 21-point hand landmark detection, via CDN
- **WebRTC** — phone → computer video
- **Node.js (no dependencies)** — signaling over Server-Sent Events + HTTP
- **HTML5 Canvas 2D** — all rendering
- **Vanilla JavaScript (ES6 classes)** — no framework, no bundler

## Server configuration

All optional; see `.env.example`.

| Variable | Purpose |
|---|---|
| `PORT` | Port (default 3000) |
| `PUBLIC_URL` | Public https address used in phone links and the QR code |
| `TRUST_PROXY` | `1` behind a reverse proxy so rate limits use real client IPs |
| `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` / `TURN_SECRET` | TURN relay for restrictive networks |
| `ICE_SERVERS_JSON` | Full custom ICE server list |
| `SSL_KEY`, `SSL_CERT` | Serve HTTPS directly (e.g. mkcert certs) |

## Troubleshooting

| Symptom | Fix |
|---|---|
| Phone says "Camera access needs a secure connection" | Open the `https://` address, not `http://` or a LAN IP (see *Using a phone*) |
| Warning on the pairing screen about the address | You opened the app via `localhost`; use a tunnel/deployment address or set `PUBLIC_URL` |
| "That code is not valid or has expired" | Codes last 10 minutes; press **New code** |
| "Another phone is already connected" | One phone per code. If the phone page was just reloaded, wait ~15 s |
| Phone connects, but no video / video drops | Network blocks peer-to-peer: configure a **TURN** server |
| Picture is cropped or hands look offset | Shouldn't happen (mapping is automatic); try the **↔ Mirror** button, then report it |
| iPhone camera freezes when you switch apps | iOS pauses cameras in background tabs; keep the phone page open and the screen on |
| Hand tracking never starts | The page loads MediaPipe from jsDelivr; check internet access/ad-blockers |

## Running it locally for development

Camera access requires `localhost` or `https://` — opening `index.html`
directly via `file://` will not work. Always go through `node server.js`.

## Tests

```bash
npm test                 # 13 server tests (pairing, auth, relay rules, rate-limit, expiry, static safety) — Node only
npm run test:qr          # QR generator vs OpenCV decoder (needs python3 + opencv-python)
npm run test:e2e         # real browser end-to-end: desktop + phone pages, real WebRTC with fake cameras
                         # (needs python3 + playwright + chromium; MediaPipe is stubbed because it loads from a CDN)
```

## Known tuning knobs (if gestures feel off)

All in `app.js`, inside `LivingGardenApp`:

- Seed-planting sensitivity: the `0.18` / `0.58` thresholds in
  `onHandResults` (closed-pinch and flick-open thresholds)
- Planting cooldown: `1100` ms in the same block
- Clap sensitivity: `0.09` (must-close-to) and `0.24` (must-have-been-open)
  in the clap detection block
- Bloom proximity radius: `radius = 150` in the animation loop
- Garden size cap: `this.maxGardenFlowers = 10` in the constructor

Phone-stream quality (resolution/frame-rate/bitrate) is set in `phone.js` (`openCamera`, `tuneSender`).

## Ideas for a next pass

- Swap flower species per fist-gesture cycle (tulip / rose / lily presets)
- A "record" button exporting a few seconds of canvas frames as a GIF
- Day/night ambient lighting cycle tied to real elapsed session time
- Two-hand "stretch" gesture to create a connecting vine between two flowers
- Screen-mirroring mode (phone display shown on the desktop) — a different problem from camera streaming; would need native screen-capture

## Phone video fallback

The phone normally uses direct WebRTC media. If DTLS/media stalls, it sends bounded, downscaled JPEG preview frames through authenticated HTTPS POST and the desktop SSE stream (target up to 6 fps). Frames are held in memory only.
