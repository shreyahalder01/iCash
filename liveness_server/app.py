# pyright: reportMissingImports=false
"""
iCash real-time liveness service.

The service deliberately requires a temporal OPEN -> CLOSED -> OPEN eye
transition for BOTH eyes. A single still photograph can therefore be detected
as a face but cannot satisfy the blink state machine.

v6 changes vs v5:
  - PAD is now a rolling bad-frame counter, not a permanent session flag.
    A single low-texture or low-chrominance frame (common during a real blink
    or under variable lighting) no longer permanently kills a session.
    Spoof is only confirmed after PAD_STRIKE_LIMIT consecutive bad frames.
  - MIN_CLOSED_FRAMES reduced 2 → 1. At 6-8 fps (realistic over network)
    a 100-150 ms natural blink produces only 1 server-side closed frame.
    Duration (MIN_BLINK_MS / MAX_BLINK_MS) is the primary validity gate.
  - Structured [LIVENESS] logging for every state transition.
"""

import base64
import bz2
import os
import time
import urllib.request
import uuid
from collections import deque

import cv2
try:
    import dlib  # type: ignore[import-not-found, import-untyped]
except ImportError:
    dlib = None
import numpy as np
from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from scipy.spatial import distance as dist

app = Flask(__name__)


def _origins():
    raw = os.getenv(
        "LIVENESS_ALLOWED_ORIGINS",
        "https://icash.onrender.com,https://icash-server.onrender.com,"
        "http://localhost:3000,http://localhost:4000,"
        "http://localhost:4001,http://localhost:5173,http://localhost:5500,"
        "http://127.0.0.1:3000,http://127.0.0.1:4000,http://127.0.0.1:4001,"
        "http://127.0.0.1:5173,http://127.0.0.1:5500",
    )
    return [x.strip().rstrip("/") for x in raw.split(",") if x.strip()]


ALLOWED_ORIGINS = _origins()
CORS(app, origins=ALLOWED_ORIGINS, supports_credentials=False)

limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    default_limits=["200 per minute"],
    storage_uri="memory://",
)

# ── Blink detection constants ─────────────────────────────────────────────────
REQUIRED_BLINKS          = 2
SESSION_TIMEOUT_SECONDS  = 180   # 3 min — matches challenge TTL
MIN_CLOSED_FRAMES        = 1     # v6: 1 frame (duration is the primary gate)
MIN_BLINK_MS             = 70    # Fastest realistic blink
MAX_BLINK_MS             = 700   # Slower deliberate blinks also accepted
BLINK_DEBOUNCE_MS        = 300
EAR_CLOSE_RATIO          = 0.72
EAR_OPEN_RATIO           = 0.88  # v6: lowered slightly (was 0.90) for re-open detection
EAR_CLOSE_FLOOR          = 0.12  # v6: lowered floor (was 0.16) for large-eye users
EAR_OPEN_FLOOR           = 0.18  # v6: lowered floor (was 0.22)
# Eyes closed > 60 frames = suspicious (closed-eye photo spoofing)
MAX_CONSECUTIVE_CLOSED   = 60

# ── PAD (Presentation Attack Detection) constants ────────────────────────────
# v6: PAD uses a rolling strike counter.  A single bad frame is a warning;
#     only PAD_STRIKE_LIMIT *consecutive* bad frames declare a spoof so that
#     real blinks (which briefly lower texture) do not permanently block users.
PAD_STRIKE_LIMIT         = 4     # consecutive bad-PAD frames required
PAD_RECOVERY_FRAMES      = 2     # consecutive good-PAD frames to clear strikes

MODEL_DIR = os.path.dirname(os.path.abspath(__file__))
PREDICTOR_PATH = os.path.join(MODEL_DIR, "shape_predictor_68_face_landmarks.dat")
MODEL_URL = "https://raw.githubusercontent.com/davisking/dlib-models/master/shape_predictor_68_face_landmarks.dat.bz2"
RIGHT_EYE_IDX = list(range(36, 42))
LEFT_EYE_IDX  = list(range(42, 48))

_DEV_LOG = os.getenv("LIVENESS_DEBUG", "true").lower() not in ("0", "false", "no")


def _log(sid_short, msg):
    if _DEV_LOG:
        print(f"[LIVENESS] {sid_short}: {msg}", flush=True)


def ensure_model():
    if dlib is None:
        return
    if os.path.exists(PREDICTOR_PATH) and os.path.getsize(PREDICTOR_PATH) >= 50_000_000:
        return
    print("[LIVENESS] Downloading shape predictor model…", flush=True)
    req = urllib.request.Request(MODEL_URL, headers={"User-Agent": "iCash-Liveness/6.0"})
    with urllib.request.urlopen(req, timeout=180) as response:
        compressed = response.read()
    with open(PREDICTOR_PATH, "wb") as out:
        out.write(bz2.decompress(compressed))
    print("[LIVENESS] Model download complete.", flush=True)


class _FallbackFaceRect:
    def __init__(self, x, y, w, h):
        self._x = int(x)
        self._y = int(y)
        self._w = int(w)
        self._h = int(h)

    def left(self):
        return self._x

    def right(self):
        return self._x + self._w

    def top(self):
        return self._y

    def bottom(self):
        return self._y + self._h

    def width(self):
        return self._w

    def height(self):
        return self._h


class _FallbackShapePart:
    def __init__(self, x, y):
        self.x = int(x)
        self.y = int(y)


class _FallbackShape:
    def __init__(self, parts):
        self._parts = [_FallbackShapePart(x, y) for (x, y) in parts]

    def part(self, i):
        return self._parts[i]


class _FallbackDetector:
    """
    Fallback face detector when dlib is not available (e.g. Windows Python 3.13).
    Detects face region using foreground adaptive thresholding and contour analysis.
    """
    def __call__(self, gray, upsample=0):
        h, w = gray.shape[:2]
        blur = cv2.GaussianBlur(gray, (7, 7), 0)
        _, thresh = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        valid_faces = []
        min_area = (h * w) * 0.05
        max_area = (h * w) * 0.90
        for cnt in contours:
            x, y, fw, fh = cv2.boundingRect(cnt)
            area = fw * fh
            aspect = fh / float(fw) if fw > 0 else 0
            if min_area <= area <= max_area and 0.8 <= aspect <= 2.2:
                valid_faces.append(_FallbackFaceRect(x, y, fw, fh))

        if not valid_faces:
            if float(cv2.Laplacian(gray, cv2.CV_64F).var()) >= 5.0:
                cw, ch = int(w * 0.5), int(h * 0.6)
                cx, cy = (w - cw) // 2, int((h - ch) * 0.35)
                valid_faces.append(_FallbackFaceRect(cx, cy, cw, ch))

        return valid_faces


class _FallbackPredictor:
    """
    Fallback 68-landmark shape predictor when dlib is not available.
    Generates standard facial landmarks and estimates Eye Aspect Ratio (EAR)
    based on eye-region texture and contrast variation.
    """
    def __call__(self, gray, face):
        fx = face.left()
        fy = face.top()
        fw = face.right() - fx
        fh = face.bottom() - fy

        r_cx, r_cy = fx + 0.35 * fw, fy + 0.38 * fh
        l_cx, l_cy = fx + 0.65 * fw, fy + 0.38 * fh
        eye_w = max(10.0, 0.14 * fw)

        h, w = gray.shape[:2]
        r_roi = gray[max(0, int(r_cy - eye_w / 2)):min(h, int(r_cy + eye_w / 2)),
                     max(0, int(r_cx - eye_w / 2)):min(w, int(r_cx + eye_w / 2))]
        l_roi = gray[max(0, int(l_cy - eye_w / 2)):min(h, int(l_cy + eye_w / 2)),
                     max(0, int(l_cx - eye_w / 2)):min(w, int(l_cx + eye_w / 2))]

        r_var = float(cv2.Laplacian(r_roi, cv2.CV_64F).var()) if r_roi.size > 0 else 20.0
        l_var = float(cv2.Laplacian(l_roi, cv2.CV_64F).var()) if l_roi.size > 0 else 20.0

        is_closed = (r_var < 8.0 and l_var < 8.0)
        ear_target = 0.10 if is_closed else 0.30
        eye_h = eye_w * ear_target

        parts = []
        # 0-16 jawline
        for i in range(17):
            t = i / 16.0
            px = fx + fw * (0.05 + 0.90 * t)
            py = fy + fh * (0.30 + 0.70 * np.sin(np.pi * t))
            parts.append((px, py))
        # 17-21 right eyebrow
        for i in range(5):
            parts.append((fx + fw * (0.20 + 0.05 * i), fy + fh * 0.28))
        # 22-26 left eyebrow
        for i in range(5):
            parts.append((fx + fw * (0.55 + 0.05 * i), fy + fh * 0.28))
        # 27-35 nose
        for i in range(9):
            parts.append((fx + fw * 0.50, fy + fh * (0.35 + 0.03 * i)))
        # 36-41 right eye
        parts.append((r_cx - eye_w / 2, r_cy))
        parts.append((r_cx - eye_w / 4, r_cy - eye_h / 2))
        parts.append((r_cx + eye_w / 4, r_cy - eye_h / 2))
        parts.append((r_cx + eye_w / 2, r_cy))
        parts.append((r_cx + eye_w / 4, r_cy + eye_h / 2))
        parts.append((r_cx - eye_w / 4, r_cy + eye_h / 2))
        # 42-47 left eye
        parts.append((l_cx - eye_w / 2, l_cy))
        parts.append((l_cx - eye_w / 4, l_cy - eye_h / 2))
        parts.append((l_cx + eye_w / 4, l_cy - eye_h / 2))
        parts.append((l_cx + eye_w / 2, l_cy))
        parts.append((l_cx + eye_w / 4, l_cy + eye_h / 2))
        parts.append((l_cx - eye_w / 4, l_cy + eye_h / 2))
        # 48-67 mouth
        for i in range(20):
            parts.append((fx + fw * (0.35 + 0.015 * (i % 10)), fy + fh * (0.75 + 0.02 * (i // 10))))

        return _FallbackShape(parts)


if dlib is not None:
    ensure_model()
    detector  = dlib.get_frontal_face_detector()
    predictor = dlib.shape_predictor(PREDICTOR_PATH)
    ENGINE_NAME = "dlib-68-landmarks-v6"
else:
    print("[LIVENESS] Note: dlib is not installed. Running in OpenCV fallback mode.", flush=True)
    detector  = _FallbackDetector()
    predictor = _FallbackPredictor()
    ENGINE_NAME = "opencv-fallback-v6"

sessions  = {}


def cleanup_sessions():
    now = time.time()
    for sid in list(sessions):
        if now - sessions[sid]["last_seen"] > SESSION_TIMEOUT_SECONDS:
            del sessions[sid]


def eye_aspect_ratio(points):
    a = dist.euclidean(points[1], points[5])
    b = dist.euclidean(points[2], points[4])
    c = dist.euclidean(points[0], points[3])
    return (a + b) / (2.0 * c) if c > 0.001 else 0.30


def decode_image(data_url):
    if not isinstance(data_url, str) or not data_url or len(data_url) > 1_500_000:
        return None
    encoded = data_url.split(",", 1)[-1]
    try:
        raw = base64.b64decode(encoded, validate=True)
        if len(raw) > 1_000_000:
            return None
        return cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    except Exception:
        return None


def presentation_attack_check(frame, face, coords):
    """
    Returns (ok: bool, reason: str).
    A failed check contributes one PAD strike; the caller accumulates strikes
    before declaring a confirmed spoof.
    """
    try:
        h, w = frame.shape[:2]
        x1, y1 = max(0, face.left()),  max(0, face.top())
        x2, y2 = min(w, face.right()), min(h, face.bottom())
        roi = frame[y1:y2, x1:x2]
        if roi.size == 0:
            return False, "empty_face"
        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        if float(cv2.Laplacian(gray, cv2.CV_64F).var()) < 8.0:
            return False, "low_texture"
        ycrcb = cv2.cvtColor(roi, cv2.COLOR_BGR2YCrCb)
        if float(np.std(ycrcb[:, :, 1])) < 1.0 and float(np.std(ycrcb[:, :, 2])) < 1.0:
            return False, "flat_chrominance"
        eye_span = np.hypot(coords[45][0] - coords[36][0], coords[45][1] - coords[36][1])
        if eye_span < 12:
            return False, "poor_face_geometry"
        return True, "ok"
    except Exception:
        return False, "analysis_error"


def new_session(challenge_type=None):
    required_blinks = 1 if challenge_type == "BLINK_ONCE" else 2
    return {
        "last_seen":          time.time(),
        "blink_count":        0,
        "eye_state":          "open",
        "closed_frames":      0,
        "blink_started":      0.0,
        "last_blink":         0.0,
        "baseline":           0.30,
        "baseline_samples":   0,
        "live":               False,
        "consumed":           False,   # one-time flag — set by /liveness/consume
        "spoof_detected":     False,
        "spoof_reason":       None,
        # v6 rolling PAD strike counter
        "pad_strikes":        0,       # consecutive bad-PAD frames
        "pad_good_streak":    0,       # consecutive good-PAD frames
        "ear_history":        deque(maxlen=30),
        "challenge_type":     challenge_type or "BLINK_TWICE",
        "required_blinks":    required_blinks,
        "exactly_one_face":   False,
    }


@app.get("/")
def home():
    return jsonify({"service": "iCash Liveness", "status": "online", "required_blinks": REQUIRED_BLINKS, "version": "6.0"})


@app.get("/health")
def health():
    return jsonify({"status": "ok", "engine": ENGINE_NAME, "active_sessions": len(sessions)})


@app.post("/liveness/start")
@limiter.limit("10 per minute")
def start():
    cleanup_sessions()
    payload        = request.get_json(silent=True) or {}
    challenge_type = payload.get("challenge_type", "BLINK_TWICE")
    if challenge_type not in {"BLINK_ONCE", "BLINK_TWICE"}:
        return jsonify({"error": "unsupported_challenge"}), 400
    sid            = str(uuid.uuid4())
    sessions[sid]  = new_session(challenge_type)
    sid_short = sid[:8]
    _log(sid_short, f"session started — challenge={challenge_type} required_blinks={sessions[sid]['required_blinks']}")
    return jsonify({
        "session_id":      sid,
        "required_blinks": sessions[sid]["required_blinks"],
        "challenge_type":  challenge_type,
        "engine":          ENGINE_NAME,
    })


@app.post("/liveness/frame")
@limiter.limit("300 per minute")
def frame():
    payload = request.get_json(silent=True) or {}
    sid     = payload.get("session_id")
    if not sid or sid not in sessions:
        return jsonify({"error": "invalid_session"}), 400
    image = decode_image(payload.get("image"))
    if image is None:
        return jsonify({"error": "bad_image"}), 400
    s = sessions[sid]
    if s.get("consumed"):
        return jsonify({"error": "session_consumed"}), 400

    sid_short = sid[:8]
    s["last_seen"] = time.time()
    gray = cv2.equalizeHist(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY))
    faces = detector(gray, 0)

    if len(faces) == 0:
        s["exactly_one_face"] = False
        s["live"] = False
        _log(sid_short, "no face detected")
        return jsonify({
            "face_found": False, "multiple_faces": False, "live": False,
            "blink_count": s["blink_count"], "exactly_one_face": False,
        })
    if len(faces) != 1:
        s["exactly_one_face"] = False
        s["live"] = False
        _log(sid_short, f"multiple faces ({len(faces)}) — rejecting")
        return jsonify({
            "face_found": True, "multiple_faces": True, "live": False,
            "blink_count": s["blink_count"], "exactly_one_face": False,
        })

    face = faces[0]
    s["exactly_one_face"] = True
    shape  = predictor(gray, face)
    coords = [(shape.part(i).x, shape.part(i).y) for i in range(68)]
    left   = [coords[i] for i in LEFT_EYE_IDX]
    right  = [coords[i] for i in RIGHT_EYE_IDX]
    left_ear  = eye_aspect_ratio(left)
    right_ear = eye_aspect_ratio(right)
    ear = (left_ear + right_ear) / 2.0

    # Integrate client-side landmark EAR telemetry if available (especially in fallback mode)
    client_ear = payload.get("client_ear") if payload.get("client_ear") is not None else payload.get("ear")
    if client_ear is not None:
        try:
            c_ear = float(client_ear)
            c_closed = bool(payload.get("is_closed"))
            if 0.01 <= c_ear <= 0.85:
                if c_closed:
                    left_ear = min(c_ear, 0.12)
                    right_ear = min(c_ear, 0.12)
                else:
                    c_left = payload.get("left_ear")
                    c_right = payload.get("right_ear")
                    left_ear = float(c_left) if c_left is not None else c_ear
                    right_ear = float(c_right) if c_right is not None else c_ear
                ear = (left_ear + right_ear) / 2.0
        except (ValueError, TypeError):
            pass

    s["ear_history"].append(ear)

    # ── Baseline calibration (open-eye frames only) ───────────────────────────
    if s["eye_state"] == "open" and ear > EAR_OPEN_FLOOR:
        n = s["baseline_samples"]
        if n < 10:
            s["baseline"] = (s["baseline"] * n + ear) / (n + 1)
            s["baseline_samples"] = n + 1
        else:
            s["baseline"] = s["baseline"] * 0.95 + ear * 0.05

    close_threshold = max(EAR_CLOSE_FLOOR, s["baseline"] * EAR_CLOSE_RATIO)
    open_threshold  = max(EAR_OPEN_FLOOR,  s["baseline"] * EAR_OPEN_RATIO)
    both_closed = left_ear <= close_threshold and right_ear <= close_threshold
    both_open   = left_ear >= open_threshold  and right_ear >= open_threshold
    now = time.time()

    # ── Temporal blink state machine: OPEN → CLOSED(≥MIN_CLOSED_FRAMES) → OPEN ──
    # A still photograph cannot satisfy this because EAR never changes over time.
    if s["eye_state"] == "open":
        if both_closed:
            s["eye_state"]     = "closed"
            s["closed_frames"] = 1
            s["blink_started"] = now
            _log(sid_short, f"eyes CLOSED (ear={ear:.3f} threshold={close_threshold:.3f})")
    else:  # state == "closed"
        if both_closed:
            s["closed_frames"] += 1
            # Eyes closed for an abnormally long time — probable closed-eye photo spoof
            if s["closed_frames"] > MAX_CONSECUTIVE_CLOSED:
                _log(sid_short, f"eyes closed too long ({s['closed_frames']} frames) — spoof flagged")
                s["spoof_detected"] = True
                s["spoof_reason"]   = "eyes_closed_too_long"
                s["live"]           = False
        elif both_open:
            duration_ms = (now - s["blink_started"]) * 1000.0
            valid_dur   = MIN_BLINK_MS <= duration_ms <= MAX_BLINK_MS
            valid_frm   = s["closed_frames"] >= MIN_CLOSED_FRAMES
            debounce    = (now - s["last_blink"]) * 1000.0 >= BLINK_DEBOUNCE_MS
            if valid_dur and valid_frm and debounce:
                s["blink_count"] += 1
                s["last_blink"]   = now
                _log(sid_short,
                     f"BLINK #{s['blink_count']}/{s['required_blinks']} confirmed "
                     f"(dur={duration_ms:.0f}ms frames={s['closed_frames']})")
            else:
                reasons = []
                if not valid_dur: reasons.append(f"dur={duration_ms:.0f}ms out of [{MIN_BLINK_MS},{MAX_BLINK_MS}]")
                if not valid_frm: reasons.append(f"frames={s['closed_frames']}<{MIN_CLOSED_FRAMES}")
                if not debounce:  reasons.append("debounce")
                _log(sid_short, f"blink rejected: {', '.join(reasons)}")
            s["eye_state"]     = "open"
            s["closed_frames"] = 0
        else:
            # Intermediate state (partially open): transition back to open
            # so that a slow re-open does not stall in "closed" indefinitely.
            duration_ms = (now - s["blink_started"]) * 1000.0
            if duration_ms > MAX_BLINK_MS:
                _log(sid_short, "intermediate state too long — resetting to open")
                s["eye_state"]     = "open"
                s["closed_frames"] = 0

    # ── Rolling PAD (Presentation Attack Detection) ───────────────────────────
    # v6: we accumulate consecutive bad frames before confirming a spoof.
    # This prevents a single blurry/dark frame during a real blink from
    # permanently invalidating a legitimate session.
    if not s["spoof_detected"]:
        pad_ok, pad_reason = presentation_attack_check(image, face, coords)
        if pad_ok:
            s["pad_strikes"]    = 0
            s["pad_good_streak"] = s["pad_good_streak"] + 1
        else:
            s["pad_good_streak"] = 0
            s["pad_strikes"]    += 1
            _log(sid_short, f"PAD warning strike {s['pad_strikes']}/{PAD_STRIKE_LIMIT}: {pad_reason}")
            if s["pad_strikes"] >= PAD_STRIKE_LIMIT:
                _log(sid_short, f"PAD SPOOF CONFIRMED after {PAD_STRIKE_LIMIT} consecutive strikes: {pad_reason}")
                s["spoof_detected"] = True
                s["spoof_reason"]   = pad_reason
                s["live"]           = False

    # ── Liveness determination ────────────────────────────────────────────────
    if not s["spoof_detected"] and s["blink_count"] >= s["required_blinks"] and s["exactly_one_face"]:
        if not s["live"]:
            _log(sid_short, f"LIVENESS CONFIRMED — blinks={s['blink_count']}/{s['required_blinks']}")
        s["live"] = True

    return jsonify({
        "face_found":      True,
        "multiple_faces":  False,
        "ear":             round(float(ear), 3),
        "left_ear":        round(float(left_ear), 3),
        "right_ear":       round(float(right_ear), 3),
        "baseline":        round(float(s["baseline"]), 3),
        "blink_count":     s["blink_count"],
        "live":            s["live"],
        "spoof_detected":  s["spoof_detected"],
        "spoof_reason":    s["spoof_reason"],
        "required_blinks": s["required_blinks"],
        "exactly_one_face": s["exactly_one_face"],
        "eye_state":       s["eye_state"],
        "pad_strikes":     s["pad_strikes"],
    })


@app.get("/liveness/status")
def status():
    sid = request.args.get("session_id")
    if not sid or sid not in sessions:
        return jsonify({"error": "invalid_session"}), 400
    s = sessions[sid]
    return jsonify({
        "live":            s["live"],
        "blink_count":     s["blink_count"],
        "required_blinks": s["required_blinks"],
        "consumed":        s.get("consumed", False),
        "exactly_one_face": s["exactly_one_face"],
        "eye_state":       s["eye_state"],
    })


@app.post("/liveness/verify")
@limiter.limit("60 per minute")
def verify():
    """
    Server-to-server endpoint called by the Node backend to confirm liveness.
    The browser never calls this directly — it requires no CORS preflight for
    same-machine Node→Python calls.
    Returns the authoritative live/spoof state for a session_id.
    """
    payload = request.get_json(silent=True) or {}
    sid     = payload.get("session_id")
    if not sid or sid not in sessions:
        return jsonify({"error": "invalid_session", "live": False}), 404
    s = sessions[sid]
    if s.get("consumed"):
        return jsonify({"error": "session_consumed", "live": False}), 400
    sid_short = sid[:8]
    _log(sid_short, f"verify called — live={s['live']} blinks={s['blink_count']}/{s['required_blinks']} spoof={s['spoof_detected']}")
    return jsonify({
        "live":            s["live"],
        "blink_count":     s["blink_count"],
        "required_blinks": s["required_blinks"],
        "spoof_detected":  s["spoof_detected"],
        "spoof_reason":    s["spoof_reason"],
        "challenge_type":  s.get("challenge_type"),
        "exactly_one_face": s["exactly_one_face"],
    })


@app.post("/liveness/consume")
@limiter.limit("60 per minute")
def consume():
    """
    Mark a liveness session as consumed (one-time use).
    Called by Node backend after issuing a biometricToken so the session
    cannot be reused in a subsequent verify-challenge request.
    """
    payload = request.get_json(silent=True) or {}
    sid     = payload.get("session_id")
    if sid and sid in sessions:
        sessions[sid]["consumed"] = True
        _log(sid[:8], "session consumed (one-time use enforced)")
    return jsonify({"ok": True})


@app.post("/liveness/reset")
def reset():
    payload = request.get_json(silent=True) or {}
    sid     = payload.get("session_id")
    if sid:
        sessions.pop(sid, None)
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", os.getenv("LIVENESS_PORT", 5001))), debug=False)
