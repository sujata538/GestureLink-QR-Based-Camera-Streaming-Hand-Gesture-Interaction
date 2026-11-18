/* ===========================================================
   RemoteCameraHost - desktop side of "use a phone as the camera"
   ===========================================================
   1. Asks the server for a room (6-digit PIN).
   2. Waits for a phone to join, then answers its WebRTC offer.
   3. Hands the received MediaStream to the app via handlers.onStream.

   Signaling goes over Server-Sent Events (server -> us) and
   HTTP POST (us -> server). Video flows phone -> desktop directly.
   =========================================================== */
class RemoteCameraHost {
    /**
     * @param {object} h handlers
     *   onCode({code, phoneUrl, origin})   a (new) pairing code is ready
     *   onPhoneJoined()                    phone entered the code
     *   onStream(stream)                   phone camera video arrived
     *   onFacing('user'|'environment')     phone told us which camera it uses
     *   onConnectionState(state)           RTCPeerConnection state changes
     *   onPhoneLeft()                      phone disconnected (room stays open)
     *   onError(message)                   unrecoverable problem
     */
    constructor(h) {
        this.h = h;
        this.room = null;      // { code, token }
        this.es = null;
        this.pc = null;
        this.pendingIce = [];
        this.queue = Promise.resolve();
        this.config = null;
        this.stopped = false;
        this.rtcVideoActive = false;
        this.rtcStream = null;
        this.frameCanvas = null;
        this.frameContext = null;
        this.frameStream = null;
        this.frameRelayActive = false;
        this.latestFrameSequence = 0;
        this._onPageHide = () => this.leaveBeacon();
        window.addEventListener('pagehide', this._onPageHide);
    }

    async start() {
        this.stopped = false;
        if (!this.config) {
            const r = await fetch('/api/config', { cache: 'no-store' });
            if (!r.ok) throw new Error('Could not reach the Living Garden server.');
            this.config = await r.json();
        }
        const res = await fetch('/api/rooms', { method: 'POST' });
        if (res.status === 429) throw new Error('Too many codes requested. Please wait a minute.');
        if (!res.ok) throw new Error('Could not create a pairing code.');
        this.room = await res.json();

        const origin = this.config.publicUrl || location.origin;
        const phoneUrl = `${origin}/phone?code=${this.room.code}`;
        this.openEvents();
        this.h.onCode({ code: this.room.code, phoneUrl, origin });
    }

    openEvents() {
        const { code, token } = this.room;
        const es = new EventSource(`/api/rooms/${code}/events?role=host&token=${encodeURIComponent(token)}`);
        this.es = es;

        es.addEventListener('phone-joined', () => {
            this.resetPeer();
            this.createPc();
            this.h.onPhoneJoined();
        });
        es.addEventListener('offer', (e) => this.enqueue(() => this.onOffer(JSON.parse(e.data))));
        es.addEventListener('ice', (e) => this.enqueue(() => this.onIce(JSON.parse(e.data))));
        es.addEventListener('camera-info', (e) => {
            const d = JSON.parse(e.data);
            if (d && (d.facing === 'user' || d.facing === 'environment')) this.h.onFacing(d.facing);
        });
        es.addEventListener('video-frame', (e) => {
            try { this.onVideoFrame(JSON.parse(e.data)); }
            catch (error) { console.warn('[DESKTOP] Invalid HTTPS video frame:', error); }
        });
        es.addEventListener('phone-left', () => {
            this.stopFrameRelay();
            this.resetPeer();
            this.h.onPhoneLeft();
        });
        es.addEventListener('room-closed', (e) => {
            const d = JSON.parse(e.data || '{}');
            this.stopFrameRelay();
            this.resetPeer();
            this.closeEvents();
            if (this.stopped) return;
            if (d.reason === 'expired') this.restart();
            else this.h.onError('The session ended. Start again to get a new code.');
        });
        es.onerror = () => {
            // EventSource retries by itself on network blips. If the server
            // rejected us (room gone), the stream is CLOSED and will not retry.
            if (es.readyState === EventSource.CLOSED && !this.stopped && this.es === es) {
                this.closeEvents();
                this.restart();
            }
        };
    }

    async restart() {
        if (this.stopped) return;
        this.stopFrameRelay();
        this.resetPeer();
        try {
            await this.start();
        } catch (e) {
            this.h.onError(e.message || 'Lost connection to the server.');
        }
    }

    // ---- WebRTC ----
    createPc() {
        const pc = new RTCPeerConnection({ iceServers: (this.config && this.config.iceServers) || [] });
        this.pc = pc;
        pc.ontrack = (e) => {
            console.log('[DESKTOP] Track received:', e.track.kind, 'trackId:', e.track.id, 'streams:', e.streams.length);
            const stream = (e.streams && e.streams[0]) || new MediaStream([e.track]);
            if (e.track.kind === 'video') {
                this.rtcStream = stream;
                this.rtcVideoActive = !e.track.muted;
                console.log('[DESKTOP] Remote video track settings:', e.track.getSettings());
                console.log('[DESKTOP] Remote video track readyState:', e.track.readyState, 'enabled:', e.track.enabled, 'muted:', e.track.muted);
                e.track.addEventListener('mute', () => {
                    console.log('[DESKTOP] Remote track muted; requesting HTTPS frame fallback');
                    this.rtcVideoActive = false;
                    if (!this.frameRelayActive) this.send('command', { action: 'start-frame-relay' });
                });
                e.track.addEventListener('unmute', () => {
                    console.log('[DESKTOP] Remote track unmuted; switching desktop preview to direct WebRTC video');
                    this.rtcVideoActive = true;
                    if (this.frameRelayActive && this.rtcStream) {
                        this.stopFrameRelay();
                        this.h.onStream(this.rtcStream);
                        this.send('command', { action: 'stop-frame-relay' });
                    }
                });
                e.track.addEventListener('ended', () => console.log('[DESKTOP] Remote track ended'));
            }
            // A WebRTC track is initially muted until RTP arrives. If the
            // HTTPS frame relay has already started, keep its live stream
            // instead of replacing it with a black, not-yet-unmuted track.
            if (!this.frameRelayActive) this.h.onStream(stream);
        };
        pc.onicecandidate = (e) => {
            if (e.candidate) {
                console.log('[DESKTOP] ICE candidate:', e.candidate.toJSON(), 'type:', e.candidate.type, 'protocol:', e.candidate.protocol);
                this.send('ice', e.candidate.toJSON());
            } else {
                console.log('[DESKTOP] ICE gathering complete');
            }
        };
        pc.oniceconnectionstatechange = () => {
            console.log('[DESKTOP] ICE connection state change:', pc.iceConnectionState);
        };
        pc.onconnectionstatechange = () => {
            console.log('[DESKTOP] Connection state change:', pc.connectionState, 'iceConnectionState:', pc.iceConnectionState, 'signalingState:', pc.signalingState);
            this.h.onConnectionState(pc.connectionState);
        };
        pc.onsignalingstatechange = () => {
            console.log('[DESKTOP] Signaling state change:', pc.signalingState);
        };

        // Monitor receiver stats
        setInterval(() => {
            if (this.pc && this.pc.connectionState === 'connected') {
                this.pc.getStats().then(stats => {
                    stats.forEach(report => {
                        if (report.type === 'inbound-rtp' && report.kind === 'video') {
                            console.log('[DESKTOP] Inbound RTP:', 'framesDecoded:', report.framesDecoded, 'framesReceived:', report.framesReceived, 'bytesReceived:', report.bytesReceived, 'packetsReceived:', report.packetsReceived, 'jitter:', report.jitter);
                        }
                        if (report.type === 'candidate-pair' && report.nominated) {
                            console.log('[DESKTOP] Nominated candidate pair:', 'local:', report.localCandidateId, 'remote:', report.remoteCandidateId, 'state:', report.state);
                        }
                    });
                }).catch(() => {});
            }
        }, 5000);
    }

    // Receive the phone's bounded JPEG fallback over the same authenticated
    // SSE channel used for signaling. The frames are drawn to a canvas and
    // exposed as a MediaStream so the existing preview and MediaPipe pipeline
    // can consume them without a UI redesign.
    onVideoFrame(data) {
        if (this.rtcVideoActive || !data || typeof data.jpeg !== 'string' ||
            !data.jpeg.startsWith('data:image/jpeg;base64,')) return;

        const sequence = Number(data.sequence) || 0;
        if (sequence && sequence <= this.latestFrameSequence) return;
        const image = new Image();
        image.onload = () => {
            if (this.stopped || this.rtcVideoActive || (sequence && sequence < this.latestFrameSequence)) return;
            const width = image.naturalWidth;
            const height = image.naturalHeight;
            if (!width || !height) return;

            if (!this.frameCanvas) {
                this.frameCanvas = document.createElement('canvas');
                this.frameCanvas.width = width;
                this.frameCanvas.height = height;
                this.frameContext = this.frameCanvas.getContext('2d', { alpha: false });
            } else if (this.frameCanvas.width !== width || this.frameCanvas.height !== height) {
                this.frameCanvas.width = width;
                this.frameCanvas.height = height;
            }
            if (!this.frameContext) return;
            this.frameContext.drawImage(image, 0, 0, width, height);
            if (sequence) this.latestFrameSequence = sequence;

            if (!this.frameStream) {
                if (typeof this.frameCanvas.captureStream !== 'function') {
                    console.error('[DESKTOP] Canvas captureStream is unavailable; cannot display HTTPS frame relay');
                    return;
                }
                this.frameStream = this.frameCanvas.captureStream(8);
                this.frameRelayActive = true;
                console.log('[DESKTOP] HTTPS frame relay started:', width, 'x', height, 'sequence:', sequence);
                this.h.onStream(this.frameStream);
            } else {
                const track = this.frameStream.getVideoTracks()[0];
                if (track && typeof track.requestFrame === 'function') track.requestFrame();
            }
        };
        image.onerror = () => console.warn('[DESKTOP] Could not decode relayed phone JPEG frame', sequence);
        image.src = data.jpeg;
    }

    stopFrameRelay() {
        if (this.frameStream) {
            this.frameStream.getTracks().forEach((track) => track.stop());
        }
        this.frameStream = null;
        this.frameCanvas = null;
        this.frameContext = null;
        this.frameRelayActive = false;
        this.latestFrameSequence = 0;
    }

    async onOffer(offer) {
        console.log('[DESKTOP] onOffer received:', offer.type);
        if (!this.pc) this.createPc();
        const pc = this.pc;
        await pc.setRemoteDescription(offer);
        console.log('[DESKTOP] Remote description set, signalingState:', pc.signalingState);
        for (const c of this.pendingIce.splice(0)) {
            try { await pc.addIceCandidate(c); } catch (e) { console.log('[DESKTOP] Stale ICE candidate ignored:', e); }
        }
        const answer = await pc.createAnswer();
        console.log('[DESKTOP] Answer created');
        await pc.setLocalDescription(answer);
        console.log('[DESKTOP] Local description set, signalingState:', pc.signalingState);
        await this.send('answer', { type: pc.localDescription.type, sdp: pc.localDescription.sdp });
        console.log('[DESKTOP] Answer sent');
    }

    async onIce(candidate) {
        if (!this.pc || !this.pc.remoteDescription) {
            this.pendingIce.push(candidate);
            return;
        }
        try { await this.pc.addIceCandidate(candidate); } catch (e) { /* ignore */ }
    }

    enqueue(fn) {
        this.queue = this.queue.then(fn).catch((e) => console.warn('Signaling error:', e));
    }

    resetPeer() {
        this.rtcVideoActive = false;
        this.rtcStream = null;
        if (this.pc) {
            this.pc.ontrack = this.pc.onicecandidate = this.pc.onconnectionstatechange = null;
            try { this.pc.close(); } catch (e) { /* ignore */ }
            this.pc = null;
        }
        this.pendingIce = [];
    }

    // ---- messaging ----
    send(type, data) {
        if (!this.room) return Promise.resolve();
        return fetch(`/api/rooms/${this.room.code}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'host', token: this.room.token, type, data }),
        }).catch(() => {});
    }

    /** Ask the phone to flip between front and rear camera. */
    switchCamera() {
        return this.send('command', { action: 'switch-camera' });
    }

    // ---- teardown ----
    closeEvents() {
        if (this.es) { this.es.close(); this.es = null; }
    }

    leaveBeacon() {
        if (!this.room) return;
        const blob = new Blob([JSON.stringify({ role: 'host', token: this.room.token })], { type: 'application/json' });
        navigator.sendBeacon(`/api/rooms/${this.room.code}/leave`, blob);
    }

    async stop() {
        this.stopped = true;
        window.removeEventListener('pagehide', this._onPageHide);
        const room = this.room;
        this.room = null;
        this.closeEvents();
        this.resetPeer();
        this.stopFrameRelay();
        this.rtcStream = null;
        this.rtcVideoActive = false;
        if (room) {
            fetch(`/api/rooms/${room.code}/leave`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: 'host', token: room.token }),
                keepalive: true,
            }).catch(() => {});
        }
    }
}

window.RemoteCameraHost = RemoteCameraHost;
