/* ===========================================================
   CameraSourceController - chooses where the camera comes from
   ===========================================================
   Mode A: this computer's webcam            (getUserMedia)
   Mode B: a phone's camera over WebRTC      (RemoteCameraHost)

   Owns the picker, the QR/PIN pairing panel and the status bar.
   Hands the chosen MediaStream to LivingGardenApp.useStream().
   =========================================================== */
class CameraSourceController {
    constructor(app) {
        this.app = app;
        this.mode = null;             // 'local' | 'phone' | null
        this.localStream = null;
        this.host = null;
        this.phoneFacing = 'user';
        this.failTimer = null;
        this.phoneLive = false;
        this.videoFramesReady = false;
        this.videoFrameWatchTimer = null;
        this.videoFrameWatchTarget = null;
        this.videoFrameWatchHandler = null;

        const $ = (id) => document.getElementById(id);
        this.el = {
            picker: $('picker'), pickerError: $('pickerError'),
            pickLocal: $('pickLocal'), pickPhone: $('pickPhone'),
            pair: $('pairPanel'), qr: $('qrCanvas'), pin: $('pinText'),
            link: $('linkInput'), copy: $('copyLink'),
            pairStatus: $('pairStatus'), pairStatusText: $('pairStatusText'),
            pairWarn: $('pairWarn'), pairNew: $('pairNew'), pairBack: $('pairBack'),
            bar: $('sourceBar'), sbStatus: $('sbStatus'), sbText: $('sbText'),
            sbFlip: $('sbFlip'), sbMirror: $('sbMirror'), sbChange: $('sbChange'),
            sbPreview: $('sbPreview'),
        };

        this.el.pickLocal.addEventListener('click', () => this.chooseLocal());
        this.el.pickPhone.addEventListener('click', () => this.choosePhone());
        this.el.pairBack.addEventListener('click', () => this.changeSource());
        this.el.pairNew.addEventListener('click', () => this.restartPhone());
        this.el.copy.addEventListener('click', () => this.copyLink());
        this.el.link.addEventListener('focus', () => this.el.link.select());
        this.el.sbChange.addEventListener('click', () => this.changeSource());
        this.el.sbMirror.addEventListener('click', () => this.app.setMirrored(!this.app.mirrored));
        this.el.sbFlip.addEventListener('click', () => this.host && this.host.switchCamera());
        this.el.sbPreview.addEventListener('click', () => this.togglePreview());
    }

    /** Called once hand tracking is ready. */
    begin() {
        const want = new URLSearchParams(location.search).get('source');
        if (want === 'local') this.chooseLocal();
        else if (want === 'phone') this.choosePhone();
        else this.showPicker();
    }

    // ------------------------------------------------------------
    // Screens
    // ------------------------------------------------------------
    showPicker(message) {
        this.el.pair.classList.add('hidden');
        this.el.bar.classList.add('hidden');
        this.el.pickerError.textContent = message || '';
        this.el.picker.classList.remove('hidden');
        this.el.pickLocal.focus({ preventScroll: true });
    }

    showBar(text, state, { flip = false, preview = false } = {}) {
        this.el.bar.classList.remove('hidden');
        this.el.sbText.textContent = text;
        this.el.sbStatus.dataset.state = state || 'ok';
        this.el.sbFlip.hidden = !flip;
        this.el.sbPreview.hidden = !preview;
        if (preview) {
            // Show preview button with current state
            const isHidden = this.app.phonePreview?.classList.contains('hidden') ?? true;
            this.el.sbPreview.textContent = isHidden ? '📹 Preview' : '📹 Preview ✓';
            this.el.sbPreview.title = isHidden ? 'Show phone camera preview' : 'Hide phone camera preview';
        }
    }

    setPairStatus(text, state) {
        this.el.pairStatusText.textContent = text;
        this.el.pairStatus.dataset.state = state || 'wait';
    }

    // ------------------------------------------------------------
    // Mode A: local webcam
    // ------------------------------------------------------------
    async chooseLocal() {
        this.el.pickerError.textContent = '';
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            return this.showPicker('This browser blocks camera access here. Open the app on localhost or an https:// address.');
        }
        this.el.pickLocal.disabled = true;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false,
            });
            this.mode = 'local';
            this.localStream = stream;
            stream.getVideoTracks()[0].addEventListener('ended', () => {
                if (this.mode === 'local' && this.localStream === stream) {
                    this.stopCurrent();
                    this.showPicker('The webcam was disconnected. Pick a camera to continue.');
                }
            });
            this.el.picker.classList.add('hidden');
            this.app.useStream(stream, { mirrored: true });
            this.showBar('Webcam active', 'ok', { preview: false });
        } catch (e) {
            const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
            const none = e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError');
            this.showPicker(
                denied ? 'Camera permission was denied. Allow it in the browser address bar and try again.'
                    : none ? 'No webcam was found on this computer. Try the phone option instead.'
                        : 'Could not start the webcam: ' + ((e && e.message) || 'unknown error')
            );
        } finally {
            this.el.pickLocal.disabled = false;
        }
    }

    // ------------------------------------------------------------
    // Mode B: phone camera
    // ------------------------------------------------------------
    async choosePhone() {
        this.mode = 'phone';
        this.phoneLive = false;
        this.phoneFacing = 'user';
        this.el.picker.classList.add('hidden');
        this.el.bar.classList.add('hidden');
        this.el.pair.classList.remove('hidden');
        this.el.pin.textContent = '––– –––';
        this.el.link.value = '';
        this.el.pairWarn.hidden = true;
        this.setPairStatus('Creating a code…', 'wait');

        this.host = new RemoteCameraHost({
            onCode: (info) => this.onCode(info),
            onPhoneJoined: () => this.setPairStatus('Phone connected — tap “Allow camera” on the phone', 'ok'),
            onStream: (stream) => this.onStream(stream),
            onFacing: (f) => this.onFacing(f),
            onConnectionState: (s) => this.onConnectionState(s),
            onPhoneLeft: () => this.onPhoneLeft(),
            onError: (msg) => {
                this.stopCurrent();
                this.showPicker(msg);
            },
        });
        try {
            await this.host.start();
        } catch (e) {
            this.stopCurrent();
            this.showPicker(e.message || 'Could not start phone mode.');
        }
    }

    async restartPhone() {
        if (this.host) await this.host.stop();
        this.host = null;
        this.app.clearSource();
        this.choosePhone();
    }

    onCode({ code, phoneUrl, origin }) {
        this.el.pin.textContent = code.slice(0, 3) + ' ' + code.slice(3);
        this.el.link.value = phoneUrl;
        try {
            QR.draw(this.el.qr, phoneUrl, { scale: 6, margin: 3 });
            this.el.qr.hidden = false;
        } catch (e) {
            console.warn('QR failed:', e);
            this.el.qr.hidden = true;
        }
        this.setPairStatus('Waiting for the phone…', 'wait');
        this.showPairWarning(origin);
    }

    showPairWarning(origin) {
        let msg = '';
        try {
            const u = new URL(origin);
            const h = u.hostname;
            const loopback = h === 'localhost' || h === '::1' || h === '[::1]' || /^127\./.test(h);
            const lan = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(h) || h.endsWith('.local');
            if (loopback || lan) {
                msg = '⚠ ' + u.host + ' only works on this computer (or this network), and phones only allow camera access over https://. ' +
                    'To use a phone elsewhere, open this app through a public https:// address (a deployment or a tunnel) or set PUBLIC_URL on the server. See the README.';
            } else if (u.protocol === 'http:') {
                msg = '⚠ Phones only allow camera access on https:// addresses. Serve this app over HTTPS.';
            }
        } catch (e) { /* ignore */ }
        this.el.pairWarn.textContent = msg;
        this.el.pairWarn.hidden = !msg;
    }

    onStream(stream) {
        clearTimeout(this.failTimer);
        this.phoneLive = true;
        this.videoFramesReady = false;
        this.app.useStream(stream, { mirrored: this.phoneFacing === 'user' });
        this.el.pair.classList.add('hidden');
        // A remote track arriving is not proof that video frames are flowing.
        // Keep the status amber until the desktop video element has dimensions.
        this.watchForPhoneVideoFrames();
    }

    watchForPhoneVideoFrames() {
        this.clearPhoneVideoFrameWatch();
        const video = this.app.phonePreview || this.app.video;
        if (!video) return;

        const markReady = () => {
            if (!this.phoneLive || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) return;
            this.videoFramesReady = true;
            this.clearPhoneVideoFrameWatch();
            this.showBar('Phone camera live', 'ok', { flip: true, preview: true });
        };

        this.videoFrameWatchTarget = video;
        this.videoFrameWatchHandler = markReady;
        video.addEventListener('loadeddata', markReady);
        video.addEventListener('playing', markReady);
        video.addEventListener('resize', markReady);
        this.showBar('Connected — waiting for video frames…', 'warn', { flip: true, preview: true });
        markReady();
        if (!this.videoFramesReady) {
            this.videoFrameWatchTimer = setTimeout(() => {
                markReady();
                if (!this.videoFramesReady && this.phoneLive) {
                    this.showBar('Connected, but no video frames received', 'warn', { flip: true, preview: true });
                }
            }, 10000);
        }
    }

    clearPhoneVideoFrameWatch() {
        if (this.videoFrameWatchTimer) {
            clearTimeout(this.videoFrameWatchTimer);
            this.videoFrameWatchTimer = null;
        }
        if (this.videoFrameWatchTarget && this.videoFrameWatchHandler) {
            this.videoFrameWatchTarget.removeEventListener('loadeddata', this.videoFrameWatchHandler);
            this.videoFrameWatchTarget.removeEventListener('playing', this.videoFrameWatchHandler);
            this.videoFrameWatchTarget.removeEventListener('resize', this.videoFrameWatchHandler);
        }
        this.videoFrameWatchTarget = null;
        this.videoFrameWatchHandler = null;
    }

    onFacing(facing) {
        this.phoneFacing = facing;
        // Selfie camera looks natural mirrored; the rear camera should not be.
        if (this.phoneLive) this.app.setMirrored(facing === 'user');
    }

    onConnectionState(state) {
        if (!this.phoneLive || this.videoFramesReady) return;
        if (state === 'connected') {
            clearTimeout(this.failTimer);
            if (this.videoFramesReady) {
                this.showBar('Phone camera live', 'ok', { flip: true, preview: true });
            } else {
                this.showBar('WebRTC connected — waiting for video frames…', 'warn', { flip: true, preview: true });
            }
        } else if (state === 'disconnected') {
            this.showBar('Connection unstable…', 'warn', { flip: true, preview: true });
        } else if (state === 'failed') {
            this.showBar('Reconnecting to phone…', 'warn', { flip: true, preview: true });
            clearTimeout(this.failTimer);
            this.failTimer = setTimeout(() => this.onPhoneLeft('The connection to the phone was lost.'), 20000);
        }
    }

    onPhoneLeft(message) {
        clearTimeout(this.failTimer);
        this.clearPhoneVideoFrameWatch();
        if (this.mode !== 'phone') return;
        this.phoneLive = false;
        this.videoFramesReady = false;
        this.app.clearSource();
        this.el.bar.classList.add('hidden');
        this.el.pair.classList.remove('hidden');
        this.setPairStatus(message || 'Phone disconnected — scan the code again to reconnect', 'warn');
    }

    /** Toggle the phone preview window visibility. */
    togglePreview() {
        if (!this.app.phonePreview) return;
        const isHidden = this.app.phonePreview.classList.toggle('hidden');
        this.el.sbPreview.textContent = isHidden ? '📹 Preview' : '📹 Preview ✓';
        this.el.sbPreview.title = isHidden ? 'Show phone camera preview' : 'Hide phone camera preview';
    }

    async copyLink() {
        const text = this.el.link.value;
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
        } catch (e) {
            this.el.link.select();
            try { document.execCommand('copy'); } catch (e2) { /* ignore */ }
        }
        const old = this.el.copy.textContent;
        this.el.copy.textContent = 'Copied ✓';
        setTimeout(() => { this.el.copy.textContent = old; }, 1500);
    }

    // ------------------------------------------------------------
    // Switching / teardown
    // ------------------------------------------------------------
    stopCurrent() {
        clearTimeout(this.failTimer);
        this.clearPhoneVideoFrameWatch();
        if (this.localStream) {
            this.localStream.getTracks().forEach((t) => t.stop());
            this.localStream = null;
        }
        if (this.host) {
            this.host.stop();
            this.host = null;
        }
        this.phoneLive = false;
        this.mode = null;
        this.app.clearSource();
    }

    changeSource() {
        this.stopCurrent();
        this.showPicker();
    }
}

window.CameraSourceController = CameraSourceController;
