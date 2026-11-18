# Living Garden camera-stream review

## Confirmed source defect

In the uploaded `public/phone.js`, `startSharing()` took two different paths based on `MediaStreamTrack.muted`:

- If the track was already unmuted, it called `showPreview(S.stream)`.
- If the track was muted, it waited for the `unmute` event but did not attach/play the stream in the phone preview first.

The supplied project comments and prior diagnosis state that on iOS Safari the local preview playback is what allows a newly acquired camera track to start producing frames. The muted branch therefore waited for a state transition without triggering the preview playback that the project itself says is needed. After its timeout, the old code continued to create the peer connection anyway.

This is a concrete source-level defect consistent with the repeated black remote preview. It does not, by itself, prove that this was the only cause of the physical-device failure.

## Changes in this patched copy

- `public/phone.js`: always reveal the live screen, attach/play the local camera preview, and wait for a live, unmuted track plus non-zero preview dimensions before sending camera info and creating the peer connection. If the local preview does not produce frames within 10 seconds, stop the camera and show a specific error instead of sending a muted track. Camera switching similarly verifies the new preview before replacing the sender track.
- `public/app.js`: reveal the desktop phone-preview element before calling `play()`, and correct the promise handling so a failed play is not subsequently logged as successful.
- `public/source.js`: no longer marks the phone camera live merely because an `ontrack` stream arrived or the peer connection connected. It waits for the desktop video element to have `readyState >= 2` and non-zero dimensions, and reports a no-frames state after 10 seconds.
- `test/e2e.py`: adds checks for the phone's local preview frames and the dedicated desktop phone-preview dimensions.

## Validation performed in this environment

Passed:
- JavaScript syntax checks for `server.js`, `public/phone.js`, `public/remote.js`, `public/app.js`, and `public/source.js`.
- Python compilation check for `test/e2e.py`.
- `node test/server.test.js`: 16/16 tests passed.
- `node test/qr.test.js`: 17 QR cases generated.
- `python3 test/qr_verify.py`: 17/17 QR cases decoded, 0 failures.

Not verified here:
- `python3 test/e2e.py` could not run to completion in this environment. Playwright navigation to its local test server was blocked with `net::ERR_BLOCKED_BY_ADMINISTRATOR` at `http://localhost:3111/`. This is an environment restriction, not a passing E2E run.
- A physical iPhone Safari test has not been performed from this environment. The iPhone must still be tested against the patched project to confirm actual camera frames on the laptop.

## Security / packaging note

The `.claude/` local settings directory was intentionally excluded from the handoff ZIP because it contained local session configuration and temporary room credentials. No `.env` files, private keys, or local Git metadata are included.


## Follow-up: authenticated HTTPS frame fallback

The physical-device diagnostics later showed `iceConnectionState: connected` while the DTLS transport remained `connecting`; the desktop had no `inbound-rtp` video report. To avoid blocking the user's camera preview on that peer-to-peer transport, this patched project retains WebRTC as the preferred path and adds a fallback:

- The phone captures downscaled JPEG frames from the already-rendering local preview and posts them as `video-frame` messages using its room token.
- The server validates the phone token, validates JPEG data URLs and enforces a 48 KB frame payload limit. Frames are not queued when the desktop SSE connection is absent and are not written to disk.
- The desktop draws relayed frames to a canvas and exposes that canvas using `captureStream()`, so the existing visible preview and MediaPipe input consume a normal `MediaStream`.
- If the real WebRTC video track later unmutes, the desktop switches back to that direct stream; if it mutes again, it requests the HTTPS fallback.

This is a practical media fallback, not proof that the original DTLS issue itself is fixed. Browser automation and server tests in this environment cannot verify a physical iPhone or external Cloudflare tunnel; that final device test remains required.
