"""End-to-end test: desktop page <-> server <-> phone page, real WebRTC with fake cameras.
MediaPipe (CDN) is replaced by a scripted stub because the sandbox has no internet.
Run:  python3 test/e2e.py
"""
import os, re, subprocess, sys, time, json, urllib.request
import numpy as np, cv2
from playwright.sync_api import sync_playwright, expect

PORT = 3111
BASE = f"http://localhost:{PORT}"
SHOTS = "/tmp/shots"; os.makedirs(SHOTS, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

HANDS_STUB = r"""
window.__hands = { sends: 0, size: null, isVideo: false, trackLive: false };
window.__phase = 'none';   // none | pinch | open | clap
window.__palm = { x: 0.3, y: 0.6 };
function lms(px, py, thumbX, idxX) {
  const a = Array.from({length: 21}, () => ({x: px, y: py + 0.1, z: 0}));
  a[0] = {x: px, y: py + 0.2, z: 0}; a[9] = {x: px, y: py, z: 0};
  a[4] = {x: thumbX, y: py, z: 0};   a[8] = {x: idxX, y: py, z: 0};
  return a;
}
class Hands {
  constructor(o) { window.__handsOpts = o; }
  setOptions(o) { this.opts = o; }
  onResults(cb) { this.cb = cb; }
  async initialize() { await new Promise(r => setTimeout(r, 30)); }
  async send({ image }) {
    const h = window.__hands; h.sends++;
    h.isVideo = image instanceof HTMLVideoElement;
    h.size = [image.videoWidth, image.videoHeight];
    const s = image.srcObject; h.trackLive = !!(s && s.getVideoTracks()[0] && s.getVideoTracks()[0].readyState === 'live');
    const p = window.__palm; let L = [], H = [];
    if (window.__phase === 'pinch') { L = [lms(p.x, p.y, p.x, p.x)]; H = [{label: 'Right'}]; }
    if (window.__phase === 'open')  { L = [lms(p.x, p.y, p.x - 0.1, p.x + 0.1)]; H = [{label: 'Right'}]; }
    this.cb({ multiHandLandmarks: L, multiHandedness: H });
    await new Promise(r => setTimeout(r, 8));
  }
}
window.Hands = Hands;
"""

results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""))

def api(path):
    return json.load(urllib.request.urlopen(BASE + path))

def decode_qr(png_path):
    img = cv2.imread(png_path, cv2.IMREAD_GRAYSCALE)
    img = cv2.copyMakeBorder(img, 40, 40, 40, 40, cv2.BORDER_CONSTANT, value=255)
    for scale in (1, 1.5, 2, 3):
        im = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST)
        v, _, _ = cv2.QRCodeDetectorAruco().detectAndDecode(im)
        if v: return v
    return ""

srv = subprocess.Popen(["node", "server.js"], cwd=ROOT, env={**os.environ, "PORT": str(PORT)}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
try:
    for _ in range(50):
        try: api("/healthz"); break
        except Exception: time.sleep(0.1)

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"])

        def route_cdn(ctx):
            ctx.route("https://cdn.jsdelivr.net/**", lambda r: r.fulfill(status=200, content_type="text/javascript", body=HANDS_STUB))
            ctx.route(re.compile(r"https://fonts\.(googleapis|gstatic)\.com/.*"), lambda r: r.fulfill(status=200, content_type="text/css", body=""))

        dctx = browser.new_context(viewport={"width": 1280, "height": 720}, permissions=["camera"]); route_cdn(dctx)
        errors = []
        def watch(page, tag):
            page.on("pageerror", lambda e: errors.append(f"{tag} pageerror: {e}"))
            page.on("console", lambda m: errors.append(f"{tag} console.error: {m.text}") if m.type == "error" else None)

        # ------------------------------------------------------------------
        print("\n== Mode 1: local webcam ==")
        d = dctx.new_page(); watch(d, "desktop")
        d.goto(BASE + "/")
        expect(d.locator("#picker")).not_to_have_class(re.compile("hidden"), timeout=8000)
        check("picker shown after hand tracking init", True)
        d.wait_for_timeout(900); d.screenshot(path=f"{SHOTS}/01_picker.png")
        d.click("#pickLocal")
        d.wait_for_function("document.getElementById('webcam').videoWidth > 0", timeout=8000)
        d.wait_for_function("window.__hands.sends > 10", timeout=8000)
        info = d.evaluate("({sends: __hands.sends, isVideo: __hands.isVideo, live: __hands.trackLive, size: __hands.size})")
        check("webcam frames flow into the hand tracker", info["isVideo"] and info["live"], str(info))
        check("status bar says webcam active", "Webcam active" in d.text_content("#sbText"))
        check("phone-only 'switch phone camera' button hidden in webcam mode", d.locator("#sbFlip").is_hidden())
        check("picker hidden once camera is live", "hidden" in (d.get_attribute("#picker", "class") or ""))

        # gesture: pinch, then flick open -> a seed is planted at the hand position
        d.evaluate("window.__palm={x:0.3,y:0.6}; window.__phase='pinch'")
        d.wait_for_timeout(250)
        d.evaluate("window.__phase='open'")
        d.wait_for_function("livingGarden.garden.length === 1", timeout=5000)
        vr = d.evaluate("livingGarden.videoRect()"); cw = d.evaluate("livingGarden.canvas.width")
        exp = (vr["x"] + 0.3 * vr["w"]) / cw
        got = d.evaluate("livingGarden.garden[0].xFrac")
        check("pinch-then-flick plants a seed (gesture logic intact)", True)
        check("seed lands where the hand is, via video->canvas mapping", abs(exp - got) < 1e-6, f"exp={exp:.4f} got={got:.4f}")
        d.evaluate("window.__phase='none'")
        d.wait_for_timeout(300)
        d.screenshot(path=f"{SHOTS}/02_local_live.png")

        d.click("#sbMirror")
        check("mirror toggle un-mirrors video + overlay", d.evaluate("document.querySelector('.container').classList.contains('unmirrored')"))
        d.click("#sbMirror")
        check("mirror toggle restores", not d.evaluate("document.querySelector('.container').classList.contains('unmirrored')"))

        d.click("#sbChange")
        expect(d.locator("#picker")).not_to_have_class(re.compile("hidden"))
        n1 = d.evaluate("__hands.sends"); d.wait_for_timeout(400); n2 = d.evaluate("__hands.sends")
        check("changing source stops tracking and releases the webcam", n1 == n2 and d.evaluate("document.getElementById('webcam').srcObject") is None, f"{n1}->{n2}")
        check("hand state cleared on source change", d.evaluate("livingGarden.handsDetected") == 0)

        # ------------------------------------------------------------------
        print("\n== Mode 3: phone camera over WebRTC / HTTPS fallback (QR / PIN) ==")
        d.click("#pickPhone")
        d.wait_for_function("/^\\d{3} \\d{3}$/.test(document.getElementById('pinText').textContent)", timeout=8000)
        pin = d.text_content("#pinText").replace(" ", "")
        link = d.input_value("#linkInput")
        check("6-digit PIN shown", re.fullmatch(r"\d{6}", pin) is not None, pin)
        check("link contains the PIN", link.endswith("/phone?code=" + pin), link)
        d.locator("#qrCanvas").screenshot(path=f"{SHOTS}/qr.png")
        decoded = decode_qr(f"{SHOTS}/qr.png")
        check("QR code on screen decodes to the phone link", decoded == link, decoded)
        check("localhost warning shown (phones can't reach it)", d.locator("#pairWarn").is_visible())
        d.screenshot(path=f"{SHOTS}/03_pairing.png")
        check("server has 1 open room", api("/healthz")["rooms"] >= 1)

        # phone
        pctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, permissions=["camera"])
        ph = pctx.new_page(); watch(ph, "phone")
        ph.goto(decoded)  # open the link exactly as scanned from the QR
        expect(ph.locator("#screenReady")).to_be_visible(timeout=8000)
        ph.screenshot(path=f"{SHOTS}/04_phone_ready.png")
        d.wait_for_function("document.getElementById('pairStatusText').textContent.includes('Phone connected')", timeout=5000)
        check("desktop sees 'phone connected' before camera is on", True)
        check("camera is NOT started before the user taps the button", ph.evaluate("document.getElementById('preview').srcObject") is None)

        ph.click("#startBtn")
        expect(ph.locator("#screenLive")).to_be_visible(timeout=8000)
        ph.wait_for_function("(() => { const v=document.getElementById('preview'); const t=v.srcObject && v.srcObject.getVideoTracks()[0]; return !!t && t.readyState==='live' && !t.muted && v.readyState>=2 && v.videoWidth>0 && v.videoHeight>0; })()", timeout=15000)
        check("phone-side preview is rendering live camera frames", True,
              str(ph.evaluate("({width: document.getElementById('preview').videoWidth, height: document.getElementById('preview').videoHeight, muted: document.getElementById('preview').srcObject.getVideoTracks()[0].muted})")))
        d.wait_for_function("document.getElementById('webcam').videoWidth > 0", timeout=15000)
        d.wait_for_function("document.getElementById('phonePreview').videoWidth > 0 && document.getElementById('phonePreview').videoHeight > 0", timeout=15000)
        check("dedicated laptop phone preview is decoding camera frames", True,
              str(d.evaluate("({width: document.getElementById('phonePreview').videoWidth, height: document.getElementById('phonePreview').videoHeight})")))
        d.wait_for_function("__hands.sends > 5 && __hands.trackLive", timeout=15000)
        check("phone video reaches desktop through the active media path", True, str(d.evaluate("__hands.size")))
        check("hand tracker receives frames from the phone stream", d.evaluate("__hands.isVideo && __hands.trackLive"))
        f1 = d.evaluate("document.getElementById('webcam').getVideoPlaybackQuality().totalVideoFrames"); d.wait_for_timeout(700)
        f2 = d.evaluate("document.getElementById('webcam').getVideoPlaybackQuality().totalVideoFrames")
        check("remote video frames keep advancing", f2 > f1 + 5, f"{f1}->{f2}")
        check("pairing panel hidden, status bar shows phone live", "Phone camera live" in d.text_content("#sbText") and "hidden" in (d.get_attribute("#pairPanel", "class") or ""))
        check("'switch phone camera' button available", d.locator("#sbFlip").is_visible())
        ph.wait_for_function("document.getElementById('liveStatus').textContent.includes('Sharing')", timeout=8000)
        check("phone shows 'Sharing with computer'", True)
        check("front camera => picture mirrored", not d.evaluate("document.querySelector('.container').classList.contains('unmirrored')"))
        d.wait_for_timeout(500)
        d.screenshot(path=f"{SHOTS}/05_remote_live_desktop.png")
        ph.screenshot(path=f"{SHOTS}/06_phone_live.png")

        # gesture over the remote stream
        d.evaluate("window.__palm={x:0.7,y:0.6}; window.__phase='pinch'"); d.wait_for_timeout(250)
        d.evaluate("window.__phase='open'")
        d.wait_for_function("livingGarden.garden.length === 2", timeout=5000)
        d.evaluate("window.__phase='none'")
        check("gestures work on the phone video too", True)

        # remote camera switch (desktop -> phone command -> replaceTrack, no renegotiation)
        d.click("#sbFlip")
        d.wait_for_function("document.querySelector('.container').classList.contains('unmirrored')", timeout=8000)
        check("desktop 'switch camera' flips phone to rear; desktop un-mirrors", True)
        a1 = d.evaluate("document.getElementById('webcam').getVideoPlaybackQuality().totalVideoFrames"); d.wait_for_timeout(900)
        a2 = d.evaluate("document.getElementById('webcam').getVideoPlaybackQuality().totalVideoFrames")
        check("video continues after camera switch", a2 > a1 + 5, f"{a1}->{a2}")
        ph.click("#flipBtn")  # phone-side switch back
        d.wait_for_function("!document.querySelector('.container').classList.contains('unmirrored')", timeout=8000)
        check("phone-side switch updates desktop mirroring", True)

        # portrait/landscape letterbox mapping
        d.set_viewport_size({"width": 600, "height": 1000}); d.wait_for_timeout(500)
        fit = d.evaluate("({c: livingGarden.fitContain, cls: document.getElementById('webcam').classList.contains('fit-contain'), r: livingGarden.videoRect(), v:[webcam.videoWidth, webcam.videoHeight], w:[innerWidth, innerHeight]})")
        sc = min(fit["w"][0] / fit["v"][0], fit["w"][1] / fit["v"][1])
        check("wide video in a tall window switches to letterbox mode", fit["c"] and fit["cls"])
        check("video rect math matches object-fit: contain", abs(fit["r"]["w"] - fit["v"][0] * sc) < 1 and abs(fit["r"]["h"] - fit["v"][1] * sc) < 1, str(fit["r"]))
        d.screenshot(path=f"{SHOTS}/07_portrait_letterbox.png")
        d.set_viewport_size({"width": 1280, "height": 720}); d.wait_for_timeout(400)
        check("returns to cover mode in a wide window", not d.evaluate("livingGarden.fitContain"))

        # phone stops -> desktop falls back to the pairing panel with the same code
        ph.click("#stopBtn")
        expect(ph.locator("#screenEnded")).to_be_visible()
        check("phone camera released on stop", ph.evaluate("document.getElementById('preview').srcObject") is None)
        d.wait_for_function("!document.getElementById('pairPanel').classList.contains('hidden')", timeout=5000)
        check("desktop shows reconnect panel when phone leaves", "disconnected" in d.text_content("#pairStatusText").lower())
        check("desktop stops tracking + clears hands when phone leaves", d.evaluate("livingGarden.trackToken") is None and d.evaluate("livingGarden.handsDetected") == 0)
        check("same PIN still valid for reconnecting", d.text_content("#pinText").replace(" ", "") == pin)

        # reconnect with the same session
        ph.click("#againBtn")
        expect(ph.locator("#screenReady")).to_be_visible(timeout=8000)
        ph.click("#startBtn")
        d.wait_for_function("document.getElementById('webcam').videoWidth > 0 && __hands.trackLive", timeout=15000)
        check("phone can rejoin the same code and stream again", "Phone camera live" in d.text_content("#sbText"))

        # second phone can't hijack an occupied session
        pctx2 = browser.new_context(viewport={"width": 390, "height": 844}, permissions=["camera"])
        ph2 = pctx2.new_page(); watch(ph2, "phone2")
        ph2.goto(BASE + "/phone?code=" + pin)
        expect(ph2.locator("#codeError")).to_contain_text("already connected", timeout=5000)
        check("a second phone is refused", True)
        ph2.screenshot(path=f"{SHOTS}/08_phone_refused.png")

        # desktop ends session -> phone told, camera released
        d.click("#sbChange")
        expect(ph.locator("#screenEnded")).to_be_visible(timeout=6000)
        check("phone told the session ended", "ended" in ph.inner_text("#endedTitle").lower())
        check("phone camera released when desktop ends session", ph.evaluate("document.getElementById('preview').srcObject") is None)
        time.sleep(0.3)
        check("room removed server-side", api("/healthz")["rooms"] == 0, str(api("/healthz")))

        # ------------------------------------------------------------------
        print("\n== Phone page edge cases ==")
        pg = pctx2.new_page(); watch(pg, "phone-manual")
        pg.goto(BASE + "/phone")
        expect(pg.locator("#screenCode")).to_be_visible()
        check("Connect disabled until 6 digits", pg.locator("#connectBtn").is_disabled())
        pg.fill("#codeInput", "123456"); 
        check("code input auto-formats", pg.input_value("#codeInput") == "123 456")
        pg.click("#connectBtn")
        expect(pg.locator("#codeError")).to_contain_text("not valid", timeout=5000)
        check("wrong code shows a clear error", True)
        pg.screenshot(path=f"{SHOTS}/09_phone_bad_code.png")

        # manual PIN entry flow
        d.reload(); d.click("#pickPhone")
        d.wait_for_function("/^\\d{3} \\d{3}$/.test(document.getElementById('pinText').textContent)", timeout=8000)
        pin2 = d.text_content("#pinText").replace(" ", "")
        pg.fill("#codeInput", pin2); pg.click("#connectBtn")
        expect(pg.locator("#screenReady")).to_be_visible(timeout=6000)
        check("manual PIN entry works", True)
        pg.click("text=Rear camera")
        pg.click("#startBtn")
        d.wait_for_function("document.getElementById('webcam').videoWidth > 0 && __hands.trackLive", timeout=15000)
        check("rear-camera-first choice streams", True)

        # closing the desktop tab frees the room
        rooms_before = api("/healthz")["rooms"]
        d.close(); time.sleep(1.0)
        check("closing the desktop tab frees the room (sendBeacon)", api("/healthz")["rooms"] < rooms_before, f"{rooms_before}->{api('/healthz')['rooms']}")
        expect(pg.locator("#screenEnded")).to_be_visible(timeout=6000)
        check("phone is told when the desktop tab closes", True)

        # insecure context message on phone
        ictx = browser.new_context(viewport={"width": 390, "height": 844})
        ip = ictx.new_page(); ip.add_init_script("Object.defineProperty(window,'isSecureContext',{value:false})")
        ip.goto(BASE + "/phone?code=123456")
        expect(ip.locator("#insecureNote")).to_contain_text("secure connection", timeout=4000)
        check("insecure (http) phone page explains the https requirement", True)

        # server refuses to start phone mode if desktop page is the only thing: console errors
        # Filter out known diagnostic logs from intentional test scenarios (wrong PIN, second phone rejected)
        known_diagnostics = [
            "[PHONE ERROR]",
            "Another phone is already connected",
            "That code is not valid or has expired",
        ]
        real_errors = [e for e in errors
                       if "favicon" not in e
                       and "404" not in e
                       and "Failed to load resource" not in e
                       and not any(d in e for d in known_diagnostics)]
        check("no JS errors on any page", not real_errors, "; ".join(real_errors[:4]))

        # ------------------------------------------------------------------
        print("\n== PUBLIC_URL + HTTPS server mode ==")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "/tmp/k.pem", "-out", "/tmp/c.pem", "-days", "1", "-subj", "/CN=localhost"], capture_output=True)
        srv2 = subprocess.Popen(["node", "server.js"], cwd=ROOT, env={**os.environ, "PORT": "3113", "PUBLIC_URL": "https://garden.example.test/", "SSL_KEY": "/tmp/k.pem", "SSL_CERT": "/tmp/c.pem"}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        try:
            time.sleep(1.2)
            sctx = browser.new_context(viewport={"width": 1280, "height": 720}, ignore_https_errors=True, permissions=["camera"]); route_cdn(sctx)
            sp = sctx.new_page(); watch(sp, "https-desktop")
            sp.goto("https://localhost:3113/?source=phone")
            sp.wait_for_function("/^\\d{3} \\d{3}$/.test(document.getElementById('pinText').textContent)", timeout=8000)
            lk = sp.input_value("#linkInput"); pn = sp.text_content("#pinText").replace(" ", "")
            check("HTTPS mode serves the app (SSL_KEY/SSL_CERT)", True)
            check("?source=phone skips the picker and opens pairing", sp.evaluate("document.getElementById('picker').classList.contains('hidden')"))
            check("PUBLIC_URL is used for the phone link (trailing slash trimmed)", lk == "https://garden.example.test/phone?code=" + pn, lk)
            sp.locator("#qrCanvas").screenshot(path=f"{SHOTS}/qr2.png")
            check("QR encodes the PUBLIC_URL link", decode_qr(f"{SHOTS}/qr2.png") == lk)
            check("no warning when PUBLIC_URL is a public https address", sp.locator("#pairWarn").is_hidden())
            sp.goto("https://localhost:3113/?source=local")
            sp.wait_for_function("document.getElementById('webcam').videoWidth > 0", timeout=8000)
            check("?source=local starts the webcam directly", "Webcam active" in sp.text_content("#sbText"))
        finally:
            srv2.terminate()
        browser.close()
finally:
    srv.terminate()

bad = [r for r in results if not r[1]]
print(f"\n{len(results) - len(bad)}/{len(results)} checks passed")
sys.exit(1 if bad else 0)
