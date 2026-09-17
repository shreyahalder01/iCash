/**
 * iCash Biometric Authentication Subsystem
 *
 * Built from scratch with strict temporal eye-blink liveness validation,
 * adaptive baseline calibration, and 128-dimensional facial vector matching.
 *
 * Zero tolerance for:
 *   - Static photos / printed photos
 *   - Screen video replays
 *   - Staring without blinking
 *   - Single-blink attempts
 *   - Face identity mismatch (Euclidean distance >= 0.52)
 *   - Client-side trust bypasses
 */

// Model URLs: Express local static assets first, fallback to Vlad Mandic CDN
const FACEAPI_MODEL_URL = '/models';
const FACEAPI_MODEL_URL_CDN = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';

// Core thresholds
const MATCH_THRESHOLD = 0.52;     // Euclidean distance < 0.52 = match
const REQUIRED_BLINKS = 2;        // 2 distinct full blinks required
const ENROLL_SAMPLES = 5;         // Diverse frames required for enrollment
const CALIBRATION_FRAMES = 15;    // Resting baseline frames
const MIN_BLINK_DURATION_MS = 70; // Shortest valid blink closure
const MAX_BLINK_DURATION_MS = 700;// Longest valid blink closure (rejects sleep / closed-eye photos)
const BLINK_DEBOUNCE_MS = 250;    // Minimum gap between blinks

// ── Math & Geometry Helpers ──────────────────────────────────────────────────
function euclidean(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

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

function getPoint(p) {
  if (!p) return null;
  const x = typeof p.x === 'number' ? p.x : (typeof p._x === 'number' ? p._x : (Array.isArray(p) ? p[0] : null));
  const y = typeof p.y === 'number' ? p.y : (typeof p._y === 'number' ? p._y : (Array.isArray(p) ? p[1] : null));
  if (x === null || y === null || isNaN(x) || isNaN(y)) return null;
  return { x, y };
}

function dist(p1, p2) {
  const pt1 = getPoint(p1);
  const pt2 = getPoint(p2);
  if (!pt1 || !pt2) return 0;
  return Math.hypot(pt1.x - pt2.x, pt1.y - pt2.y);
}

/**
 * Soukupová & Čech Eye Aspect Ratio formula:
 * Points: [p0, p1, p2, p3, p4, p5]
 * EAR = (||p1 - p5|| + ||p2 - p4||) / (2 * ||p0 - p3||)
 */
function calculateEAR(pts) {
  if (!pts || pts.length < 6) return 0.28;
  const v1 = dist(pts[1], pts[5]);
  const v2 = dist(pts[2], pts[4]);
  const h  = dist(pts[0], pts[3]);
  if (h <= 0.001) return 0.28;
  return (v1 + v2) / (2.0 * h);
}

// ── Camera Manager ────────────────────────────────────────────────────────────
const CameraManager = {
  activeStreams: new WeakMap(),

  async start(videoEl, errEl) {
    if (errEl) {
      errEl.textContent = '';
      errEl.classList.remove('active');
    }
    if (!videoEl) throw new Error('NO_VIDEO_ELEMENT');

    // Set mobile-friendly video attributes
    videoEl.setAttribute('playsinline', 'true');
    videoEl.setAttribute('webkit-playsinline', 'true');
    videoEl.setAttribute('muted', 'true');
    videoEl.muted = true;

    // Stop existing stream if any
    this.stop(videoEl);

    if (!window.isSecureContext) {
      const err = new Error('INSECURE_CONTEXT');
      if (errEl) {
        errEl.textContent = 'Camera requires a secure HTTPS or localhost context.';
        errEl.classList.add('active');
      }
      throw err;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const err = new Error('NO_MEDIA_API');
      if (errEl) {
        errEl.textContent = 'Camera access is not supported by this browser.';
        errEl.classList.add('active');
      }
      throw err;
    }

    const constraints = {
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: 'user',
        frameRate: { ideal: 30, max: 30 },
      },
      audio: false,
    };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      // Fallback for strict devices
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }

    videoEl.srcObject = stream;
    this.activeStreams.set(videoEl, stream);

    await new Promise((resolve) => {
      if (videoEl.readyState >= 2) {
        resolve();
      } else {
        videoEl.onloadedmetadata = () => resolve();
        setTimeout(resolve, 1500);
      }
    });

    try {
      await videoEl.play();
    } catch (_) {}

    return stream;
  },

  stop(videoEl) {
    if (!videoEl) return;
    const stream = this.activeStreams.get(videoEl) || videoEl.srcObject;
    if (stream && typeof stream.getTracks === 'function') {
      stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (_) {}
      });
    }
    videoEl.srcObject = null;
    this.activeStreams.delete(videoEl);
  },
};

// ── Model Loader ──────────────────────────────────────────────────────────────
window._bioModelsLoaded = false;
window._bioModelsLoading = false;

async function ensureBioModels() {
  if (window._bioModelsLoaded) return true;
  if (window._bioModelsLoading) {
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (window._bioModelsLoaded) return true;
    }
    return false;
  }
  window._bioModelsLoading = true;

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
      console.log('[iCash Biometric] Face models loaded successfully from:', src);
      return true;
    } catch (e) {
      console.warn('[iCash Biometric] Failed loading models from', src, '— trying next source:', e.message || e);
    }
  }

  window._bioModelsLoading = false;
  console.error('[iCash Biometric] All model sources failed.');
  return false;
}

function getDetectOptions() {
  return new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.30 });
}

// ── Face Quality Gate ─────────────────────────────────────────────────────────
const FaceQualityGate = {
  validate(detections, videoEl) {
    if (!detections || detections.length === 0) {
      return { ok: false, reason: 'NO_FACE', message: 'Center your face in the camera circle' };
    }
    if (detections.length > 1) {
      return { ok: false, reason: 'MULTI_FACE', message: 'Multiple faces detected — only one person allowed' };
    }

    const det = detections[0];
    const score = det.detection.score || 0;
    if (score < 0.32) {
      return { ok: false, reason: 'LOW_SCORE', message: 'Low confidence — look straight at the camera' };
    }

    const box = det.detection.box;
    const vw = videoEl.videoWidth || 640;
    const vh = videoEl.videoHeight || 480;

    // Coverage check: face should cover 20% to 85% of frame dimension
    const faceCoverage = Math.max(box.width / vw, box.height / vh);
    if (faceCoverage < 0.20) {
      return { ok: false, reason: 'TOO_FAR', message: 'Move closer to the camera' };
    }
    if (faceCoverage > 0.88) {
      return { ok: false, reason: 'TOO_CLOSE', message: 'Move slightly back from the camera' };
    }

    // Centeredness: face center must be within 25% of frame center
    const faceCenterX = (box.x + box.width / 2) / vw;
    const faceCenterY = (box.y + box.height / 2) / vh;
    const offsetX = Math.abs(faceCenterX - 0.5);
    const offsetY = Math.abs(faceCenterY - 0.5);

    if (offsetX > 0.25 || offsetY > 0.25) {
      return { ok: false, reason: 'NOT_CENTERED', message: 'Center your face in the circle' };
    }

    return { ok: true, det };
  },
};

// ── EAR Calculator ────────────────────────────────────────────────────────────
const EarCalculator = {
  calculate(landmarks) {
    if (!landmarks) return null;
    let leftPts = null;
    let rightPts = null;

    if (typeof landmarks.getLeftEye === 'function') {
      leftPts = landmarks.getLeftEye();
      rightPts = landmarks.getRightEye();
    } else if (landmarks.positions && landmarks.positions.length >= 68) {
      leftPts = landmarks.positions.slice(36, 42);
      rightPts = landmarks.positions.slice(42, 48);
    }

    if (!leftPts || !rightPts) return null;

    const leftEAR = calculateEAR(leftPts);
    const rightEAR = calculateEAR(rightPts);
    const avgEAR = (leftEAR + rightEAR) / 2;

    return { leftEAR, rightEAR, avgEAR };
  },
};

// ── Adaptive Baseline Calibration ─────────────────────────────────────────────
class AdaptiveBaseline {
  constructor(samplesRequired = CALIBRATION_FRAMES) {
    this.samplesRequired = samplesRequired;
    this.samples = [];
    this.baselineOpenEar = 0.28;
    this.closeThreshold = 0.20;
    this.openThreshold = 0.25;
    this.isCalibrated = false;
  }

  reset() {
    this.samples = [];
    this.baselineOpenEar = 0.28;
    this.closeThreshold = 0.20;
    this.openThreshold = 0.25;
    this.isCalibrated = false;
  }

  addSample(avgEAR) {
    if (this.isCalibrated) return true;
    // Reject samples where user is clearly blinking during calibration
    if (avgEAR >= 0.19) {
      this.samples.push(avgEAR);
    }
    if (this.samples.length >= this.samplesRequired) {
      const sorted = [...this.samples].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
      this.baselineOpenEar = Math.max(0.24, Math.min(0.42, median));
      this.closeThreshold = Math.min(0.21, Number((this.baselineOpenEar * 0.74).toFixed(3)));
      this.openThreshold = Math.max(0.24, Number((this.baselineOpenEar * 0.88).toFixed(3)));
      this.isCalibrated = true;
      console.log(`[iCash Bio] Calibration complete: baseline=${this.baselineOpenEar.toFixed(3)}, closeThresh=${this.closeThreshold}, openThresh=${this.openThreshold}`);
      return true;
    }
    return false;
  }
}

// ── Temporal Blink State Machine ──────────────────────────────────────────────
class BlinkStateMachine {
  constructor(requiredBlinks = REQUIRED_BLINKS) {
    this.requiredBlinks = requiredBlinks;
    this.state = 'CALIBRATING'; // CALIBRATING | WAITING_FOR_BLINK | CLOSING | CLOSED | OPENING
    this.blinkCount = 0;
    this.closedStartTime = 0;
    this.lastBlinkEndTime = 0;
    this.isBothClosed = false;
  }

  reset(requiredBlinks = REQUIRED_BLINKS) {
    this.requiredBlinks = requiredBlinks;
    this.state = 'CALIBRATING';
    this.blinkCount = 0;
    this.closedStartTime = 0;
    this.lastBlinkEndTime = 0;
    this.isBothClosed = false;
  }

  update(earData, baseline, now = Date.now()) {
    if (!baseline.isCalibrated) {
      this.state = 'CALIBRATING';
      return {
        state: this.state,
        blinkCount: this.blinkCount,
        requiredBlinks: this.requiredBlinks,
        isClosed: false,
        blinkDetected: false,
      };
    }

    const { leftEAR, rightEAR, avgEAR } = earData;
    const bothClosed = leftEAR < baseline.closeThreshold && rightEAR < baseline.closeThreshold;
    const bothOpen = leftEAR >= baseline.openThreshold && rightEAR >= baseline.openThreshold;
    let blinkDetected = false;

    switch (this.state) {
      case 'CALIBRATING':
      case 'WAITING_FOR_BLINK':
        if (bothClosed) {
          this.state = 'CLOSED';
          this.closedStartTime = now;
          this.isBothClosed = true;
        } else if (avgEAR < baseline.openThreshold) {
          this.state = 'CLOSING';
        }
        break;

      case 'CLOSING':
        if (bothClosed) {
          this.state = 'CLOSED';
          this.closedStartTime = now;
          this.isBothClosed = true;
        } else if (bothOpen) {
          this.state = 'WAITING_FOR_BLINK';
        }
        break;

      case 'CLOSED':
        const closedDuration = now - this.closedStartTime;
        if (bothOpen || avgEAR >= baseline.closeThreshold) {
          // Eyes opening
          if (closedDuration >= MIN_BLINK_DURATION_MS && closedDuration <= MAX_BLINK_DURATION_MS) {
            // Check debounce
            if (now - this.lastBlinkEndTime >= BLINK_DEBOUNCE_MS) {
              this.blinkCount++;
              this.lastBlinkEndTime = now;
              blinkDetected = true;
              console.log(`[iCash Bio] Valid blink #${this.blinkCount}/${this.requiredBlinks} (duration: ${closedDuration}ms)`);
            }
          }
          this.state = bothOpen ? 'WAITING_FOR_BLINK' : 'OPENING';
          this.isBothClosed = false;
        } else if (closedDuration > MAX_BLINK_DURATION_MS) {
          // Eyes closed too long (e.g. photo of closed eyes or prolonged squint)
          this.state = 'WAITING_FOR_BLINK';
          this.isBothClosed = false;
        }
        break;

      case 'OPENING':
        if (bothOpen) {
          this.state = 'WAITING_FOR_BLINK';
          this.isBothClosed = false;
        } else if (bothClosed) {
          this.state = 'CLOSED';
          this.closedStartTime = now;
          this.isBothClosed = true;
        }
        break;
    }

    return {
      state: this.state,
      blinkCount: this.blinkCount,
      requiredBlinks: this.requiredBlinks,
      isClosed: this.isBothClosed,
      blinkDetected,
    };
  }
}

// ── Evidence Collector ────────────────────────────────────────────────────────
class EvidenceCollector {
  constructor(maxFrames = 120) {
    this.maxFrames = maxFrames;
    this.frames = [];
    this.bestDescriptor = null;
    this.descriptors = [];
    this.lastDescriptorTime = 0;
  }

  reset() {
    this.frames = [];
    this.bestDescriptor = null;
    this.descriptors = [];
    this.lastDescriptorTime = 0;
  }

  addFrame(timestamp, earData, state, isFaceOk, descriptor = null) {
    if (this.frames.length < this.maxFrames) {
      this.frames.push({
        timestamp,
        leftEAR: Number(earData.leftEAR.toFixed(4)),
        rightEAR: Number(earData.rightEAR.toFixed(4)),
        avgEAR: Number(earData.avgEAR.toFixed(4)),
        state,
        faceDetected: isFaceOk,
      });
    }

    // Capture descriptor on high quality open-eye frames
    if (descriptor && isFaceOk && (state === 'WAITING_FOR_BLINK' || state === 'CALIBRATING')) {
      if (!this.bestDescriptor) {
        this.bestDescriptor = descriptor;
      }
      if (timestamp - this.lastDescriptorTime >= 200 && this.descriptors.length < ENROLL_SAMPLES) {
        this.descriptors.push(descriptor);
        this.lastDescriptorTime = timestamp;
      }
    }
  }

  getPackage(challengeId, nonce) {
    return {
      challengeId,
      nonce,
      liveDescriptor: this.bestDescriptor ? Array.from(this.bestDescriptor) : [],
      challengeProof: this.frames,
    };
  }
}

// ── UI Overlay & Debug Helpers ────────────────────────────────────────────────
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

function getOverlayCanvas(id, parentEl) {
  let oc = document.getElementById(id);
  if (!oc && parentEl) {
    oc = document.createElement('canvas');
    oc.id = id;
    oc.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;width:100%;height:100%;z-index:2;';
    parentEl.style.position = 'relative';
    parentEl.appendChild(oc);
  }
  return oc;
}

function getDebugPanel(id, parentEl) {
  if (!_bioDebugEnabled || !parentEl) return null;
  let panel = document.getElementById(id);
  if (!panel) {
    panel = document.createElement('div');
    panel.id = id;
    panel.style.cssText = [
      'position:absolute;bottom:6px;left:6px;z-index:10;',
      'background:rgba(10,15,30,0.85);color:#38bdf8;',
      'font:10px/1.4 monospace;padding:6px 8px;border-radius:6px;',
      'pointer-events:none;white-space:pre;min-width:200px;',
      'border:1px solid rgba(56,189,248,0.3);',
    ].join('');
    parentEl.style.position = 'relative';
    parentEl.appendChild(panel);
  }
  return panel;
}

function updateBlinkDots(prefix, blinkCount, reqBlinks = 2) {
  const dot1 = document.getElementById(`${prefix}-dot-1`);
  const dot2 = document.getElementById(`${prefix}-dot-2`);
  if (dot1) {
    if (blinkCount >= 1) dot1.classList.add('active');
    else dot1.classList.remove('active');
  }
  if (dot2) {
    if (blinkCount >= 2) dot2.classList.add('active');
    else dot2.classList.remove('active');
  }
}

function setBannerStatus(prefix, text, stateClass = 'info') {
  const banner = document.getElementById(`${prefix}-instruction-banner`);
  const textEl = document.getElementById(`${prefix}-instruction-text`);
  if (textEl) textEl.textContent = text;
  if (banner) {
    banner.className = `scan-instruction-banner ${stateClass}`;
  }
  const statusEl = document.getElementById(`${prefix}-scan-status`);
  if (statusEl) {
    statusEl.textContent = text;
    if (stateClass === 'bad') statusEl.classList.add('bad');
    else statusEl.classList.remove('bad');
  }
}

function drawFaceRing(canvas, video, quality, earData, blinkInfo) {
  if (!canvas || !video) return;
  const w = video.videoWidth || 640;
  const h = video.videoHeight || 480;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  if (!quality.ok || !quality.det) {
    return;
  }

  const det = quality.det;
  const box = det.detection.box;
  const isGood = blinkInfo && blinkInfo.blinkCount >= (blinkInfo.requiredBlinks || 2);
  const isClosed = blinkInfo && blinkInfo.isClosed;
  const color = isGood ? '#22c55e' : (isClosed ? '#38bdf8' : '#2dd4bf');

  // Bounding box
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  // Corner brackets
  const s = 14;
  const corners = [
    [box.x, box.y, 1, 1],
    [box.x + box.width, box.y, -1, 1],
    [box.x, box.y + box.height, 1, -1],
    [box.x + box.width, box.y + box.height, -1, -1],
  ];
  ctx.lineWidth = 3.5;
  corners.forEach(([cx, cy, dx, dy]) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy + dy * s);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + dx * s, cy);
    ctx.stroke();
  });

  // Eye landmarks
  if (det.landmarks) {
    try {
      const left = det.landmarks.getLeftEye ? det.landmarks.getLeftEye() : null;
      const right = det.landmarks.getRightEye ? det.landmarks.getRightEye() : null;
      const eyeColor = isClosed ? '#22c55e' : '#38bdf8';
      ctx.strokeStyle = eyeColor;
      ctx.lineWidth = 1.5;
      [left, right].forEach((pts) => {
        if (!pts || pts.length < 6) return;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.stroke();
      });
    } catch (_) {}
  }

  ctx.restore();
}

// ── Shared Challenge State ────────────────────────────────────────────────────
let _currentChallenge = null;

// ==============================================================================
// 1. LOGIN BIOMETRIC SCAN
// ==============================================================================
let _loginActive = false;

async function beginLoginScan() {
  _loginActive = false;
  const video = document.getElementById('login-video');
  const errEl = document.getElementById('login-cam-error');
  const retryBtn = document.getElementById('login-retry-cam-btn');
  const captureBtn = document.getElementById('login-capture-btn');

  if (captureBtn) captureBtn.style.display = 'none';
  if (retryBtn) retryBtn.style.display = 'none';

  updateBlinkDots('login', 0, 2);
  setBannerStatus('login', 'Initializing secure biometric camera…', 'info');

  const parent = video ? video.parentElement : null;
  const overlayCanvas = getOverlayCanvas('login-overlay-canvas', parent);
  const debugPanel = getDebugPanel('login-debug-panel', parent);

  // 1. Ensure models loaded
  const modelsOk = await ensureBioModels();
  if (!modelsOk) {
    setBannerStatus('login', 'Biometric models unavailable. Use PIN authorization.', 'bad');
    if (captureBtn) {
      captureBtn.style.display = '';
      captureBtn.disabled = false;
      captureBtn.textContent = 'Sign In with PIN';
      captureBtn.onclick = () => goTo('screen-pin-login');
    }
    return;
  }

  // 2. Start Camera
  try {
    await CameraManager.start(video, errEl);
  } catch (camErr) {
    setBannerStatus('login', 'Camera permission needed. Use PIN authorization.', 'bad');
    if (retryBtn) retryBtn.style.display = '';
    return;
  }

  // 3. Request fresh server challenge
  const targetUser = window._loginTargetUser;
  try {
    setBannerStatus('login', 'Requesting cryptographic challenge from server…', 'info');
    const challengeRes = await window.iCashApi.issueChallenge({
      userIdHint: targetUser ? targetUser.id : undefined,
    });
    if (!challengeRes || !challengeRes.ok || !challengeRes.challengeId) {
      throw new Error(challengeRes.message || 'Challenge generation failed');
    }
    _currentChallenge = challengeRes;
  } catch (chalErr) {
    setBannerStatus('login', 'Liveness server unavailable. Please sign in with PIN.', 'bad');
    teardownLoginScan();
    return;
  }

  // 4. Initialize engines
  const baseline = new AdaptiveBaseline(CALIBRATION_FRAMES);
  const stateMachine = new BlinkStateMachine(REQUIRED_BLINKS);
  const evidence = new EvidenceCollector(120);

  _loginActive = true;
  setBannerStatus('login', 'Center your face and hold still to calibrate…', 'info');

  let framesProcessed = 0;
  const MAX_FRAMES = 500; // ~40 seconds timeout

  const runLoop = async () => {
    if (!_loginActive) return;

    framesProcessed++;
    if (framesProcessed > MAX_FRAMES) {
      _loginActive = false;
      setBannerStatus('login', 'Authentication timed out. Please retry or use PIN.', 'bad');
      if (retryBtn) retryBtn.style.display = '';
      return;
    }

    let detections = [];
    try {
      detections = await faceapi
        .detectAllFaces(video, getDetectOptions())
        .withFaceLandmarks()
        .withFaceDescriptors();
    } catch (_) {}

    if (!_loginActive) return;

    const quality = FaceQualityGate.validate(detections, video);
    if (!quality.ok) {
      drawFaceRing(overlayCanvas, video, quality, null, null);
      setBannerStatus('login', quality.message, 'warning');
      setTimeout(runLoop, 90);
      return;
    }

    const det = quality.det;
    const earData = EarCalculator.calculate(det.landmarks);
    if (!earData) {
      setTimeout(runLoop, 80);
      return;
    }

    const now = Date.now();

    // Calibration phase
    if (!baseline.isCalibrated) {
      baseline.addSample(earData.avgEAR);
      const progress = Math.round((baseline.samples.length / CALIBRATION_FRAMES) * 100);
      setBannerStatus('login', `Calibrating eye baseline (${progress}%)… hold steady`, 'info');
      evidence.addFrame(now, earData, 'CALIBRATING', true, det.descriptor);
      drawFaceRing(overlayCanvas, video, quality, earData, { blinkCount: 0, requiredBlinks: 2, isClosed: false });
      setTimeout(runLoop, 80);
      return;
    }

    // Active liveness verification phase
    const blinkResult = stateMachine.update(earData, baseline, now);
    evidence.addFrame(now, earData, blinkResult.state, true, det.descriptor);
    drawFaceRing(overlayCanvas, video, quality, earData, blinkResult);
    updateBlinkDots('login', blinkResult.blinkCount, REQUIRED_BLINKS);

    // Update debug telemetry if open
    if (debugPanel) {
      debugPanel.textContent = [
        `Face Quality: OK`,
        `Left EAR: ${earData.leftEAR.toFixed(3)} | Right: ${earData.rightEAR.toFixed(3)}`,
        `Baseline: ${baseline.baselineOpenEar.toFixed(3)} (close < ${baseline.closeThreshold})`,
        `Blink State: ${blinkResult.state}`,
        `Blinks: ${blinkResult.blinkCount}/${REQUIRED_BLINKS}`,
        `Frames Recorded: ${evidence.frames.length}`,
      ].join('\n');
    }

    if (blinkResult.blinkCount === 0) {
      setBannerStatus('login', '👁 Blink naturally now (0/2 blinks)…', 'info');
    } else if (blinkResult.blinkCount === 1) {
      setBannerStatus('login', '✔ 1st blink detected! Blink once more (1/2)…', 'info');
    } else if (blinkResult.blinkCount >= REQUIRED_BLINKS) {
      // 2 blinks reached! Transmit evidence to server
      _loginActive = false;
      setBannerStatus('login', '✅ 2/2 blinks confirmed! Validating temporal proof with server…', 'info');

      try {
        const payload = evidence.getPackage(_currentChallenge.challengeId, _currentChallenge.nonce);
        if (targetUser && targetUser.id) {
          payload.userId = targetUser.id;
        }

        const verifyRes = await window.iCashApi.verifyChallenge(payload);
        if (!verifyRes || !verifyRes.ok || !verifyRes.biometricToken) {
          throw new Error(verifyRes.message || 'Liveness and biometric verification failed');
        }

        setBannerStatus('login', '✅ Biometrics verified! Logging in…', 'ok');
        CameraManager.stop(video);

        // Complete login via biometricToken
        const authRes = await window.iCashApi.loginBiometric(verifyRes.biometricToken);
        if (authRes.ok && authRes.user) {
          currentUser = authRes.user;
          sessionStorage.setItem('icash_session_active', 'true');
          enterDashboard();
        } else {
          throw new Error(authRes.message || 'Failed to establish session');
        }
      } catch (err) {
        console.error('[iCash Bio] Verification error:', err);
        setBannerStatus('login', `❌ ${err.message || 'Biometric authentication failed.'}`, 'bad');
        if (retryBtn) retryBtn.style.display = '';
      }
      return;
    }

    setTimeout(runLoop, 80);
  };

  runLoop();
}

function cancelLoginScan() {
  teardownLoginScan();
  goTo('screen-welcome');
}

function teardownLoginScan() {
  _loginActive = false;
  _currentChallenge = null;
  const video = document.getElementById('login-video');
  CameraManager.stop(video);
  const oc = document.getElementById('login-overlay-canvas');
  if (oc) oc.getContext('2d').clearRect(0, 0, oc.width, oc.height);
  updateBlinkDots('login', 0, 2);
}

function captureLoginFace() {
  // Manual button redirects to PIN login for security
  goTo('screen-pin-login');
}

// ==============================================================================
// 2. REGISTRATION BIOMETRIC SCAN
// ==============================================================================
let _regActive = false;

async function beginRegisterScan() {
  _regActive = false;
  const video = document.getElementById('reg-video');
  const errEl = document.getElementById('reg-cam-error');
  const retryBtn = document.getElementById('reg-retry-cam-btn');
  const captureBtn = document.getElementById('reg-capture-btn');

  if (captureBtn) captureBtn.style.display = 'none';
  if (retryBtn) retryBtn.style.display = 'none';

  updateBlinkDots('reg', 0, 2);
  setBannerStatus('reg', 'Initializing camera for biometric enrollment…', 'info');

  const parent = video ? video.parentElement : null;
  const overlayCanvas = getOverlayCanvas('reg-overlay-canvas', parent);
  const debugPanel = getDebugPanel('reg-debug-panel', parent);

  const modelsOk = await ensureBioModels();
  if (!modelsOk) {
    setBannerStatus('reg', 'Face models unavailable. Please refresh or try again.', 'bad');
    return;
  }

  try {
    await CameraManager.start(video, errEl);
  } catch (camErr) {
    setBannerStatus('reg', 'Camera access denied or unavailable.', 'bad');
    if (retryBtn) retryBtn.style.display = '';
    return;
  }

  const baseline = new AdaptiveBaseline(CALIBRATION_FRAMES);
  const stateMachine = new BlinkStateMachine(REQUIRED_BLINKS);
  const evidence = new EvidenceCollector(120);

  _regActive = true;
  setBannerStatus('reg', 'Look at camera and hold steady for calibration…', 'info');

  let framesProcessed = 0;
  const MAX_FRAMES = 500;

  const runLoop = async () => {
    if (!_regActive) return;

    framesProcessed++;
    if (framesProcessed > MAX_FRAMES) {
      _regActive = false;
      setBannerStatus('reg', 'Enrollment timed out. Click Retry to scan again.', 'bad');
      if (retryBtn) retryBtn.style.display = '';
      return;
    }

    let detections = [];
    try {
      detections = await faceapi
        .detectAllFaces(video, getDetectOptions())
        .withFaceLandmarks()
        .withFaceDescriptors();
    } catch (_) {}

    if (!_regActive) return;

    const quality = FaceQualityGate.validate(detections, video);
    if (!quality.ok) {
      drawFaceRing(overlayCanvas, video, quality, null, null);
      setBannerStatus('reg', quality.message, 'warning');
      setTimeout(runLoop, 90);
      return;
    }

    const det = quality.det;
    const earData = EarCalculator.calculate(det.landmarks);
    if (!earData) {
      setTimeout(runLoop, 80);
      return;
    }

    const now = Date.now();

    if (!baseline.isCalibrated) {
      baseline.addSample(earData.avgEAR);
      const progress = Math.round((baseline.samples.length / CALIBRATION_FRAMES) * 100);
      setBannerStatus('reg', `Calibrating resting baseline (${progress}%)…`, 'info');
      evidence.addFrame(now, earData, 'CALIBRATING', true, det.descriptor);
      drawFaceRing(overlayCanvas, video, quality, earData, { blinkCount: 0, requiredBlinks: 2, isClosed: false });
      setTimeout(runLoop, 80);
      return;
    }

    const blinkResult = stateMachine.update(earData, baseline, now);
    evidence.addFrame(now, earData, blinkResult.state, true, det.descriptor);
    drawFaceRing(overlayCanvas, video, quality, earData, blinkResult);
    updateBlinkDots('reg', blinkResult.blinkCount, REQUIRED_BLINKS);

    const collectedCount = evidence.descriptors.length;

    if (blinkResult.blinkCount === 0) {
      setBannerStatus('reg', `👁 Please blink twice to verify liveness (${collectedCount}/${ENROLL_SAMPLES} samples)…`, 'info');
    } else if (blinkResult.blinkCount === 1) {
      setBannerStatus('reg', `✔ 1st blink captured! Blink once more (1/2)…`, 'info');
    } else if (blinkResult.blinkCount >= REQUIRED_BLINKS) {
      if (collectedCount < ENROLL_SAMPLES) {
        setBannerStatus('reg', `Collecting diverse face samples (${collectedCount}/${ENROLL_SAMPLES})…`, 'info');
      } else {
        // Anti-photo diversity check
        const diversity = calculateSampleDiversity(evidence.descriptors);
        if (diversity < 0.0025) {
          setBannerStatus('reg', '⚠️ Static photo detected — live person required.', 'bad');
          evidence.descriptors = [];
          setTimeout(runLoop, 1500);
          return;
        }

        _regActive = false;
        setBannerStatus('reg', '✅ 2/2 blinks and face samples verified! Creating account…', 'ok');
        CameraManager.stop(video);

        try {
          const payload = {
            ...window._pendingRegPayload,
            descriptors: evidence.descriptors.map((d) => Array.from(d)),
          };
          const regRes = await window.iCashApi.register(payload);
          if (regRes.ok && regRes.user) {
            currentUser = regRes.user;
            sessionStorage.setItem('icash_session_active', 'true');
            enterDashboard();
          } else {
            throw new Error(regRes.message || 'Registration failed');
          }
        } catch (err) {
          setBannerStatus('reg', `❌ ${err.message || 'Registration failed.'}`, 'bad');
          if (retryBtn) retryBtn.style.display = '';
        }
        return;
      }
    }

    setTimeout(runLoop, 80);
  };

  runLoop();
}

function cancelRegisterScan() {
  teardownRegisterScan();
  goTo('screen-register-form');
}

function teardownRegisterScan() {
  _regActive = false;
  const video = document.getElementById('reg-video');
  CameraManager.stop(video);
  const oc = document.getElementById('reg-overlay-canvas');
  if (oc) oc.getContext('2d').clearRect(0, 0, oc.width, oc.height);
  updateBlinkDots('reg', 0, 2);
}

function captureRegisterFace() {
  setBannerStatus('reg', 'Automatic scan active. Look at camera to enroll.', 'info');
}

// ==============================================================================
// 3. TRANSACTION BIOMETRIC GATE
// ==============================================================================
let _gateActive = false;

async function launchBiometricGate(title, lead) {
  document.getElementById('verify-title').textContent = title || 'Authorize Transaction';
  document.getElementById('verify-lead').textContent = lead || 'Blink twice to verify your identity';
  document.getElementById('verify-msg').textContent = '';
  document.getElementById('verify-pin-block').style.display = 'none';

  openModal('verify');

  const video = document.getElementById('verify-video');
  const errEl = document.getElementById('verify-cam-error');
  const statusEl = document.getElementById('verify-scan-status');
  const retryBtn = document.getElementById('verify-retry-cam-btn');
  const captureBtn = document.getElementById('verify-capture-btn');

  if (captureBtn) captureBtn.style.display = 'none';
  if (retryBtn) retryBtn.style.display = 'none';
  if (statusEl) statusEl.textContent = 'Initializing biometric verification…';

  const parent = video ? video.parentElement : null;
  const overlayCanvas = getOverlayCanvas('verify-overlay-canvas', parent);

  const modelsOk = await ensureBioModels();
  if (!modelsOk) {
    if (statusEl) statusEl.textContent = 'Face models unavailable. Use PIN authorization.';
    toggleVerifyPin();
    return;
  }

  try {
    await CameraManager.start(video, errEl);
  } catch (camErr) {
    if (statusEl) statusEl.textContent = 'Camera unavailable. Use PIN authorization.';
    toggleVerifyPin();
    return;
  }

  // Issue challenge
  let challenge;
  try {
    challenge = await window.iCashApi.issueChallenge({
      userIdHint: currentUser ? currentUser.id : undefined,
    });
    if (!challenge.ok) throw new Error('Challenge creation failed');
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Liveness server unavailable. Use PIN.';
    toggleVerifyPin();
    return;
  }

  const baseline = new AdaptiveBaseline(CALIBRATION_FRAMES);
  const stateMachine = new BlinkStateMachine(REQUIRED_BLINKS);
  const evidence = new EvidenceCollector(120);

  _gateActive = true;
  if (statusEl) statusEl.textContent = 'Center your face and hold still to calibrate…';

  let framesProcessed = 0;
  const MAX_FRAMES = 400;

  const runLoop = async () => {
    if (!_gateActive) return;

    framesProcessed++;
    if (framesProcessed > MAX_FRAMES) {
      _gateActive = false;
      if (statusEl) statusEl.textContent = 'Verification timed out. Use PIN to authorize.';
      toggleVerifyPin();
      return;
    }

    let detections = [];
    try {
      detections = await faceapi
        .detectAllFaces(video, getDetectOptions())
        .withFaceLandmarks()
        .withFaceDescriptors();
    } catch (_) {}

    if (!_gateActive) return;

    const quality = FaceQualityGate.validate(detections, video);
    if (!quality.ok) {
      drawFaceRing(overlayCanvas, video, quality, null, null);
      if (statusEl) statusEl.textContent = quality.message;
      setTimeout(runLoop, 90);
      return;
    }

    const det = quality.det;
    const earData = EarCalculator.calculate(det.landmarks);
    if (!earData) {
      setTimeout(runLoop, 80);
      return;
    }

    const now = Date.now();

    if (!baseline.isCalibrated) {
      baseline.addSample(earData.avgEAR);
      const progress = Math.round((baseline.samples.length / CALIBRATION_FRAMES) * 100);
      if (statusEl) statusEl.textContent = `Calibrating baseline (${progress}%)…`;
      evidence.addFrame(now, earData, 'CALIBRATING', true, det.descriptor);
      drawFaceRing(overlayCanvas, video, quality, earData, { blinkCount: 0, requiredBlinks: 2, isClosed: false });
      setTimeout(runLoop, 80);
      return;
    }

    const blinkResult = stateMachine.update(earData, baseline, now);
    evidence.addFrame(now, earData, blinkResult.state, true, det.descriptor);
    drawFaceRing(overlayCanvas, video, quality, earData, blinkResult);

    if (blinkResult.blinkCount === 0) {
      if (statusEl) statusEl.textContent = '👁 Face aligned — blink twice to authorize (0/2)…';
    } else if (blinkResult.blinkCount === 1) {
      if (statusEl) statusEl.textContent = '✔ 1st blink verified! Blink once more (1/2)…';
    } else if (blinkResult.blinkCount >= REQUIRED_BLINKS) {
      _gateActive = false;
      if (statusEl) statusEl.textContent = '✅ Liveness verified! Validating with server…';

      try {
        const payload = evidence.getPackage(challenge.challengeId, challenge.nonce);
        if (currentUser) payload.userId = currentUser.id;

        const verifyRes = await window.iCashApi.verifyChallenge(payload);
        if (!verifyRes || !verifyRes.ok || !verifyRes.biometricToken) {
          throw new Error(verifyRes.message || 'Biometric authorization denied');
        }

        if (statusEl) statusEl.textContent = '✅ Authorized! Executing transaction…';
        CameraManager.stop(video);
        await executePendingAction();
        teardownVerifyGate();
        closeModal('verify');
      } catch (err) {
        const msgEl = document.getElementById('verify-msg');
        if (msgEl) {
          msgEl.textContent = err.message || 'Authorization failed.';
          msgEl.className = 'modal-msg err';
        }
        if (statusEl) statusEl.textContent = '❌ Authorization failed.';
      }
      return;
    }

    setTimeout(runLoop, 80);
  };

  runLoop();
}

function cancelVerify() {
  teardownVerifyGate();
  closeModal('verify');
  pendingVerificationAction = null;
  showAlertToast('Transaction cancelled.', true);
}

function teardownVerifyGate() {
  _gateActive = false;
  const video = document.getElementById('verify-video');
  CameraManager.stop(video);
  const oc = document.getElementById('verify-overlay-canvas');
  if (oc) oc.getContext('2d').clearRect(0, 0, oc.width, oc.height);
}

function captureVerifyFace() {
  toggleVerifyPin();
}

// Background preload of models on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => ensureBioModels(), 600);
});
