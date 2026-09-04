"""
ICash Real-Time Liveness Detection Server
------------------------------------------
Flask microservice that processes browser camera frames to perform real-time
eye-blink and facial liveness detection using OpenCV + dlib 68-point facial landmarks.

API Endpoints:
- GET  /health          -> Server status & engine info
- POST /liveness/start  -> Initializes new liveness verification session
- POST /liveness/frame  -> Analyzes single frame (base64) & detects blinks/EAR
- GET  /liveness/status -> Queries current liveness status of session
- POST /liveness/reset  -> Cleans up session
"""

import base64
import bz2
import os
import sys
import time
import urllib.request
import uuid
from collections import deque

import cv2
import numpy as np
import dlib
from flask import Flask, request, jsonify
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from scipy.spatial import distance as dist

app = Flask(__name__)

# ── CORS — restrict to configured origins, not wildcard ──────────────────────
_allowed_origins_raw = os.environ.get(
    'LIVENESS_ALLOWED_ORIGINS',
    'http://localhost:4000,http://127.0.0.1:4000,http://localhost:4001,http://127.0.0.1:4001,http://localhost:3000'
)
ALLOWED_ORIGINS = [o.strip() for o in _allowed_origins_raw.split(',') if o.strip()]
CORS(app, origins=ALLOWED_ORIGINS, supports_credentials=False)

# ── Rate Limiting ──────────────────────────────────────────────────────
limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=['200 per minute'],
    storage_uri='memory://',
)

# ── Configuration & Constants ───────────────────────────────────────────────

# Adaptive EAR blink thresholds (relative to each person's open-eye baseline)
EAR_CLOSE_RATIO = 0.80  # eye closed when EAR < baseline * 0.80
EAR_OPEN_RATIO  = 0.88  # eye opened when EAR > baseline * 0.88
EAR_CLOSE_FLOOR = 0.20  # hard minimum for close threshold
EAR_OPEN_FLOOR  = 0.23  # hard minimum for open  threshold

REQUIRED_BLINKS         = 2   # blinks needed to pass liveness (matches frontend)
SESSION_TIMEOUT_SECONDS = 90  # seconds before idle session is purged
BLINK_DEBOUNCE_MS       = 150 # min ms gap between two distinct blinks

MODEL_DIR            = os.path.dirname(os.path.abspath(__file__))
SHAPE_PREDICTOR_PATH = os.path.join(MODEL_DIR, "shape_predictor_68_face_landmarks.dat")
MODEL_URL            = "https://raw.githubusercontent.com/davisking/dlib-models/master/shape_predictor_68_face_landmarks.dat.bz2"

# dlib 68-point facial landmark eye indices (0-indexed)
# 36-41 = person's RIGHT eye  |  42-47 = person's LEFT eye
RIGHT_EYE_IDX = list(range(36, 42))
LEFT_EYE_IDX  = list(range(42, 48))

# ── Model Auto-Download & Load ───────────────────────────────────────────────
def ensure_model_exists():
    if not os.path.exists(SHAPE_PREDICTOR_PATH) or os.path.getsize(SHAPE_PREDICTOR_PATH) < 50_000_000:
        print(f"[iCash Liveness] Downloading 68-point facial landmark model from {MODEL_URL}...")
        req = urllib.request.Request(MODEL_URL, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=180) as resp:
            compressed = resp.read()
        print(f"[iCash Liveness] Downloaded {len(compressed)} bytes. Decompressing...")
        decompressed = bz2.decompress(compressed)
        with open(SHAPE_PREDICTOR_PATH, "wb") as f:
            f.write(decompressed)
            f.flush()
        print(f"[iCash Liveness] Model saved to {SHAPE_PREDICTOR_PATH} ({len(decompressed)} bytes).")

print("[iCash Liveness] Initializing Face Detector and Landmark Predictor...")
ensure_model_exists()
detector  = dlib.get_frontal_face_detector()
predictor = dlib.shape_predictor(SHAPE_PREDICTOR_PATH)
print("[iCash Liveness] dlib 68-point models loaded successfully! Server ready.")

# ── In-Memory Session Store ───────────────────────────────────────────────
sessions = {}


def cleanup_old_sessions():
    now = time.time()
    dead = [sid for sid, s in sessions.items() if now - s.get("last_seen", 0) > SESSION_TIMEOUT_SECONDS]
    for sid in dead:
        del sessions[sid]


def eye_aspect_ratio(eye_points):
    """
    Compute Eye Aspect Ratio (EAR) for a set of 6 (x,y) eye landmark points.
    EAR = (||p1-p5|| + ||p2-p4||) / (2 * ||p0-p3||)
    Returns a value ~0.25-0.35 for open eyes, drops toward 0 when closed.
    """
    A = dist.euclidean(eye_points[1], eye_points[5])
    B = dist.euclidean(eye_points[2], eye_points[4])
    C = dist.euclidean(eye_points[0], eye_points[3])
    if C < 0.001:
        return 0.30
    ear = (A + B) / (2.0 * C)
    return ear


def detect_anti_spoof(frame, face_rect, coords):
    """
    Multi-metric presentation attack detection (PAD):
    1. Texture Sharpness & Frequency (Laplacian variance)
    2. Color Space Skin Chrominance Dispersion (YCrCb color space)
    3. 3D Facial Landmark Depth Geometry (nose projection vs eye-span)
    Returns (is_live: bool, confidence: float, reason: str)
    """
    try:
        h, w = frame.shape[:2]
        x1, y1 = max(0, face_rect.left()), max(0, face_rect.top())
        x2, y2 = min(w, face_rect.right()), min(h, face_rect.bottom())
        if x2 <= x1 or y2 <= y1:
            return True, 0.5, "ok"

        face_roi = frame[y1:y2, x1:x2]
        if face_roi.size == 0:
            return True, 0.5, "ok"

        # 1. Texture Sharpness Variance (Laplacian)
        gray_roi = cv2.cvtColor(face_roi, cv2.COLOR_BGR2GRAY)
        lap_var = cv2.Laplacian(gray_roi, cv2.CV_64F).var()

        # 2. Skin Chrominance Distribution in YCrCb
        ycrcb = cv2.cvtColor(face_roi, cv2.COLOR_BGR2YCrCb)
        cr = ycrcb[:, :, 1]
        cb = ycrcb[:, :, 2]
        cr_std = np.std(cr)
        cb_std = np.std(cb)

        # 3. 3D Landmark Proportion Consistency
        # Point 30 (nose tip), Point 8 (chin), Point 27 (nasion), Points 36, 45 (eye outer corners)
        eye_span = np.hypot(coords[45][0] - coords[36][0], coords[45][1] - coords[36][1])
        nose_len = np.hypot(coords[30][0] - coords[27][0], coords[30][1] - coords[27][1])
        chin_dist = np.hypot(coords[8][0] - coords[30][0], coords[8][1] - coords[30][1])

        if eye_span < 10 or nose_len < 5:
            return True, 0.5, "ok"

        nose_ratio = nose_len / eye_span
        chin_ratio = chin_dist / eye_span

        # Plausibility checks for real 3D human anatomy:
        # A live face has nose_ratio ~0.35-0.75 and chin_ratio ~0.40-0.90
        # Highly distorted screen projections or flat warped photos fall outside
        valid_geometry = (0.22 <= nose_ratio <= 0.95) and (0.25 <= chin_ratio <= 1.15)

        # Extremely low Laplacian (< 12) indicates a blurry print or low-quality digital screen replay
        if lap_var < 8.0:
            return False, 0.1, "blur_photo_spoof"

        # Ultra-flat chrominance (monochrome/grayscale print attack)
        if cr_std < 1.5 and cb_std < 1.5:
            return False, 0.1, "grayscale_print_spoof"

        # Flat/warped 2D surfaces (printed photos, phone/tablet screens held up to the
        # camera) lack real facial depth, so their landmark proportions fall outside
        # plausible live-human geometry. This was previously computed but never
        # enforced, which let sharp, full-color photos bypass anti-spoofing entirely.
        if not valid_geometry:
            return False, 0.15, "flat_geometry_spoof"

        return True, round(float(min(1.0, lap_var / 100.0)), 2), "live_human"
    except Exception:
        # Never treat an analysis failure as proof of liveness.
        return False, 0.0, "analysis_error"


def decode_base64_image(data_url):
    if not data_url:
        return None
    if "," in data_url:
        _, encoded = data_url.split(",", 1)
    else:
        encoded = data_url
    try:
        img_bytes = base64.b64decode(encoded)
        np_arr = np.frombuffer(img_bytes, dtype=np.uint8)
        frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        return frame
    except Exception:
        return None


# ── Routes ────────────────────────────────────────────────────────────

@app.route("/", methods=["GET"])
def home():
    return jsonify({
        "service": "iCash Real-Time Liveness Detection Server",
        "engine": "dlib-68-landmarks",
        "status": "online",
        "version": "3.0.0",
        "required_blinks": REQUIRED_BLINKS,
    })


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "engine": "dlib-68-landmarks",
        "active_sessions": len(sessions),
        "required_blinks": REQUIRED_BLINKS,
    })


@app.route("/liveness/start", methods=["POST"])
@limiter.limit("10 per minute")  # Max 10 new liveness sessions per IP per minute
def liveness_start():
    cleanup_old_sessions()
    session_id = str(uuid.uuid4())
    sessions[session_id] = {
        # Rolling EAR history used to compute adaptive open-eye baseline
        "ear_history":    deque(maxlen=30),
        "blink_count":    0,
        "eye_is_open":    True,      # State machine: True = eyes open, False = eyes closed
        "eye_closed_frames": 0,      # How many consecutive frames eye has been closed
        "last_seen":      time.time(),
        "last_blink_ts":  0.0,       # Timestamp (seconds) of last counted blink
        "open_baseline":  0.30,      # Adaptive open-eye EAR baseline
        "baseline_count": 0,         # Number of open-eye samples collected so far
        "no_face_frames": 0,
        "live":           False,
    }
    return jsonify({
        "session_id":      session_id,
        "required_blinks": REQUIRED_BLINKS,
        "engine":          "dlib-68-landmarks"
    })


@app.route("/liveness/frame", methods=["POST"])
@limiter.limit("300 per minute")  # Max 5 fps × 60 s = 300 frames per minute per IP
def liveness_frame():
    data       = request.get_json(silent=True) or {}
    session_id = data.get("session_id")
    image_data = data.get("image")

    if not session_id or session_id not in sessions:
        return jsonify({"error": "invalid_session"}), 400
    if not image_data:
        return jsonify({"error": "no_image"}), 400

    session = sessions[session_id]
    session["last_seen"] = time.time()

    frame = decode_base64_image(image_data)
    if frame is None:
        return jsonify({"error": "bad_image"}), 400

    # ── Preprocess ────────────────────────────────────────────
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    # Normalize brightness so blink detection works in dim / bright conditions
    gray = cv2.equalizeHist(gray)

    faces = detector(gray, 0)

    if len(faces) == 0:
        session["no_face_frames"] += 1
        return jsonify({
            "face_found":    False,
            "multiple_faces": False,
            "live":          session["live"],
            "blink_count":   session["blink_count"],
            "ear":           None,
        })

    if len(faces) > 1:
        return jsonify({
            "face_found":    True,
            "multiple_faces": True,
            "live":          session["live"],
            "blink_count":   session["blink_count"],
            "ear":           None,
        })

    # ── Landmark extraction ───────────────────────────────────
    session["no_face_frames"] = 0
    face  = faces[0]
    shape = predictor(gray, face)
    coords = [(shape.part(i).x, shape.part(i).y) for i in range(68)]

    left_eye  = [coords[i] for i in LEFT_EYE_IDX]
    right_eye = [coords[i] for i in RIGHT_EYE_IDX]

    left_ear  = eye_aspect_ratio(left_eye)
    right_ear = eye_aspect_ratio(right_eye)

    # Use the MINIMUM (most-closed eye) for maximum blink sensitivity.
    # This catches partial blinks and side-angle blinks that avg() would miss.
    ear = min(left_ear, right_ear)

    session["ear_history"].append(ear)

    # ── Adaptive baseline calibration ────────────────────────
    # Only update baseline during confirmed open-eye frames
    if session["eye_is_open"] and ear > 0.22:
        n = session["baseline_count"]
        if n < 5:
            # Arithmetic average for first 5 open frames
            session["open_baseline"] = (
                ear if n == 0
                else (session["open_baseline"] * n + ear) / (n + 1)
            )
        else:
            # Slow EMA after baseline is stable
            session["open_baseline"] = session["open_baseline"] * 0.93 + ear * 0.07
        session["baseline_count"] += 1

    baseline       = session["open_baseline"]
    close_threshold = max(EAR_CLOSE_FLOOR, baseline * EAR_CLOSE_RATIO)
    open_threshold  = max(EAR_OPEN_FLOOR,  baseline * EAR_OPEN_RATIO)

    # ── Blink state machine: OPEN -> CLOSED -> OPEN ───────────
    now_ts = time.time()

    if session["eye_is_open"] and ear <= close_threshold:
        # Eye just closed
        session["eye_is_open"]     = False
        session["eye_closed_frames"] = 1
        print(f"[iCash Liveness] Eye CLOSED  | EAR={ear:.3f} threshold<={close_threshold:.3f} baseline={baseline:.3f}")

    elif not session["eye_is_open"]:
        if ear <= close_threshold:
            # Still closed
            session["eye_closed_frames"] += 1
        elif ear >= open_threshold:
            # Eye reopened — count as blink if debounce period has passed
            debounce_ok = (now_ts - session["last_blink_ts"]) >= (BLINK_DEBOUNCE_MS / 1000.0)
            if session["eye_closed_frames"] >= 1 and debounce_ok:
                session["blink_count"] += 1
                session["last_blink_ts"] = now_ts
                print(
                    f"[iCash Liveness] 👁 BLINK #{session['blink_count']}/{REQUIRED_BLINKS} | "
                    f"EAR={ear:.3f} baseline={baseline:.3f} closed_frames={session['eye_closed_frames']}"
                )
            session["eye_is_open"]      = True
            session["eye_closed_frames"] = 0

    # ── Presentation Attack / Anti-Spoof Detection ────────────
    is_live_texture, spoof_conf, spoof_reason = detect_anti_spoof(frame, face, coords)
    if not is_live_texture:
        session["spoof_frames"] = session.get("spoof_frames", 0) + 1
        print(f"[iCash Liveness] ⚠️ SPOOF ATTEMPT DETECTED: {spoof_reason} (conf={spoof_conf})")
    else:
        session["spoof_frames"] = 0

    # ── Liveness determination ───────────────────────────────
    # Requires BOTH 2 verified real dynamic blinks AND passing the anti-spoof texture checks
    if session["blink_count"] >= REQUIRED_BLINKS and session.get("spoof_frames", 0) == 0:
        session["live"] = True

    return jsonify({
        "face_found":      True,
        "multiple_faces":  False,
        "ear":             round(float(ear), 3),
        "left_ear":        round(float(left_ear), 3),
        "right_ear":       round(float(right_ear), 3),
        "baseline":        round(float(baseline), 3),
        "blink_count":     session["blink_count"],
        "live":            session["live"],
        "spoof_detected":  not is_live_texture,
        "spoof_reason":    spoof_reason,
        "required_blinks": REQUIRED_BLINKS,
    })


@app.route("/liveness/status", methods=["GET"])
def liveness_status():
    session_id = request.args.get("session_id")
    if not session_id or session_id not in sessions:
        return jsonify({"error": "invalid_session"}), 400
    session = sessions[session_id]
    return jsonify({
        "live":            session["live"],
        "blink_count":     session["blink_count"],
        "required_blinks": REQUIRED_BLINKS,
        "baseline":        round(float(session["open_baseline"]), 3),
    })


@app.route("/liveness/reset", methods=["POST"])
def liveness_reset():
    data       = request.get_json(silent=True) or {}
    session_id = data.get("session_id")
    if session_id and session_id in sessions:
        del sessions[session_id]
    return jsonify({"ok": True})


if __name__ == "__main__":
    port = int(os.environ.get("LIVENESS_PORT", 5001))
    app.run(host="0.0.0.0", port=port, debug=False)