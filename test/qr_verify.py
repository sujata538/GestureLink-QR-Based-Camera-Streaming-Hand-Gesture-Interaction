import json, sys, cv2, numpy as np
cases = json.load(open('/tmp/qr_cases.json'))
det = cv2.QRCodeDetectorAruco()
bad = 0
for c in cases:
    n = c['size']; scale = 8; margin = 4
    img = np.full(((n+2*margin)*scale,)*2, 255, np.uint8)
    for y, row in enumerate(c['rows']):
        for x, ch in enumerate(row):
            if ch == '1':
                img[(y+margin)*scale:(y+margin+1)*scale, (x+margin)*scale:(x+margin+1)*scale] = 0
    val, pts, _ = det.detectAndDecode(img)
    ok = val == c['text']
    bad += not ok
    print(('PASS' if ok else 'FAIL'), 'v%d mask%d len=%d' % (c['version'], c['mask'], len(c['text'].encode())), '' if ok else repr(val))
print('failures:', bad)
sys.exit(1 if bad else 0)
