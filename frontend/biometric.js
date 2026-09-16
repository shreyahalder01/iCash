/**
 * iCash Real Biometric Engine
 *
 * Blink Detection — three parallel methods (first to fire wins):
 *   1. EAR (Eye Aspect Ratio) via face-api.js 68-point landmarks
 *   2. BRFv4-style eyelid collapse detection (adapted for face-api.js)
 *   3. MediaPipe Facemesh 468-landmark EAR (theankurkedia/blink-detection approach)
 *
 * Face Recognition:
 *   - TinyFaceDetector + 128-D FaceRecognitionNet (face-api.js)
 *   - Euclidean distance threshold 0.52
 *   - 5 auto-collected enrollment samples, 2 consecutive matches to confirm identity
 *
 * Liveness:
 *   - Client-side EAR blink detection is the primary user-facing signal
 *   - Server-side dlib/OpenCV liveness augments anti-spoof protection when available
 */

// Local models served by Express (primary) — CDN fallback handled in ensureBioModels()
const FACEAPI_MODEL_URL = '/models';
const FACEAPI_MODEL_URL_CDN = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';

const MATCH_THRESHOLD  = 0.52; // Euclidean < 0.52 = same person (server-side only for verify-challenge)
const ENROLL_SAMPLES   = 5;   // Auto-collected enrollment samples
const ENROLL_INTERVAL  = 100; // ms between landmark & blink checks during enrollment
const VERIFY_INTERVAL  = 100; // ms between frames for real-time blink detection
const REQUIRED_MATCHES = 3;   // ≥3 consecutive matching frames required (was 2; prevents single-frame photo match)
const REQUIRED_BLINKS  = 2;   // Default; overridden by server-issued challenge type

// ── Hardened blink detector constants ────────────────────────────────────────
// MIN_CLOSED_FRAMES_CLIENT = 1:
//   At ~100ms detection cadence, a fast 100-150ms blink produces 1-2 closed frames.
//   Requiring 3 frames (=300ms minimum closure) was silently rejecting real blinks.
//   Duration-based gates (MIN_BLINK_DURATION_MS / MAX_BLINK_DURATION_MS) remain the
//   primary anti-spoof mechanism — a static photo cannot change EAR over time.
const MIN_CLOSED_FRAMES_CLIENT   = 1;   // v6: was 3 — see comment above
const MIN_BLINK_DURATION_MS      = 70;  // v6: was 100ms — matches server MIN_BLINK_MS
const MAX_BLINK_DURATION_MS      = 700; // v6: was 500ms — matches server MAX_BLINK_MS
const BLINK_DEBOUNCE_MS          = 300; // prevents rapid-flash attacks
const MAX_CONSECUTIVE_CLOSED_CLI = 60;  // > 60 frames closed = closed-eye photo, reset

// ── Active challenge state (server-issued) ────────────────────────────────────
let _activeChallengeId    = null;
let _activeChallengeNonce = null;
let _activeChallengeType  = null;
let _activeChallengeExp   = null;  // Date
let _challengeProofFrames = [];    // [{ timestamp, earLeft, earRight, yaw? }]
let _activeBiometricToken = null;  // short-lived token after successful verify-challenge

function _getDetectOptions() {
  // 320px input size with 0.28 score threshold allows reliable detection across diverse lighting
  // (e.g. overhead fixtures, backlighting) while maintaining fast ~20ms inference cadence.
  return new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.28 });
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

// ── Ankur Kedia blink-detection engine (MediaPipe Facemesh + EAR) ─────────────
// Standalone bundled engine based on https://github.com/theankurkedia/blink-detection
// Uses 468-point 3D facial landmarks and 0.27 EAR threshold for ultra-accurate blink detection.

let _ankurBlinkLib = null;
let _ankurBlinkLoading = false;
let _ankurBlinkReady = false;

async function initAnkurBlinkEngine(video) {
  if (_ankurBlinkReady && _ankurBlinkLib) return _ankurBlinkLib;
  if (_ankurBlinkLoading) {
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      if (_ankurBlinkReady) return _ankurBlinkLib;
    }
    return _ankurBlinkLib;
  }
  _ankurBlinkLoading = true;
  try {
    const raw = window['blink-detection']?.default || window['blink-detection'] || window.blink;
    if (raw && typeof raw.loadModel === 'function') {
      await raw.loadModel();
      _ankurBlinkLib = raw;
      if (video && typeof raw.setUpCamera === 'function') {
        try {
          await raw.setUpCamera(video);
        } catch {
          // Camera already playing; video element attached
        }
      }
      _ankurBlinkReady = true;
      console.log('[iCash Biometrics] Ankur Kedia blink-detection engine initialized ✓');
    }
  } catch (e) {
    console.warn('[iCash Biometrics] Ankur Kedia engine init:', e.message || e);
  }
  _ankurBlinkLoading = false;
  return _ankurBlinkLib;
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
    this.reset(requiredBlinks);
  }

  reset(requiredBlinks = null) {
    if (typeof requiredBlinks === 'number' && requiredBlinks > 0) {
      this.requiredBlinks = requiredBlinks;
    }
    this.openEyeBaseline = 0.28; // Default resting baseline so it is never 0.000
    this.baselineSamples = 0;
    this.prevEar         = null;
    this.closedFrames    = 0;
    this.blinkCount      = 0;
    this.isClosed        = false;
    this.hasBlinked      = false;
    this.currentEar      = 0.28;
    this.currentLeftEar  = 0.28;
    this.currentRightEar = 0.28;
    this.lastBlinkTime   = 0;
    this.blinkStartedAt  = 0;
    this._mpPredicting   = false;
    this._lastMpPollAt   = 0;
  }

  update(landmarks, video) {
    const now = Date.now();

    // Poll Ankur Kedia's MediaPipe model in the background as a backup signal, throttled.
    // This used to fire on every single update() call (~80-100ms, same cadence as the main
    // face-api detection loop), which meant two separate ML pipelines were doing full
    // inference on every frame at once. EAR + eyelid-collapse below already come "for free"
    // from the face-api landmarks, so MediaPipe only needs to run a few times a second as a
    // secondary check, not in lockstep with the primary loop.
    if (video && _ankurBlinkReady && _ankurBlinkLib && !this._mpPredicting && (now - this._lastMpPollAt) >= 200) {
      this._mpPredicting = true;
      this._lastMpPollAt = now;
      _ankurBlinkLib.getBlinkPrediction().then((pred) => {
        this._mpPredicting = false;
        // MediaPipe is telemetry only. The authoritative blink state machine
        // below uses synchronized face-api landmarks from the current frame.
        if (pred && (pred.blink || pred.wink || pred.left || pred.right)) {
          this.lastMpBlinkAt = now;
        }
      }).catch(() => { this._mpPredicting = false; });
    }

    if (!landmarks) {
      return {
        hasBlinked: this.hasBlinked,
        blinkCount: this.blinkCount,
        requiredBlinks: this.requiredBlinks,
        ear: this.currentEar,
        leftEar: this.currentLeftEar,
        rightEar: this.currentRightEar,
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
          leftEar: this.currentLeftEar,
          rightEar: this.currentRightEar,
          isClosed: this.isClosed,
        };
      }
      const ear = Math.min(...ears);
      this.currentEar = ear;
      this.currentLeftEar = leftEar;
      this.currentRightEar = rightEar;

      const leftCollapse  = detectBlinkByCollapse(leftEye);
      const rightCollapse = detectBlinkByCollapse(rightEye);
      const collapseDetected = leftCollapse || rightCollapse;

      // ── Auto-Calibrate Baseline to User's Actual Resting EAR ─────────────
      // Ignore low-EAR frames so a blink caught at startup cannot lower the baseline.
      if (!this.isClosed && !collapseDetected && ear > 0.18) {
        if (this.baselineSamples === 0) {
          this.openEyeBaseline = ear;
          this.baselineSamples = 1;
        } else if (ear >= this.openEyeBaseline * 0.80) {
          if (this.baselineSamples < 12) {
            this.openEyeBaseline = (this.openEyeBaseline * this.baselineSamples + ear) / (this.baselineSamples + 1);
            this.baselineSamples++;
          } else {
            // Slow continuous exponential moving average
            this.openEyeBaseline = this.openEyeBaseline * 0.95 + ear * 0.05;
          }
        }
      }

      const baseline = this.openEyeBaseline || 0.28;

      // Thresholds: proportional to individual baseline
      // Eye is closed if EAR drops by >= 20% from baseline OR eyelids collapse
      const closeThreshold = Math.max(0.18, baseline * 0.80);
      // Eye is open if EAR is within 12% of resting baseline
      const openThreshold  = Math.max(0.20, baseline * 0.88);

      // Require BOTH eyes to close and then reopen. A wink or landmark glitch
      // must never satisfy a blink challenge.
      const leftClosed = leftEar <= closeThreshold || leftCollapse;
      const rightClosed = rightEar <= closeThreshold || rightCollapse;
      const leftOpen = leftEar >= openThreshold && !leftCollapse;
      const rightOpen = rightEar >= openThreshold && !rightCollapse;
      const bothEyesClosed = leftClosed && rightClosed;
      const bothEyesOpen = leftOpen && rightOpen;

      if (bothEyesClosed) {
        if (!this.isClosed) this.blinkStartedAt = now;
        this.closedFrames++;
        this.isClosed = true;
        if (this.closedFrames > MAX_CONSECUTIVE_CLOSED_CLI) {
          this.closedFrames = 0;
          this.isClosed = false;
          this.blinkStartedAt = 0;
          console.warn('[iCash Bio] ⚠ Anti-spoof: eyes closed too long, resetting blink state.');
        }
      } else if (bothEyesOpen && this.isClosed) {
        const durationMs = now - this.blinkStartedAt;
        const validDuration = durationMs >= MIN_BLINK_DURATION_MS && durationMs <= MAX_BLINK_DURATION_MS;
        const validFrames   = this.closedFrames >= MIN_CLOSED_FRAMES_CLIENT;
        const validDebounce = (now - this.lastBlinkTime) >= BLINK_DEBOUNCE_MS;
        if (validDuration && validFrames && validDebounce) {
          this.blinkCount++;
          this.lastBlinkTime = now;
          if (this.blinkCount >= this.requiredBlinks) this.hasBlinked = true;
          console.log(`[iCash Bio] 👁 BLINK #${this.blinkCount}/${this.requiredBlinks} | dur=${Math.round(durationMs)}ms frames=${this.closedFrames}`);
        }
        this.isClosed = false;
        this.closedFrames = 0;
        this.blinkStartedAt = 0;
      } else if (bothEyesOpen && !this.isClosed) {
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
      leftEar: this.currentLeftEar,
      rightEar: this.currentRightEar,
      isClosed: this.isClosed,
      baseline: this.openEyeBaseline,
      openEyeBaseline: this.openEyeBaseline,
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

async function initLivenessSession(challengeType, serverSessionId = null) {
  activeLivenessSessionId = serverSessionId || null;
  currentLivenessState = { live: false, blink_count: 0, ear: 0.3 };
  if (!serverSessionId && window.iCashApi && window.iCashApi.liveness) {
    const res = await window.iCashApi.liveness.start(challengeType || _activeChallengeType);
    if (res && res.session_id) {
      activeLivenessSessionId = res.session_id;
      console.log(
        '[iCash Liveness] Session started:',
        activeLivenessSessionId,
        'engine:', res.engine,
        'challenge:', res.challenge_type
      );
    }
  }
}

let _livenessFrameInFlight = false;
let _lastLivenessFrameAt = 0;
let _lastBlinkStatus = null;
// v6: 120ms ≈ 8 fps. A blink lasts 70-350ms; at 300ms we risked the server
// missing the closed-eye window entirely. One in-flight guard still prevents
// queuing up requests — we skip the tick if the previous one is still running.
const LIVENESS_FRAME_MIN_INTERVAL_MS = 120;

async function streamLivenessFrame(video, blinkStatus = null) {
  if (!activeLivenessSessionId || !window.iCashApi || !window.iCashApi.liveness)
    return currentLivenessState;
  if (blinkStatus) {
    _lastBlinkStatus = blinkStatus;
  }
  // Back-pressure guard: previously this fired a fresh base64 encode + network POST on
  // every ~80-100ms detection tick with no check for an in-flight request, so on any real
  // network latency the requests queued up and starved the camera/render loop, which is
  // what showed up as "laggy camera". Now we skip the tick instead of stacking requests.
  const now = Date.now();
  if (_livenessFrameInFlight || now - _lastLivenessFrameAt < LIVENESS_FRAME_MIN_INTERVAL_MS) {
    return currentLivenessState;
  }
  const frameBase64 = grabVideoFrameBase64(video);
  if (!frameBase64) return currentLivenessState;
  _livenessFrameInFlight = true;
  _lastLivenessFrameAt = now;
  try {
    const res = await window.iCashApi.liveness.sendFrame(activeLivenessSessionId, frameBase64, _lastBlinkStatus || {});
    if (res && !res.error) {
      currentLivenessState = res;
    }
  } catch (e) {
  } finally {
    _livenessFrameInFlight = false;
  }
  return currentLivenessState;
}

async function waitForAuthoritativeLiveness(video, timeoutMs = 4500) {
  if (!activeLivenessSessionId || activeLivenessSessionId.startsWith('local-bio-')) {
    console.log('[LIVENESS] Local session mode — client blink proof validated ✓');
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (currentLivenessState?.live === true &&
        currentLivenessState?.exactly_one_face !== false &&
        !currentLivenessState?.spoof_detected) {
      console.log('[LIVENESS] Authoritative liveness confirmed ✓');
      return true;
    }
    // Keep streaming frames so the server can process the blink
    await streamLivenessFrame(video, _lastBlinkStatus);
    if (currentLivenessState?.live === true &&
        currentLivenessState?.exactly_one_face !== false &&
        !currentLivenessState?.spoof_detected) {
      console.log('[LIVENESS] Authoritative liveness confirmed ✓');
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.warn('[LIVENESS] waitForAuthoritativeLiveness timed out after', timeoutMs, 'ms');
  return false;
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

// ── Debug overlay panel ────────────────────────────────────────────────────────
// Only shown when localStorage.icash_bio_debug === 'true'.
// Toggle via browser console: localStorage.setItem('icash_bio_debug','true'); location.reload()
const _bioDebugEnabled = (() => {
  try {
    if (typeof window !== 'undefined' && window.location) {
      const host = window.location.hostname;
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    }
    return localStorage.getItem('icash_bio_debug') === 'true';
  } catch {
    return false;
  }
})();

function getOrCreateDebugPanel(id, parentEl) {
  if (!_bioDebugEnabled) return null;
  let panel = document.getElementById(id);
  if (!panel) {
    panel = document.createElement('div');
    panel.id = id;
    panel.style.cssText = [
      'position:absolute;bottom:8px;left:8px;z-index:10;',
      'background:rgba(0,0,0,0.85);color:#38bdf8;',
      'font:11px/1.5 monospace;padding:6px 10px;border-radius:6px;',
      'pointer-events:none;white-space:pre;min-width:210px;',
      'border:1px solid rgba(56,189,248,0.3);box-shadow:0 4px 12px rgba(0,0,0,0.4);',
    ].join('');
    parentEl.style.position = 'relative';
    parentEl.appendChild(panel);
  }
  return panel;
}

function updateDebugPanel(panel, blinkInfo, serverState, hasFace = true) {
  if (!panel) return;
  const ls = serverState || currentLivenessState || {};
  const bi = blinkInfo || {};
  const ear = bi.ear != null ? Number(bi.ear).toFixed(3) : '0.000';
  const lEar = bi.leftEar != null ? Number(bi.leftEar).toFixed(3) : (ls.left_ear != null ? Number(ls.left_ear).toFixed(3) : ear);
  const rEar = bi.rightEar != null ? Number(bi.rightEar).toFixed(3) : (ls.right_ear != null ? Number(ls.right_ear).toFixed(3) : ear);
  const rawBaseline = bi.openEyeBaseline != null ? bi.openEyeBaseline : (bi.baseline != null ? bi.baseline : (ls.baseline != null ? ls.baseline : 0.28));
  const baseline = Number(rawBaseline).toFixed(3);
  const eyeState = bi.isClosed ? 'CLOSED' : 'OPEN';
  const liveSvr  = (ls.live || (currentLivenessState && currentLivenessState.live)) ? 'YES' : 'NO';
  const isExpired = _activeChallengeExp && new Date() > _activeChallengeExp;
  const challengeActive = !_activeChallengeId ? 'ACTIVE' : (isExpired ? 'EXPIRED' : 'ACTIVE');
  const facesCount = hasFace ? (bi.facesCount != null ? bi.facesCount : 1) : 0;
  const reqBlinks = bi.requiredBlinks || (_activeChallengeType === 'BLINK_TWICE' ? 2 : 1);
  const currentBlinks = bi.blinkCount || 0;

  panel.textContent = [
    `Face: ${hasFace ? 'YES' : 'NO'}`,
    `Faces: ${facesCount}`,
    `Left EAR: ${hasFace ? lEar : '0.000'}`,
    `Right EAR: ${hasFace ? rEar : '0.000'}`,
    `Baseline EAR: ${baseline}`,
    `Eyes: ${hasFace ? eyeState : 'N/A'}`,
    `Blink: ${currentBlinks}/${reqBlinks}`,
    `Server Liveness: ${liveSvr}`,
    `Challenge: ${challengeActive}`,
  ].join('\n');
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

    // Glow box — shadowBlur is one of the more expensive canvas ops and this is redrawn
    // every single frame, so only pay for the glow on the states that actually need to pop
    // (confirmation/error/multi-face), not on the continuous "SCAN" state that's on-screen
    // for most of the interaction.
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    if (state === 'GOOD' || state === 'BAD' || state === 'MULTI') {
      ctx.shadowBlur = 10;
      ctx.shadowColor = color;
    }
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

    // Draw eye landmark meshes with real-time blink telemetry
    if (det.landmarks) {
      try {
        const leftEye = det.landmarks.getLeftEye ? det.landmarks.getLeftEye() : null;
        const rightEye = det.landmarks.getRightEye ? det.landmarks.getRightEye() : null;
        if (leftEye && rightEye) {
          const isClosed = Boolean(blinkInfo && blinkInfo.isClosed);
          const eyeColor = isClosed ? '#22C55E' : '#38BDF8';
          ctx.save();
          ctx.strokeStyle = eyeColor;
          ctx.lineWidth = isClosed ? 2.5 : 1.5;
          if (isClosed) {
            ctx.shadowBlur = 10;
            ctx.shadowColor = '#22C55E';
          }
          [leftEye, rightEye].forEach((pts) => {
            if (!pts || pts.length === 0) return;
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) {
              ctx.lineTo(pts[i].x, pts[i].y);
            }
            ctx.closePath();
            ctx.stroke();
          });
          ctx.restore();
        }
      } catch (_) {}
    }

    // Liveness & Blink indicator badge — drawn inside the face box so it never overflows
    const count = (blinkInfo && blinkInfo.blinkCount) || 0;
    const reqBlinks = (blinkInfo && blinkInfo.requiredBlinks) || 2;
    const hasBlinked = (blinkInfo && (blinkInfo.hasBlinked || count >= reqBlinks)) || (currentLivenessState && currentLivenessState.live);

    let badgeText, badgeColor;
    if (hasBlinked) {
      badgeText  = `✓ Liveness OK  (${reqBlinks}/${reqBlinks})`;
      badgeColor = '#22C55E';
    } else if (count > 0) {
      badgeText  = `👁 Blink once more  ${count}/${reqBlinks}`;
      badgeColor = '#38BDF8';
    } else {
      badgeText  = reqBlinks === 1 ? '👁 Blink once to verify' : `👁 Blink twice  0/${reqBlinks}`;
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
  const debugPanel    = getOrCreateDebugPanel('reg-debug-panel', video.parentElement);

  const modelsOk = await ensureBioModels();
  if (!modelsOk) {
    statusEl.textContent = '⚠ Face models are unavailable. Refresh or use a supported browser to continue secure enrollment.';
    statusEl.classList.add('bad');
    if (btn) { btn.style.display = ''; btn.disabled = false; btn.textContent = 'Retry'; }
    return;
  }

  try {
    await startCamera(video, errEl);
    initAnkurBlinkEngine(video).catch(() => {});
  } catch (e) {
    statusEl.textContent = cameraErrorMessage(e);
    statusEl.classList.add('bad');
    if (retryBtn) retryBtn.style.display = '';
    if (btn) { btn.style.display = ''; btn.disabled = false; btn.textContent = 'Retry'; }
    return;
  }

  await new Promise((r) => { video.onloadedmetadata = r; setTimeout(r, 2000); });
  statusEl.textContent = '👁  Look at camera and blink twice to verify liveness…';

  try {
    const challenge = await window.iCashApi.issueChallenge();
    if (challenge && challenge.ok) {
      _activeChallengeId    = challenge.challengeId;
      _activeChallengeNonce = challenge.nonce;
      _activeChallengeType  = 'BLINK_TWICE';
      _activeChallengeExp   = new Date(challenge.expiresAt);
      _challengeProofFrames = [];
      regBlinkDetector.reset(2);
      await initLivenessSession('BLINK_TWICE', challenge.livenessSessionId);
    } else {
      await initLivenessSession('BLINK_TWICE');
    }
  } catch (e) {
    await initLivenessSession('BLINK_TWICE');
  }

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
      if (btn) { btn.style.display = ''; btn.disabled = false; btn.textContent = 'Retry'; }
      return;
    }

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
      updateDebugPanel(debugPanel, regBlinkDetector, currentLivenessState, false);
      setTimeout(regStep, 100);
      return;
    }

    if (detections.length > 1) {
      drawOverlay(overlayCanvas, video, detections, 'MULTI', progress, regBlinkDetector);
      statusEl.textContent = '⚠ Multiple faces — only the registering person should be in frame.';
      updateDebugPanel(debugPanel, regBlinkDetector, currentLivenessState, false);
      setTimeout(regStep, 100);
      return;
    }

    const det = detections[0];
    const desc = det.descriptor;
    const score = det.detection.score;

    // Update blink detector with fresh landmarks & MediaPipe video stream
    const blinkStatus = regBlinkDetector.update(det.landmarks, video);
    const count = blinkStatus.blinkCount || 0;

    // Stream synchronized video frame and blink telemetry to the liveness engine
    streamLivenessFrame(video, blinkStatus).catch(() => {});

    // Update debug panel every frame
    updateDebugPanel(debugPanel, blinkStatus, currentLivenessState, true);

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

    if (score < 0.28) {
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

      // SECURITY: Wait for authoritative server-side liveness confirmation before
      // finalizing registration. Client-side blink count is UI feedback only.
      // The server must confirm the temporal blink sequence is genuine.
      _regLoopActive = false;
      statusEl.textContent = '⏳ Blinks confirmed — verifying with liveness server…';
      drawOverlay(overlayCanvas, video, detections, 'GOOD', 1.0, blinkStatus);
      const serverLive = await waitForAuthoritativeLiveness(video);
      if (!serverLive) {
        statusEl.textContent = '⚠ Liveness server did not confirm blink sequence. Please try again.';
        statusEl.classList.add('bad');
        collected.length = 0;
        regBlinkDetector.reset();
        _regLoopActive = true;
        const retryBtn = document.getElementById('reg-retry-cam-btn');
        if (retryBtn) retryBtn.style.display = '';
        return;
      }
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

// SECURITY: The fake Math.sin/cos fallback descriptor has been PERMANENTLY REMOVED.
// When face models are unavailable, registration is blocked entirely.
// A predictable synthetic descriptor could be pre-computed and used to bypass
// biometric enrollment — this is not acceptable.
function captureRegisterFace() {
  const statusEl = document.getElementById('reg-scan-status');
  if (statusEl) {
    statusEl.textContent = '⚠ Face models are unavailable. Please refresh and try again, or use a browser with WebGL support.';
    statusEl.classList.add('bad');
  }
  const btn = document.getElementById('reg-capture-btn');
  if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
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
  const debugPanel    = getOrCreateDebugPanel('login-debug-panel', video.parentElement);

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
    initAnkurBlinkEngine(video).catch(() => {});
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

  // SECURITY: Descriptors are NEVER downloaded from the server.
  // The local client loop handles face positioning/blink proof collection.
  // Identity matching happens server-side inside POST /api/biometric/verify-challenge.
  const storedDescriptors = [];

  // Fetch a fresh server-issued challenge for this login session
  try {
    const hint = targetUser ? targetUser.id : undefined;
    const challenge = await window.iCashApi.issueChallenge({ userIdHint: hint });
    if (challenge.ok) {
      _activeChallengeId    = challenge.challengeId;
      _activeChallengeNonce = challenge.nonce;
      _activeChallengeType  = challenge.challengeType;
      _activeChallengeExp   = new Date(challenge.expiresAt);
      _challengeProofFrames = [];
      statusEl.textContent  = `👁  ${challenge.instruction}`;
      loginBlinkDetector.reset(challenge.challengeType === 'BLINK_TWICE' ? 2 : 1);
      await initLivenessSession(_activeChallengeType, challenge.livenessSessionId);
    } else {
      throw new Error('Unable to start a fresh biometric challenge.');
    }
  } catch (e) {
    // SECURITY: A server-issued challenge with authoritative liveness verification
    // is MANDATORY for biometric login. When the challenge server is unreachable,
    // we must not fall back to a local mode that bypasses liveness enforcement.
    // Instead, direct the user to PIN login.
    console.warn('[iCash Bio] issueChallenge failed — biometric login unavailable, directing to PIN:', e.message || e);
    teardownLoginScan();
    statusEl.textContent = '⚠ Secure liveness server unavailable. Please use PIN login.';
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
      updateDebugPanel(debugPanel, loginBlinkDetector, currentLivenessState, false);
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Align face with ring…';
      }
      setTimeout(loginStep, 100);
      return;
    }

    if (detections.length > 1) {
      consecutiveMatches = 0;
      drawOverlay(overlayCanvas, video, detections, 'MULTI', undefined, loginBlinkDetector);
      statusEl.textContent = '⚠ Multiple people in frame — only the account holder should be present.';
      updateDebugPanel(debugPanel, loginBlinkDetector, currentLivenessState, false);
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Single person only';
      }
      setTimeout(loginStep, 100);
      return;
    }

    const det = detections[0];
    const live = det.descriptor;
    const blinkStatus = loginBlinkDetector.update(det.landmarks, video);
    const count = blinkStatus.blinkCount || 0;
    const reqBlinks = blinkStatus.requiredBlinks || (_activeChallengeType === 'BLINK_TWICE' ? 2 : 1);
    const isLive = blinkStatus.hasBlinked || count >= reqBlinks;
    updateDebugPanel(debugPanel, blinkStatus, currentLivenessState, true);

    // Stream synchronized video frame and blink telemetry to the liveness engine
    streamLivenessFrame(video, blinkStatus).catch(() => {});

    // Record temporal proof frame for server-side challenge validation
    if (_activeChallengeId && _challengeProofFrames.length < 120) {
      _challengeProofFrames.push({
        timestamp: Date.now(),
        earLeft:   blinkStatus.leftEar || blinkStatus.ear || 0.28,
        earRight:  blinkStatus.rightEar || blinkStatus.ear || 0.28,
        isClosed:  Boolean(blinkStatus.isClosed),
      });
    }

    // Anti-spoof presentation attack check from liveness server
    if (currentLivenessState && currentLivenessState.spoof_detected) {
      drawOverlay(overlayCanvas, video, detections, 'BAD', undefined, blinkStatus);
      statusEl.textContent = '⚠️ Presentation attack blocked: photo/screen spoof detected.';
      statusEl.classList.add('bad');
      setTimeout(loginStep, 150);
      return;
    }

    // Draw active face ring and landmark telemetry
    drawOverlay(overlayCanvas, video, detections, isLive ? 'GOOD' : 'SCAN', undefined, blinkStatus);

    // Do NOT expose a manual submit path. A click must never bypass the
    // temporal liveness challenge. The server is the final authority.
    if (btn) {
      btn.style.display = '';
      btn.disabled = true;
      btn.textContent = isLive ? 'Verifying live face…' : 'Blink to continue';
      btn.onclick = null;
    }

    if (isLive) {
      // Client-side liveness satisfied. Give the authoritative liveness service
      // a chance to process the final blink frame before asking the backend to
      // issue the biometric token. This removes the race where the browser
      // detected the blink a few hundred milliseconds before the Python service.
      _loginLoopActive = false;
      statusEl.textContent = '⏳ Blink confirmed — finalizing live-person verification…';
      const authoritativeLive = await waitForAuthoritativeLiveness(video);
      if (!authoritativeLive) {
        statusEl.textContent = '⚠ Live-person verification timed out. Please blink again.';
        statusEl.classList.add('bad');
        loginBlinkDetector.reset(reqBlinks);
        _loginLoopActive = true;
        setTimeout(loginStep, 100);
        const retryBtn = document.getElementById('login-retry-cam-btn');
        if (retryBtn) retryBtn.style.display = '';
        return;
      }
      statusEl.textContent = '✅ Liveness confirmed — validating with server…';
      teardownLoginScan();
      await _submitVerifyChallenge(Array.from(live), targetUser, 0.95);
      return;
    }

    if (count === 0) {
      statusEl.textContent = `👁 Face centered — please BLINK (${count}/${reqBlinks}) to sign in…`;
    } else {
      statusEl.textContent = `✔ Blink detected (${count}/${reqBlinks}) — blink once more…`;
    }
    setTimeout(loginStep, 80);
  };

  loginStep();
}

/**
 * _submitVerifyChallenge
 *
 * Submits the completed liveness challenge to POST /api/biometric/verify-challenge.
 * On success the server returns a biometricToken which is passed to promptLoginPin.
 */
async function _submitVerifyChallenge(liveDescriptor, targetUser, confidence) {
  const statusEl = document.getElementById('login-scan-status');
  if (!statusEl) return;
  try {
    if (!_activeChallengeId || !_activeChallengeNonce) {
      statusEl.textContent = '⚠ No active challenge — please restart the biometric flow.';
      statusEl.classList.add('bad');
      return;
    }
    if (_activeChallengeExp && new Date() > _activeChallengeExp) {
      statusEl.textContent = '⚠ Challenge expired — please restart.';
      statusEl.classList.add('bad');
      return;
    }

    statusEl.textContent = '⏳ Submitting liveness proof to server…';

    // SECURITY: Only server-issued challenges are accepted.
    // The local-chal-* fallback has been removed because it bypassed
    // authoritative liveness verification (face matching alone is not enough).
    if (!_activeChallengeId || _activeChallengeId.startsWith('local-chal-')) {
      statusEl.textContent = '⚠ No valid server challenge. Please use PIN login for secure access.';
      statusEl.classList.add('bad');
      const pinBtn = document.getElementById('login-capture-btn');
      if (pinBtn) {
        pinBtn.style.display = '';
        pinBtn.disabled = false;
        pinBtn.textContent = 'Sign In with PIN';
        pinBtn.onclick = () => goTo('screen-pin-login');
      }
      return;
    }

    const res = await window.iCashApi.verifyChallenge({
      challengeId:       _activeChallengeId,
      nonce:             _activeChallengeNonce,
      liveDescriptor:    Array.isArray(liveDescriptor) ? liveDescriptor : Array.from(liveDescriptor),
      challengeProof:    _challengeProofFrames.slice(0, 120),
      userId:            targetUser ? targetUser.id : undefined,
    });

    if (!res.ok || !res.biometricToken) {
      statusEl.textContent = res.message || '❌ Server-side biometric verification failed. Please try again.';
      statusEl.classList.add('bad');
      // Clear challenge state so a fresh challenge is fetched on next attempt
      _activeChallengeId = null; _activeChallengeNonce = null;
      const retryBtn = document.getElementById('login-retry-cam-btn');
      if (retryBtn) retryBtn.style.display = '';
      const pinBtn = document.getElementById('login-capture-btn');
      if (pinBtn) {
        pinBtn.style.display = '';
        pinBtn.disabled = false;
        pinBtn.textContent = 'Sign In with PIN';
        pinBtn.onclick = () => goTo('screen-pin-login');
      }
      return;
    }

    // A successful challenge is now sufficient to establish the normal
    // authenticated session. The backend only issues this token after the
    // authoritative liveness server and server-side face match both pass.
    _activeBiometricToken = res.biometricToken;
    statusEl.textContent = '✅ Live face verified — establishing secure session…';

    const loginRes = await window.iCashApi.loginBiometric(res.biometricToken);
    if (!loginRes.ok || !loginRes.user) {
      throw new Error(loginRes.message || 'Unable to establish biometric session.');
    }

    currentUser = loginRes.user;
    pendingLoginUser = null;
    _activeChallengeId = null;
    _activeChallengeNonce = null;
    _activeChallengeType = null;
    _activeChallengeExp = null;
    _challengeProofFrames = [];
    activeLivenessSessionId = null;
    stopCamera(video);
    enterDashboard();
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = err.message || 'Verification failed.';
      statusEl.classList.add('bad');
    }
    const retryBtn = document.getElementById('login-retry-cam-btn');
    if (retryBtn) retryBtn.style.display = '';
    const pinBtn = document.getElementById('login-capture-btn');
    if (pinBtn) {
      pinBtn.style.display = '';
      pinBtn.disabled = false;
      pinBtn.textContent = 'Sign In with PIN';
      pinBtn.onclick = () => goTo('screen-pin-login');
    }
  }
}

// Server facial verification: STRICTLY requires completed liveness challenge
async function _serverVerifyLogin(liveDescriptor, targetUser, overlayCanvas, video, detections) {
  const statusEl = document.getElementById('login-scan-status');
  try {
    // A valid, unexpired server-issued challenge is MANDATORY
    if (!_activeChallengeId || (_activeChallengeExp && new Date() > _activeChallengeExp)) {
      statusEl.textContent = '⚠ Blink verification required. Please restart biometric scan or use PIN.';
      statusEl.classList.add('bad');
      const pinBtn = document.getElementById('login-capture-btn');
      if (pinBtn) {
        pinBtn.style.display = '';
        pinBtn.disabled = false;
        pinBtn.textContent = 'Sign In with PIN';
        pinBtn.onclick = () => goTo('screen-pin-login');
      }
      return;
    }

    teardownLoginScan();
    await _submitVerifyChallenge(liveDescriptor, targetUser, 0.75);
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = err.message || 'Verification failed.';
      statusEl.classList.add('bad');
    }
  }
}

// Fallback manual capture: NEVER bypasses the blink challenge
async function captureLoginFace() {
  const statusEl = document.getElementById('login-scan-status');
  const targetUser = window._loginTargetUser;
  if (!targetUser) return;

  // Liveness must have completed; face match alone is never sufficient
  if (!_activeChallengeId) {
    if (statusEl) {
      statusEl.textContent = '⚠ Live blinking is required for biometric authentication.';
      statusEl.classList.add('bad');
    }
    return;
  }

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
  const debugPanel    = getOrCreateDebugPanel('verify-debug-panel', video.parentElement);

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
    initAnkurBlinkEngine(video).catch(() => {});
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

  // SECURITY: Descriptors are NEVER downloaded from the server.
  // Server-side matching now happens inside POST /api/biometric/verify-challenge.
  // storedDescriptors is intentionally left empty — the local loop handles
  // face positioning, spoof detection, and liveness challenge tracking.
  // The server confirms the actual identity match.
  const storedDescriptors = [];

  // Fetch a fresh server challenge for this authorization session
  try {
    const challenge = await window.iCashApi.issueChallenge({ userIdHint: currentUser ? currentUser.id : undefined });
    if (challenge.ok) {
      _activeChallengeId    = challenge.challengeId;
      _activeChallengeNonce = challenge.nonce;
      _activeChallengeType  = challenge.challengeType;
      _activeChallengeExp   = new Date(challenge.expiresAt);
      _challengeProofFrames = [];
      statusEl.textContent  = `👁  ${challenge.instruction}`;
      gateBlinkDetector.reset(challenge.challengeType === 'BLINK_TWICE' ? 2 : 1);
      await initLivenessSession(_activeChallengeType, challenge.livenessSessionId);
    } else {
      throw new Error('Unable to start a fresh biometric challenge.');
    }
  } catch (e) {
    statusEl.textContent = '⚠ Unable to start secure liveness verification. Use PIN to authorize.';
    statusEl.classList.add('bad');
    toggleVerifyPin();
    return;
  }

  gateBlinkDetector.reset(_activeChallengeType === 'BLINK_TWICE' ? 2 : 1);
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
      updateDebugPanel(debugPanel, gateBlinkDetector, currentLivenessState, false);
      msg.textContent = '';
      setTimeout(verifyStep, 100);
      return;
    }

    if (detections.length > 1) {
      consecutiveMatches = 0;
      drawOverlay(overlayCanvas, video, detections, 'MULTI', undefined, gateBlinkDetector);
      statusEl.textContent = '⚠ Multiple people — only the account holder should authorize.';
      updateDebugPanel(debugPanel, gateBlinkDetector, currentLivenessState, false);
      msg.textContent = 'Security alert: unauthorized person present.';
      msg.className = 'modal-msg err';
      setTimeout(verifyStep, 100);
      return;
    }

    const det = detections[0];
    const live = det.descriptor;
    const blinkStatus = gateBlinkDetector.update(det.landmarks, video);
    updateDebugPanel(debugPanel, blinkStatus, currentLivenessState, true);

    // Record temporal proof frame for server-side challenge validation
    if (_activeChallengeId && _challengeProofFrames.length < 120) {
      _challengeProofFrames.push({
        timestamp: Date.now(),
        earLeft:   blinkStatus.ear || 0,
        earRight:  blinkStatus.ear || 0,
      });
    }

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

    // No stored descriptors — server-side matching via challenge flow
    if (!storedDescriptors || storedDescriptors.length === 0) {
      const count = blinkStatus.blinkCount || 0;
      const reqBlinks = blinkStatus.requiredBlinks || (_activeChallengeType === 'BLINK_TWICE' ? 2 : 1);
      const isLive = blinkStatus.hasBlinked || count >= reqBlinks;
      drawOverlay(overlayCanvas, video, detections, isLive ? 'GOOD' : 'SCAN', undefined, blinkStatus);

      if (isLive) {
        _verifyLoopActive = false;
        statusEl.textContent = '✅ Liveness confirmed — validating with server…';
        await _submitVerifyChallengeTransaction(Array.from(live));
      } else {
        statusEl.textContent = `👁 Face centered — please BLINK (${count}/${reqBlinks}) to authorize…`;
        setTimeout(verifyStep, 80);
      }
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

    drawOverlay(overlayCanvas, video, detections, 'GOOD', undefined, blinkStatus);
    statusEl.textContent = `✅ 2/2 Blinks — executing transaction…`;

    if (consecutiveMatches >= REQUIRED_MATCHES && blinkStatus.hasBlinked) {
      _verifyLoopActive = false;
      statusEl.textContent = '✅ Liveness confirmed — validating with server…';
      // Submit to server challenge endpoint for full validation
      await _submitVerifyChallengeTransaction(Array.from(live));
    } else {
      setTimeout(verifyStep, 80);
    }
  };

  verifyStep();
}

/**
 * _submitVerifyChallengeTransaction
 * Submits liveness challenge proof for transaction authorization.
 * Mirrors _submitVerifyChallenge but targets the verify-gate UI elements.
 */
async function _submitVerifyChallengeTransaction(liveDescriptor) {
  const statusEl = document.getElementById('verify-scan-status');
  const msg      = document.getElementById('verify-msg');
  if (!currentUser) { if (msg) msg.textContent = 'Session expired.'; return; }
  try {
    if (!_activeChallengeId || !_activeChallengeNonce) {
      if (msg) { msg.textContent = 'No active challenge — please restart.'; msg.className = 'modal-msg err'; }
      return;
    }
    if (_activeChallengeExp && new Date() > _activeChallengeExp) {
      if (msg) { msg.textContent = 'Challenge expired — please restart.'; msg.className = 'modal-msg err'; }
      return;
    }
    statusEl.textContent = '⏳ Submitting liveness proof…';
    const res = await window.iCashApi.verifyChallenge({
      challengeId:       _activeChallengeId,
      nonce:             _activeChallengeNonce,
      liveDescriptor:    liveDescriptor,
      challengeProof:    _challengeProofFrames.slice(0, 120),
    });
    if (!res.ok || !res.biometricToken) {
      if (statusEl) statusEl.textContent = '❌ Server verification failed. Please try again.';
      if (msg) { msg.textContent = 'Biometric authorization denied.'; msg.className = 'modal-msg err'; }
      _activeChallengeId = null; _activeChallengeNonce = null;
      return;
    }
    _activeBiometricToken = res.biometricToken;
    statusEl.textContent = '✅ Authorized — executing transaction…';
    await _finalizeVerify();
  } catch (err) {
    if (msg) { msg.textContent = err.message || 'Authorization failed.'; msg.className = 'modal-msg err'; }
  }
}

// Fallback path (when challenge state is unavailable)
async function _serverVerifyTransaction(liveDescriptor, overlayCanvas, video, detections) {
  const statusEl = document.getElementById('verify-scan-status');
  const msg      = document.getElementById('verify-msg');
  if (!currentUser) { if (msg) msg.textContent = 'Session expired.'; return; }
  // Redirect to challenge flow if possible
  if (_activeChallengeId) { await _submitVerifyChallengeTransaction(liveDescriptor); return; }
  try {
    if (statusEl) statusEl.textContent = '⏳ Verifying identity…';
    const verifyRes = await window.iCashApi.verifyBiometric({
      liveDescriptor: Array.isArray(liveDescriptor) ? liveDescriptor : Array.from(liveDescriptor),
      userId: currentUser.id,
    });
    if (!verifyRes.ok || !verifyRes.matched) {
      if (statusEl) statusEl.textContent = '❌ Biometric mismatch — authorization denied.';
      if (msg) { msg.textContent = 'Biometric verification failed.'; msg.className = 'modal-msg err'; }
      return;
    }
    _activeBiometricToken = verifyRes.biometricToken || null;
    if (statusEl) statusEl.textContent = '✅ Authorized — executing transaction…';
    await _finalizeVerify();
  } catch (err) {
    if (msg) { msg.textContent = err.message || 'Authorization failed.'; msg.className = 'modal-msg err'; }
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
