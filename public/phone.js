/* ===========================================================
   Living Garden - phone page
   Joins a desktop session by PIN, asks the user for camera
   permission, and streams the camera to the desktop over WebRTC.
   =========================================================== */
(() => {
    'use strict';
    const $ = (id) => document.getElementById(id);
    const screens = ['screenCode', 'screenReady', 'screenLive', 'screenEnded'];

    // Diagnostic logging
    function log(...args) {
        const prefix = '[PHONE]';
        console.log(prefix, new Date().toISOString(), ...args);
    }

    function logError(...args) {
        const prefix = '[PHONE ERROR]';
        console.error(prefix, new Date().toISOString(), ...args);
    }

    const S = {
        room: null,          // { code, token }
        es: null,
        pc: null,
        sender: null,
        stream: null,
        facing: 'user',
        config: null,
        pendingIce: [],
        chain: Promise.resolve(),
        wakeLock: null,
        switching: false,
        sharing: false,
        closing: false,
        sseConnectTimer: null,  // timeout for SSE connection
        frameRelayTimer: null,
        frameRelayBusy: false,
        frameRelayGeneration: 0,
        frameRelayConnected: false,
        frameSequence: 0,
        frameCanvas: null,
    };

    // ------------------------------------------------------------------
    // UI helpers
    // ------------------------------------------------------------------
    function show(name) {
        for (const s of screens) $(s).hidden = s !== name;
    }
    function setText(id, t) { $(id).textContent = t || ''; }
    const digits = (v) => String(v || '').replace(/\D/g, '').slice(0, 6);
    const fmtCode = (d) => (d.length > 3 ? d.slice(0, 3) + ' ' + d.slice(3) : d);

    function endWith(title, text, canRestart = true) {
        S.closing = true;
        teardown();
        setText('endedTitle', title);
        setText('endedText', text);
        $('againBtn').hidden = !canRestart;
        show('screenEnded');
    }

    // ------------------------------------------------------------------
    // Environment check - getUserMedia only works on HTTPS / localhost
    // ------------------------------------------------------------------
    function cameraSupported() {
        return window.isSecureContext && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && 'RTCPeerConnection' in window;
    }

    // ------------------------------------------------------------------
    // Joining
    // ------------------------------------------------------------------
    async function loadConfig() {
        if (S.config) return S.config;
        const r = await fetch('/api/config', { cache: 'no-store' });
        if (!r.ok) throw new Error('Cannot reach the server.');
        S.config = await r.json();
        return S.config;
    }

    async function join(code) {
        log('join() called with code:', code);
        setText('codeError', '');
        $('connectBtn').disabled = true;
        S.closing = false;
        if (screens.every((n) => $(n).hidden)) {
            setText('endedTitle', 'Connecting…');
            setText('endedText', 'Linking to the computer.');
            $('againBtn').hidden = true;
            show('screenEnded');
        }
        try {
            await loadConfig();
            log('Sending join request to /api/rooms/' + code + '/join');
            const r = await fetch(`/api/rooms/${code}/join`, { method: 'POST' });
            log('Join response status:', r.status);
            const body = await r.json().catch(() => ({}));
            log('Join response body:', body);
            if (!r.ok) {
                show('screenCode');
                $('codeInput').value = fmtCode(code);
                let msg = body.error || 'Could not connect.';
                if (r.status === 409) msg += ' If you just reloaded this page, wait 15 seconds and try again.';
                logError('Join failed:', msg);
                setText('codeError', msg);
                $('connectBtn').disabled = digits($('codeInput').value).length !== 6;
                return;
            }
            S.room = { code: body.code, token: body.token };
            log('Join successful, token received, opening SSE events');
            openEvents();
        } catch (e) {
            logError('Join exception:', e);
            show('screenCode');
            setText('codeError', e.message || 'Could not connect.');
            $('connectBtn').disabled = digits($('codeInput').value).length !== 6;
        }
    }

    function openEvents() {
        const { code, token } = S.room;
        const es = new EventSource(`/api/rooms/${code}/events?role=phone&token=${encodeURIComponent(token)}`);
        S.es = es;
        log('EventSource created, readyState:', es.readyState);

        let readyEventReceived = false;
        let readyFallbackTimer = null;
        let reconnectAttempted = false;

        // Connection timeout - if SSE connection not open within 10 seconds, show error
        S.sseConnectTimer = setTimeout(() => {
            if (es.readyState !== EventSource.OPEN) {
                logError('SSE connection timeout - readyState:', es.readyState);
                es.close();
                if (!S.closing) {
                    endWith('Connection failed', 'Could not connect to the computer. Check your internet connection and try again.', true);
                }
            }
        }, 10000);

        es.onopen = () => {
            log('EventSource onopen fired, readyState:', es.readyState);
            // Fallback: if ready event not received within 5 seconds of connection opening,
            // assume the connection is ready and show the camera screen.
            // This handles cases where the ready event might be lost due to proxy buffering or race conditions.
            S.readyFallbackTimer = setTimeout(() => {
                if (!readyEventReceived && es.readyState === EventSource.OPEN && !S.sharing) {
                    log('Ready event not received within 5s of SSE open, falling back to screenReady');
                    show('screenReady');
                }
            }, 5000);
        };

        es.addEventListener('ready', (event) => {
            readyEventReceived = true;
            if (S.readyFallbackTimer) { clearTimeout(S.readyFallbackTimer); S.readyFallbackTimer = null; }
            const data = JSON.parse(event.data || '{}');
            log('Received ready event:', data, 'readyState:', es.readyState);
            clearTimeout(S.sseConnectTimer);
            S.sseConnectTimer = null;
            reconnectAttempted = false; // Reset on successful connection
            if (!S.sharing) show('screenReady');
        });
        es.addEventListener('answer', (e) => enqueue(() => onAnswer(JSON.parse(e.data))));
        es.addEventListener('ice', (e) => enqueue(() => onIce(JSON.parse(e.data))));
        es.addEventListener('command', (e) => {
            const d = JSON.parse(e.data || '{}');
            if (d.action === 'switch-camera' && S.sharing) switchCamera();
            if (d.action === 'stop-frame-relay') stopFrameRelay();
            if (d.action === 'start-frame-relay' && S.sharing) startFrameRelay();
        });
        es.addEventListener('room-closed', (e) => {
            const d = JSON.parse(e.data || '{}');
            if (S.closing) return;
            endWith(
                d.reason === 'expired' ? 'Session expired' : 'Session ended',
                d.reason === 'expired' ? 'This code ran out of time. Ask for a new one.' : 'The computer ended the session. Your camera is off.',
                false
            );
        });
        es.onerror = (err) => {
            logError('EventSource error, readyState:', es.readyState, err);
            if (es.readyState === EventSource.CLOSED && !S.closing && S.es === es) {
                clearTimeout(S.sseConnectTimer);
                S.sseConnectTimer = null;
                // Attempt to reconnect with the same token (server supports grace period reconnection)
                if (!reconnectAttempted) {
                    reconnectAttempted = true;
                    log('SSE closed unexpectedly, attempting to reconnect with same token...');
                    // Small delay to allow server to process the disconnect
                    setTimeout(() => {
                        if (!S.closing && S.room) {
                            openEvents();
                        }
                    }, 500);
                } else {
                    logError('Reconnection attempt also failed, ending session');
                    endWith('Connection lost', 'Could not stay connected to the session. Your camera is off.', true);
                }
            }
        };
    }

    function send(type, data) {
        if (!S.room) return Promise.resolve(false);
        return fetch(`/api/rooms/${S.room.code}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'phone', token: S.room.token, type, data }),
        }).then((response) => response.ok).catch((error) => {
            if (type !== 'video-frame') logError('Signal send failed:', type, error && error.message);
            return false;
        });
    }

    function enqueue(fn) { S.chain = S.chain.then(fn).catch((e) => console.warn('Signaling error:', e)); }

    // ------------------------------------------------------------------
    // Camera
    // ------------------------------------------------------------------
    async function openCamera(facing) {
        const video = {
            facingMode: { ideal: facing },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 },
        };
        const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        const track = stream.getVideoTracks()[0];
        const reported = track.getSettings().facingMode;
        S.facing = reported === 'user' || reported === 'environment' ? reported : facing;
        track.addEventListener('ended', () => {
            if (S.sharing && !S.switching && S.stream === stream && !S.closing) {
                endWith('Camera stopped', 'The camera was turned off (another app may have taken it, or permission changed).', true);
            }
        });
        return stream;
    }

    function showPreview(stream) {
        const v = $('preview');
        v.srcObject = stream;
        v.classList.toggle('mirror', S.facing === 'user');
        const playPromise = v.play();
        if (playPromise) {
            playPromise.catch(e => {
                logError('Preview video play failed:', e.name, e.message);
            });
        }
        log('Preview video play() called, readyState:', v.readyState);
        return playPromise;
    }

    // Wait until the local camera preview has actually rendered a frame before
    // adding its track to WebRTC. On iOS Safari, getUserMedia tracks can start
    // muted and become unmuted only after a video element renders them.
    function waitForPreviewFrames(video, track, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            const startedAt = Date.now();
            let timer = null;
            let settled = false;

            const cleanup = () => {
                if (timer !== null) clearTimeout(timer);
                video.removeEventListener('loadeddata', check);
                video.removeEventListener('playing', check);
                track.removeEventListener('unmute', check);
                track.removeEventListener('ended', onEnded);
            };
            const finish = (error) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (error) reject(error);
                else resolve({ width: video.videoWidth, height: video.videoHeight });
            };
            const onEnded = () => finish(new Error('The camera track ended before the preview produced a frame.'));
            const check = () => {
                if (track.readyState !== 'live') {
                    finish(new Error(`Camera track is ${track.readyState}.`));
                    return;
                }
                if (!track.muted && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
                    finish(null);
                    return;
                }
                if (Date.now() - startedAt >= timeoutMs) {
                    finish(new Error(
                        `No camera frame within ${timeoutMs}ms ` +
                        `(muted=${track.muted}, videoReadyState=${video.readyState}, ` +
                        `size=${video.videoWidth}x${video.videoHeight}).`
                    ));
                    return;
                }
                if (timer === null) timer = setTimeout(() => { timer = null; check(); }, 100);
            };

            video.addEventListener('loadeddata', check);
            video.addEventListener('playing', check);
            track.addEventListener('unmute', check);
            track.addEventListener('ended', onEnded, { once: true });
            check();
        });
    }

    // HTTPS/SSE frame relay fallback. The normal path remains WebRTC, but some
    // phone/mobile-network combinations can establish ICE without completing
    // DTLS. In that case, send small JPEG frames through the existing HTTPS
    // signaling route so the desktop can still display and track the camera.
    function stopFrameRelay() {
        S.frameRelayGeneration += 1;
        if (S.frameRelayTimer) {
            clearTimeout(S.frameRelayTimer);
            S.frameRelayTimer = null;
        }
        S.frameRelayConnected = false;
        S.frameRelayBusy = false;
        S.frameCanvas = null;
        S.frameRelayOversizeLogged = false;
        S.frameRelayErrorLogged = false;
    }

    function startFrameRelay() {
        stopFrameRelay();
        const generation = S.frameRelayGeneration;
        const video = $('preview');
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { alpha: false });
        S.frameCanvas = canvas;
        S.frameSequence = 0;
        if (!ctx) {
            logError('Frame relay unavailable: could not create canvas context');
            return;
        }

        const sendFrame = async () => {
            if (!S.sharing || !S.room || S.frameCanvas !== canvas || generation !== S.frameRelayGeneration) return;
            if (!S.frameRelayBusy && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
                S.frameRelayBusy = true;
                try {
                    const scale = Math.min(1, 480 / Math.max(video.videoWidth, video.videoHeight));
                    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
                    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    let jpeg = canvas.toDataURL('image/jpeg', 0.42);

                    // Keep each JSON/SSE message comfortably below the server's
                    // 64 KiB request-body limit, even for detailed camera scenes.
                    if (jpeg.length > 48000) {
                        const shrink = 0.72;
                        canvas.width = Math.max(160, Math.round(canvas.width * shrink));
                        canvas.height = Math.max(120, Math.round(canvas.height * shrink));
                        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                        jpeg = canvas.toDataURL('image/jpeg', 0.32);
                    }
                    if (jpeg.length <= 48000) {
                        const ok = await send('video-frame', { sequence: ++S.frameSequence, jpeg });
                        if (generation !== S.frameRelayGeneration) return;
                        if (ok && !S.frameRelayConnected) {
                            S.frameRelayConnected = true;
                            log('HTTPS frame relay accepted by desktop; sequence:', S.frameSequence);
                            setText('liveStatus', 'Sharing with computer');
                        }
                    } else if (!S.frameRelayOversizeLogged) {
                        S.frameRelayOversizeLogged = true;
                        logError('Frame relay JPEG exceeded 48 KB after downscaling; reducing preview resolution further is required.');
                    }
                } catch (e) {
                    if (!S.frameRelayErrorLogged) {
                        S.frameRelayErrorLogged = true;
                        logError('HTTPS frame relay failed:', e && e.message);
                    }
                } finally {
                    if (generation === S.frameRelayGeneration) S.frameRelayBusy = false;
                }
            }
            if (S.sharing && S.room && S.frameCanvas === canvas && generation === S.frameRelayGeneration) {
                S.frameRelayTimer = setTimeout(sendFrame, 160); // target ~6 frames/second
            }
        };

        log('Starting HTTPS camera-frame fallback at up to 6 fps');
        sendFrame();
    }

    function camErrorMessage(e) {
        switch (e && e.name) {
            case 'NotAllowedError':
            case 'SecurityError':
                return 'Camera permission was blocked. Allow camera access for this site in your browser settings, then try again.';
            case 'NotFoundError':
            case 'OverconstrainedError':
                return 'No matching camera was found on this device.';
            case 'NotReadableError':
            case 'AbortError':
                return 'The camera is busy. Close other apps that use the camera and try again.';
            default:
                return 'Could not start the camera: ' + ((e && e.message) || 'unknown error');
        }
    }

    async function startSharing() {
        log('startSharing() called');
        setText('camError', '');
        $('startBtn').disabled = true;
        const facing = (document.querySelector('input[name="facing"]:checked') || {}).value || 'user';
        log('Requesting camera with facing:', facing);
        try {
            S.stream = await openCamera(facing);
            log('getUserMedia succeeded, stream:', S.stream);
        } catch (e) {
            logError('getUserMedia failed:', e.name, e.message);
            setText('camError', camErrorMessage(e));
            $('startBtn').disabled = false;
            return;
        }
        S.sharing = true;
        setText('liveStatus', 'Starting camera…');
        // Reveal the live screen first. Then attach and play the local preview
        // BEFORE waiting for the track to unmute. On iOS Safari the preview is
        // what causes a muted getUserMedia track to start producing frames.
        show('screenLive');
        const track = S.stream.getVideoTracks()[0];
        const preview = $('preview');
        log('Camera track before preview:', {
            readyState: track.readyState,
            enabled: track.enabled,
            muted: track.muted,
            settings: track.getSettings(),
        });

        try {
            const playPromise = showPreview(S.stream);
            if (playPromise) await playPromise;
            const frame = await waitForPreviewFrames(preview, track, 10000);
            log('Phone camera preview is producing frames:', frame, 'trackMuted:', track.muted);
        } catch (e) {
            logError('Camera preview did not produce frames; not creating PeerConnection:', e.message);
            if (S.stream) {
                S.stream.getTracks().forEach((t) => t.stop());
                S.stream = null;
            }
            preview.pause();
            preview.srcObject = null;
            S.sharing = false;
            $('startBtn').disabled = false;
            setText('camError', 'The camera opened, but no video frames started. Keep this page open and try starting the camera again. ' + e.message);
            show('screenReady');
            return;
        }

        setText('liveStatus', 'Connecting…');
        requestWakeLock();
        await send('camera-info', { facing: S.facing });
        startFrameRelay();
        log('Camera frames confirmed; HTTPS fallback started and creating WebRTC PeerConnection');
        createPc();
    }

    async function switchCamera() {
        if (S.switching || !S.stream || !S.sender) return;
        S.switching = true;
        $('flipBtn').disabled = true;
        const previous = S.facing;
        const next = previous === 'user' ? 'environment' : 'user';
        const oldStream = S.stream;
        oldStream.getTracks().forEach((t) => t.stop()); // many phones can't open two cameras at once
        let newStream = null;
        try {
            newStream = await openCamera(next);
        } catch (e) {
            try { newStream = await openCamera(previous); } catch (e2) { /* handled below */ }
        }
        if (!newStream) {
            S.switching = false;
            return endWith('Camera stopped', 'Could not switch cameras.', true);
        }
        const newTrack = newStream.getVideoTracks()[0];
        try {
            // Start and verify the new local preview before replacing the sender
            // track, so iOS does not briefly send a muted replacement track.
            const playPromise = showPreview(newStream);
            if (playPromise) await playPromise;
            const frame = await waitForPreviewFrames($('preview'), newTrack, 10000);
            await S.sender.replaceTrack(newTrack);
            S.stream = newStream;
            log('Switched camera preview is producing frames:', frame);
            await send('camera-info', { facing: S.facing });
            S.switching = false;
            $('flipBtn').disabled = false;
        } catch (e) {
            logError('Camera switch failed before video frames were ready:', e.message);
            newStream.getTracks().forEach((t) => t.stop());
            S.switching = false;
            endWith('Camera switch failed', 'The new camera did not start producing video frames. Please reconnect and try again.', true);
        }
    }

    async function requestWakeLock() {
        try {
            if ('wakeLock' in navigator) {
                S.wakeLock = await navigator.wakeLock.request('screen');
                S.wakeLock.addEventListener('release', () => { S.wakeLock = null; });
            }
        } catch (e) { /* not critical */ }
    }
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && S.sharing && !S.wakeLock) requestWakeLock();
    });

    // ------------------------------------------------------------------
    // WebRTC (phone is the offerer)
    // ------------------------------------------------------------------
    function createPc() {
        log('createPc() called');
        const pc = new RTCPeerConnection({ iceServers: S.config.iceServers || [] });
        S.pc = pc;
        S.pendingIce = [];

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                log('ICE candidate:', e.candidate.toJSON(), 'type:', e.candidate.type, 'protocol:', e.candidate.protocol);
                send('ice', e.candidate.toJSON());
            } else {
                log('ICE gathering complete');
            }
        };
        pc.onnegotiationneeded = async () => {
            log('onnegotiationneeded fired, signalingState:', pc.signalingState);
            try {
                const offer = await pc.createOffer();
                log('Offer created, signalingState:', pc.signalingState);
                if (pc.signalingState !== 'stable') return;
                await pc.setLocalDescription(offer);
                log('Local description set, signalingState:', pc.signalingState);
                await send('offer', { type: pc.localDescription.type, sdp: pc.localDescription.sdp });
                log('Offer sent');
                tuneSender();
            } catch (e) { logError('Offer failed:', e); }
        };
        pc.oniceconnectionstatechange = () => {
            log('ICE connection state change:', pc.iceConnectionState);
        };
        pc.onconnectionstatechange = () => {
            log('Connection state change:', pc.connectionState, 'iceConnectionState:', pc.iceConnectionState, 'signalingState:', pc.signalingState);
            if (S.closing) return;
            if (S.frameRelayConnected) {
                setText('liveStatus', 'Sharing with computer');
                return;
            }
            switch (pc.connectionState) {
                case 'connected': setText('liveStatus', 'Sharing with computer'); break;
                case 'connecting': setText('liveStatus', 'Connecting…'); break;
                case 'disconnected': setText('liveStatus', 'Reconnecting…'); break;
                case 'failed':
                    setText('liveStatus', 'Retrying…');
                    try { pc.restartIce(); } catch (e) { /* ignore */ }
                    break;
            }
        };
        pc.onsignalingstatechange = () => {
            log('Signaling state change:', pc.signalingState);
        };
        pc.ontrack = (e) => {
            log('Track received:', e.track.kind, 'trackId:', e.track.id, 'streams:', e.streams.length);
            if (e.track.kind === 'video') {
                log('Remote video track settings:', e.track.getSettings());
                log('Remote video track readyState:', e.track.readyState, 'enabled:', e.track.enabled, 'muted:', e.track.muted);
                e.track.addEventListener('mute', () => log('Remote track muted'));
                e.track.addEventListener('unmute', () => log('Remote track unmuted'));
                e.track.addEventListener('ended', () => log('Remote track ended'));
            }
        };

        const track = S.stream.getVideoTracks()[0];
        log('Local track:', track.id, 'kind:', track.kind, 'readyState:', track.readyState, 'enabled:', track.enabled, 'muted:', track.muted, 'settings:', track.getSettings());
        track.addEventListener('mute', () => log('Local track muted'));
        track.addEventListener('unmute', () => log('Local track unmuted'));
        track.addEventListener('ended', () => log('Local track ended'));
        S.sender = pc.addTrack(track, S.stream);
        log('Track added to PeerConnection, sender:', S.sender ? 'created' : 'failed');

        // Monitor sender stats
        setInterval(() => {
            if (S.sender && S.pc && S.pc.connectionState === 'connected') {
                S.sender.getStats().then(stats => {
                    stats.forEach(report => {
                        if (report.type === 'outbound-rtp' && report.kind === 'video') {
                            log('Outbound RTP:', 'framesEncoded:', report.framesEncoded, 'bytesSent:', report.bytesSent, 'packetsSent:', report.packetsSent);
                        }
                        if (report.type === 'candidate-pair' && report.nominated) {
                            log('Nominated candidate pair:', 'local:', report.localCandidateId, 'remote:', report.remoteCandidateId, 'state:', report.state);
                        }
                    });
                }).catch(() => {});
            }
        }, 5000);
    }

    async function tuneSender() {
        try {
            const p = S.sender.getParameters();
            if (!p.encodings || !p.encodings.length) p.encodings = [{}];
            p.encodings[0].maxBitrate = 2500000;
            p.encodings[0].maxFramerate = 30;
            await S.sender.setParameters(p);
        } catch (e) { /* optional optimisation */ }
    }

    async function onAnswer(answer) {
        log('onAnswer() called, answer:', answer.type, 'signalingState:', S.pc ? S.pc.signalingState : 'no pc');
        const pc = S.pc;
        if (!pc || pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription(answer);
        log('Remote description set, signalingState:', pc.signalingState);
        for (const c of S.pendingIce.splice(0)) {
            try { await pc.addIceCandidate(c); } catch (e) { log('Stale ICE candidate ignored:', e); }
        }
    }

    async function onIce(candidate) {
        log('onIce() called, candidate:', candidate, 'hasRemoteDescription:', S.pc ? !!S.pc.remoteDescription : false);
        if (!S.pc || !S.pc.remoteDescription) { S.pendingIce.push(candidate); return; }
        try { await S.pc.addIceCandidate(candidate); log('ICE candidate added'); } catch (e) { logError('addIceCandidate failed:', e); }
    }

    // ------------------------------------------------------------------
    // Teardown
    // ------------------------------------------------------------------
    function teardown() {
        S.sharing = false;
        stopFrameRelay();
        if (S.sseConnectTimer) { clearTimeout(S.sseConnectTimer); S.sseConnectTimer = null; }
        if (S.readyFallbackTimer) { clearTimeout(S.readyFallbackTimer); S.readyFallbackTimer = null; }
        if (S.es) { S.es.close(); S.es = null; }
        if (S.pc) {
            S.pc.onicecandidate = S.pc.onnegotiationneeded = S.pc.onconnectionstatechange = null;
            try { S.pc.close(); } catch (e) { /* ignore */ }
            S.pc = null;
        }
        S.sender = null;
        if (S.stream) { S.stream.getTracks().forEach((t) => t.stop()); S.stream = null; }
        $('preview').srcObject = null;
        if (S.wakeLock) { S.wakeLock.release().catch(() => {}); S.wakeLock = null; }
        const room = S.room;
        S.room = null;
        S.pendingIce = [];
        if (room) {
            fetch(`/api/rooms/${room.code}/leave`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: 'phone', token: room.token }),
                keepalive: true,
            }).catch(() => {});
        }
        S.lastCode = room ? room.code : S.lastCode;
    }

    window.addEventListener('pagehide', () => {
        if (S.room) {
            const blob = new Blob([JSON.stringify({ role: 'phone', token: S.room.token })], { type: 'application/json' });
            navigator.sendBeacon(`/api/rooms/${S.room.code}/leave`, blob);
        }
    });

    // ------------------------------------------------------------------
    // Wire up UI
    // ------------------------------------------------------------------
    const codeInput = $('codeInput');
    codeInput.addEventListener('input', () => {
        const d = digits(codeInput.value);
        codeInput.value = fmtCode(d);
        $('connectBtn').disabled = d.length !== 6;
        setText('codeError', '');
    });
    codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && digits(codeInput.value).length === 6) join(digits(codeInput.value)); });
    $('connectBtn').addEventListener('click', () => join(digits(codeInput.value)));
    $('startBtn').addEventListener('click', startSharing);
    $('flipBtn').addEventListener('click', switchCamera);
    $('stopBtn').addEventListener('click', () => endWith('Sharing stopped', 'Your camera is off. Nothing is being sent.', true));
    $('againBtn').addEventListener('click', () => {
        const code = S.lastCode || digits(new URLSearchParams(location.search).get('code'));
        $('startBtn').disabled = false;
        if (code.length === 6) join(code); else show('screenCode');
    });

    // ------------------------------------------------------------------
    // Boot
    // ------------------------------------------------------------------
    if (!cameraSupported()) {
        for (const s of screens) $(s).hidden = true;
        const note = $('insecureNote');
        note.hidden = false;
        note.textContent = window.isSecureContext
            ? 'This browser does not support camera sharing. Try the latest Chrome, Safari or Firefox.'
            : 'Camera access needs a secure connection. Ask the person who shared this link for the https:// address and open that instead.';
        return;
    }

    const fromUrl = digits(new URLSearchParams(location.search).get('code'));
    if (fromUrl.length === 6) {
        S.lastCode = fromUrl;
        join(fromUrl);
    } else {
        show('screenCode');
        codeInput.focus();
    }
})();
