# Applying the Living Garden camera-frame fallback patch

This patch keeps direct WebRTC as the preferred video path and adds a bounded JPEG-over-HTTPS/SSE fallback for the exact failure seen in the physical test: ICE connected while DTLS remained `connecting` and the desktop received no video frames.

## Apply on Ubuntu

From a terminal:

```bash
cd ~/Projects
cp -a living-garden living-garden-backup-before-frame-relay
unzip -o ~/Downloads/living-garden-frame-relay-fix.zip -d ~/Projects
cd ~/Projects/living-garden
```

## Verify local checks

```bash
node --check server.js
node --check public/phone.js
node --check public/remote.js
node --check public/app.js
node --check public/source.js
node test/server.test.js
node test/qr.test.js
python3 test/qr_verify.py
```

## Run it

Keep the Cloudflare tunnel terminal open. In a separate terminal, start the server using the *exact current URL printed by cloudflared*:

```bash
cd ~/Projects/living-garden
PUBLIC_URL=https://YOUR-CURRENT-TUNNEL.trycloudflare.com node server.js
```

Do not type the placeholder literally. Open `http://localhost:3000` on the laptop, refresh, create a fresh QR code, and scan it with the iPhone.

## What the fallback does

While sharing, the phone sends downscaled JPEG frames (target up to 6 fps, max 48 KB per frame) through the existing authenticated `/send` endpoint. The server relays those frames to the laptop's existing SSE connection. The laptop draws them to a canvas-capture `MediaStream`, which feeds the existing preview window and MediaPipe hand-tracking pipeline. If direct WebRTC video starts producing frames, the desktop switches back to it.

This is a fallback transport, not proof that the underlying DTLS issue has been fixed. Verify the physical iPhone picture appears and moves on the laptop.
