'use strict';

// --- DOM ---
const bpmEl    = document.getElementById('bpm');
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('start');
const modeBtn  = document.getElementById('mode');
const tapBtn   = document.getElementById('tap');

// --- Tunables ---
const KICK_CUTOFF_HZ   = 150;   // low-pass to isolate kick drum
const ENERGY_WINDOW_MS = 20;    // RMS window
const BASELINE_TC_MS   = 1000;  // moving baseline time-constant
const TRIGGER_RATIO    = 1.4;   // instantaneous / baseline to fire a beat
const REFRACTORY_MS    = 250;   // min gap between beats -> caps at 240 BPM
const BEATS_FOR_BPM    = 8;     // window of intervals for rolling median
const BPM_MIN          = 60;
const BPM_MAX          = 200;
const STALE_MS         = 2500;  // if no beat for this long, show '--'

// --- State ---
let mode = 'mic';              // 'mic' | 'tap'
let running = false;
let audioCtx = null;
let micStream = null;
let sourceNode = null;
let filterNode = null;
let analyser = null;
let rafId = null;

let baseline = 0;              // EMA of energy
let lastBeatAt = 0;            // performance.now() of last beat
let intervals = [];            // last N inter-beat intervals (ms)
let displayedBpm = null;

// ---------- Utility ----------
function setStatus(text)  { statusEl.textContent = text; }
function setBpm(value, conf) {
  if (value == null) {
    bpmEl.textContent = '--';
    bpmEl.className = 'bpm idle';
    return;
  }
  bpmEl.textContent = String(Math.round(value));
  bpmEl.classList.remove('idle', 'low-conf', 'ok');
  bpmEl.classList.add(conf >= 0.6 ? 'ok' : 'low-conf');
}

function pulse() {
  bpmEl.classList.add('pulse');
  setTimeout(() => bpmEl.classList.remove('pulse'), 70);
  if (navigator.vibrate) {
    try { navigator.vibrate(15); } catch (_) {}
  }
}

function median(arr) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------- Beat bookkeeping (shared by mic + tap) ----------
function registerBeat(now) {
  if (lastBeatAt) {
    const dt = now - lastBeatAt;
    if (dt >= REFRACTORY_MS && dt <= 2000) {
      intervals.push(dt);
      if (intervals.length > BEATS_FOR_BPM) intervals.shift();
    } else if (dt > 2000) {
      // long gap -> restart interval window
      intervals = [];
    }
  }
  lastBeatAt = now;
  pulse();
  updateBpm();
}

function updateBpm() {
  if (intervals.length < 2) {
    setBpm(null);
    return;
  }
  const medMs = median(intervals);
  let bpm = 60000 / medMs;
  if (bpm < BPM_MIN || bpm > BPM_MAX) { setBpm(null); return; }
  // Smooth a touch: average with previous displayed value.
  displayedBpm = displayedBpm == null ? bpm : displayedBpm * 0.4 + bpm * 0.6;
  const conf = Math.min(1, intervals.length / BEATS_FOR_BPM);
  setBpm(displayedBpm, conf);
}

// Watchdog: clear display if no beats for a while
setInterval(() => {
  if (lastBeatAt && performance.now() - lastBeatAt > STALE_MS) {
    intervals = [];
    displayedBpm = null;
    setBpm(null);
  }
}, 500);

// ---------- Mic mode ----------
async function startMic() {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
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
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;

    sourceNode.connect(filterNode);
    filterNode.connect(analyser);

    // Reset detection state
    baseline = 0;
    intervals = [];
    lastBeatAt = 0;
    displayedBpm = null;

    const buf = new Float32Array(analyser.fftSize);
    const baselineAlpha = 1 - Math.exp(-(1000 / 60) / BASELINE_TC_MS); // assume ~60 fps loop

    function loop() {
      analyser.getFloatTimeDomainData(buf);
      // RMS over the buffer
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);

      // EMA baseline
      baseline = baseline === 0 ? rms : baseline + baselineAlpha * (rms - baseline);

      const now = performance.now();
      if (
        baseline > 0.0005 &&                // require some real signal
        rms > baseline * TRIGGER_RATIO &&
        (now - lastBeatAt) > REFRACTORY_MS
      ) {
        registerBeat(now);
      }

      rafId = requestAnimationFrame(loop);
    }
    loop();

    setStatus('Listening…');
    return true;
  } catch (err) {
    console.error(err);
    setStatus('Mic blocked. Try Tap mode.');
    return false;
  }
}

function stopMic() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (sourceNode) try { sourceNode.disconnect(); } catch (_) {}
  if (filterNode) try { filterNode.disconnect(); } catch (_) {}
  if (analyser)   try { analyser.disconnect();   } catch (_) {}
  if (micStream)  micStream.getTracks().forEach(t => t.stop());
  if (audioCtx)   audioCtx.close().catch(() => {});
  audioCtx = micStream = sourceNode = filterNode = analyser = null;
}

// ---------- Tap mode ----------
function handleTap(e) {
  e.preventDefault();
  registerBeat(performance.now());
}

// ---------- Control wiring ----------
async function start() {
  if (running) return;
  running = true;
  startBtn.textContent = 'Stop';
  startBtn.classList.add('active');
  intervals = [];
  lastBeatAt = 0;
  displayedBpm = null;
  setBpm(null);

  if (mode === 'mic') {
    const ok = await startMic();
    if (!ok) { stop(); return; }
  } else {
    setStatus('Tap to the beat');
  }
}

function stop() {
  if (!running) return;
  running = false;
  startBtn.textContent = 'Start';
  startBtn.classList.remove('active');
  if (mode === 'mic') stopMic();
  setStatus(mode === 'mic' ? 'Tap Start to listen' : 'Tap Start, then tap to the beat');
}

function setMode(next) {
  if (running) stop();
  mode = next;
  modeBtn.textContent = 'Mode: ' + (mode === 'mic' ? 'Mic' : 'Tap');
  modeBtn.setAttribute('aria-pressed', mode === 'tap' ? 'true' : 'false');
  if (mode === 'tap') {
    tapBtn.classList.remove('hidden');
    setStatus('Tap Start, then tap to the beat');
  } else {
    tapBtn.classList.add('hidden');
    setStatus('Tap Start to listen');
  }
}

startBtn.addEventListener('click', () => (running ? stop() : start()));
modeBtn.addEventListener('click', () => setMode(mode === 'mic' ? 'tap' : 'mic'));
tapBtn.addEventListener('touchstart', handleTap, { passive: false });
tapBtn.addEventListener('mousedown',  handleTap);

// Prevent iOS double-tap zoom on quick taps
document.addEventListener('gesturestart', e => e.preventDefault());
