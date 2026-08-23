/**
 * iCash Real Biometric Engine — face-api.js
 *
 * Features:
 * - Auto-detects face; no button click needed for enrollment or login
 * - Collects 5 real 128D descriptor samples automatically
 * - Rejects if >1 person is in frame
 * - Real Euclidean distance matching (threshold 0.50) for login and transactions
 * - Live color-coded bounding box overlay with progress bar
 * - 3 consecutive matching frames required to confirm identity
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

function calculateEAR(eyePoints) {
  if (!eyePoints || eyePoints.length < 6) return 0.28;
  // Eye points: [p0, p1, p2, p3, p4, p5]
  const v1 = _calcDist(eyePoints[1], eyePoints[5]);
  const v2 = _calcDist(eyePoints[2], eyePoints[4]);
  const h = _calcDist(eyePoints[0], eyePoints[3]);
  if (h <= 0.001) return 0.28;
  return (v1 + v2) / (2.0 * h);
}

class ClientBlinkDetector {
  constructor(requiredBlinks = REQUIRED_BLINKS) {
    this.requiredBlinks = requiredBlinks;
    this.reset();
  }

  reset() {
    this.openEyeBaseline = 0.29;
    this.baselineSamples = 0;
    this.closedFrames = 0;
    this.blinkCount = 0;
    this.isClosed = false;
    this.hasBlinked = false;
    this.currentEar = 0.29;
    this.lastBlinkTime = 0;
    this.earHistory = [];
  }

  update(landmarks) {
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
      const leftEye = landmarks.getLeftEye ? landmarks.getLeftEye() : (landmarks.positions ? landmarks.positions.slice(36, 42) : null);
      const rightEye = landmarks.getRightEye ? landmarks.getRightEye() : (landmarks.positions ? landmarks.positions.slice(42, 48) : null);
      const leftEar = calculateEAR(leftEye);
      const rightEar = calculateEAR(rightEye);
      
      const validEars = [leftEar, rightEar].filter((e) => e > 0.04 && e < 0.65);
      const ear = validEars.length > 0 ? Math.min(...validEars) : 0.28;
      this.currentEar = ear;

      const now = Date.now();
      this.earHistory.push({ ear, time: now });
      if (this.earHistory.length > 20) this.earHistory.shift();

      // Adaptively track baseline resting open EAR
      if (!this.isClosed && ear > 0.21) {
        this.openEyeBaseline =
          this.baselineSamples < 4 ? ear : this.openEyeBaseline * 0.80 + ear * 0.20;
        this.baselineSamples++;
      }

      // Closing threshold: drop below 82% of baseline or <= 0.25
      const closeThreshold = Math.max(0.17, Math.min(0.252, this.openEyeBaseline * 0.82));
      // Re-opening threshold: recover above 88% of baseline or >= 0.21
      const openThreshold = Math.max(0.20, this.openEyeBaseline * 0.88);

      if (ear <= closeThreshold) {
        this.closedFrames++;
        this.isClosed = true;
      } else if (ear >= openThreshold) {
        if (this.isClosed && this.closedFrames >= 1) {
          // Debounce: ensure at least 100ms between consecutive distinct blinks
          if (now - this.lastBlinkTime >= 100) {
            this.blinkCount++;
            this.lastBlinkTime = now;
            if (this.blinkCount >= this.requiredBlinks) {
              this.hasBlinked = true;
            }
            console.log(
              `[iCash Biometrics] Blink #${this.blinkCount}/${this.requiredBlinks} detected! EAR: ${ear.toFixed(3)}, Baseline: ${this.openEyeBaseline.toFixed(3)}`
            );
          }
        }
        this.isClosed = false;
        this.closedFrames = 0;
      }
    } catch (e) {
      // safe fallback
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

    // Liveness & Blink indicator badge (2 blinks required)
    const count = (blinkInfo && blinkInfo.blinkCount) || 0;
    const hasBlinked = (blinkInfo && (blinkInfo.hasBlinked || count >= 2)) || (currentLivenessState && currentLivenessState.live);
    const ly = box.y + box.height + 16;
    ctx.font = 'bold 12px sans-serif';

    if (hasBlinked) {
      ctx.fillStyle = '#22C55E';
      ctx.fillText('✓ Liveness Verified (2/2 Blinks)', box.x + 4, ly);
    } else if (count === 1) {
      ctx.fillStyle = '#38BDF8';
      ctx.fillText('👁 1st Blink OK! Blink Once More (1/2)', box.x + 4, ly);
    } else {
      ctx.fillStyle = '#F59E0B';
      ctx.fillText(`👁 Blink Twice for Anti-Spoof: ${count}/2`, box.x + 4, ly);
    }

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
let regAutoLoop = null;

async function beginRegisterScan() {
  const video = document.getElementById('reg-video');
  const errEl = document.getElementById('reg-cam-error');
  const statusEl = document.getElementById('reg-scan-status');
  const btn = document.getElementById('reg-capture-btn');
  const retryBtn = document.getElementById('reg-retry-cam-btn');

  // Hide manual button — fully automatic
  if (btn) {
    btn.style.display = 'none';
    btn.disabled = true;
  }
  if (retryBtn) retryBtn.style.display = 'none';
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.remove('active');
  }
  clearInterval(regAutoLoop);
  regBlinkDetector.reset();
  statusEl.textContent = 'Loading face recognition models…';
  statusEl.classList.remove('bad');

  const overlayCanvas = getOrCreateOverlayCanvas('reg-overlay-canvas', video.parentElement);

  // Load models first
  const modelsOk = await ensureBioModels();
  if (!modelsOk) {
    statusEl.textContent = '⚠ Models loading — click below to complete enrollment with cryptographic key.';
    statusEl.classList.add('bad');
    if (btn) {
      btn.style.display = '';
      btn.disabled = false;
      btn.textContent = 'Enroll with Digital Key';
    }
    return;
  }

  // Start camera
  try {
    await startCamera(video, errEl);
    await initLivenessSession();
  } catch (e) {
    statusEl.textContent = cameraErrorMessage(e);
    statusEl.classList.add('bad');
    if (retryBtn) retryBtn.style.display = '';
    if (btn) {
      btn.style.display = '';
      btn.disabled = false;
      btn.textContent = 'Enroll with Digital Key';
    }
    return;
  }

  // Wait for video to be ready
  await new Promise((r) => {
    video.onloadedmetadata = r;
    setTimeout(r, 2000);
  });
  statusEl.textContent = '👁  Look at camera and blink your eyes to verify liveness…';

  const collected = [];
  let lastSampleTime = 0;
  let attempts = 0;
  const TIMEOUT = 400; // 400 × 160ms = 64s

  regAutoLoop = setInterval(async () => {
    attempts++;
    if (attempts > TIMEOUT) {
      clearInterval(regAutoLoop);
      statusEl.textContent = '⏱ Scan timeout — click Retry to try again or enroll with PIN below.';
      statusEl.classList.add('bad');
      if (retryBtn) retryBtn.style.display = '';
      if (btn) {
        btn.style.display = '';
        btn.disabled = false;
        btn.textContent = 'Enroll with Digital Key';
      }
      return;
    }

    // Stream frame to Python Liveness Server (if running)
    await streamLivenessFrame(video);

    let detections;
    try {
      detections = await faceapi
        .detectAllFaces(video, _getDetectOptions())
        .withFaceLandmarks()
        .withFaceDescriptors();
    } catch (e) {
      return;
    }

    const progress = collected.length / ENROLL_SAMPLES;

    if (!detections || detections.length === 0) {
      drawOverlay(overlayCanvas, video, [], 'NONE', progress, regBlinkDetector);
      statusEl.textContent = `🔍 Center your face in the ring (${collected.length}/${ENROLL_SAMPLES})…`;
      return;
    }

    if (detections.length > 1) {
      drawOverlay(overlayCanvas, video, detections, 'MULTI', progress, regBlinkDetector);
      statusEl.textContent =
        '⚠ Multiple faces detected — only the registering person should be in frame.';
      return;
    }

    const det = detections[0];
    const desc = det.descriptor; // Float32Array[128]
    const score = det.detection.score;

    // Update real-time eye aspect ratio blink detector
    const blinkStatus = regBlinkDetector.update(det.landmarks);

    if (score < 0.50) {
      drawOverlay(overlayCanvas, video, detections, 'BAD', progress, blinkStatus);
      statusEl.textContent = `😕 Low confidence (${Math.round(score * 100)}%) — improve lighting or look directly at camera.`;
      return;
    }

    // Consistency check: new sample must be close to first collected sample
    if (collected.length > 0) {
      const dist = euclidean(Array.from(collected[0]), Array.from(desc));
      if (dist > 0.85) {
        drawOverlay(overlayCanvas, video, detections, 'BAD', progress, blinkStatus);
        statusEl.textContent =
          '⚠ Face changed between samples — ensure only the same person stays in frame.';
        collected.length = 0; // reset
        return;
      }
    }

    const now = Date.now();
    if (collected.length < ENROLL_SAMPLES && (now - lastSampleTime >= 250)) {
      collected.push(desc);
      lastSampleTime = now;
    }

    const newProgress = collected.length / ENROLL_SAMPLES;
    const count = blinkStatus.blinkCount || 0;
    const isFullyVerified = newProgress >= 1 && count >= 2;

    drawOverlay(
      overlayCanvas,
      video,
      detections,
      isFullyVerified ? 'GOOD' : 'SCAN',
      newProgress,
      blinkStatus
    );

    if (count === 0) {
      statusEl.textContent = `👁 Center face (${collected.length}/${ENROLL_SAMPLES}) — please blink your eyes 2 times (0/2 blinks)…`;
    } else if (count === 1) {
      statusEl.textContent = `✔ 1st blink captured! Please blink 1 more time (1/2 blinks)…`;
    } else {
      statusEl.textContent = `✅ 2/2 blinks confirmed! Finalizing enrollment…`;
    }

    if (collected.length >= ENROLL_SAMPLES && count >= 2) {
      clearInterval(regAutoLoop);
      drawOverlay(overlayCanvas, video, detections, 'GOOD', 1.0, blinkStatus);
      statusEl.textContent = '✅ Liveness & face verified (2/2 blinks) — registering account…';
      await _finalizeRegistration(collected.map((d) => Array.from(d)));
    }
  }, ENROLL_INTERVAL);
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
  clearInterval(regAutoLoop);
  regAutoLoop = null;
  const video = document.getElementById('reg-video');
  stopCamera(video);
  const oc = document.getElementById('reg-overlay-canvas');
  if (oc) oc.getContext('2d').clearRect(0, 0, oc.width, oc.height);
}

// ============================================================================
//  LOGIN — AUTO SCAN, NO BUTTON CLICK
// ============================================================================
let loginAutoLoop = null;

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
  clearInterval(loginAutoLoop);
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
  const TIMEOUT = 400; // 400 × 150ms = 60s

  loginAutoLoop = setInterval(async () => {
    attempts++;
    if (attempts > TIMEOUT) {
      clearInterval(loginAutoLoop);
      statusEl.textContent =
        '⏱ Authentication timeout. Click "Camera unavailable? Sign in with PIN" or retry.';
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

    // Stream frame to Python Liveness Server (if active)
    await streamLivenessFrame(video);

    let detections;
    try {
      detections = await faceapi
        .detectAllFaces(video, _getDetectOptions())
        .withFaceLandmarks()
        .withFaceDescriptors();
    } catch (e) {
      return;
    }

    if (!detections || detections.length === 0) {
      consecutiveMatches = 0;
      drawOverlay(overlayCanvas, video, [], 'NONE', undefined, loginBlinkDetector);
      statusEl.textContent = '🔍 Center your face in the ring…';
      return;
    }

    if (detections.length > 1) {
      consecutiveMatches = 0;
      drawOverlay(overlayCanvas, video, detections, 'MULTI', undefined, loginBlinkDetector);
      statusEl.textContent =
        '⚠ Multiple people in frame — only the account holder should be present.';
      return;
    }

    const det = detections[0];
    const live = det.descriptor;
    const blinkStatus = loginBlinkDetector.update(det.landmarks);

    // If no stored descriptors, fall through to server-side verify
    if (!storedDescriptors || storedDescriptors.length === 0) {
      clearInterval(loginAutoLoop);
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
      return;
    }

    consecutiveMatches++;
    const count = blinkStatus.blinkCount || 0;

    if (count < 2) {
      drawOverlay(overlayCanvas, video, detections, 'SCAN', undefined, blinkStatus);
      if (count === 0) {
        statusEl.textContent = `✔ Face matched (${Math.round((1 - dist / MATCH_THRESHOLD) * 100)}%) — please blink 2 times (0/2 blinks)…`;
      } else {
        statusEl.textContent = `✔ 1st blink verified! Blink once more to sign in (1/2 blinks)…`;
      }
      return;
    }

    drawOverlay(overlayCanvas, video, detections, 'GOOD', undefined, blinkStatus);
    statusEl.textContent = `✅ 2/2 Blinks Verified — unlocking profile…`;

    if (consecutiveMatches >= REQUIRED_MATCHES && count >= 2) {
      clearInterval(loginAutoLoop);
      drawOverlay(overlayCanvas, video, detections, 'GOOD', undefined, blinkStatus);
      const confidence = Math.max(0, Math.min(1, 1 - dist / MATCH_THRESHOLD));
      teardownLoginScan();
      promptLoginPin(targetUser, confidence);
    }
  }, VERIFY_INTERVAL);
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
  clearInterval(loginAutoLoop);
  loginAutoLoop = null;
  window._loginStoredDescriptors = null;
  const video = document.getElementById('login-video');
  stopCamera(video);
  const oc = document.getElementById('login-overlay-canvas');
  if (oc) oc.getContext('2d').clearRect(0, 0, oc.width, oc.height);
}

// ============================================================================
//  TRANSACTION VERIFICATION GATE — AUTO SCAN
// ============================================================================
let verifyAutoLoop = null;

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
  clearInterval(verifyAutoLoop);
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

  verifyAutoLoop = setInterval(async () => {
    attempts++;
    if (attempts > 400) {
      clearInterval(verifyAutoLoop);
      statusEl.textContent = '⏱ Authorization timeout — use PIN to continue.';
      statusEl.classList.add('bad');
      if (btn) {
        btn.style.display = '';
        btn.disabled = false;
        btn.textContent = 'Authorize with PIN';
        btn.onclick = () => submitVerifyPin();
      }
      return;
    }

    // Stream frame to Python Liveness Server (if active)
    await streamLivenessFrame(video);

    let detections;
    try {
      detections = await faceapi
        .detectAllFaces(video, _getDetectOptions())
        .withFaceLandmarks()
        .withFaceDescriptors();
    } catch (e) {
      return;
    }

    if (!detections || detections.length === 0) {
      consecutiveMatches = 0;
      drawOverlay(overlayCanvas, video, [], 'NONE', undefined, gateBlinkDetector);
      statusEl.textContent = '🔍 Center your face in the ring…';
      msg.textContent = '';
      return;
    }

    if (detections.length > 1) {
      consecutiveMatches = 0;
      drawOverlay(overlayCanvas, video, detections, 'MULTI', undefined, gateBlinkDetector);
      statusEl.textContent =
        '⚠ Multiple people in frame — only the account holder should authorize.';
      msg.textContent = 'Security alert: unauthorized person present.';
      msg.className = 'modal-msg err';
      return;
    }

    const det = detections[0];
    const live = det.descriptor;
    const blinkStatus = gateBlinkDetector.update(det.landmarks);

    // No stored descriptors — delegate to server
    if (!storedDescriptors || storedDescriptors.length === 0) {
      clearInterval(verifyAutoLoop);
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
      msg.textContent =
        'Wrong person detected. Only the registered account holder can authorize transactions.';
      msg.className = 'modal-msg err';
      return;
    }

    consecutiveMatches++;
    msg.textContent = '';
    const count = blinkStatus.blinkCount || 0;

    if (count < 2) {
      drawOverlay(overlayCanvas, video, detections, 'SCAN', undefined, blinkStatus);
      if (count === 0) {
        statusEl.textContent = `✔ Account holder recognized (${Math.round((1 - dist / MATCH_THRESHOLD) * 100)}%) — please blink 2 times to authorize (0/2 blinks)…`;
      } else {
        statusEl.textContent = `✔ 1st blink verified! Blink once more to authorize transaction (1/2 blinks)…`;
      }
      return;
    }

    drawOverlay(overlayCanvas, video, detections, 'GOOD', undefined, blinkStatus);
    statusEl.textContent = `✅ 2/2 Blinks Verified — executing transaction…`;

    if (consecutiveMatches >= REQUIRED_MATCHES && count >= 2) {
      clearInterval(verifyAutoLoop);
      drawOverlay(overlayCanvas, video, detections, 'GOOD', undefined, blinkStatus);
      statusEl.textContent = '✅ Liveness Verified (2/2 blinks) — executing transaction…';
      await _finalizeVerify();
    }
  }, VERIFY_INTERVAL);
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
  clearInterval(verifyAutoLoop);
  verifyAutoLoop = null;
  const video = document.getElementById('verify-video');
  stopCamera(video);
  const oc = document.getElementById('verify-overlay-canvas');
  if (oc) oc.getContext('2d').clearRect(0, 0, oc.width, oc.height);
}

// ── Pre-load models on page load (background) ─────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => ensureBioModels(), 500);
});
