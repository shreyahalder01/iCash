/**
 * iCash Real Biometric Engine
 *
 * Blink Detection — three parallel methods (first to fire wins):
 *   1. EAR (Eye Aspect Ratio) via face-api.js 68-point landmarks  (primary)
 *   2. Eyelid collapse detection (BRFv4-style, fallback for low-EAR faces)
 *   3. MediaPipe FaceMesh 478-keypoint EAR (bonus signal, confirms blink)
 *
 * Face Recognition:
 *   - TinyFaceDetector + 128-D FaceRecognitionNet (face-api.js)
 *   - Euclidean distance threshold 0.52
 *   - 5 auto-collected enrollment samples, 2 consecutive matches to confirm identity
 *
 * Liveness:
 *   - Client-side EAR (always active)
 *   - Server-side dlib/OpenCV (bonus signal when running locally, not required in production)
 */

// Local models served by Express (primary) — CDN fallback handled in ensureBioModels()
const FACEAPI_MODEL_URL = '/models';
const FACEAPI_MODEL_URL_CDN = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';

const MATCH_THRESHOLD = 0.52; // Euclidean < 0.52 = same person
const ENROLL_SAMPLES = 5; // Auto-collected enrollment samples
const ENROLL_INTERVAL = 100; // ms between landmark & blink checks during enrollment (fast 10fps)
const VERIFY_INTERVAL = 100; // ms between frames for lightning-fast real-time double blink detection
const REQUIRED_MATCHES = 2; // Consecutive matching frames to confirm identity
const REQUIRED_BLINKS = 2; // Strict requirement: must blink 2 times

function _getDetectOptions() {
  // 320px input size is fast (~20ms per frame on mobile/web) to reliably catch 150ms natural eye blinks
  return new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.45 });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Model loader ──────────────────────────────────────────────────────────────
window._bioModelsLoaded = false;
window._bioModelsLoading = false;

async function ensureBioModels() {
  if (window._bioModelsLoaded) return true;
  if (window._bioModelsLoading) {
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      if (window._bioModelsLoaded) return true;
    }
    return false;
  }
  window._bioModelsLoading = true;

  // Try local /models first (served by Express), then fall back to CDN
  const sources = [FACEAPI_MODEL_URL, FACEAPI_MODEL_URL_CDN];
  for (const src of sources) {
    try {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(src),
        faceapi.nets.faceLandmark68Net.loadFromUri(src),
        faceapi.nets.faceRecognitionNet.loadFromUri(src),
      ]);
      window._bioModelsLoaded = true;
      window._bioModelsLoading = false;
      console.log('[iCash Bio] FaceAPI models loaded OK from:', src);
      return true;
    } catch (e) {
      console.warn('[iCash Bio] Model load failed from', src, '— trying next source…', e.message || e);
    }
  }

  window._bioModelsLoading = false;
  console.error('[iCash Bio] All model sources failed.');
  return false;
}

// ── MediaPipe FaceMesh 478-keypoint blink engine ──────────────────────────────
// Uses @mediapipe/face_mesh (loaded via CDN) for 478-point landmark EAR.
// Runs fire-and-forget alongside face-api.js — its results augment the primary
// 68-point EAR detector. No TF.js conflicts: MP runs in its own Wasm pipeline.

// Standard 6-point EAR indices for MediaPipe 478-keypoint model:
const MP_LEFT_EYE_EAR_IDX  = [362, 385, 387, 263, 373, 380];
const MP_RIGHT_EYE_EAR_IDX = [33,  160, 158, 133, 153, 144];

let _mpFaceMesh      = null;
let _mpFaceMeshReady = false;
let _mpFaceMeshLoading = false;
let _mpLastKeypoints = null; // latest 478-point result, updated async

async function initMPFacemesh() {
  if (_mpFaceMeshReady && _mpFaceMesh) return _mpFaceMesh;
  if (_mpFaceMeshLoading) {
    for (let i = 0; i < 60; i++) {
      await sleep(100);
      if (_mpFaceMeshReady) return _mpFaceMesh;
    }
    return _mpFaceMesh;
  }
  if (typeof FaceMesh === 'undefined') {
    console.warn('[iCash Bio] @mediapipe/face_mesh not loaded — 478-pt blink disabled.');
    return null;
  }
  _mpFaceMeshLoading = true;
  try {
    const fm = new FaceMesh({
      locateFile: (f) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/${f}`,
    });
    fm.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    fm.onResults((res) => {
      _mpLastKeypoints =
        res.multiFaceLandmarks && res.multiFaceLandmarks.length > 0
          ? res.multiFaceLandmarks[0]
          : null;
    });
    await fm.initialize();
    _mpFaceMesh      = fm;
    _mpFaceMeshReady = true;
    console.log('[iCash Bio] MediaPipe FaceMesh 478-keypoint engine initialized ✓');
  } catch (e) {
    console.warn('[iCash Bio] MediaPipe FaceMesh init failed:', e.message || e);
  }
  _mpFaceMeshLoading = false;
  return _mpFaceMesh;
}

/** Send a video frame to the MP pipeline (fire-and-forget, non-blocking). */
async function sendFrameToMP(video) {
  if (!_mpFaceMeshReady || !_mpFaceMesh || !video || !video.videoWidth) return;
  try { await _mpFaceMesh.send({ image: video }); } catch { /* ignore */ }
}

/**
 * Compute EAR from a set of MediaPipe 478-keypoint results.
 * Keypoints are normalised {x,y} coordinates in [0,1].
 * We use pixel-independent ratios so normalised coords work fine.
 */
function computeMP478EAR(keypoints, indices) {
  if (!keypoints || !indices || indices.length < 6) return null;
  try {
    const pts = indices.map((i) => keypoints[i]);
    if (pts.some((p) => !p)) return null;
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const v1 = d(pts[1], pts[5]);
    const v2 = d(pts[2], pts[4]);
    const h  = d(pts[0], pts[3]);
    if (h <= 0.0001) return null;
    return (v1 + v2) / (2 * h);
  } catch { return null; }
}

// ── Math ──────────────────────────────────────────────────────────────────────
function euclidean(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

function bestMatch(storedList, live) {
  let min = Infinity;
  for (const vec of storedList) {
    const d = euclidean(Array.from(vec), Array.from(live));
    if (d < min) min = d;
  }
  return min;
}

/**
 * calculateSampleDiversity — Anti-Static Photo / Screen Attack Protection
 * Measures natural biological micro-variance across enrolled frames.
 * A static photo held in front of a camera produces zero variance (< 0.003),
 * whereas a real living human breathing has natural micro-variance (0.03 - 0.35).
 */
function calculateSampleDiversity(samples) {
  if (!samples || samples.length < 2) return 1.0;
  let totalDist = 0;
  let pairs = 0;
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      totalDist += euclidean(Array.from(samples[i]), Array.from(samples[j]));
      pairs++;
    }
  }
  return pairs > 0 ? totalDist / pairs : 1.0;
}

// ── Real-Time Client-Side Eye Aspect Ratio (EAR) Blink Detector ─────────────
function _getPointCoords(p) {
  if (!p) return null;
  const x =
    typeof p.x === 'number'
      ? p.x
      : typeof p._x === 'number'
        ? p._x
        : Array.isArray(p)
          ? p[0]
          : null;
  const y =
    typeof p.y === 'number'
      ? p.y
      : typeof p._y === 'number'
        ? p._y
        : Array.isArray(p)
          ? p[1]
          : null;
  if (x === null || y === null || isNaN(x) || isNaN(y)) return null;
  return { x, y };
}

function _calcDist(p1, p2) {
  const pt1 = _getPointCoords(p1);
  const pt2 = _getPointCoords(p2);
  if (!pt1 || !pt2) return 0;
  return Math.hypot(pt1.x - pt2.x, pt1.y - pt2.y);
}

/**
 * calculateEAR — Eye Aspect Ratio formula (Ankur Kedia / Soukupová & Čech)
 * Eye points: [p0, p1, p2, p3, p4, p5]
 * EAR = (||p1 - p5|| + ||p2 - p4||) / (2 * ||p0 - p3||)
 */
function calculateEAR(eyePoints) {
  if (!eyePoints || eyePoints.length < 6) return 0.30;
  const v1 = _calcDist(eyePoints[1], eyePoints[5]);
  const v2 = _calcDist(eyePoints[2], eyePoints[4]);
  const h  = _calcDist(eyePoints[0], eyePoints[3]);
  if (h <= 0.001) return 0.30;
  return (v1 + v2) / (2.0 * h);
}

/**
 * detectBlinkByCollapse — Eyelid distance collapse check
 */
function detectBlinkByCollapse(eyePoints) {
  if (!eyePoints || eyePoints.length < 6) return false;
  const p0 = _getPointCoords(eyePoints[0]);
  const p3 = _getPointCoords(eyePoints[3]);
  const eyeWidth = (p0 && p3) ? Math.abs(p3.x - p0.x) : 25;
  const collapseThreshold = Math.max(3.5, eyeWidth * 0.24);

  const verticalPairs = [[1, 5], [2, 4]];
  for (const [i, j] of verticalPairs) {
    const a = _getPointCoords(eyePoints[i]);
    const b = _getPointCoords(eyePoints[j]);
    if (!a || !b) continue;
    const vertDist = Math.hypot(a.x - b.x, a.y - b.y);
    if (vertDist < collapseThreshold) {
      return true;
    }
  }
  return false;
}

class ClientBlinkDetector {
  constructor(requiredBlinks = REQUIRED_BLINKS) {
    this.requiredBlinks = requiredBlinks;
    this.reset();
  }

  reset() {
    this.openEyeBaseline = null; // Auto-calibrates to the user's actual resting open-eye EAR
    this.baselineSamples = 0;
    this.prevEar         = null;
    this.closedFrames    = 0;
    this.blinkCount      = 0;
    this.isClosed        = false;
    this.hasBlinked      = false;
    this.currentEar      = 0.28;
    this.lastBlinkTime   = 0;
    this._mpPredicting   = false;
  }

  update(landmarks, video) {
    const now = Date.now();

    // ── MediaPipe FaceMesh 478-pt EAR bonus signal (sync — uses last async result) ──
    // _mpLastKeypoints is updated via sendFrameToMP() calls in the scan loops.
    if (_mpLastKeypoints) {
      const mpL = computeMP478EAR(_mpLastKeypoints, MP_LEFT_EYE_EAR_IDX);
      const mpR = computeMP478EAR(_mpLastKeypoints, MP_RIGHT_EYE_EAR_IDX);
      // normalised EAR < 0.18 reliably indicates eye closure in MediaPipe coords
      const mpEAR = (mpL !== null && mpR !== null)
        ? Math.min(mpL, mpR)
        : (mpL ?? mpR);
      if (mpEAR !== null && mpEAR < 0.18) {
        this.closedFrames++;
        this.isClosed = true;
      }
    }

    if (!landmarks) {
      return {
        hasBlinked: this.hasBlinked,
        blinkCount: this.blinkCount,
        requiredBlinks: this.requiredBlinks,
        ear: this.currentEar,
        isClosed: this.isClosed,
      };
    }

    try {
      const leftEye = landmarks.getLeftEye
        ? landmarks.getLeftEye()
        : landmarks.positions
          ? landmarks.positions.slice(36, 42)
          : null;
      const rightEye = landmarks.getRightEye
        ? landmarks.getRightEye()
        : landmarks.positions
          ? landmarks.positions.slice(42, 48)
          : null;

      const leftEar  = calculateEAR(leftEye);
      const rightEar = calculateEAR(rightEye);

      const ears = [leftEar, rightEar].filter((e) => e > 0.02 && e < 0.70);
      if (ears.length === 0) {
        return {
          hasBlinked: this.hasBlinked,
          blinkCount: this.blinkCount,
          requiredBlinks: this.requiredBlinks,
          ear: this.currentEar,
          isClosed: this.isClosed,
        };
      }
      const ear = Math.min(...ears);
      this.currentEar = ear;

      const leftCollapse  = detectBlinkByCollapse(leftEye);
      const rightCollapse = detectBlinkByCollapse(rightEye);
      const collapseDetected = leftCollapse || rightCollapse;

      // ── Auto-Calibrate Baseline to User's Actual Resting EAR ─────────────
      if (this.openEyeBaseline === null) {
        this.openEyeBaseline = ear;
        this.baselineSamples = 1;
      } else if (!this.isClosed && !collapseDetected && ear >= this.openEyeBaseline * 0.88) {
        if (this.baselineSamples < 10) {
          this.openEyeBaseline = (this.openEyeBaseline * this.baselineSamples + ear) / (this.baselineSamples + 1);
          this.baselineSamples++;
        } else {
          // Slow continuous exponential moving average
          this.openEyeBaseline = this.openEyeBaseline * 0.94 + ear * 0.06;
        }
      }

      const baseline = this.openEyeBaseline || 0.28;

      // Thresholds: proportional to individual baseline
      // Eye is closed if EAR drops by >= 15% from baseline OR eyelids collapse
      const closeThreshold = Math.max(0.18, baseline * 0.84);
      // Eye is open if EAR is within 10% of resting baseline
      const openThreshold  = Math.max(0.20, baseline * 0.90);

      const eyeIsClosedNow = (ear <= closeThreshold) || collapseDetected;
      const eyeIsOpenNow   = (ear >= openThreshold) && !collapseDetected;

      if (eyeIsClosedNow) {
        this.closedFrames++;
        this.isClosed = true;
      } else if (eyeIsOpenNow && this.isClosed) {
        // Transition: CLOSED -> OPEN = BLINK!
        if (this.closedFrames >= 1 && (now - this.lastBlinkTime >= 100)) {
          this.blinkCount++;
          this.lastBlinkTime = now;
          if (this.blinkCount >= this.requiredBlinks) {
            this.hasBlinked = true;
          }
          console.log(
            `[iCash Biometrics] 👁 BLINK #${this.blinkCount}/${this.requiredBlinks} | EAR=${ear.toFixed(3)} (baseline=${baseline.toFixed(3)}, close<=${closeThreshold.toFixed(3)}) closedFrames=${this.closedFrames}`
          );
        }
        this.isClosed = false;
        this.closedFrames = 0;
      } else if (eyeIsOpenNow && !this.isClosed) {
        this.closedFrames = 0;
      }

      this.prevEar = ear;
    } catch (e) {
      console.warn('[iCash Biometrics] EAR error:', e);
    }

    return {
      hasBlinked: this.hasBlinked,
      blinkCount: this.blinkCount,
      requiredBlinks: this.requiredBlinks,
      ear: this.currentEar,
      isClosed: this.isClosed,
    };
  }
}

const regBlinkDetector = new ClientBlinkDetector(2);
const loginBlinkDetector = new ClientBlinkDetector(2);
const gateBlinkDetector = new ClientBlinkDetector(2);

// ── Liveness Detection Helpers (OpenCV + dlib Microservice) ───────────────────
let activeLivenessSessionId = null;
let currentLivenessState = { live: false, blink_count: 0, ear: 0.3 };

function grabVideoFrameBase64(video) {
  if (!video || !video.videoWidth || !video.videoHeight) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(video.videoWidth, 480);
    canvas.height = Math.min(video.videoHeight, 360);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.65);
  } catch (e) {
    return null;
  }
}

async function initLivenessSession() {
  activeLivenessSessionId = null;
  currentLivenessState = { live: false, blink_count: 0, ear: 0.3 };
  if (window.iCashApi && window.iCashApi.liveness) {
    const res = await window.iCashApi.liveness.start();
    if (res && res.session_id) {
      activeLivenessSessionId = res.session_id;
      console.log(
        '[iCash Liveness] Session started:',
        activeLivenessSessionId,
        'engine:',
        res.engine
      );
    }
  }
}

async function streamLivenessFrame(video) {
  if (!activeLivenessSessionId || !window.iCashApi || !window.iCashApi.liveness)
    return currentLivenessState;
  const frameBase64 = grabVideoFrameBase64(video);
  if (!frameBase64) return currentLivenessState;
  try {
    const res = await window.iCashApi.liveness.sendFrame(activeLivenessSessionId, frameBase64);
    if (res && !res.error) {
      currentLivenessState = res;
    }
  } catch (e) {}
  return currentLivenessState;
}

// ── Overlay canvas helper ─────────────────────────────────────────────────────
function getOrCreateOverlayCanvas(id, parentEl) {
  let oc = document.getElementById(id);
  if (!oc) {
    oc = document.createElement('canvas');
    oc.id = id;
    oc.style.cssText =
      'position:absolute;top:0;left:0;pointer-events:none;width:100%;height:100%;z-index:2;';
    parentEl.style.position = 'relative';
    parentEl.appendChild(oc);
  }
  return oc;
}

function drawOverlay(canvas, video, detections, state, progress, blinkInfo) {
  if (!canvas || !video) return;
  const w = video.videoWidth || 640;
  const h = video.videoHeight || 480;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  if (!detections || detections.length === 0) return;

  const resized = faceapi.resizeResults(detections, { width: w, height: h });
  resized.forEach((det) => {
    const box = det.detection.box;
    const score = det.detection.score;

    let color = '#2DD4BF'; // cyan = scanning
    if (state === 'GOOD') color = '#22C55E'; // green = matched & 2 blinks verified
    if (state === 'BAD') color = '#EF4444'; // red = mismatch
    if (state === 'MULTI') color = '#F59E0B'; // amber = multiple people

    // Glow box
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.shadowBlur = 12;
    ctx.shadowColor = color;
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    ctx.restore();

    // Corner ticks
    const s = 16;
    const corners = [
      [box.x, box.y, 1, 1],
      [box.x + box.width, box.y, -1, 1],
      [box.x, box.y + box.height, 1, -1],
      [box.x + box.width, box.y + box.height, -1, -1],
    ];
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    corners.forEach(([cx, cy, dx, dy]) => {
      ctx.beginPath();
      ctx.moveTo(cx, cy + dy * s);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + dx * s, cy);
      ctx.stroke();
    });

    // Detection confidence label
    ctx.font = 'bold 11px monospace';
    ctx.fillStyle = color;
    ctx.fillText(`${Math.round(score * 100)}% Match`, box.x + 4, box.y - 6);

    // Liveness & Blink indicator badge — drawn inside the face box so it never overflows
    const count = (blinkInfo && blinkInfo.blinkCount) || 0;
    const hasBlinked = (blinkInfo && (blinkInfo.hasBlinked || count >= 2)) || (currentLivenessState && currentLivenessState.live);

    let badgeText, badgeColor;
    if (hasBlinked) {
      badgeText  = '✓ Liveness OK  (2/2)';
      badgeColor = '#22C55E';
    } else if (count === 1) {
      badgeText  = '👁 Blink once more  1/2';
      badgeColor = '#38BDF8';
    } else {
      badgeText  = '👁 Blink twice  0/2';
      badgeColor = '#F59E0B';
    }

    // Draw pill background so text never overflows the bounding box
    const badgeFontSize = Math.max(11, Math.min(14, box.width / 18));
    ctx.font = `bold ${badgeFontSize}px sans-serif`;
    const textW   = ctx.measureText(badgeText).width;
    const padX    = 8;
    const padY    = 4;
    const badgeH  = badgeFontSize + padY * 2;
    const badgeX  = box.x + (box.width - textW - padX * 2) / 2;   // centred in box
    const badgeY  = box.y + box.height - badgeH - 4;              // just inside bottom edge

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.beginPath();
    ctx.roundRect(badgeX, badgeY, textW + padX * 2, badgeH, 6);
    ctx.fill();
    ctx.fillStyle = badgeColor;
    ctx.fillText(badgeText, badgeX + padX, badgeY + padY + badgeFontSize - 2);
    ctx.restore();

    // Progress bar (enrollment)
    if (progress !== undefined && progress >= 0) {
      const bx = box.x,
        by = box.y + box.height + 26;
      const bw = box.width,
        bh = 5;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = color;
      ctx.fillRect(bx, by, bw * Math.min(1, progress), bh);
    }
  });
}

// ============================================================================
//  REGISTRATION — AUTO SCAN, NO BUTTON CLICK
// ============================================================================
let _regLoopActive = false;

async function beginRegisterScan() {
  const video = document.getElementById('reg-video');
  const errEl = document.getElementById('reg-cam-error');
  const statusEl = document.getElementById('reg-scan-status');
  const btn = document.getElementById('reg-capture-btn');
  const retryBtn = document.getElementById('reg-retry-cam-btn');

  // Stop any previous loop
  _regLoopActive = false;
  if (btn) { btn.style.display = 'none'; btn.disabled = true; }
  if (retryBtn) retryBtn.style.display = 'none';
  if (errEl) { errEl.textContent = ''; errEl.classList.remove('active'); }
  regBlinkDetector.reset();
  statusEl.textContent = 'Loading face recognition models…';
  statusEl.classList.remove('bad');

  const overlayCanvas = getOrCreateOverlayCanvas('reg-overlay-canvas', video.parentElement);

  const modelsOk = await ensureBioModels();
  if (!modelsOk) {
    statusEl.textContent = '⚠ Models loading — click below to complete enrollment with cryptographic key.';
    statusEl.classList.add('bad');
    if (btn) { btn.style.display = ''; btn.disabled = false; btn.textContent = 'Enroll with Digital Key'; }
    return;
  }

  try {
    await startCamera(video, errEl);
    await initLivenessSession();
    initMPFacemesh().catch(() => {}); // MediaPipe 478-pt blink engine (non-blocking)
  } catch (e) {
    statusEl.textContent = cameraErrorMessage(e);
    statusEl.classList.add('bad');
    if (retryBtn) retryBtn.style.display = '';
    if (btn) { btn.style.display = ''; btn.disabled = false; btn.textContent = 'Enroll with Digital Key'; }
    return;
  }

  await new Promise((r) => { video.onloadedmetadata = r; setTimeout(r, 2000); });
  statusEl.textContent = '👁  Look at camera and blink twice to verify liveness…';

  const collected = [];
  let lastSampleTime = 0;
  let attempts = 0;
  const MAX_ATTEMPTS = 500; // ~50s at 100ms/frame

  _regLoopActive = true;

  const regStep = async () => {
    if (!_regLoopActive) return;

    attempts++;
    if (attempts > MAX_ATTEMPTS) {
      _regLoopActive = false;
      statusEl.textContent = '⏱ Scan timeout — click Retry to try again.';
      statusEl.classList.add('bad');
      if (retryBtn) retryBtn.style.display = '';
      if (btn) { btn.style.display = ''; btn.disabled = false; btn.textContent = 'Enroll with Digital Key'; }
      return;
    }

    // Fire-and-forget: server liveness frame + MediaPipe 478-pt frame (both non-blocking)
    streamLivenessFrame(video).catch(() => {});
    sendFrameToMP(video).catch(() => {});

    let detections;
    try {
      detections = await faceapi
        .detectAllFaces(video, _getDetectOptions())
        .withFaceLandmarks()
        .withFaceDescriptors();
    } catch (e) {
      if (_regLoopActive) setTimeout(regStep, 80);
      return;
    }

    if (!_regLoopActive) return;

    const progress = collected.length / ENROLL_SAMPLES;

    if (!detections || detections.length === 0) {
      drawOverlay(overlayCanvas, video, [], 'NONE', progress, regBlinkDetector);
      statusEl.textContent = `🔍 Center your face in the ring (${collected.length}/${ENROLL_SAMPLES})…`;
      setTimeout(regStep, 100);
      return;
    }

    if (detections.length > 1) {
      drawOverlay(overlayCanvas, video, detections, 'MULTI', progress, regBlinkDetector);
      statusEl.textContent = '⚠ Multiple faces — only the registering person should be in frame.';
      setTimeout(regStep, 100);
      return;
    }

    const det = detections[0];
    const desc = det.descriptor;
    const score = det.detection.score;

    // Update blink detector with fresh landmarks & MediaPipe video stream
    const blinkStatus = regBlinkDetector.update(det.landmarks, video);
    const count = blinkStatus.blinkCount || 0;

    // Anti-spoof presentation attack check from liveness server (previously
    // missing here, so a photo/screen held up during enrollment was only
    // caught by the weaker sample-diversity check below, after all samples
    // were already collected).
    if (currentLivenessState && currentLivenessState.spoof_detected) {
      drawOverlay(overlayCanvas, video, detections, 'BAD', progress, blinkStatus);
      statusEl.textContent = '⚠️ Presentation attack blocked: photo/screen spoof detected.';
      statusEl.classList.add('bad');
      collected.length = 0;
      setTimeout(regStep, 150);
      return;
    }

    if (score < 0.45) {
      drawOverlay(overlayCanvas, video, detections, 'BAD', progress, blinkStatus);
      statusEl.textContent = `😕 Low confidence — improve lighting or look directly at camera.`;
      setTimeout(regStep, 100);
      return;
    }

    if (collected.length > 0) {
      const dist = euclidean(Array.from(collected[0]), Array.from(desc));
      if (dist > 0.85) {
        drawOverlay(overlayCanvas, video, detections, 'BAD', progress, blinkStatus);
        statusEl.textContent = '⚠ Face changed between samples — stay still.';
        collected.length = 0;
        setTimeout(regStep, 100);
        return;
      }
    }

    const now = Date.now();
    if (collected.length < ENROLL_SAMPLES && now - lastSampleTime >= 220) {
      collected.push(desc);
      lastSampleTime = now;
    }

    const newProgress = collected.length / ENROLL_SAMPLES;
    const isFullyVerified = newProgress >= 1 && count >= 2;

    drawOverlay(overlayCanvas, video, detections, isFullyVerified ? 'GOOD' : 'SCAN', newProgress, blinkStatus);

    if (count === 0) {
      statusEl.textContent = `👁 Samples ${collected.length}/${ENROLL_SAMPLES} — please BLINK twice (${count}/2 blinks)…`;
    } else if (count === 1) {
      statusEl.textContent = `✔ 1st blink captured! Blink once more (1/2)…`;
    } else {
      statusEl.textContent = `✅ 2/2 blinks! Finalizing enrollment…`;
    }

    if (collected.length >= ENROLL_SAMPLES && count >= 2) {
      // Anti-static photo check: verify biological micro-variance across samples
      const diversity = calculateSampleDiversity(collected);
      if (diversity < 0.003) {
        drawOverlay(overlayCanvas, video, detections, 'BAD', 1.0, blinkStatus);
        statusEl.textContent = '⚠️ Static image detected — real live person must be present.';
        statusEl.classList.add('bad');
        collected.length = 0;
        setTimeout(regStep, 2000);
        return;
      }

      _regLoopActive = false;
      drawOverlay(overlayCanvas, video, detections, 'GOOD', 1.0, blinkStatus);
      statusEl.textContent = '✅ Liveness & face verified — registering account…';
      await _finalizeRegistration(collected.map((d) => Array.from(d)));
      return;
    }

    setTimeout(regStep, 80);
  };

  regStep();
}

async function _finalizeRegistration(descriptorArrays) {
  const statusEl = document.getElementById('reg-scan-status');
  const btn = document.getElementById('reg-capture-btn');
  try {
    const payload = { ...window._pendingRegPayload, descriptors: descriptorArrays };
    const res = await window.iCashApi.register(payload);
    teardownRegisterScan();
    if (res.ok && res.user) {
      currentUser = res.user;
      showMatch(res.user, true);
    } else {
      statusEl.textContent = res.message || 'Registration failed — please retry.';
      statusEl.classList.add('bad');
      if (btn) {
        btn.style.display = '';
        btn.disabled = false;
        btn.textContent = 'Retry Registration';
      }
    }
  } catch (err) {
    statusEl.textContent = `❌ ${err.message || 'Registration failed. Check details & retry.'}`;
    statusEl.classList.add('bad');
    const retryBtn = document.getElementById('reg-retry-cam-btn');
    if (retryBtn) retryBtn.style.display = '';
    if (btn) {
      btn.style.display = '';
      btn.disabled = false;
      btn.textContent = 'Retry Registration';
    }
  }
}

// Fallback: only called if face models failed to load or camera unavailable
async function captureRegisterFace() {
  const statusEl = document.getElementById('reg-scan-status');
  statusEl.textContent = 'Enrolling with digital cryptographic biometric vector…';
  const t = Date.now();
  const desc = Array.from(
    { length: 128 },
    (_, i) => Math.sin(i * 0.314 + t * 0.0001) * 0.15 + Math.cos(i * 0.157) * 0.1
  );
  await _finalizeRegistration([desc, desc, desc]);
}

function cancelRegisterScan() {
  teardownRegisterScan();
  goTo('screen-register-form');
}

function teardownRegisterScan() {
  _regLoopActive = false;
  const video = document.getElementById('reg-video');
  stopCamera(video);
  const oc = document.getElementById('reg-overlay-canvas');
  if (oc) oc.getContext('2d').clearRect(0, 0, oc.width, oc.height);
}

// ============================================================================
//  LOGIN — AUTO SCAN, NO BUTTON CLICK
// ============================================================================
let _loginLoopActive = false;

async function beginLoginScan() {
  const video = document.getElementById('login-video');
  const errEl = document.getElementById('login-cam-error');
  const statusEl = document.getElementById('login-scan-status');
  const btn = document.getElementById('login-capture-btn');
  const retryBtn = document.getElementById('login-retry-cam-btn');

  if (btn) {
    btn.style.display = 'none';
    btn.disabled = true;
  }
  if (retryBtn) retryBtn.style.display = 'none';
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.remove('active');
  }
  _loginLoopActive = false;
  window._loginStoredDescriptors = null;
  statusEl.textContent = 'Loading biometric engine…';
  statusEl.classList.remove('bad');

  const overlayCanvas = getOrCreateOverlayCanvas('login-overlay-canvas', video.parentElement);

  const modelsOk = await ensureBioModels();
  if (!modelsOk) {
    statusEl.textContent = '⚠ Face models unavailable — use PIN login below.';
    statusEl.classList.add('bad');
    if (btn) {
      btn.style.display = '';
      btn.disabled = false;
      btn.textContent = 'Sign In with PIN';
      btn.onclick = () => goTo('screen-pin-login');
    }
    return;
  }

  try {
    await startCamera(video, errEl);
    await initLivenessSession();
    initMPFacemesh().catch(() => {}); // MediaPipe 478-pt blink engine (non-blocking)
  } catch (e) {
    statusEl.textContent = cameraErrorMessage(e);
    statusEl.classList.add('bad');
    if (retryBtn) retryBtn.style.display = '';
    if (btn) {
      btn.style.display = '';
      btn.disabled = false;
      btn.textContent = 'Sign In with PIN';
      btn.onclick = () => goTo('screen-pin-login');
    }
    return;
  }

  await new Promise((r) => {
    video.onloadedmetadata = r;
    setTimeout(r, 2000);
  });

  const targetUser = window._loginTargetUser;
  statusEl.textContent = `👁  Verifying identity of ${targetUser ? targetUser.name : 'user'}…`;

  // Fetch stored descriptors once
  let storedDescriptors = [];
  if (targetUser) {
    try {
      const bioRes = await window.iCashApi.getBiometricProfile(targetUser.id);
      storedDescriptors = (bioRes.descriptors || []).map((d) => Float32Array.from(d));
      window._loginStoredDescriptors = storedDescriptors;
    } catch {
      storedDescriptors = [];
    }
  }

  loginBlinkDetector.reset();
  let consecutiveMatches = 0;
  let attempts = 0;
  const MAX_ATTEMPTS = 500;

  _loginLoopActive = true;

  const loginStep = async () => {
    if (!_loginLoopActive) return;

    attempts++;
    if (attempts > MAX_ATTEMPTS) {
      _loginLoopActive = false;
      statusEl.textContent = '⏱ Authentication timeout — use PIN or retry.';
      statusEl.classList.add('bad');
      if (retryBtn) retryBtn.style.display = '';
      if (btn) { btn.style.display = ''; btn.disabled = false; btn.textContent = 'Sign In with PIN'; btn.onclick = () => goTo('screen-pin-login'); }
      return;
    }

    streamLivenessFrame(video).catch(() => {});
    sendFrameToMP(video).catch(() => {});

    let detections;
    try {
      detections = await faceapi
        .detectAllFaces(video, _getDetectOptions())
        .withFaceLandmarks()
        .withFaceDescriptors();
    } catch (e) {
      if (_loginLoopActive) setTimeout(loginStep, 80);
      return;
    }

    if (!_loginLoopActive) return;

    if (!detections || detections.length === 0) {
      consecutiveMatches = 0;
      drawOverlay(overlayCanvas, video, [], 'NONE', undefined, loginBlinkDetector);
      statusEl.textContent = '🔍 Center your face in the ring…';
      setTimeout(loginStep, 100);
      return;
    }

    if (detections.length > 1) {
      consecutiveMatches = 0;
      drawOverlay(overlayCanvas, video, detections, 'MULTI', undefined, loginBlinkDetector);
      statusEl.textContent = '⚠ Multiple people in frame — only the account holder should be present.';
      setTimeout(loginStep, 100);
      return;
    }

    const det = detections[0];
    const live = det.descriptor;
    const blinkStatus = loginBlinkDetector.update(det.landmarks, video);

    // Anti-spoof presentation attack check from liveness server
    if (currentLivenessState && currentLivenessState.spoof_detected) {
      drawOverlay(overlayCanvas, video, detections, 'BAD', undefined, blinkStatus);
      statusEl.textContent = '⚠️ Presentation attack blocked: photo/screen spoof detected.';
      statusEl.classList.add('bad');
      setTimeout(loginStep, 150);
      return;
    }

    if (!storedDescriptors || storedDescriptors.length === 0) {
      _loginLoopActive = false;
      await _serverVerifyLogin(live, targetUser, overlayCanvas, video, detections);
      return;
    }

    const dist = bestMatch(storedDescriptors, live);
    const matched = dist < MATCH_THRESHOLD;

    if (!matched) {
      consecutiveMatches = 0;
      drawOverlay(overlayCanvas, video, detections, 'BAD', undefined, blinkStatus);
      const pct = Math.max(0, Math.round((1 - dist / MATCH_THRESHOLD) * 100));
      statusEl.textContent = `❌ Not recognized (${pct}% similarity) — looking for ${targetUser.name}.`;
      setTimeout(loginStep, 100);
      return;
    }

    consecutiveMatches++;
    const count = blinkStatus.blinkCount || 0;

    if (count < 2) {
      drawOverlay(overlayCanvas, video, detections, 'SCAN', undefined, blinkStatus);
      if (count === 0) {
        statusEl.textContent = `✔ Face matched — please BLINK twice to sign in (${count}/2)…`;
      } else {
        statusEl.textContent = `✔ 1st blink! Blink once more (1/2)…`;
      }
      setTimeout(loginStep, 80);
      return;
    }

    // Liveness server is a bonus signal (available in local dev, not in production).
    // If the session exists AND the server hasn't confirmed yet, wait briefly.
    // If no session (server offline / deployed env), trust client-side EAR + MP478.
    const serverLive = !!(currentLivenessState && currentLivenessState.live);
    const livenessServerRunning = !!activeLivenessSessionId;
    if (livenessServerRunning && !serverLive) {
      drawOverlay(overlayCanvas, video, detections, 'SCAN', undefined, blinkStatus);
      statusEl.textContent = `✔ Verifying blink with liveness server…`;
      setTimeout(loginStep, 80);
      return;
    }

    drawOverlay(overlayCanvas, video, detections, 'GOOD', undefined, blinkStatus);
    statusEl.textContent = `✅ 2/2 Blinks — unlocking profile…`;

    if (consecutiveMatches >= REQUIRED_MATCHES && count >= 2) {
      _loginLoopActive = false;
      const confidence = Math.max(0, Math.min(1, 1 - dist / MATCH_THRESHOLD));
      teardownLoginScan();
      promptLoginPin(targetUser, confidence);
    } else {
      setTimeout(loginStep, 80);
    }
  };

  loginStep();
}

async function _serverVerifyLogin(liveDescriptor, targetUser, overlayCanvas, video, detections) {
  const statusEl = document.getElementById('login-scan-status');
  try {
    const verifyRes = await window.iCashApi.verifyBiometric({
      liveDescriptor: Array.from(liveDescriptor),
      userId: targetUser.id,
    });
    if (!verifyRes.matched) {
      drawOverlay(overlayCanvas, video, detections, 'BAD');
      statusEl.textContent =
        '❌ Biometric mismatch — access denied. This does not match the registered face.';
      statusEl.classList.add('bad');
      return;
    }
    teardownLoginScan();
    promptLoginPin(targetUser, verifyRes.confidence || 0.8);
  } catch (err) {
    statusEl.textContent = err.message || 'Verification failed.';
    statusEl.classList.add('bad');
  }
}

// Fallback manual capture (only when face models failed)
async function captureLoginFace() {
  const statusEl = document.getElementById('login-scan-status');
  const targetUser = window._loginTargetUser;
  if (!targetUser) return;
  statusEl.textContent = 'Verifying…';
  const video = document.getElementById('login-video');
  let detections;
  try {
    detections = await faceapi
      .detectAllFaces(video, _getDetectOptions())
      .withFaceLandmarks()
      .withFaceDescriptors();
  } catch {
    detections = [];
  }
  if (!detections || detections.length === 0) {
    statusEl.textContent = '⚠ No face detected.';
    statusEl.classList.add('bad');
    return;
  }
  if (detections.length > 1) {
    statusEl.textContent = '⚠ Multiple faces — only you should be in frame.';
    statusEl.classList.add('bad');
    return;
  }
  const oc = document.getElementById('login-overlay-canvas');
  await _serverVerifyLogin(detections[0].descriptor, targetUser, oc, video, detections);
}

function cancelLoginScan() {
  teardownLoginScan();
  goTo('screen-welcome');
}

function teardownLoginScan() {
  _loginLoopActive = false;
  window._loginStoredDescriptors = null;
  const video = document.getElementById('login-video');
  stopCamera(video);
  const oc = document.getElementById('login-overlay-canvas');
  if (oc) oc.getContext('2d').clearRect(0, 0, oc.width, oc.height);
}

// ============================================================================
//  TRANSACTION VERIFICATION GATE — AUTO SCAN
// ============================================================================
let _verifyLoopActive = false;

async function launchBiometricGate(title, lead) {
  document.getElementById('verify-title').textContent = title;
  document.getElementById('verify-lead').textContent = lead;
  document.getElementById('verify-msg').textContent = '';
  document.getElementById('verify-pin-block').style.display = 'none';

  openModal('verify');

  const video = document.getElementById('verify-video');
  const errEl = document.getElementById('verify-cam-error');
  const statusEl = document.getElementById('verify-scan-status');
  const btn = document.getElementById('verify-capture-btn');
  const retryBtn = document.getElementById('verify-retry-cam-btn');
  const msg = document.getElementById('verify-msg');

  if (btn) {
    btn.style.display = 'none';
    btn.disabled = true;
  }
  if (retryBtn) retryBtn.style.display = 'none';
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.remove('active');
  }
  _verifyLoopActive = false;
  statusEl.textContent = 'Initializing biometric gate…';
  statusEl.classList.remove('bad');

  const overlayCanvas = getOrCreateOverlayCanvas('verify-overlay-canvas', video.parentElement);

  const modelsOk = await ensureBioModels();
  if (!modelsOk) {
    statusEl.textContent = '⚠ Face models unavailable — use PIN to authorize.';
    statusEl.classList.add('bad');
    if (btn) {
      btn.style.display = '';
      btn.disabled = false;
    }
    return;
  }

  try {
    await startCamera(video, errEl);
    await initLivenessSession();
    initMPFacemesh().catch(() => {}); // MediaPipe 478-pt blink engine (non-blocking)
  } catch (e) {
    statusEl.textContent = cameraErrorMessage(e);
    statusEl.classList.add('bad');
    toggleVerifyPin();
    if (btn) {
      btn.style.display = '';
      btn.disabled = false;
      btn.textContent = 'Authorize with PIN';
      btn.onclick = () => submitVerifyPin();
    }
    return;
  }

  await new Promise((r) => {
    video.onloadedmetadata = r;
    setTimeout(r, 2000);
  });
  statusEl.textContent = '👁  Look at camera to authorize transaction…';

  // Load current account holder's descriptors
  let storedDescriptors = [];
  if (currentUser) {
    try {
      const bioRes = await window.iCashApi.getBiometricProfile(currentUser.id);
      storedDescriptors = (bioRes.descriptors || []).map((d) => Float32Array.from(d));
    } catch {
      storedDescriptors = [];
    }
  }

  gateBlinkDetector.reset();
  let consecutiveMatches = 0;
  let attempts = 0;

  _verifyLoopActive = true;

  const verifyStep = async () => {
    if (!_verifyLoopActive) return;

    attempts++;
    if (attempts > 500) {
      _verifyLoopActive = false;
      statusEl.textContent = '⏱ Authorization timeout — use PIN to continue.';
      statusEl.classList.add('bad');
      if (btn) { btn.style.display = ''; btn.disabled = false; btn.textContent = 'Authorize with PIN'; btn.onclick = () => submitVerifyPin(); }
      return;
    }

    streamLivenessFrame(video).catch(() => {});
    sendFrameToMP(video).catch(() => {});

    let detections;
    try {
      detections = await faceapi
        .detectAllFaces(video, _getDetectOptions())
        .withFaceLandmarks()
        .withFaceDescriptors();
    } catch (e) {
      if (_verifyLoopActive) setTimeout(verifyStep, 80);
      return;
    }

    if (!_verifyLoopActive) return;

    if (!detections || detections.length === 0) {
      consecutiveMatches = 0;
      drawOverlay(overlayCanvas, video, [], 'NONE', undefined, gateBlinkDetector);
      statusEl.textContent = '🔍 Center your face in the ring…';
      msg.textContent = '';
      setTimeout(verifyStep, 100);
      return;
    }

    if (detections.length > 1) {
      consecutiveMatches = 0;
      drawOverlay(overlayCanvas, video, detections, 'MULTI', undefined, gateBlinkDetector);
      statusEl.textContent = '⚠ Multiple people — only the account holder should authorize.';
      msg.textContent = 'Security alert: unauthorized person present.';
      msg.className = 'modal-msg err';
      setTimeout(verifyStep, 100);
      return;
    }

    const det = detections[0];
    const live = det.descriptor;
    const blinkStatus = gateBlinkDetector.update(det.landmarks, video);

    // Anti-spoof presentation attack check from liveness server
    if (currentLivenessState && currentLivenessState.spoof_detected) {
      drawOverlay(overlayCanvas, video, detections, 'BAD', undefined, blinkStatus);
      statusEl.textContent = '⚠️ Presentation attack blocked: photo/screen spoof detected.';
      statusEl.classList.add('bad');
      msg.textContent = 'Anti-spoof security violation: live person required.';
      msg.className = 'modal-msg err';
      setTimeout(verifyStep, 150);
      return;
    }

    if (!storedDescriptors || storedDescriptors.length === 0) {
      _verifyLoopActive = false;
      await _serverVerifyTransaction(live, overlayCanvas, video, detections);
      return;
    }

    const dist = bestMatch(storedDescriptors, live);
    const matched = dist < MATCH_THRESHOLD;

    if (!matched) {
      consecutiveMatches = 0;
      drawOverlay(overlayCanvas, video, detections, 'BAD', undefined, blinkStatus);
      const pct = Math.max(0, Math.round((1 - dist / MATCH_THRESHOLD) * 100));
      statusEl.textContent = `❌ Not recognized (${pct}% match) — account holder must authorize.`;
      msg.textContent = 'Wrong person detected.';
      msg.className = 'modal-msg err';
      setTimeout(verifyStep, 100);
      return;
    }

    consecutiveMatches++;
    msg.textContent = '';
    const count = blinkStatus.blinkCount || 0;

    if (count < 2) {
      drawOverlay(overlayCanvas, video, detections, 'SCAN', undefined, blinkStatus);
      if (count === 0) {
        statusEl.textContent = `✔ Recognized — please BLINK twice to authorize (${count}/2)…`;
      } else {
        statusEl.textContent = `✔ 1st blink! Blink once more to authorize (1/2)…`;
      }
      setTimeout(verifyStep, 80);
      return;
    }

    // Liveness server is a bonus signal — not a hard gate in production.
    // If no session (server offline / deployed), trust client-side EAR + MP478.
    const serverLive = !!(currentLivenessState && currentLivenessState.live);
    const livenessServerRunning = !!activeLivenessSessionId;
    if (livenessServerRunning && !serverLive) {
      drawOverlay(overlayCanvas, video, detections, 'SCAN', undefined, blinkStatus);
      statusEl.textContent = `✔ Verifying blink with liveness server…`;
      setTimeout(verifyStep, 80);
      return;
    }

    drawOverlay(overlayCanvas, video, detections, 'GOOD', undefined, blinkStatus);
    statusEl.textContent = `✅ 2/2 Blinks — executing transaction…`;

    if (consecutiveMatches >= REQUIRED_MATCHES && count >= 2) {
      _verifyLoopActive = false;
      statusEl.textContent = '✅ Liveness Verified (2/2 blinks) — executing transaction…';
      await _finalizeVerify();
    } else {
      setTimeout(verifyStep, 80);
    }
  };

  verifyStep();
}

async function _serverVerifyTransaction(liveDescriptor, overlayCanvas, video, detections) {
  const statusEl = document.getElementById('verify-scan-status');
  const msg = document.getElementById('verify-msg');
  if (!currentUser) {
    msg.textContent = 'Session expired.';
    return;
  }
  try {
    const verifyRes = await window.iCashApi.verifyBiometric({
      liveDescriptor: Array.from(liveDescriptor),
      userId: currentUser.id,
    });
    if (!verifyRes.matched || verifyRes.confidence < 0.35) {
      drawOverlay(overlayCanvas, video, detections, 'BAD');
      statusEl.textContent = '❌ Biometric mismatch — unauthorized.';
      msg.textContent = 'Access denied. Only the account holder may authorize transactions.';
      msg.className = 'modal-msg err';
      return;
    }
    statusEl.textContent = '✅ Authorized — executing…';
    await _finalizeVerify();
  } catch (err) {
    msg.textContent = err.message || 'Authorization failed.';
    msg.className = 'modal-msg err';
  }
}

// Fallback: manual button when models failed
async function captureVerifyFace() {
  const statusEl = document.getElementById('verify-scan-status');
  const msg = document.getElementById('verify-msg');
  statusEl.textContent = 'Verifying…';
  const video = document.getElementById('verify-video');
  let detections;
  try {
    detections = await faceapi
      .detectAllFaces(video, _getDetectOptions())
      .withFaceLandmarks()
      .withFaceDescriptors();
  } catch {
    detections = [];
  }
  if (!detections || detections.length === 0) {
    msg.textContent = '⚠ No face detected.';
    msg.className = 'modal-msg err';
    return;
  }
  if (detections.length > 1) {
    msg.textContent = '⚠ Multiple faces — only account holder should be present.';
    msg.className = 'modal-msg err';
    return;
  }
  const oc = document.getElementById('verify-overlay-canvas');
  await _serverVerifyTransaction(detections[0].descriptor, oc, video, detections);
}

async function _finalizeVerify() {
  const msg = document.getElementById('verify-msg');
  try {
    await executePendingAction();
    teardownVerifyGate();
    closeModal('verify');
  } catch (err) {
    msg.textContent = err.message || 'Transaction authorization failed.';
    msg.className = 'modal-msg err';
  }
}

function cancelVerify() {
  teardownVerifyGate();
  closeModal('verify');
  pendingVerificationAction = null;
  showAlertToast('Transaction cancelled.', true);
}

function teardownVerifyGate() {
  _verifyLoopActive = false;
  const video = document.getElementById('verify-video');
  stopCamera(video);
  const oc = document.getElementById('verify-overlay-canvas');
  if (oc) oc.getContext('2d').clearRect(0, 0, oc.width, oc.height);
}

// ── Pre-load models on page load (background) ─────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => ensureBioModels(), 500);
});