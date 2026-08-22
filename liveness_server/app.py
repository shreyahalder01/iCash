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
from scipy.spatial import distance as dist

app = Flask(__name__)
CORS(app)

# ============================================================
# CONFIGURATION & CONSTANTS
# ============================================================
EAR_THRESHOLD = 0.23          # Below this = eye considered closed
EAR_RECOVER = 0.28            # Above this = eye opened -> blink counted
REQUIRED_BLINKS = 1           # Required blinks to confirm liveness
SESSION_TIMEOUT_SECONDS = 60  # Session timeout
MIN_FRAME_GAP = 0.05

MODEL_DIR = os.path.dirname(os.path.abspath(__file__))
SHAPE_PREDICTOR_PATH = os.path.join(MODEL_DIR, "shape_predictor_68_face_landmarks.dat")
MODEL_URL = "https://raw.githubusercontent.com/davisking/dlib-models/master/shape_predictor_68_face_landmarks.dat.bz2"

# 68-point dlib facial landmark indices for left/right eye
LEFT_EYE_IDX = list(range(42, 48))
RIGHT_EYE_IDX = list(range(36, 42))

# ============================================================
# AUTO-DOWNLOAD & LOAD DLIB MODELS
# ============================================================
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
detector = dlib.get_frontal_face_detector()
predictor = dlib.shape_predictor(SHAPE_PREDICTOR_PATH)
print("[iCash Liveness] dlib 68-point models loaded successfully! Server ready on port 5001.")

# ============================================================
# IN-MEMORY SESSION STORE
# ============================================================
sessions = {}


def cleanup_old_sessions():
    now = time.time()
    dead = [sid for sid, s in sessions.items() if now - s.get("last_seen", 0) > SESSION_TIMEOUT_SECONDS]
    for sid in dead:
        del sessions[sid]


def eye_aspect_ratio(eye_points):
    # eye_points = 6 (x, y) points around one eye
    A = dist.euclidean(eye_points[1], eye_points[5])
    B = dist.euclidean(eye_points[2], eye_points[4])
    C = dist.euclidean(eye_points[0], eye_points[3])
    ear = (A + B) / (2.0 * C)
    return ear


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


# ============================================================
# ROUTES
# ============================================================

@app.route("/", methods=["GET"])
def home():
    return jsonify({
        "service": "iCash Real-Time Liveness Detection Server",
        "engine": "dlib-68-landmarks",
        "status": "online",
        "version": "2.0.0"
    })


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "engine": "dlib-68-landmarks",
        "active_sessions": len(sessions)
    })


@app.route("/liveness/start", methods=["POST"])
def liveness_start():
    cleanup_old_sessions()
    session_id = str(uuid.uuid4())
    sessions[session_id] = {
        "ear_history": deque(maxlen=5),
        "blink_count": 0,
        "eye_was_open": True,
        "last_seen": time.time(),
        "no_face_frames": 0,
        "live": False,
    }
    return jsonify({
        "session_id": session_id,
        "required_blinks": REQUIRED_BLINKS,
        "engine": "dlib-68-landmarks"
    })


@app.route("/liveness/frame", methods=["POST"])
def liveness_frame():
    data = request.get_json(silent=True) or {}
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

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    faces = detector(gray, 0)

    if len(faces) == 0:
        session["no_face_frames"] += 1
        return jsonify({
            "face_found": False,
            "multiple_faces": False,
            "live": session["live"],
            "blink_count": session["blink_count"],
        })

    if len(faces) > 1:
        return jsonify({
            "face_found": True,
            "multiple_faces": True,
            "live": session["live"],
            "blink_count": session["blink_count"],
        })

    session["no_face_frames"] = 0
    face = faces[0]
    shape = predictor(gray, face)
    coords = [(shape.part(i).x, shape.part(i).y) for i in range(68)]

    left_eye = [coords[i] for i in LEFT_EYE_IDX]
    right_eye = [coords[i] for i in RIGHT_EYE_IDX]

    left_ear = eye_aspect_ratio(left_eye)
    right_ear = eye_aspect_ratio(right_eye)
    avg_ear = (left_ear + right_ear) / 2.0

    session["ear_history"].append(avg_ear)

    # Blink state machine: open -> closed -> open
    if session["eye_was_open"] and avg_ear < EAR_THRESHOLD:
        session["eye_was_open"] = False
    elif (not session["eye_was_open"]) and avg_ear > EAR_RECOVER:
        session["eye_was_open"] = True
        session["blink_count"] += 1

    if session["blink_count"] >= REQUIRED_BLINKS:
        session["live"] = True

    return jsonify({
        "face_found": True,
        "multiple_faces": False,
        "ear": round(float(avg_ear), 3),
        "blink_count": session["blink_count"],
        "live": session["live"],
    })


@app.route("/liveness/status", methods=["GET"])
def liveness_status():
    session_id = request.args.get("session_id")
    if not session_id or session_id not in sessions:
        return jsonify({"error": "invalid_session"}), 400
    session = sessions[session_id]
    return jsonify({
        "live": session["live"],
        "blink_count": session["blink_count"],
    })


@app.route("/liveness/reset", methods=["POST"])
def liveness_reset():
    data = request.get_json(silent=True) or {}
    session_id = data.get("session_id")
    if session_id and session_id in sessions:
        del sessions[session_id]
    return jsonify({"ok": True})


if __name__ == "__main__":
    port = int(os.environ.get("LIVENESS_PORT", 5001))
    app.run(host="0.0.0.0", port=port, debug=False)
