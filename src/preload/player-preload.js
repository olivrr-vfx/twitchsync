'use strict';

// Runs inside every player.twitch.tv <webview> (isolated world, sandboxed).
//
// What the public surface offers (checked against player.twitch.tv/js/embed/v1.js
// and the live player):
//   * The embedded player broadcasts its state as `UPDATE_STATE` messages
//     (namespace "twitch-embed-player-proxy") – the data behind the official
//     Embed API's getPlaybackStats(), incl. `hlsLatencyBroadcaster`.
//     Running top-level in a webview, the player posts these to itself, so we
//     can simply listen.
//   * Embed API *commands* (play/pause/volume/quality) are ignored when the
//     player is not inside a real parent frame, and there is no rate command.
//   * HTMLMediaElement.playbackRate works, but the player resets it whenever it
//     notices a value different from its own. A real pause() makes the player
//     drop the buffer and jump back to the live edge on resume.
//
// So: latency comes from the public player state, speed control goes through
// the <video> element, with a small main-world hook that keeps reporting the
// player's own rate to the player. Freezing (rate 0) replaces pause().
// The video data itself is never modified.

const { contextBridge, ipcRenderer, webFrame } = require('electron');

const config = (() => {
  try {
    const match = /[#&]tsync=([^&]+)/.exec(window.location.hash);
    return match ? JSON.parse(decodeURIComponent(match[1])) : {};
  } catch {
    return {};
  }
})();

const token = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

function installHooks(secret, cfg) {
  const rateDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
  const volumeDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  const state = {
    forcedRate: null,
    playerRate: 1,
    gain: typeof cfg.gain === 'number' ? cfg.gain : 1,
    playerVolume: null,
  };
  const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

  Object.defineProperty(HTMLMediaElement.prototype, 'playbackRate', {
    configurable: true,
    enumerable: true,
    get() {
      return state.forcedRate === null ? rateDesc.get.call(this) : state.playerRate;
    },
    set(value) {
      state.playerRate = value;
      if (state.forcedRate === null) rateDesc.set.call(this, value);
    },
  });

  Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
    configurable: true,
    enumerable: true,
    get() {
      return state.playerVolume === null ? volumeDesc.get.call(this) : state.playerVolume;
    },
    set(value) {
      state.playerVolume = value;
      volumeDesc.set.call(this, clamp01(value * state.gain));
    },
  });

  // Per-player defaults without racing other players over shared localStorage.
  const getItem = Storage.prototype.getItem;
  Storage.prototype.getItem = function patchedGetItem(key) {
    if (this === window.localStorage) {
      if (key === 'lowLatencyModeEnabled') return 'false';
      if (key === 'volume') return '1';
      if (key === 'video-quality' && cfg.quality) return JSON.stringify({ default: cfg.quality });
    }
    return getItem.call(this, key);
  };

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== window || !data || data.__tsync !== secret) return;
    const media = document.querySelectorAll('video');
    if (data.type === 'rate') {
      state.forcedRate = typeof data.value === 'number' ? data.value : null;
      const rate = state.forcedRate === null ? state.playerRate : state.forcedRate;
      media.forEach((el) => {
        try {
          rateDesc.set.call(el, rate);
        } catch {
          /* rate out of range */
        }
      });
    } else if (data.type === 'gain') {
      state.gain = clamp01(data.value);
      const base = state.playerVolume === null ? 1 : state.playerVolume;
      media.forEach((el) => volumeDesc.set.call(el, clamp01(base * state.gain)));
    }
  });
}

if (typeof contextBridge.executeInMainWorld === 'function') {
  contextBridge.executeInMainWorld({ func: installHooks, args: [token, config] });
} else {
  webFrame.executeJavaScript(`(${installHooks.toString()})(${JSON.stringify(token)}, ${JSON.stringify(config)})`);
}

const toMain = (type, value) => window.postMessage({ __tsync: token, type, value }, '*');
const toHost = (channel, payload) => ipcRenderer.sendToHost(channel, payload);

// ---------------------------------------------------------------------------
// Latency estimation
//
// The player refreshes hlsLatencyBroadcaster about every two seconds. For a
// continuous stream "wallclock - latency - currentTime" is a constant (the
// broadcast clock offset). We take the median of recent samples and derive a
// smooth latency for any moment from the current playback position.

const estimator = {
  samples: [],
  offset: null,
  lastRaw: null,
  misses: 0,
  quietUntil: 0,
  reset() {
    this.samples = [];
    this.offset = null;
    this.misses = 0;
  },
};

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function video() {
  const list = document.querySelectorAll('video');
  for (const el of list) if (el.readyState > 0) return el;
  return list[0] || null;
}

function addSample(raw) {
  const el = video();
  if (!(raw > 0) || !el || el.readyState < 2 || el.paused) return;
  if (raw === estimator.lastRaw) return;
  estimator.lastRaw = raw;
  if (Date.now() < estimator.quietUntil || el.playbackRate === 0) return;
  const offset = Date.now() / 1000 - raw - el.currentTime;
  if (estimator.offset !== null && Math.abs(offset - estimator.offset) > 1) {
    estimator.misses += 1;
    if (estimator.misses < 2) return;
    estimator.reset();
  }
  estimator.misses = 0;
  estimator.samples.push(offset);
  if (estimator.samples.length > 11) estimator.samples.shift();
  estimator.offset = median(estimator.samples);
}

function currentLatency(el) {
  if (estimator.offset === null || !el) return null;
  return Date.now() / 1000 - el.currentTime - estimator.offset;
}

// ---------------------------------------------------------------------------
// Player state

let playerState = null;
let embedStatus = 'loading';
let lastQualitiesKey = '';

window.addEventListener(
  'message',
  (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object' || event.source !== window) return;
    if (data.namespace === 'twitch-embed-player-proxy' && data.eventName === 'UPDATE_STATE') {
      playerState = data.params || null;
      const stats = playerState && playerState.stats && playerState.stats.videoStats;
      if (stats) addSample(Number(stats.hlsLatencyBroadcaster));
    } else if (data.namespace === 'twitch-embed' && typeof data.eventName === 'string') {
      const name = data.eventName;
      if (name === 'offline') embedStatus = 'offline';
      else if (name === 'online' || name === 'playing') embedStatus = 'online';
      else if (name === 'ended') embedStatus = 'ended';
      if (name === 'seek' || name === 'video.play') estimator.reset();
      toHost('player-event', { name });
    }
  },
  true,
);

const AD_SELECTOR = [
  '[data-a-target*="video-ad"]',
  '[data-test-selector*="video-ad"]',
  '[data-test-selector*="ad-banner"]',
  '[class*="video-ad__"]',
  '[aria-label*="Werbung"]',
].join(',');

let adActive = false;
let lastAdCheck = 0;
let lastProgress = { ct: -1, at: 0 };

function report() {
  const el = video();
  const now = Date.now();
  if (now - lastAdCheck > 900) {
    lastAdCheck = now;
    adActive = Boolean(document.querySelector(AD_SELECTOR));
  }

  let ahead = null;
  let ct = null;
  let rate = null;
  let stalled = false;
  if (el) {
    ct = el.currentTime;
    rate = el.playbackRate;
    const buffered = el.buffered;
    if (buffered && buffered.length) ahead = Math.max(0, buffered.end(buffered.length - 1) - ct);
    if (ct !== lastProgress.ct) lastProgress = { ct, at: now };
    stalled = !el.paused && rate > 0 && el.readyState > 0 && now - lastProgress.at > 900;
  }

  const stats = playerState && playerState.stats && playerState.stats.videoStats;
  const playback = playerState ? playerState.playback : 'Idle';
  const playing = Boolean(el && !el.paused && el.readyState >= 2 && playback !== 'Idle');
  const latency = playing ? currentLatency(el) : null;

  const qualities = (playerState && playerState.qualitiesAvailable) || [];
  const qualitiesKey = qualities.map((q) => q.group).join('|');
  const payload = {
    status: embedStatus,
    playback,
    playing,
    latency,
    raw: stats ? stats.hlsLatencyBroadcaster : null,
    samples: estimator.samples.length,
    ahead,
    rate,
    stalled: stalled || playback === 'Buffering',
    ad: adActive,
    quality: playerState ? playerState.quality : null,
    resolution: stats ? stats.videoResolution : null,
    fps: stats ? Math.round(stats.fps || 0) : null,
    playerMuted: el ? el.muted : null,
    aspect: el && el.videoWidth ? el.videoWidth / el.videoHeight : null,
  };
  if (qualitiesKey !== lastQualitiesKey) {
    lastQualitiesKey = qualitiesKey;
    payload.qualities = qualities.map((q) => ({ name: q.name, group: q.group }));
  }
  toHost('metrics', payload);
}

setInterval(report, 250);

document.addEventListener(
  'emptied',
  () => estimator.reset(),
  true,
);

// ---------------------------------------------------------------------------
// Commands from the app

let holdTimer = null;

ipcRenderer.on('cmd', (_event, cmd) => {
  if (!cmd || typeof cmd !== 'object') return;
  switch (cmd.type) {
    case 'rate':
      clearTimeout(holdTimer);
      toMain('rate', typeof cmd.value === 'number' ? cmd.value : null);
      estimator.quietUntil = Date.now() + 800;
      break;
    case 'hold': {
      // Freeze for an exact duration, timed here to avoid IPC round-trip lag.
      const ms = Math.max(0, Math.min(120000, Number(cmd.ms) || 0));
      clearTimeout(holdTimer);
      toMain('rate', 0);
      estimator.quietUntil = Date.now() + ms + 800;
      holdTimer = setTimeout(() => toMain('rate', null), ms);
      break;
    }
    case 'gain':
      toMain('gain', cmd.value);
      break;
    case 'unmute': {
      const el = video();
      if (el && el.muted) el.muted = false;
      break;
    }
    case 'reset':
      estimator.reset();
      break;
    case 'bare':
      document.documentElement.classList.toggle('ts-bare', Boolean(cmd.value));
      break;
    case 'detect':
      detectFaces(cmd)
        .then((result) => toHost('faces', { id: cmd.id, ...result }))
        .catch((err) => toHost('faces', { id: cmd.id, supported: true, error: String(err && err.message) }));
      break;
    case 'snapshot':
      toHost('snapshot', { id: cmd.id, ...snapshot(cmd.width || 960) });
      break;
    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// Facecam support: face detection (Shape Detection API, backed by Apple's
// Vision framework on macOS) on a few frames, and still frames for the crop
// editor. The video is MSE-backed and same-origin, so frames are readable.

let faceDetector = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function drawFrame(width) {
  const el = video();
  if (!el || el.readyState < 2 || !el.videoWidth) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.round((width * el.videoHeight) / el.videoWidth);
  canvas.getContext('2d').drawImage(el, 0, 0, canvas.width, canvas.height);
  return { canvas, aspect: el.videoWidth / el.videoHeight };
}

async function detectFaces({ samples = 5, interval = 900 }) {
  if (typeof FaceDetector === 'undefined') return { supported: false, frames: [] };
  if (!faceDetector) faceDetector = new FaceDetector({ fastMode: false, maxDetectedFaces: 6 });
  const frames = [];
  let aspect = 16 / 9;
  for (let i = 0; i < samples; i += 1) {
    if (i) await sleep(interval);
    const frame = drawFrame(960);
    if (!frame) continue;
    aspect = frame.aspect;
    const { width, height } = frame.canvas;
    const faces = await faceDetector.detect(frame.canvas);
    frames.push(
      faces.map((f) => ({
        x: f.boundingBox.x / width,
        y: f.boundingBox.y / height,
        w: f.boundingBox.width / width,
        h: f.boundingBox.height / height,
      })),
    );
  }
  return { supported: true, frames, aspect };
}

function snapshot(width) {
  const frame = drawFrame(width);
  if (!frame) return { data: null };
  return { data: frame.canvas.toDataURL('image/jpeg', 0.82), aspect: frame.aspect };
}

// ---------------------------------------------------------------------------
// Interaction: clicks pick the audio source, double clicks toggle focus mode.
// The player's own click-to-pause / double-click-fullscreen are suppressed
// because pausing a live player drops its buffer and breaks the sync.

const PASS_THROUGH = [
  '[data-a-target="player-controls"]',
  '[data-a-target="player-settings-menu"]',
  '[role="menu"]',
  '[role="dialog"]',
  'button',
  'a',
  'input',
  'select',
  'label',
].join(',');

function isControl(target) {
  return target instanceof Element && Boolean(target.closest(PASS_THROUGH));
}

function modifiers(e) {
  return { alt: e.altKey, meta: e.metaKey, shift: e.shiftKey, ctrl: e.ctrlKey };
}

window.addEventListener(
  'click',
  (e) => {
    if (!e.isTrusted || e.button !== 0) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target && target.closest('[data-a-target="player-fullscreen-button"]')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      toHost('pointer', { type: 'focus' });
      return;
    }
    if (isControl(target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toHost('pointer', { type: 'click', ...modifiers(e) });
  },
  true,
);

window.addEventListener(
  'dblclick',
  (e) => {
    if (!e.isTrusted || isControl(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toHost('pointer', { type: 'dblclick', ...modifiers(e) });
  },
  true,
);

let lastMove = 0;
window.addEventListener(
  'mousemove',
  () => {
    const now = Date.now();
    if (now - lastMove < 250) return;
    lastMove = now;
    toHost('pointer', { type: 'move' });
  },
  { capture: true, passive: true },
);

document.addEventListener('mouseleave', () => toHost('pointer', { type: 'leave' }));
document.addEventListener('mouseenter', () => toHost('pointer', { type: 'enter' }));

window.addEventListener(
  'wheel',
  (e) => {
    if (!e.altKey) return;
    e.preventDefault();
    toHost('pointer', { type: 'wheel', deltaY: e.deltaY });
  },
  { capture: true, passive: false },
);

window.addEventListener(
  'keydown',
  (e) => {
    const t = e.target;
    if (t instanceof Element && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.metaKey || e.ctrlKey) return; // app menu shortcuts
    if (e.key === 'Tab') return;
    // Twitch's own hotkeys (space = pause, f = fullscreen, m = mute …) would
    // fight the sync and the app's audio routing – the app handles keys instead.
    e.preventDefault();
    e.stopImmediatePropagation();
    toHost('key', { key: e.key, code: e.code, ...modifiers(e) });
  },
  true,
);

// ---------------------------------------------------------------------------
// Visual tweaks: the app draws its own channel bar, so Twitch's top overlay
// (title, follow buttons) is hidden. The bottom control bar stays.

const PLAYER_CSS = `
  .top-bar, [data-a-target="player-overlay-preview-background"] { display: none !important; }
  html.ts-bare .player-controls,
  html.ts-bare [data-a-target="player-controls"],
  html.ts-bare .video-player__overlay [class*="gradient"] { opacity: 0 !important; pointer-events: none !important; }
  html, body { background: #000 !important; }
  .video-player__overlay .player-controls { padding-bottom: 2px !important; }
`;

function injectCss() {
  try {
    webFrame.insertCSS(PLAYER_CSS);
  } catch {
    /* ignore */
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectCss, { once: true });
else injectCss();
