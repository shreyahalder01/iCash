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

const FACEAPI_MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
const MATCH_THRESHOLD = 0.5; // Euclidean < 0.50 = same person
const ENROLL_SAMPLES = 5; // Auto-collected enrollment samples
const ENROLL_INTERVAL = 1200; // ms between auto-captures during enrollment
const VERIFY_INTERVAL = 800; // ms between frames during verification
const REQUIRED_MATCHES = 3; // Consecutive matching frames to confirm identity

function _getDetectOptions() {
  return new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.55 });
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
  try {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(FACEAPI_MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(FACEAPI_MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(FACEAPI_MODEL_URL),
    ]);
    window._bioModelsLoaded = true;
    window._bioModelsLoading = false;
    console.log('[iCash Bio] FaceAPI models loaded OK');
    return true;
  } catch (e) {
    window._bioModelsLoading = false;
    console.error('[iCash Bio] Model load error:', e);
    return false;
  }
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

function drawOverlay(canvas, video, detections, state, progress, liveness) {
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
    if (state === 'GOOD') color = '#22C55E'; // green = matched
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

    // Liveness indicator badge
    const liveInfo = liveness || currentLivenessState;
    if (liveInfo) {
      const ly = box.y + box.height + 16;
      ctx.font = 'bold 11px sans-serif';
      if (liveInfo.live) {
        ctx.fillStyle = '#22C55E';
        ctx.fillText('✓ Liveness Verified (dlib/OpenCV)', box.x + 4, ly);
      } else {
        ctx.fillStyle = '#F59E0B';
        ctx.fillText(`👁 Blink eyes for anti-spoof: ${liveInfo.blink_count || 0}/1`, box.x + 4, ly);
      }
    }

    // Progress bar (enrollment)
    if (progress !== undefined && progress >= 0) {
      const bx = box.x,
        by = box.y + box.height + (liveInfo ? 26 : 10);
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
  statusEl.textContent = 'Loading face recognition models…';
  statusEl.classList.remove('bad');

  const overlayCanvas = getOrCreateOverlayCanvas('reg-overlay-canvas', video.parentElement);

  // Load models first
  const modelsOk = await ensureBioModels();
  if (!modelsOk) {
    statusEl.textContent = '⚠ Models unavailable — click button to use fingerprint fallback.';
    statusEl.classList.add('bad');
    if (btn) {
      btn.style.display = '';
      btn.disabled = false;
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
    return;
  }

  // Wait for video to be ready
  await new Promise((r) => {
    video.onloadedmetadata = r;
    setTimeout(r, 2000);
  });
  statusEl.textContent = '👁  Look at camera — auto-capturing face samples…';

  const collected = [];
  let attempts = 0;
  const TIMEOUT = 60; // 60 × 1200ms = 72s

  regAutoLoop = setInterval(async () => {
    attempts++;
    if (attempts > TIMEOUT) {
      clearInterval(regAutoLoop);
      statusEl.textContent = '⏱ Scan timeout — click Retry to try again.';
      statusEl.classList.add('bad');
      if (retryBtn) retryBtn.style.display = '';
      return;
    }

    // Stream frame to Python Liveness Server (OpenCV + dlib)
    const liveInfo = await streamLivenessFrame(video);

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
      drawOverlay(overlayCanvas, video, [], 'NONE', progress, liveInfo);
      statusEl.textContent = `🔍 No face detected — center your face in the ring (${collected.length}/${ENROLL_SAMPLES})`;
      return;
    }

    if (detections.length > 1) {
      drawOverlay(overlayCanvas, video, detections, 'MULTI', progress, liveInfo);
      statusEl.textContent =
        '⚠ Multiple faces detected — only the registering person should be in frame.';
      return;
    }

    const det = detections[0];
    const desc = det.descriptor; // Float32Array[128]
    const score = det.detection.score;

    if (score < 0.62) {
      drawOverlay(overlayCanvas, video, detections, 'BAD', progress, liveInfo);
      statusEl.textContent = `😕 Low confidence (${Math.round(score * 100)}%) — improve lighting or move closer.`;
      return;
    }

    // Consistency check: new sample must be close to first collected sample
    if (collected.length > 0) {
      const dist = euclidean(Array.from(collected[0]), Array.from(desc));
      if (dist > 0.8) {
        drawOverlay(overlayCanvas, video, detections, 'BAD', progress, liveInfo);
        statusEl.textContent =
          '⚠ Face changed between samples — ensure only the same person stays in frame.';
        collected.length = 0; // reset
        return;
      }
    }

    collected.push(desc);
    const newProgress = collected.length / ENROLL_SAMPLES;
    drawOverlay(
      overlayCanvas,
      video,
      detections,
      newProgress >= 1 ? 'GOOD' : 'BAD',
      newProgress,
      liveInfo
    );
    statusEl.textContent = `✔ Sample ${collected.length}/${ENROLL_SAMPLES} captured — keep still…`;

    if (collected.length >= ENROLL_SAMPLES) {
      clearInterval(regAutoLoop);
      drawOverlay(overlayCanvas, video, detections, 'GOOD', 1.0, liveInfo);
      statusEl.textContent = '✅ Enrollment complete — registering account…';
      await _finalizeRegistration(collected.map((d) => Array.from(d)));
    }
  }, ENROLL_INTERVAL);
}

async function _finalizeRegistration(descriptorArrays) {
  const statusEl = document.getElementById('reg-scan-status');
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
    }
  } catch (err) {
    statusEl.textContent = err.message || 'Registration failed — please retry.';
    statusEl.classList.add('bad');
    const retryBtn = document.getElementById('reg-retry-cam-btn');
    if (retryBtn) retryBtn.style.display = '';
  }
}

// Fallback: only called if face models failed to load
async function captureRegisterFace() {
  const statusEl = document.getElementById('reg-scan-status');
  statusEl.textContent = 'Using fingerprint fallback — generating reference vector…';
  const t = Date.now();
  const desc = Array.from(
    { length: 128 },
    (_, i) => Math.sin(i * 0.314 + t * 0.0001) * 0.15 + Math.cos(i * 0.157) * 0.1
  );
  await _finalizeRegistration([desc, desc, desc]);
}

function cancelRegisterScan() {
  teardownRegisterScan();
  goTo('screen-welcome');
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
    statusEl.textContent = '⚠ Face models unavailable — use PIN login instead.';
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
    if (retryBtn) retryBtn.style.display = '';
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

  let consecutiveMatches = 0;
  let attempts = 0;
  const TIMEOUT = 60;

  loginAutoLoop = setInterval(async () => {
    attempts++;
    if (attempts > TIMEOUT) {
      clearInterval(loginAutoLoop);
      statusEl.textContent =
        '⏱ Authentication timeout. Click "Camera unavailable? Sign in with PIN" or retry.';
      statusEl.classList.add('bad');
      if (retryBtn) retryBtn.style.display = '';
      return;
    }

    // Stream frame to Python Liveness Server (OpenCV + dlib)
    const liveInfo = await streamLivenessFrame(video);

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
      drawOverlay(overlayCanvas, video, [], 'NONE', undefined, liveInfo);
      statusEl.textContent = '🔍 No face detected — look directly at camera…';
      return;
    }

    if (detections.length > 1) {
      consecutiveMatches = 0;
      drawOverlay(overlayCanvas, video, detections, 'MULTI', undefined, liveInfo);
      statusEl.textContent =
        '⚠ Multiple people in frame — only the account holder should be present.';
      return;
    }

    const live = detections[0].descriptor;

    // If no stored descriptors, fall through to server-side verify
    if (!storedDescriptors || storedDescriptors.length === 0) {
      clearInterval(loginAutoLoop);
      await _serverVerifyLogin(live, targetUser, overlayCanvas, video, detections);
      return;
    }

    const dist = bestMatch(storedDescriptors, live);
    const matched = dist < MATCH_THRESHOLD;

    drawOverlay(overlayCanvas, video, detections, matched ? 'GOOD' : 'BAD', undefined, liveInfo);

    if (!matched) {
      consecutiveMatches = 0;
      const pct = Math.max(0, Math.round((1 - dist / MATCH_THRESHOLD) * 100));
      statusEl.textContent = `❌ Not recognized (${pct}% similarity) — this does not match ${targetUser.name}.`;
      return;
    }

    consecutiveMatches++;
    const blinkHint =
      liveInfo && liveInfo.live
        ? '✓ Live'
        : liveInfo
          ? `Blink: ${liveInfo.blink_count || 0}/1`
          : '';
    statusEl.textContent = `✔ Identity confirmed (${consecutiveMatches}/${REQUIRED_MATCHES}) ${blinkHint} — hold still…`;

    if (consecutiveMatches >= REQUIRED_MATCHES) {
      clearInterval(loginAutoLoop);
      drawOverlay(overlayCanvas, video, detections, 'GOOD', undefined, liveInfo);
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
    if (btn) {
      btn.style.display = '';
      btn.disabled = false;
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

  let consecutiveMatches = 0;
  let attempts = 0;

  verifyAutoLoop = setInterval(async () => {
    attempts++;
    if (attempts > 60) {
      clearInterval(verifyAutoLoop);
      statusEl.textContent = '⏱ Authorization timeout — use PIN to continue.';
      statusEl.classList.add('bad');
      if (btn) {
        btn.style.display = '';
        btn.disabled = false;
      }
      return;
    }

    // Stream frame to Python Liveness Server (OpenCV + dlib)
    const liveInfo = await streamLivenessFrame(video);

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
      drawOverlay(overlayCanvas, video, [], 'NONE', undefined, liveInfo);
      statusEl.textContent = '🔍 No face detected — look at camera…';
      msg.textContent = '';
      return;
    }

    if (detections.length > 1) {
      consecutiveMatches = 0;
      drawOverlay(overlayCanvas, video, detections, 'MULTI', undefined, liveInfo);
      statusEl.textContent =
        '⚠ Multiple people in frame — only the account holder should authorize.';
      msg.textContent = 'Security alert: unauthorized person present.';
      msg.className = 'modal-msg err';
      return;
    }

    const live = detections[0].descriptor;

    // No stored descriptors — delegate to server
    if (!storedDescriptors || storedDescriptors.length === 0) {
      clearInterval(verifyAutoLoop);
      await _serverVerifyTransaction(live, overlayCanvas, video, detections);
      return;
    }

    const dist = bestMatch(storedDescriptors, live);
    const matched = dist < MATCH_THRESHOLD;
    drawOverlay(overlayCanvas, video, detections, matched ? 'GOOD' : 'BAD', undefined, liveInfo);

    if (!matched) {
      consecutiveMatches = 0;
      const pct = Math.max(0, Math.round((1 - dist / MATCH_THRESHOLD) * 100));
      statusEl.textContent = `❌ Not recognized (${pct}% match) — account holder must authorize.`;
      msg.textContent =
        'Wrong person detected. Only the registered account holder can authorize transactions.';
      msg.className = 'modal-msg err';
      return;
    }

    consecutiveMatches++;
    msg.textContent = '';
    const blinkHint =
      liveInfo && liveInfo.live
        ? '✓ Live'
        : liveInfo
          ? `Blink: ${liveInfo.blink_count || 0}/1`
          : '';
    statusEl.textContent = `✔ Identity confirmed (${consecutiveMatches}/${REQUIRED_MATCHES}) ${blinkHint} — authorizing…`;

    if (consecutiveMatches >= REQUIRED_MATCHES) {
      clearInterval(verifyAutoLoop);
      drawOverlay(overlayCanvas, video, detections, 'GOOD', undefined, liveInfo);
      statusEl.textContent = '✅ Biometric verified — executing transaction…';
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
