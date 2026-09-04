"""
iCash real-time liveness service.

The service deliberately requires a temporal OPEN -> CLOSED -> OPEN eye
transition for BOTH eyes. A single still photograph can therefore be detected
as a face but cannot satisfy the blink state machine.
"""

import base64
import bz2
import os
import time
import urllib.request
import uuid
from collections import deque

import cv2
import dlib
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

REQUIRED_BLINKS = 2
SESSION_TIMEOUT_SECONDS = 90
MIN_CLOSED_FRAMES = 2
MIN_BLINK_MS = 100
MAX_BLINK_MS = 900
BLINK_DEBOUNCE_MS = 300
EAR_CLOSE_RATIO = 0.72
EAR_OPEN_RATIO = 0.90
EAR_CLOSE_FLOOR = 0.16
EAR_OPEN_FLOOR = 0.22

MODEL_DIR = os.path.dirname(os.path.abspath(__file__))
PREDICTOR_PATH = os.path.join(MODEL_DIR, "shape_predictor_68_face_landmarks.dat")
MODEL_URL = "https://raw.githubusercontent.com/davisking/dlib-models/master/shape_predictor_68_face_landmarks.dat.bz2"
RIGHT_EYE_IDX = list(range(36, 42))
LEFT_EYE_IDX = list(range(42, 48))


def ensure_model():
    if os.path.exists(PREDICTOR_PATH) and os.path.getsize(PREDICTOR_PATH) >= 50_000_000:
        return
    req = urllib.request.Request(MODEL_URL, headers={"User-Agent": "iCash-Liveness/4.0"})
    with urllib.request.urlopen(req, timeout=180) as response:
        compressed = response.read()
    with open(PREDICTOR_PATH, "wb") as out:
        out.write(bz2.decompress(compressed))


ensure_model()
detector = dlib.get_frontal_face_detector()
predictor = dlib.shape_predictor(PREDICTOR_PATH)
sessions = {}


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
    """Conservative extra PAD gate; a failed check is never treated as live."""
    try:
        h, w = frame.shape[:2]
        x1, y1 = max(0, face.left()), max(0, face.top())
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


def new_session():
    return {
        "last_seen": time.time(),
        "blink_count": 0,
        "eye_state": "open",
        "closed_frames": 0,
        "blink_started": 0.0,
        "last_blink": 0.0,
        "baseline": 0.30,
        "baseline_samples": 0,
        "live": False,
        "spoof_detected": False,
        "spoof_reason": None,
        "ear_history": deque(maxlen=30),
    }


@app.get("/")
def home():
    return jsonify({"service": "iCash Liveness", "status": "online", "required_blinks": REQUIRED_BLINKS})


@app.get("/health")
def health():
    return jsonify({"status": "ok", "engine": "dlib-68-landmarks", "active_sessions": len(sessions)})


@app.post("/liveness/start")
@limiter.limit("10 per minute")
def start():
    cleanup_sessions()
    sid = str(uuid.uuid4())
    sessions[sid] = new_session()
    return jsonify({"session_id": sid, "required_blinks": REQUIRED_BLINKS, "engine": "dlib-68-landmarks-v4"})


@app.post("/liveness/frame")
@limiter.limit("300 per minute")
def frame():
    payload = request.get_json(silent=True) or {}
    sid = payload.get("session_id")
    if not sid or sid not in sessions:
        return jsonify({"error": "invalid_session"}), 400
    image = decode_image(payload.get("image"))
    if image is None:
        return jsonify({"error": "bad_image"}), 400

    s = sessions[sid]
    s["last_seen"] = time.time()
    gray = cv2.equalizeHist(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY))
    faces = detector(gray, 0)

    if len(faces) == 0:
        return jsonify({"face_found": False, "multiple_faces": False, "live": False, "blink_count": s["blink_count"]})
    if len(faces) != 1:
        return jsonify({"face_found": True, "multiple_faces": True, "live": False, "blink_count": s["blink_count"]})

    face = faces[0]
    shape = predictor(gray, face)
    coords = [(shape.part(i).x, shape.part(i).y) for i in range(68)]
    left = [coords[i] for i in LEFT_EYE_IDX]
    right = [coords[i] for i in RIGHT_EYE_IDX]
    left_ear = eye_aspect_ratio(left)
    right_ear = eye_aspect_ratio(right)
    ear = (left_ear + right_ear) / 2.0
    s["ear_history"].append(ear)

    if s["eye_state"] == "open" and ear > 0.22:
        n = s["baseline_samples"]
        if n < 10:
            s["baseline"] = (s["baseline"] * n + ear) / (n + 1)
            s["baseline_samples"] = n + 1
        else:
            s["baseline"] = s["baseline"] * 0.95 + ear * 0.05

    close_threshold = max(EAR_CLOSE_FLOOR, s["baseline"] * EAR_CLOSE_RATIO)
    open_threshold = max(EAR_OPEN_FLOOR, s["baseline"] * EAR_OPEN_RATIO)
    both_closed = left_ear <= close_threshold and right_ear <= close_threshold
    both_open = left_ear >= open_threshold and right_ear >= open_threshold
    now = time.time()

    # A blink is a real temporal event, not a property of one frame:
    # OPEN -> CLOSED for >=2 frames -> OPEN. This blocks still photos.
    if s["eye_state"] == "open":
        if both_closed:
            s["eye_state"] = "closed"
            s["closed_frames"] = 1
            s["blink_started"] = now
    else:
        if both_closed:
            s["closed_frames"] += 1
        elif both_open:
            duration_ms = (now - s["blink_started"]) * 1000.0
            valid = MIN_BLINK_MS <= duration_ms <= MAX_BLINK_MS and s["closed_frames"] >= MIN_CLOSED_FRAMES
            debounce = (now - s["last_blink"]) * 1000.0 >= BLINK_DEBOUNCE_MS
            if valid and debounce:
                s["blink_count"] += 1
                s["last_blink"] = now
            s["eye_state"] = "open"
            s["closed_frames"] = 0
        # Intermediate eye states stay closed; they cannot create a blink.

    pad_ok, pad_reason = presentation_attack_check(image, face, coords)
    if not pad_ok:
        s["spoof_detected"] = True
        s["spoof_reason"] = pad_reason
        s["live"] = False
    elif not s["spoof_detected"] and s["blink_count"] >= REQUIRED_BLINKS:
        s["live"] = True

    return jsonify({
        "face_found": True,
        "multiple_faces": False,
        "ear": round(float(ear), 3),
        "left_ear": round(float(left_ear), 3),
        "right_ear": round(float(right_ear), 3),
        "baseline": round(float(s["baseline"]), 3),
        "blink_count": s["blink_count"],
        "live": s["live"],
        "spoof_detected": s["spoof_detected"],
        "spoof_reason": s["spoof_reason"],
        "required_blinks": REQUIRED_BLINKS,
    })


@app.get("/liveness/status")
def status():
    sid = request.args.get("session_id")
    if not sid or sid not in sessions:
        return jsonify({"error": "invalid_session"}), 400
    s = sessions[sid]
    return jsonify({"live": s["live"], "blink_count": s["blink_count"], "required_blinks": REQUIRED_BLINKS})


@app.post("/liveness/reset")
def reset():
    payload = request.get_json(silent=True) or {}
    sid = payload.get("session_id")
    if sid:
        sessions.pop(sid, None)
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", os.getenv("LIVENESS_PORT", 5001))), debug=False)
