'use strict';

/* ============================================================
   Beat Counter v2
   - Adaptive-threshold mic onset detector (kick band)
   - PLL tempo tracker (period + phase + stability)
   - Outlier rejection, automatic octave correction
   - Combined Mic + Tap input via a shared event bus
   - Wake lock, auto-resume, hidden settings drawer
   ============================================================ */

// ---------- DOM ----------
const bpmEl       = document.getElementById('bpm');
const stabSpan    = document.querySelector('#stability > span');
const statusEl    = document.getElementById('status');
const tapLayer    = document.getElementById('taplayer');
const stopBtn     = document.getElementById('stop');
const segBtns     = document.querySelectorAll('.seg-btn');
const settingsBtn = document.getElementById('settings-btn');
const drawer      = document.getElementById('drawer');
const optSens     = document.getElementById('opt-sens');
const optMin      = document.getElementById('opt-min');
const optMax      = document.getElementById('opt-max');
const optAgg      = document.getElementById('opt-agg');
const optFlash    = document.getElementById('opt-flash');
const optReset    = document.getElementById('opt-reset');
const optClose    = document.getElementById('opt-close');
const flashEl     = document.getElementById('flash');
const lockBadge   = document.getElementById('lock');

// ---------- Settings (persisted) ----------
const SETTINGS_KEY = 'beatcounter.v2.settings';
const DEFAULTS = {
  sensitivity: 1.0,   // multiplier on adaptive threshold (>1 = less sensitive)
  bpmMin: 70,
  bpmMax: 180,
  aggressiveness: 1.0,// multiplier on PLL gains
  flash: true,        // full-screen beat-synced flash overlay
};
let settings = Object.assign({}, DEFAULTS, loadSettings());
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); }
  catch (_) { return {}; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
  catch (_) {}
}

// ---------- Tunables ----------
const KICK_CUTOFF_HZ = 150;
const FFT_SIZE       = 1024;     // ~21 ms hop at 48 kHz
const ENERGY_HISTORY = 64;       // ~1.3 s of energy history for MAD baseline
const REFRACTORY_MS  = 180;      // min between mic events (allows up to ~333 BPM raw, clamped later)
const PLL_ALPHA      = 0.06;     // period gain (per unit confidence)
const PLL_BETA       = 0.25;     // phase  gain (per unit confidence)
const STABILITY_TC   = 0.12;     // EMA factor for stability metric
const PERIOD_SAMPLES = 12;       // for slow display median
const STALE_MS       = 3000;     // no events for this long -> reset
const LOCK_TIGHT_FRAC= 0.15;     // |e|/period below this counts as a "tight" hit
const LOCK_STABILITY = 0.6;      // stability EMA threshold for lock
const LOCK_HITS_NEED = 8;        // consecutive tight hits to lock
const FLASH_PEAK     = 0.18;     // overlay opacity at peak of each beat flash

// ---------- State ----------
let mode = 'both';               // 'mic' | 'both' | 'tap'
let running = false;
let started = false;             // user has interacted at least once
let micOn  = false;              // mic actually capturing

// Tracker state
let period       = null;         // ms per beat (the PLL's working estimate)
let nextBeat     = null;         // predicted time (performance.now ms) of next beat
let lastEventAt  = 0;
let stability    = 0;
let periodSamples = [];          // recent period samples for slow display median
let recentEvents = [];           // recent event timestamps (for octave check)
let displayedBpm = null;

// Lock state
let tightHits = 0;               // consecutive PLL events with tight error
let locked    = false;

// Audio state
let audioCtx, micStream, sourceNode, filterNode, analyser, audioBuf;
let micRafId = null;
let micLastEventAt = 0;
let energyHistory = [];

// Wake lock state
let wakeLock = null;

// ---------- Utilities ----------
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function setStatus(msg) { statusEl.textContent = msg || ''; }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------- BPM display ----------
function setBpm(v) {
  if (v == null || !isFinite(v)) {
    bpmEl.textContent = '--';
    bpmEl.classList.add('idle');
    stabSpan.style.width = '0%';
    return;
  }
  bpmEl.textContent = String(Math.round(v));
  bpmEl.classList.remove('idle');
}

function updateStabilityBar() {
  const pct = clamp(stability, 0, 1) * 100;
  stabSpan.style.width = pct.toFixed(1) + '%';
  // Color fades from red -> green as stability rises
  stabSpan.style.background =
    stability > 0.7 ? 'var(--ok)' : stability > 0.4 ? 'var(--accent)' : '#666';
}

function pulse() {
  bpmEl.classList.add('pulse');
  setTimeout(() => bpmEl.classList.remove('pulse'), 70);
  if (settings.flash) {
    // Tag overlay colour by lock state, then snap opacity high and let CSS fade it
    flashEl.classList.toggle('locked', locked);
    flashEl.style.transition = 'none';
    flashEl.style.opacity = String(FLASH_PEAK);
    // Force reflow so the next style change animates
    // eslint-disable-next-line no-unused-expressions
    flashEl.offsetHeight;
    flashEl.style.transition = '';
    flashEl.style.opacity = '0';
  }
  if (navigator.vibrate) { try { navigator.vibrate(12); } catch (_) {} }
}

function setLocked(next) {
  if (next === locked) return;
  locked = next;
  bpmEl.classList.toggle('locked', locked);
  lockBadge.classList.toggle('hidden', !locked);
}

// ---------- Event bus / PLL ----------
/**
 * Register a beat candidate event.
 * @param {number} t      performance.now() timestamp (ms)
 * @param {number} conf   confidence in [0, 1] (tap = 1.0)
 * @param {string} source 'tap' | 'mic'
 */
function registerBeatEvent(t, conf, source) {
  // Stale reset: long silence wipes state
  if (lastEventAt && t - lastEventAt > STALE_MS) {
    period = null; nextBeat = null;
    periodSamples = []; recentEvents = [];
    stability = 0;
    displayedBpm = null;
    tightHits = 0;
    setLocked(false);
    setBpm(null);
  }
  lastEventAt = t;

  // Always keep recent events for octave evaluation
  recentEvents.push({ t, conf });
  if (recentEvents.length > 16) recentEvents.shift();

  if (period == null) {
    // Initialisation: need a second event to set initial period
    if (recentEvents.length >= 2) {
      const prev = recentEvents[recentEvents.length - 2];
      const dt = t - prev.t;
      const minP = 60000 / settings.bpmMax;
      const maxP = 60000 / settings.bpmMin;
      if (dt >= minP * 0.5 && dt <= maxP * 2) {
        // accept any in a wide range; octave-lock will fix it later
        period = clamp(dt, minP * 0.5, maxP * 2);
        nextBeat = t + period;
        stability = conf * 0.3;
        periodSamples = [period];
      }
    }
    pulse();
    return;
  }

  // Predict the nearest beat slot to t
  const nBeats = Math.round((t - (nextBeat - period)) / period);
  const predicted = (nextBeat - period) + nBeats * period;
  const e = t - predicted; // signed error in ms, in [-period/2, +period/2] ideally

  // Outlier rejection: ignore events very far from any beat slot,
  // unless confidence is high (tap).
  if (Math.abs(e) > period * 0.45 && conf < 0.9) {
    // still maintain a soft "alive" feel
    return;
  }

  // PLL update (gains scaled by confidence and user aggressiveness)
  const agg = settings.aggressiveness;
  const cα = PLL_ALPHA * conf * agg;
  const cβ = PLL_BETA  * conf * agg;
  period   += cα * e;
  nextBeat += cβ * e; // phase pull

  // Advance nextBeat forward of "now" using the freshly updated period
  while (nextBeat <= t) nextBeat += period;

  // Clamp period to sane envelope (very wide; octave-lock then tightens)
  const minP = 60000 / 240;
  const maxP = 60000 / 40;
  period = clamp(period, minP, maxP);

  // Stability EMA: 1 = perfect agreement, 0 = error of half a beat
  const agreement = 1 - Math.min(1, (2 * Math.abs(e)) / period);
  stability = (1 - STABILITY_TC) * stability + STABILITY_TC * agreement * conf;

  // Lock state machine: count tight hits, lock once we've had enough in a row.
  const errFrac = Math.abs(e) / period;
  if (errFrac < LOCK_TIGHT_FRAC && stability >= LOCK_STABILITY) {
    tightHits = Math.min(LOCK_HITS_NEED + 4, tightHits + 1);
    if (tightHits >= LOCK_HITS_NEED) setLocked(true);
  } else if (errFrac > 0.25 || stability < 0.35) {
    tightHits = Math.max(0, tightHits - 2);
    if (tightHits <= LOCK_HITS_NEED / 2) setLocked(false);
  } else {
    tightHits = Math.max(0, tightHits - 1);
  }

  // Octave correction (band-snap with hysteresis)
  octaveCheck();

  // Slow display BPM = recency-weighted median of recent periods
  periodSamples.push(period);
  if (periodSamples.length > PERIOD_SAMPLES) periodSamples.shift();
  const medP = median(periodSamples);
  const rawBpm = 60000 / medP;
  // smooth display lightly toward target
  displayedBpm = displayedBpm == null
    ? rawBpm
    : displayedBpm * 0.55 + rawBpm * 0.45;

  setBpm(displayedBpm);
  updateStabilityBar();
  pulse();
}

function octaveCheck() {
  // If current BPM falls outside user-configured musical band,
  // double or halve the period to bring it back, *if* enough events agree
  // that the alternative is also consistent.
  const curBpm = 60000 / period;
  let target = period;
  if (curBpm < settings.bpmMin && curBpm * 2 <= settings.bpmMax) target = period / 2;
  else if (curBpm > settings.bpmMax && curBpm / 2 >= settings.bpmMin) target = period * 2;
  if (target === period) return;

  // Confirm with phase-coherence: how many recent inter-event intervals
  // are closer to the target period than to the current one?
  if (recentEvents.length < 3) return;
  let votes = 0, total = 0;
  for (let i = 1; i < recentEvents.length; i++) {
    const dt = recentEvents[i].t - recentEvents[i - 1].t;
    const errCur = Math.min(
      Math.abs(((dt + period / 2) % period) - period / 2),
      Math.abs(((dt + period) % (2 * period)) - period));
    const errTgt = Math.min(
      Math.abs(((dt + target / 2) % target) - target / 2),
      Math.abs(((dt + target) % (2 * target)) - target));
    if (errTgt < errCur) votes++;
    total++;
  }
  if (votes / total > 0.6) {
    period = target;
    // Re-seed phase from latest event
    nextBeat = recentEvents[recentEvents.length - 1].t + period;
    // Mild stability reset so display isn't overconfident immediately
    stability *= 0.5;
    periodSamples = [period];
    // Octave change invalidates the lock
    tightHits = 0;
    setLocked(false);
  }
}

// Staleness watchdog: blank display if nothing happens
setInterval(() => {
  if (!lastEventAt) return;
  const now = performance.now();
  if (now - lastEventAt > STALE_MS) {
    period = null; nextBeat = null;
    periodSamples = []; recentEvents = [];
    stability = 0; displayedBpm = null;
    tightHits = 0;
    setLocked(false);
    setBpm(null);
    updateStabilityBar();
  } else if (now - lastEventAt > 1500) {
    // decay stability quickly when events stop arriving
    stability *= 0.92;
    if (stability < 0.35) setLocked(false);
    updateStabilityBar();
  }
}, 400);

// ---------- Mic onset detector (adaptive threshold) ----------
async function startMic() {
  if (micOn) return true;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') {
      try { await audioCtx.resume(); } catch (_) {}
    }
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
      },
    });
    sourceNode = audioCtx.createMediaStreamSource(micStream);

    filterNode = audioCtx.createBiquadFilter();
    filterNode.type = 'lowpass';
    filterNode.frequency.value = KICK_CUTOFF_HZ;
    filterNode.Q.value = 0.7;

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0;

    sourceNode.connect(filterNode);
    filterNode.connect(analyser);

    audioBuf = new Float32Array(analyser.fftSize);
    energyHistory = [];
    micLastEventAt = 0;
    micOn = true;
    micLoop();
    return true;
  } catch (err) {
    console.warn('Mic error:', err);
    micOn = false;
    return false;
  }
}

function stopMic() {
  if (!micOn) return;
  if (micRafId) cancelAnimationFrame(micRafId);
  micRafId = null;
  try { sourceNode && sourceNode.disconnect(); } catch (_) {}
  try { filterNode && filterNode.disconnect(); } catch (_) {}
  try { analyser   && analyser.disconnect();   } catch (_) {}
  if (micStream)  micStream.getTracks().forEach(t => t.stop());
  if (audioCtx)   audioCtx.close().catch(() => {});
  audioCtx = micStream = sourceNode = filterNode = analyser = null;
  micOn = false;
}

function micLoop() {
  if (!analyser) return;
  analyser.getFloatTimeDomainData(audioBuf);
  let sum = 0;
  for (let i = 0; i < audioBuf.length; i++) sum += audioBuf[i] * audioBuf[i];
  const rms = Math.sqrt(sum / audioBuf.length);

  energyHistory.push(rms);
  if (energyHistory.length > ENERGY_HISTORY) energyHistory.shift();

  if (energyHistory.length >= 16) {
    // Median + MAD for an adaptive threshold robust to spiky noise.
    const med = median(energyHistory);
    const dev = energyHistory.map(v => Math.abs(v - med));
    const mad = median(dev) || 1e-6;
    // sensitivity > 1 = need more energy to trigger; < 1 = trigger more easily
    const k = 4 * settings.sensitivity;
    const threshold = med + k * mad;

    const now = performance.now();
    if (rms > threshold && rms > 0.002 && (now - micLastEventAt) > REFRACTORY_MS) {
      const conf = clamp((rms - threshold) / Math.max(threshold, 1e-6), 0, 1);
      // Map raw confidence to a milder range so taps still dominate
      const micConf = 0.3 + 0.5 * conf;
      micLastEventAt = now;
      registerBeatEvent(now, micConf, 'mic');
    }
  }

  micRafId = requestAnimationFrame(micLoop);
}

// ---------- Tap input ----------
let lastTapAt = 0;
function handleTap(e) {
  if (e && e.cancelable) e.preventDefault();
  if (mode === 'mic') return;
  const now = performance.now();
  if (now - lastTapAt < 80) return; // debounce double-touches
  lastTapAt = now;
  // First gesture also triggers session start (auto-start)
  ensureStarted();
  registerBeatEvent(now, 1.0, 'tap');
}

tapLayer.addEventListener('touchstart', handleTap, { passive: false });
tapLayer.addEventListener('mousedown',  handleTap);

// ---------- Mode control ----------
function applyMode() {
  segBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  // Tap layer disabled in mic-only mode
  if (mode === 'mic') tapLayer.classList.add('off');
  else                tapLayer.classList.remove('off');

  // Manage mic
  if (running) {
    if (mode === 'tap') {
      if (micOn) stopMic();
    } else {
      if (!micOn) startMic().then(ok => {
        if (!ok) setStatus('Mic blocked — using Tap mode');
      });
    }
  }

  setStatus(modeHint());
}
function modeHint() {
  if (!running) return 'Tap anywhere to start';
  if (mode === 'mic')  return 'Listening…';
  if (mode === 'tap')  return 'Tap to the beat';
  return 'Listening — tap anytime to anchor';
}
segBtns.forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    mode = btn.dataset.mode;
    applyMode();
    // If user hasn't started yet, the segmented button counts as the
    // user gesture that unlocks mic (in mic-only mode the tap layer is off,
    // so this is the only way to start).
    if (!running) ensureStarted();
  });
});

// ---------- Auto-start / Stop ----------
async function ensureStarted() {
  if (running) return;
  running = true;
  started = true;
  stopBtn.classList.remove('hidden');
  if (mode !== 'tap') {
    const ok = await startMic();
    if (!ok && mode === 'mic') {
      mode = 'tap';
      applyMode();
      setStatus('Mic blocked — using Tap mode');
      return;
    } else if (!ok && mode === 'both') {
      setStatus('Mic blocked — Tap still works');
    }
  }
  acquireWakeLock();
  setStatus(modeHint());
}

function stopAll() {
  running = false;
  stopMic();
  releaseWakeLock();
  stopBtn.classList.add('hidden');
  setStatus('Tap anywhere to start');
}

stopBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  stopAll();
});

// ---------- Wake lock ----------
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (_) {}
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

// Re-acquire wake lock + resume audio after returning to foreground
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !running) return;
  if (!wakeLock) acquireWakeLock();
  if (audioCtx && audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch (_) {}
  }
  // Rebuild mic pipeline if it should be running but the stream tracks died
  // (iOS audio interruption / route change).
  if ((mode === 'mic' || mode === 'both')) {
    const tracksDead = micStream && micStream.getTracks().every(t => t.readyState !== 'live');
    if (!micOn || tracksDead) {
      stopMic();
      startMic();
    }
  }
});

// ---------- Settings drawer ----------
function refreshSettingsUi() {
  optSens.value = settings.sensitivity;
  optMin.value  = settings.bpmMin;
  optMax.value  = settings.bpmMax;
  optAgg.value  = settings.aggressiveness;
  optFlash.checked = !!settings.flash;
  document.getElementById('opt-sens-val').textContent = (+settings.sensitivity).toFixed(1);
  document.getElementById('opt-min-val').textContent  = String(settings.bpmMin);
  document.getElementById('opt-max-val').textContent  = String(settings.bpmMax);
  document.getElementById('opt-agg-val').textContent  = (+settings.aggressiveness).toFixed(1);
}
refreshSettingsUi();

settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  drawer.classList.toggle('hidden');
});
optClose.addEventListener('click', () => drawer.classList.add('hidden'));
drawer.addEventListener('click', (e) => {
  // click on backdrop closes
  if (e.target === drawer) drawer.classList.add('hidden');
});

function bindRange(input, key, parser) {
  input.addEventListener('input', () => {
    settings[key] = parser(input.value);
    saveSettings();
    refreshSettingsUi();
  });
}
bindRange(optSens, 'sensitivity',    parseFloat);
bindRange(optAgg,  'aggressiveness', parseFloat);
optMin.addEventListener('input', () => {
  settings.bpmMin = Math.min(parseInt(optMin.value, 10), settings.bpmMax - 10);
  saveSettings(); refreshSettingsUi();
});
optMax.addEventListener('input', () => {
  settings.bpmMax = Math.max(parseInt(optMax.value, 10), settings.bpmMin + 10);
  saveSettings(); refreshSettingsUi();
});

optFlash.addEventListener('change', () => {
  settings.flash = optFlash.checked;
  saveSettings();
  // Hide overlay immediately if turned off mid-pulse
  if (!settings.flash) flashEl.style.opacity = '0';
});

optReset.addEventListener('click', () => {
  period = null; nextBeat = null;
  periodSamples = []; recentEvents = [];
  stability = 0; displayedBpm = null;
  tightHits = 0;
  setLocked(false);
  setBpm(null); updateStabilityBar();
  setStatus('Tracker reset');
});

// Prevent iOS double-tap zoom on quick taps
document.addEventListener('gesturestart', e => e.preventDefault());

// Initial state
applyMode();
setStatus('Tap anywhere to start');
