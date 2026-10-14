import { icons, brandMark } from './icons.js';
import {
  h,
  $,
  toast,
  popover,
  closePopover,
  confirmDialog,
  installTooltips,
  debounce,
  isTyping,
  hasOverlay,
  modal,
  avatar,
  formatViewers,
  formatSeconds,
  escapeHtml,
} from './ui.js';
import { gridRects, focusRects } from './layout.js';
import { Tile, STREAM_COLORS } from './tile.js';
import { SyncEngine } from './sync.js';
import { ChatPanel } from './chat.js';
import { Sidebar } from './sidebar.js';
import { openSettings } from './settings.js';
import { cropFromFaces, CAM_ASPECT } from './facecam.js';

const api = window.tsync;
const MAX_TILES = 16;
const GAP = 6;
const LOGIN_RE = /^[a-z0-9_]{2,25}$/;
const RESERVED_PATHS = new Set([
  'directory', 'videos', 'settings', 'p', 'search', 'downloads', 'jobs', 'turbo', 'subscriptions', 'inventory',
  'drops', 'wallet', 'friends', 'messages', 'popout', 'embed', 'moderator', 'login', 'signup', 'store', 'prime',
]);
const SOURCE_LABELS = { together: 'Stream Together', sharedChat: 'Shared Chat', title: 'Im Titel' };
const BAR_H = 30;
const VIEWS = ['grid', 'focus', 'facecam'];
const REDETECT_MS = 3 * 60_000;

const state = {
  settings: null,
  auth: { loggedIn: false, user: null },
  appInfo: {},
  adblock: { blocked: 0, rules: 0, enabled: true },
  extensions: { loaded: [], failed: [] },
  tiles: [],
  view: 'grid', // 'grid' | 'focus' | 'facecam'
  main: null, // login of the big stream in focus / facecam view
  audio: new Set(),
  mutedAll: false,
  followed: null,
  followedError: null,
  followedLoading: false,
  top: [],
  announcedPartners: new Set(),
  syncStatus: null,
  drag: null,
  settingsView: null,
  blockedTick: null,
};

const els = {};
let sidebar = null;
let chat = null;
let engine = null;

// --------------------------------------------------------------- settings

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
  return out;
}

function updateSettings(patch) {
  state.settings = merge(state.settings, patch);
  return api.settings.set(patch).catch((err) => console.error('settings', err));
}

const persistChannels = debounce(() => {
  updateSettings({
    channels: state.tiles.map((t) => ({
      login: t.login,
      offset: t.offset,
      volume: t.volume,
      quality: t.quality || null,
      crop: t.crop || null,
    })),
    audio: [...state.audio],
    view: state.view,
    main: state.main,
    mutedAll: state.mutedAll,
  });
}, 300);

// ----------------------------------------------------------------- input

export function parseChannels(text) {
  const out = [];
  for (const raw of String(text || '').split(/[\s,;]+/)) {
    let token = raw.trim();
    if (!token) continue;
    const url = /(?:https?:\/\/)?(?:www\.|m\.|player\.)?twitch\.tv\/(?:popout\/)?([^/?#\s]+)/i.exec(token);
    if (url) {
      token = url[1];
      const channelParam = /[?&]channel=([^&#]+)/i.exec(raw);
      if (channelParam) token = channelParam[1];
    }
    token = token.replace(/^@/, '').toLowerCase();
    if (LOGIN_RE.test(token) && !RESERVED_PATHS.has(token) && !out.includes(token)) out.push(token);
  }
  return out;
}

// ---------------------------------------------------------------- tiles

const controller = {
  defaultQuality: () => state.settings.playback.quality,
  isMutedAll: () => state.mutedAll,
  barHeight: () => barHeight(),
  chromeHidden: () => Boolean(state.settings.ui.chromeHidden),
  showSyncPanel: (tile, anchor) => showSyncPanel(tile, anchor),
  editCrop: (tile) => editCrop(tile),
  visiblePartners,
  showPartners,
  onTileAction,
  onTileClick(tile, mods) {
    if (mods.alt) toggleMix(tile);
    else solo(tile);
  },
  toggleFocus: (tile) => toggleFocus(tile),
  onGuestKey: (_tile, key) => handleKey(key),
  startDrag,
  dragOver,
  nudgeOffset(tile, delta) {
    tile.setOffset(Math.max(-60, Math.min(60, tile.offset + delta)));
    persistChannels();
  },
  resync(tile) {
    tile.reload();
    toast(`<b>${escapeHtml(tile.displayName())}</b> wird neu verbunden und angeglichen.`, { icon: 'resync', duration: 2600 });
  },
  setVolume(tile, volume) {
    tile.setVolume(volume);
    persistChannels();
  },
  removeTile: (tile) => removeTile(tile),
};

function nextColor() {
  const used = new Set(state.tiles.map((t) => t.color));
  return STREAM_COLORS.find((c) => !used.has(c)) || STREAM_COLORS[state.tiles.length % STREAM_COLORS.length];
}

function tileByLogin(login) {
  return state.tiles.find((t) => t.login === login) || null;
}

function addChannels(logins, { announce = true } = {}) {
  const added = [];
  let skipped = 0;
  for (const login of logins) {
    const existing = tileByLogin(login);
    if (existing) {
      existing.flash();
      continue;
    }
    if (state.tiles.length >= MAX_TILES) {
      skipped += 1;
      continue;
    }
    const tile = new Tile({ login }, { color: nextColor(), controller });
    state.tiles.push(tile);
    added.push(tile);
  }
  if (skipped) toast(`Maximal ${MAX_TILES} Streams gleichzeitig – ${skipped} nicht hinzugefügt.`, { kind: 'warn' });
  if (!added.length) return added;

  if (!state.audio.size) setAudio([added[0].login], { quiet: true });
  for (const tile of added) tile.setAudible(state.audio.has(tile.login));
  layout(true);
  afterChannelsChanged();
  if (announce && added.length > 1) toast(`${added.length} Streams hinzugefügt.`, { icon: 'plus', duration: 2600 });
  if (state.tiles.length === 10 && added.length) {
    toast('Viele gleichzeitige Streams brauchen viel Bandbreite und CPU. Tipp: niedrigere Standardqualität in den Einstellungen.', {
      kind: 'warn',
      duration: 8000,
    });
  }
  return added;
}

function removeTile(tile) {
  const index = state.tiles.indexOf(tile);
  if (index < 0) return;
  state.tiles.splice(index, 1);
  tile.destroy();
  state.audio.delete(tile.login);
  if (state.main === tile.login) {
    state.main = null;
    if (state.view !== 'grid') state.view = state.tiles.length > 1 ? state.view : 'grid';
  }
  if (!state.audio.size && state.tiles.length) setAudio([state.tiles[0].login], { quiet: true });
  layout(true);
  afterChannelsChanged();
}

async function clearChannels() {
  if (!state.tiles.length) return;
  const ok = await confirmDialog({
    title: 'Alle Kanäle entfernen?',
    text: `${state.tiles.length} Streams werden aus dem Grid entfernt.`,
    confirm: 'Entfernen',
    danger: true,
  });
  if (!ok) return;
  for (const tile of [...state.tiles]) tile.destroy();
  state.tiles = [];
  state.audio.clear();
  state.main = null;
  state.view = 'grid';
  layout();
  afterChannelsChanged();
}

function afterChannelsChanged() {
  persistChannels();
  updateChatChannels();
  renderSidebar();
  renderEmpty();
  refreshInfoSoon();
}

// ---------------------------------------------------------------- layout

let animTimer = null;

function barHeight() {
  return state.settings.playback.tileChrome === 'bar' && !state.settings.ui.chromeHidden ? BAR_H : 0;
}

function mainTile() {
  if (state.view === 'grid') return null;
  return tileByLogin(state.main) || audibleTile();
}

function layout(animate = false) {
  const grid = els.grid;
  const width = grid.clientWidth;
  const height = grid.clientHeight;
  const n = state.tiles.length;
  const area = { x: 0, y: 0, width, height };
  const extraH = barHeight();
  const main = mainTile();
  const mainIndex = main ? state.tiles.indexOf(main) : -1;
  if (main) state.main = main.login;

  grid.dataset.chrome = state.settings.playback.tileChrome;
  grid.classList.toggle('chrome-hidden', Boolean(state.settings.ui.chromeHidden));
  grid.dataset.view = state.view;

  let rects;
  if (state.view === 'facecam' && mainIndex >= 0 && n > 1) {
    rects = focusRects(n, mainIndex, area, GAP, {
      extraH,
      stripAspect: CAM_ASPECT,
      fractions: [0.18, 0.22, 0.26, 0.3, 0.34, 0.38],
    });
  } else if (state.view === 'focus' && mainIndex >= 0) {
    rects = focusRects(n, mainIndex, area, GAP, { extraH });
  } else {
    rects = gridRects(n, area, GAP, { extraH });
  }

  if (animate) {
    grid.classList.add('animate');
    clearTimeout(animTimer);
    animTimer = setTimeout(() => grid.classList.remove('animate'), 420);
  }
  let queued = 0;
  state.tiles.forEach((tile, i) => {
    const role = n > 1 && i === mainIndex ? 'main' : state.view === 'facecam' && mainIndex >= 0 ? 'cam' : 'tile';
    tile.setRole(role);
    tile.setRect(rects[i]);
    tile.setFocused(state.view === 'focus' && i === mainIndex);
    if (!tile.el.isConnected) {
      grid.append(tile.el);
      setTimeout(() => tile.start(), queued++ * 180);
    }
  });
  els.empty.hidden = n > 0;
  renderViewSwitch();
  if (state.view === 'facecam') scheduleDetection(400);
}

function setView(view, login) {
  if (!VIEWS.includes(view)) return;
  state.view = view;
  if (login) state.main = login;
  if (view !== 'grid' && !tileByLogin(state.main)) {
    const tile = audibleTile();
    state.main = tile ? tile.login : null;
  }
  if (view !== 'grid' && state.settings.playback.audioFollowsFocus) {
    const tile = tileByLogin(state.main);
    if (tile && !state.audio.has(tile.login)) solo(tile);
  }
  layout(true);
  persistChannels();
}

function toggleFocus(tile) {
  if (!tile) return;
  if (state.view === 'facecam') {
    // In facecam view a double click promotes a facecam to the main picture.
    if (state.main === tile.login) setView('grid');
    else setView('facecam', tile.login);
    return;
  }
  if (state.view === 'focus' && state.main === tile.login) setView('grid');
  else setView('focus', tile.login);
}

function setChromeHidden(hidden) {
  updateSettings({ ui: { chromeHidden: hidden } });
  for (const tile of state.tiles) tile.setBare(hidden || tile.role === 'cam');
  els.btnChrome.innerHTML = hidden ? icons.eyeOff : icons.eye;
  els.btnChrome.classList.toggle('is-warn', hidden);
  els.btnChrome.setAttribute('data-tip', hidden ? 'Kachel-Infos einblenden · I' : 'Kachel-Infos ausblenden · I');
  layout(true);
}

function setTileChrome(mode) {
  updateSettings({ playback: { tileChrome: mode === 'overlay' ? 'overlay' : 'bar' } });
  layout(true);
}

function renderViewSwitch() {
  if (!els.viewSeg) return;
  for (const btn of els.viewSeg.querySelectorAll('button')) btn.classList.toggle('is-active', btn.dataset.view === state.view);
}

// ------------------------------------------------------------- facecams

let detectTimer = null;
let detecting = false;

function scheduleDetection(delay = 5000) {
  clearTimeout(detectTimer);
  detectTimer = setTimeout(runDetection, delay);
}

function needsDetection(tile, now) {
  if (tile.role !== 'cam' || (tile.crop && tile.crop.manual)) return false;
  if (tile.camStatus === 'unsupported') return false;
  if (!tile.metrics || !tile.metrics.playing || tile.metrics.ad) return false;
  if (tile.camStatus === 'idle' || (!tile.crop && tile.camStatus !== 'none')) return true;
  return now - (tile.detectedAt || 0) > REDETECT_MS;
}

async function runDetection() {
  if (state.view !== 'facecam' || detecting) return;
  const now = Date.now();
  const tile = state.tiles.find((t) => needsDetection(t, now));
  if (!tile) {
    scheduleDetection(5000);
    return;
  }
  detecting = true;
  await detectFacecam(tile, { quiet: true });
  detecting = false;
  scheduleDetection(600);
}

async function detectFacecam(tile, { quiet = false } = {}) {
  const hadCrop = Boolean(tile.crop);
  if (!hadCrop) tile.setCrop(null, 'detecting');
  try {
    const result = await tile.request('detect', { samples: 5, interval: 900 }, 25000);
    tile.detectedAt = Date.now();
    if (!result.supported) {
      tile.setCrop(tile.crop, 'unsupported');
      return null;
    }
    const crop = cropFromFaces(result.frames || [], result.aspect || 16 / 9);
    if (crop) {
      tile.setCrop({ x: crop.x, y: crop.y, w: crop.w, h: crop.h, manual: false }, 'found');
      persistChannels();
      return crop;
    }
    if (!hadCrop) tile.setCrop(null, 'none');
    if (!quiet) toast(`Bei <b>${escapeHtml(tile.displayName())}</b> wurde kein Gesicht gefunden – lege den Ausschnitt selbst fest.`, { kind: 'warn', icon: 'crop' });
    return null;
  } catch (err) {
    tile.detectedAt = Date.now();
    if (!hadCrop) tile.setCrop(null, 'none');
    return null;
  }
}

// Crop editor: a still frame of the stream with a draggable 4:3 frame.
async function editCrop(tile) {
  let shot;
  try {
    shot = await tile.request('snapshot', { width: 1280 }, 6000);
  } catch {
    shot = null;
  }
  if (!shot || !shot.data) {
    toast('Vom Stream ist gerade kein Bild verfügbar – sobald er läuft, nochmal versuchen.', { kind: 'warn' });
    return;
  }
  const aspect = shot.aspect || 16 / 9;
  // crop in normalised frame coords
  let crop = tile.crop ? { ...tile.crop } : { x: 0.7, y: 0.05, w: 0.27, h: (0.27 * aspect) / CAM_ASPECT };

  const img = h('img', { class: 'crop-img', src: shot.data, draggable: 'false', alt: '' });
  const box = h('div', { class: 'crop-box' }, [
    h('span', { class: 'crop-label eyebrow', text: 'Facecam' }),
    ...['nw', 'ne', 'sw', 'se'].map((c) => h('span', { class: `crop-handle ${c}`, dataset: { corner: c } })),
  ]);
  const stage = h('div', { class: 'crop-stage', style: { aspectRatio: String(aspect) } }, [img, h('div', { class: 'crop-shade' }), box]);

  const clamp = () => {
    const minW = 0.05;
    crop.w = Math.max(minW, Math.min(1, crop.w));
    crop.h = Math.min(1, (crop.w * aspect) / CAM_ASPECT);
    crop.w = (crop.h * CAM_ASPECT) / aspect;
    crop.x = Math.max(0, Math.min(1 - crop.w, crop.x));
    crop.y = Math.max(0, Math.min(1 - crop.h, crop.y));
  };
  const paint = () => {
    clamp();
    Object.assign(box.style, {
      left: `${crop.x * 100}%`,
      top: `${crop.y * 100}%`,
      width: `${crop.w * 100}%`,
      height: `${crop.h * 100}%`,
    });
  };
  paint();

  stage.addEventListener('pointerdown', (e) => {
    const rect = stage.getBoundingClientRect();
    const corner = e.target.dataset && e.target.dataset.corner;
    const onBox = box.contains(e.target);
    const start = { x: e.clientX, y: e.clientY, crop: { ...crop } };
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    if (!onBox) {
      // click outside: centre the frame there
      crop.x = (e.clientX - rect.left) / rect.width - crop.w / 2;
      crop.y = (e.clientY - rect.top) / rect.height - crop.h / 2;
      paint();
      start.crop = { ...crop };
    }
    const move = (ev) => {
      const dx = (ev.clientX - start.x) / rect.width;
      const dy = (ev.clientY - start.y) / rect.height;
      if (corner) {
        const c0 = start.crop;
        const grow = corner.includes('e') ? dx : -dx;
        const w = c0.w + grow;
        crop.w = w;
        clamp();
        crop.x = corner.includes('w') ? c0.x + c0.w - crop.w : c0.x;
        crop.y = corner.includes('n') ? c0.y + c0.h - crop.h : c0.y;
      } else {
        crop.x = start.crop.x + dx;
        crop.y = start.crop.y + dy;
      }
      paint();
    };
    const up = () => {
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerup', up);
    };
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', up);
  });

  const status = h('span', { class: 's-desc', text: tile.crop ? (tile.crop.manual ? 'Manuell festgelegt.' : 'Automatisch erkannt.') : 'Noch kein Ausschnitt.' });
  const autoBtn = h('button', {
    class: 'btn',
    html: `${icons.sparkle}<span>Automatisch erkennen</span>`,
    onClick: async () => {
      autoBtn.disabled = true;
      status.textContent = 'Suche Gesicht in mehreren Bildern …';
      const found = await detectFacecam(tile, { quiet: true });
      autoBtn.disabled = false;
      if (found) {
        crop = { x: found.x, y: found.y, w: found.w, h: found.h };
        paint();
        status.textContent = `Gesicht in ${found.hits} von ${found.samples} Bildern gefunden.`;
      } else {
        status.textContent = tile.camStatus === 'unsupported' ? 'Gesichtserkennung ist hier nicht verfügbar.' : 'Kein Gesicht gefunden – bitte von Hand wählen.';
      }
    },
  });
  const panel = h('div', { class: 'crop-editor' }, [
    h('div', { class: 'crop-head' }, [
      h('div', {}, [h('div', { class: 'eyebrow', text: 'Facecam-Ausschnitt' }), h('h3', { text: tile.displayName() })]),
      h('button', { class: 'icon-btn', html: icons.x, onClick: () => close() }),
    ]),
    h('p', { class: 'lede', text: 'Ziehe den Rahmen auf die Webcam oder klicke an die Stelle. Ecken ändern die Größe.' }),
    stage,
    h('div', { class: 'crop-foot' }, [
      autoBtn,
      status,
      h('span', { style: { flex: '1' } }),
      tile.crop && tile.crop.manual
        ? h('button', {
            class: 'btn ghost',
            text: 'Wieder automatisch',
            onClick: () => {
              tile.setCrop(null, 'idle');
              persistChannels();
              close();
              scheduleDetection(200);
            },
          })
        : null,
      h('button', {
        class: 'btn primary',
        text: 'Übernehmen',
        onClick: () => {
          clamp();
          tile.setCrop({ x: crop.x, y: crop.y, w: crop.w, h: crop.h, manual: true }, 'found');
          persistChannels();
          close();
        },
      }),
    ]),
  ]);
  const close = modal(panel);
}

// Sync controls in a popover (used in "bar" mode, where nothing covers the picture).
function showSyncPanel(tile, anchor) {
  const readout = h('div', { class: 'sp-readout' });
  const offsetBtn = h('button', { class: 'offset-val', 'data-tip': 'Klick setzt zurück' });
  const vol = h('input', { class: 'range signal', type: 'range', min: '0', max: '100', step: '1' });
  const paint = () => {
    const st = tile.sync.state;
    const lat = tile.sync.latency;
    const label = { ref: 'Referenz', ok: 'Synchron', adjust: 'Gleicht an', freeze: 'Hält an', wait: 'Misst …', ad: 'Werbung', offline: 'Offline', off: 'Auto-Sync aus', far: 'Zu weit entfernt' }[st] || '';
    readout.innerHTML = `<span class="eyebrow">${escapeHtml(label)}</span><span class="mono big">${typeof lat === 'number' ? escapeHtml(formatSeconds(lat, 2)) : '–'}</span>`;
    offsetBtn.textContent = `${tile.offset > 0 ? '+' : tile.offset < 0 ? '−' : '±'}${Math.abs(tile.offset).toFixed(1).replace('.', ',')} s`;
    offsetBtn.classList.toggle('is-set', Math.abs(tile.offset) >= 0.05);
    const pct = Math.round(tile.volume * 100);
    if (document.activeElement !== vol) vol.value = String(pct);
    vol.style.setProperty('--p', `${pct}%`);
  };
  const step = (d, label) => h('button', { class: 'step', text: label, onClick: () => (controller.nudgeOffset(tile, d), paint()) });
  offsetBtn.addEventListener('click', () => (controller.nudgeOffset(tile, -tile.offset), paint()));
  vol.addEventListener('input', () => (controller.setVolume(tile, Number(vol.value) / 100), paint()));
  const content = h('div', { class: 'sync-panel' }, [
    h('div', { class: 'pop-head' }, [h('div', { class: 'eyebrow', text: `Sync · ${tile.displayName()}` })]),
    readout,
    h('div', { class: 'sp-row' }, [step(-1, '−1'), step(-0.1, '−0,1'), offsetBtn, step(0.1, '+0,1'), step(1, '+1')]),
    h('div', { class: 'sp-row' }, [h('span', { class: 'sp-ico', html: icons.volume }), vol]),
    h('div', { class: 'pop-foot' }, [
      h('button', { class: 'btn', html: `${icons.resync}<span>Resync</span>`, onClick: () => (closePopover(), controller.resync(tile)) }),
    ]),
  ]);
  paint();
  const timer = setInterval(paint, 250);
  popover(anchor, content, { align: 'end', onClose: () => clearInterval(timer) });
}

// ----------------------------------------------------------------- audio

function setAudio(logins, { quiet = false } = {}) {
  state.audio = new Set(logins);
  for (const tile of state.tiles) tile.setAudible(state.audio.has(tile.login));
  if (!quiet && logins.length === 1 && state.settings.playback.chatFollowsAudio) chat.select(logins[0]);
  persistChannels();
}

function solo(tile) {
  if (state.mutedAll) setMutedAll(false);
  setAudio([tile.login]);
}

function toggleMix(tile) {
  if (state.mutedAll) setMutedAll(false);
  const next = new Set(state.audio);
  if (next.has(tile.login) && next.size > 1) next.delete(tile.login);
  else next.add(tile.login);
  setAudio([...next], { quiet: true });
}

function setMutedAll(muted) {
  state.mutedAll = muted;
  for (const tile of state.tiles) tile.applyAudio();
  els.btnMute.innerHTML = muted ? icons.mute : icons.volume;
  els.btnMute.classList.toggle('is-warn', muted);
  els.btnMute.setAttribute('data-tip', muted ? 'Ton wieder an · ⇧⌘M' : 'Alle stummschalten · ⇧⌘M');
  persistChannels();
}

function audibleTile() {
  return state.tiles.find((t) => state.audio.has(t.login)) || state.tiles[0] || null;
}

// ------------------------------------------------------------- tile actions

function onTileAction(tile, action, anchor, event) {
  switch (action) {
    case 'audio':
      if (event && event.altKey) toggleMix(tile);
      else if (state.audio.size === 1 && state.audio.has(tile.login)) setMutedAll(!state.mutedAll);
      else solo(tile);
      break;
    case 'focus':
      toggleFocus(tile);
      break;
    case 'main':
      setView(state.view === 'grid' ? 'facecam' : state.view, tile.login);
      break;
    case 'crop':
      editCrop(tile);
      break;
    case 'chat':
      setChatOpen(true);
      chat.select(tile.login);
      break;
    case 'more':
      showTileMenu(tile, anchor);
      break;
    case 'remove':
      removeTile(tile);
      break;
    default:
      break;
  }
}

function showTileMenu(tile, anchor) {
  const item = (icon, label, onClick, extra) =>
    h('button', { class: 'menu-item', onClick: () => (closePopover(), onClick()) }, [
      h('span', { html: icons[icon] }),
      h('span', { class: 'grow', text: label }),
      extra || null,
    ]);
  const defaultLabel = { auto: 'Automatisch', chunked: 'Quelle' }[state.settings.playback.quality] || `${state.settings.playback.quality}p`;
  const qualities = [{ group: null, name: `Standard (${defaultLabel})` }].concat(
    (tile.qualities || []).filter((q) => q.group && q.group !== 'auto').map((q) => ({ group: q.group, name: q.name })),
  );
  const current = tile.metrics && tile.metrics.quality;
  const menu = h('div', {}, [
    h('div', { class: 'pop-head' }, [h('div', { class: 'eyebrow', text: tile.displayName() })]),
    item('external', 'Auf Twitch öffnen', () => api.openExternal(`https://www.twitch.tv/${tile.login}`)),
    item('refresh', 'Player neu laden', () => tile.reload()),
    item('chat', 'Chat anzeigen', () => {
      setChatOpen(true);
      chat.select(tile.login);
    }),
    Math.abs(tile.offset) >= 0.05 ? item('sync', 'Versatz zurücksetzen', () => controller.nudgeOffset(tile, -tile.offset)) : null,
    h('div', { class: 'menu-sep' }),
    h('div', { class: 'pop-head', style: { padding: '2px 10px 4px' } }, [
      h('span', { class: 'eyebrow', text: `Qualität${current ? ` · aktuell ${current}` : ''}` }),
    ]),
    ...qualities.map((q) =>
      h('button', {
        class: 'menu-item',
        onClick: () => {
          closePopover();
          tile.setQuality(q.group);
          persistChannels();
        },
      }, [
        h('span', { class: 'grow', text: q.name }),
        (tile.quality || null) === q.group ? h('span', { class: 'check', html: icons.check }) : null,
      ]),
    ),
  ]);
  popover(anchor, menu, { align: 'end' });
}

// ------------------------------------------------------------------ drag

function startDrag(tile, e) {
  if (e.button !== 0 || state.tiles.length < 2) return;
  e.preventDefault();
  state.drag = { tile, over: null };
  els.grid.classList.add('is-dragging');
  tile.el.classList.add('is-dragged');
  const end = () => {
    window.removeEventListener('pointerup', end, true);
    window.removeEventListener('blur', end);
    finishDrag();
  };
  window.addEventListener('pointerup', end, true);
  window.addEventListener('blur', end);
}

function dragOver(tile) {
  if (!state.drag) return;
  for (const t of state.tiles) t.el.classList.toggle('drop-target', t === tile && t !== state.drag.tile);
  state.drag.over = tile === state.drag.tile ? null : tile;
}

function finishDrag() {
  const drag = state.drag;
  state.drag = null;
  els.grid.classList.remove('is-dragging');
  for (const t of state.tiles) t.el.classList.remove('drop-target', 'is-dragged');
  if (!drag || !drag.over) return;
  const from = state.tiles.indexOf(drag.tile);
  const to = state.tiles.indexOf(drag.over);
  state.tiles.splice(from, 1);
  state.tiles.splice(to, 0, drag.tile);
  layout(true);
  persistChannels();
  updateChatChannels();
}

// -------------------------------------------------------------- partners

function visiblePartners(tile) {
  const partners = (tile.info && tile.info.partners) || [];
  return partners.filter((p) => !tileByLogin(p.login));
}

function sourceList(partners) {
  const set = new Set();
  for (const p of partners) for (const s of p.sources) set.add(s);
  return [...set];
}

function showPartners(tile, anchor) {
  const partners = (tile.info && tile.info.partners) || [];
  const missing = partners.filter((p) => !tileByLogin(p.login));
  const sources = sourceList(partners);
  const list = h('div', { class: 'pop-list' });
  for (const p of partners) {
    const inGrid = Boolean(tileByLogin(p.login));
    list.append(
      h('div', { class: 'pop-row' }, [
        avatar(p.avatar, p.displayName, { live: true, size: 'md' }),
        h('div', { class: 'ch-main' }, [
          h('div', { class: 'ch-name', text: p.displayName }),
          h('div', { class: 'ch-sub' }, [
            h('span', { class: 'mono', text: formatViewers(p.stream ? p.stream.viewers : 0) }),
            p.stream && p.stream.game ? h('span', { text: p.stream.game }) : null,
          ]),
        ]),
        inGrid
          ? h('span', { class: 'badge', text: 'im Grid' })
          : h('button', {
              class: 'icon-btn small',
              html: icons.plus,
              'data-tip': `${p.displayName} hinzufügen`,
              onClick: () => {
                addChannels([p.login]);
                showPartners(tile, anchor);
              },
            }),
      ]),
    );
  }
  const content = h('div', {}, [
    h('div', { class: 'pop-head' }, [
      h('div', { class: 'eyebrow', text: 'Zusammen live' }),
      h('h4', { text: `${tile.displayName()} + ${partners.length}` }),
      h('div', { class: 'sources' }, sources.map((s) => h('span', { class: 'badge violet', text: SOURCE_LABELS[s] || s }))),
    ]),
    list,
    h('div', { class: 'pop-foot' }, [
      h('button', {
        class: 'btn violet',
        html: `${icons.partners}<span>${missing.length ? `Alle öffnen (${missing.length})` : 'Alle im Grid'}</span>`,
        disabled: !missing.length,
        onClick: () => {
          closePopover();
          openPartners(tile);
        },
      }),
    ]),
  ]);
  popover(anchor, content, { align: 'end' });
}

function openPartners(tile) {
  const logins = visiblePartners(tile).map((p) => p.login);
  if (!logins.length) return;
  const added = addChannels(logins, { announce: false });
  toast(`${added.length} Partner-Stream${added.length === 1 ? '' : 's'} von <b>${escapeHtml(tile.displayName())}</b> geöffnet.`, {
    icon: 'partners',
    kind: 'partner',
    duration: 3200,
  });
}

function announcePartners() {
  if (!state.settings.playback.partnerToasts) return;
  for (const tile of state.tiles) {
    const fresh = visiblePartners(tile).filter((p) => !state.announcedPartners.has(`${tile.login}>${p.login}`));
    if (!fresh.length) continue;
    const all = visiblePartners(tile);
    for (const p of all) state.announcedPartners.add(`${tile.login}>${p.login}`);
    // Partners of channels already announced via another tile are not repeated.
    const novel = fresh.filter((p) => ![...state.announcedPartners].some((k) => k.endsWith(`>${p.login}`) && !k.startsWith(`${tile.login}>`)));
    if (!novel.length) continue;
    const labels = sourceList(all).map((s) => SOURCE_LABELS[s] || s).join(' · ');
    toast(
      `<b>${escapeHtml(tile.displayName())}</b> ist mit ${all.length} ${all.length === 1 ? 'weiterem Kanal' : 'weiteren Kanälen'} live <span class="mono" style="color:var(--text-2)">· ${escapeHtml(labels)}</span>`,
      {
        kind: 'partner',
        icon: 'partners',
        duration: 9000,
        actions: [
          { label: 'Ansehen', onClick: () => showPartners(tile, tile.partnersChip.hidden ? tile.el : tile.partnersChip) },
          { label: 'Alle öffnen', violet: true, onClick: () => openPartners(tile) },
        ],
      },
    );
  }
}

// ----------------------------------------------------------- twitch data

let infoRefreshing = false;
async function refreshInfo() {
  if (infoRefreshing || !state.tiles.length) return;
  infoRefreshing = true;
  try {
    const result = await api.twitch.channels(state.tiles.map((t) => t.login));
    for (const tile of state.tiles) if (result[tile.login]) tile.setInfo(result[tile.login]);
    updateChatChannels();
    announcePartners();
  } catch (err) {
    console.warn('channel info failed', err);
  } finally {
    infoRefreshing = false;
  }
}
const refreshInfoSoon = debounce(refreshInfo, 1200);

async function refreshFollowed(manual = false) {
  if (!state.auth.loggedIn) {
    state.followed = null;
    state.followedError = null;
    renderSidebar();
    return;
  }
  if (state.followedLoading) return;
  state.followedLoading = true;
  renderSidebar();
  try {
    state.followed = await api.twitch.followed();
    state.followedError = null;
  } catch (err) {
    state.followedError = err.message;
    if (manual) toast(escapeHtml(err.message), { kind: 'error' });
  } finally {
    state.followedLoading = false;
    renderSidebar();
    renderEmpty();
  }
}

async function refreshTop() {
  try {
    state.top = await api.twitch.top();
    renderSidebar();
    renderEmpty();
  } catch (err) {
    console.warn('top streams failed', err);
  }
}

// --------------------------------------------------------------- sidebar

const sidebarController = {
  onSidebarPick(user) {
    const tile = tileByLogin(user.login);
    if (tile) {
      tile.flash();
      return;
    }
    addChannels([user.login]);
  },
  refreshFollowed: (manual) => refreshFollowed(manual),
  login: () => login(),
  logout: () => logout(),
  toggleDiscover() {
    updateSettings({ ui: { discoverOpen: !state.settings.ui.discoverOpen } });
    renderSidebar();
  },
};

function renderSidebar() {
  if (!sidebar) return;
  sidebar.render({
    auth: state.auth,
    followed: state.followed,
    followedError: state.followedError,
    followedLoading: state.followedLoading,
    top: state.top,
    inGrid: new Set(state.tiles.map((t) => t.login)),
    discoverOpen: state.settings.ui.discoverOpen,
    adblock: state.adblock,
  });
}

function setSidebar(mode) {
  els.app.dataset.sidebar = mode;
  updateSettings({ ui: { sidebar: mode } });
}

// ------------------------------------------------------------------ chat

function updateChatChannels() {
  chat.setChannels(
    state.tiles.map((t) => ({
      login: t.login,
      name: t.displayName(),
      avatar: t.info && t.info.avatar,
      color: t.color,
    })),
  );
}

function setChatOpen(open) {
  els.app.dataset.chat = open ? 'open' : 'closed';
  els.btnChat.classList.toggle('is-on', open);
  updateSettings({ ui: { chatOpen: open } });
}

function setChatWidth(width) {
  const w = Math.round(Math.max(280, Math.min(600, width)));
  els.app.style.setProperty('--chat-w', `${w}px`);
  return w;
}

function installChatResizer() {
  const handle = $('#chat-resizer');
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('is-active');
    els.app.classList.add('is-resizing');
    const startX = e.clientX;
    const startW = els.chat.getBoundingClientRect().width;
    let width = startW;
    const move = (ev) => {
      width = setChatWidth(startW + (startX - ev.clientX));
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.classList.remove('is-active');
      els.app.classList.remove('is-resizing');
      updateSettings({ ui: { chatWidth: width } });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('lostpointercapture', up, { once: true });
  });
}

// ------------------------------------------------------------------ auth

async function login() {
  try {
    await api.auth.login();
  } catch (err) {
    toast(escapeHtml(err.message), { kind: 'error' });
  }
}

async function logout() {
  const ok = await confirmDialog({
    title: 'Von Twitch abmelden?',
    text: 'Die gespeicherte Sitzung wird gelöscht. Player und Chats laden danach ohne Konto.',
    confirm: 'Abmelden',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.auth.logout();
  } catch (err) {
    toast(escapeHtml(err.message), { kind: 'error' });
  }
}

function onAuthChanged(auth) {
  const was = state.auth;
  state.auth = auth;
  const changedUser = Boolean(was.loggedIn) !== Boolean(auth.loggedIn);
  if (changedUser) {
    if (auth.loggedIn) {
      const name = auth.user ? auth.user.displayName : 'deinem Konto';
      toast(`Angemeldet als <b>${escapeHtml(name)}</b> – Player und Chats laden mit deinem Konto neu.`, { icon: 'check' });
    } else {
      toast(auth.expired ? 'Deine Twitch-Sitzung ist abgelaufen. Bitte neu anmelden.' : 'Abgemeldet.', { kind: auth.expired ? 'warn' : 'info', icon: 'logout' });
    }
    state.tiles.forEach((t, i) => setTimeout(() => t.reload(), i * 120));
    chat.reloadAll();
  }
  renderSidebar();
  refreshFollowed();
  if (state.settingsView) state.settingsView.refresh();
}

// ------------------------------------------------------------------ sync

function setSyncEnabled(enabled) {
  updateSettings({ sync: { enabled } });
  els.syncToggle.checked = enabled;
  api.setMenuState({ syncEnabled: enabled });
}

function resyncAll() {
  if (!state.tiles.length) return;
  state.tiles.forEach((t, i) => setTimeout(() => t.reload(), i * 150));
  toast('Alle Streams werden neu verbunden und anschließend angeglichen.', { icon: 'resync', duration: 3200 });
}

function resetOffsets() {
  for (const t of state.tiles) t.setOffset(0);
  persistChannels();
  toast('Alle manuellen Versätze zurückgesetzt.', { icon: 'sync', duration: 2400 });
}

const railMarkers = new Map();

function renderSync(status) {
  state.syncStatus = status;
  const cluster = els.syncCluster;
  cluster.dataset.state = status.state;

  let text = 'aus';
  if (status.state === 'idle') text = 'bereit';
  else if (status.state === 'wait') text = 'misst …';
  else if (status.state === 'ok') text = `±${(status.spread || 0).toFixed(2).replace('.', ',')} s`;
  else if (status.state === 'adjust') text = status.catchingUp ? 'holt auf …' : `gleicht ${status.adjusting} an`;
  els.syncValue.textContent = text;

  // Rail
  const items = status.items.filter((i) => typeof i.effective === 'number');
  const rail = els.rail;
  rail.classList.toggle('has-target', status.enabled && typeof status.target === 'number' && items.length >= 2);
  const emptyEl = rail.querySelector('.rail-empty');
  if (!items.length) {
    for (const m of railMarkers.values()) m.remove();
    railMarkers.clear();
    if (!emptyEl) rail.append(h('div', { class: 'rail-empty', text: state.tiles.length ? 'messe latenz' : 'keine streams' }));
    else emptyEl.textContent = state.tiles.length ? 'messe latenz' : 'keine streams';
  } else {
    if (emptyEl) emptyEl.remove();
    const values = items.map((i) => i.effective);
    if (typeof status.target === 'number') values.push(status.target);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(4, max - min + 1);
    const lo = (min + max) / 2 - span / 2;
    const pos = (v) => `${8 + ((v - lo) / span) * 84}%`;
    const seen = new Set();
    for (const item of items) {
      seen.add(item.login);
      let marker = railMarkers.get(item.login);
      if (!marker) {
        marker = h('div', { class: 'rail-marker' });
        els.railMarkers.append(marker);
        railMarkers.set(item.login, marker);
      }
      marker.style.setProperty('--m-color', item.color);
      marker.style.left = pos(item.effective);
      marker.classList.toggle('is-ref', Boolean(item.ref));
    }
    for (const [login, marker] of railMarkers) {
      if (!seen.has(login)) {
        marker.remove();
        railMarkers.delete(login);
      }
    }
    if (typeof status.target === 'number') els.railTarget.style.left = pos(status.target);
  }
  const lines = status.items.map((i) => {
    const label = { ref: 'Referenz', ok: 'synchron', adjust: 'gleicht an', freeze: 'hält an', wait: 'misst …', ad: 'Werbung', offline: 'offline', off: '', far: 'zu weit entfernt' }[i.state] || '';
    return `${i.name}: ${typeof i.latency === 'number' ? formatSeconds(i.latency, 2) : '–'}${label ? ` · ${label}` : ''}`;
  });
  rail.setAttribute('data-tip', lines.length ? `Latenz zum Streamer\n${lines.join('\n')}` : 'Latenz-Schiene: zeigt, wie weit die Streams auseinanderliegen.');

  for (const tile of state.tiles) tile.renderMetrics();
}

// ------------------------------------------------------------- add input

function installAddBox() {
  const input = els.addInput;
  const box = els.suggest;
  let results = [];
  let active = -1;
  let requestId = 0;

  const close = () => {
    box.hidden = true;
    active = -1;
  };

  const choose = (user) => {
    addChannels([user.login]);
    input.value = '';
    close();
    input.blur();
  };

  const render = (head, list, emptyText) => {
    results = list;
    active = list.length ? 0 : -1;
    box.replaceChildren();
    if (head) box.append(h('div', { class: 'suggest-head eyebrow', text: head }));
    if (!list.length && emptyText) box.append(h('div', { class: 'suggest-empty', text: emptyText }));
    list.forEach((u, i) => {
      const inGrid = Boolean(tileByLogin(u.login));
      box.append(
        h(
          'button',
          {
            class: `suggest-item ${i === active ? 'is-active' : ''}`,
            onMousedown: (e) => {
              e.preventDefault();
              choose(u);
            },
            onMouseenter: () => highlight(i),
          },
          [
            avatar(u.avatar, u.displayName, { live: Boolean(u.stream), size: 'md' }),
            h('div', { class: 's-main' }, [
              h('div', { class: 's-name', text: u.displayName }),
              h('div', { class: 's-sub', text: u.stream ? [u.stream.game, u.stream.title].filter(Boolean).join(' · ') : 'offline' }),
            ]),
            h('span', { class: 's-tag', text: inGrid ? 'IM GRID' : u.stream ? formatViewers(u.stream.viewers) : '' }),
          ],
        ),
      );
    });
    box.hidden = false;
  };

  const highlight = (i) => {
    active = i;
    box.querySelectorAll('.suggest-item').forEach((el, j) => el.classList.toggle('is-active', j === i));
  };

  const showDefault = () => {
    const pool = (state.followed && state.followed.length ? state.followed : state.top).slice(0, 8);
    if (!pool.length) {
      close();
      return;
    }
    render(state.followed && state.followed.length ? 'Live · Gefolgt' : 'Gerade beliebt', pool);
  };

  const search = debounce(async (term) => {
    const id = ++requestId;
    try {
      const list = await api.twitch.search(term);
      if (id !== requestId || input.value.trim() !== term) return;
      render('Suche', list, 'Keine Kanäle gefunden – Enter fügt den Namen trotzdem hinzu.');
    } catch {
      if (id === requestId) render('Suche', [], 'Suche gerade nicht möglich – Enter fügt den Namen direkt hinzu.');
    }
  }, 220);

  input.addEventListener('focus', () => {
    if (!input.value.trim()) showDefault();
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('input', () => {
    const value = input.value.trim();
    if (!value) {
      showDefault();
      return;
    }
    const parsed = parseChannels(value);
    if (parsed.length > 1 || /twitch\.tv/i.test(value)) {
      render(`Enter fügt ${parsed.length} ${parsed.length === 1 ? 'Kanal' : 'Kanäle'} hinzu`, [], parsed.join(', ') || 'Kein gültiger Kanalname.');
      results = [];
      return;
    }
    search(value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && results.length) {
      e.preventDefault();
      highlight((active + 1) % results.length);
    } else if (e.key === 'ArrowUp' && results.length) {
      e.preventDefault();
      highlight((active - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const value = input.value.trim();
      const parsed = parseChannels(value);
      const typedExact = results.find((r) => r.login === value.toLowerCase());
      if (results.length && active >= 0 && (!value || parsed.length <= 1) && !typedExact) {
        choose(results[active]);
      } else if (parsed.length) {
        addChannels(parsed);
        input.value = '';
        close();
        input.blur();
      } else if (value) {
        toast('Das sieht nicht nach einem Twitch-Kanal aus.', { kind: 'warn', duration: 2600 });
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      input.value = '';
      close();
      input.blur();
    }
  });
}

function focusAddInput() {
  const hero = $('#hero-input');
  const target = hero && !els.empty.hidden ? hero : els.addInput;
  target.focus();
  target.select();
}

// ----------------------------------------------------------- empty state

function renderEmpty() {
  if (state.tiles.length) {
    els.empty.hidden = true;
    return;
  }
  els.empty.hidden = false;
  const heroInput = h('input', {
    id: 'hero-input',
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: 'z. B. papaplatte, trymacs, twitch.tv/eliasn97',
  });
  const submit = () => {
    const logins = parseChannels(heroInput.value);
    if (!logins.length) {
      heroInput.focus();
      return;
    }
    addChannels(logins);
  };
  heroInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });

  const pool = state.followed && state.followed.length ? state.followed : state.top;
  const sugTitle = state.followed && state.followed.length ? 'Gerade live bei dir' : 'Gerade beliebt';
  const demoRows = [
    ['A', '#59dcff', '24%', '0'],
    ['B', '#ff7ad9', '44%', '24px'],
    ['C', '#ffb547', '12%', '48px'],
    ['D', '#a796ff', '36%', '72px'],
  ];

  const inner = h('div', { class: 'empty-inner' }, [
    h('div', { class: 'hero-kicker' }, [h('span', { class: 'line' }), h('span', { class: 'eyebrow', text: 'Twitch Multiview · Auto-Sync' })]),
    h('h1', { class: 'hero-title' }, [h('span', { text: 'Viele Streams.' }), h('span', { class: 'accent', text: 'Ein Moment.' })]),
    h('p', {
      class: 'hero-copy',
      text: 'TwitchSync misst die Verzögerung jedes Streams und gleicht alle automatisch an – Events, Kills und Reaktionen siehst du überall gleichzeitig. Dazu Chat, gefolgte Kanäle und Multistream-Erkennung.',
    }),
    h('div', { class: 'hero-add' }, [
      h('label', { class: 'field' }, [h('span', { class: 'add-icon', html: icons.search }), heroInput]),
      h('button', { class: 'btn primary lg', html: `${icons.plus}<span>Hinzufügen</span>`, onClick: submit }),
    ]),
    h(
      'div',
      { class: 'hero-demo', 'aria-hidden': 'true' },
      [
        ...demoRows.map(([label, color, from, top]) =>
          h('div', { class: 'demo-row', style: { top } }, [
            h('span', { class: 'lbl', text: `STREAM ${label}` }),
            h('span', { class: 'blip', style: { '--c': color, '--from': from } }),
          ]),
        ),
        h('div', { class: 'demo-line' }),
      ],
    ),
    pool && pool.length
      ? h('div', { class: 'hero-sugs' }, [
          h('div', { class: 'eyebrow', text: sugTitle }),
          h(
            'div',
            { class: 'sug-list' },
            pool.slice(0, 10).map((u) =>
              h('button', { class: 'sug', 'data-tip': u.stream ? u.stream.title : '', onClick: () => addChannels([u.login]) }, [
                avatar(u.avatar, u.displayName, { size: 'sm' }),
                h('span', { text: u.displayName }),
                u.stream ? h('span', { class: 'mono', text: formatViewers(u.stream.viewers) }) : null,
              ]),
            ),
          ),
        ])
      : null,
    state.auth.loggedIn
      ? null
      : h('div', { class: 'hero-sugs' }, [
          h('button', { class: 'btn ghost', html: `${icons.login}<span>Mit Twitch anmelden – für gefolgte Kanäle, Turbo & Sub-Emotes</span>`, onClick: () => login() }),
        ]),
  ]);
  els.empty.replaceChildren(inner);
}

// -------------------------------------------------------------- keyboard

function handleKey(key) {
  if (key.meta || key.ctrl) return false;
  switch (key.key) {
    case 'Escape':
      if (closePopover()) return true;
      if (state.view !== 'grid') {
        setView('grid');
        return true;
      }
      return false;
    case 'f':
    case 'F':
      toggleFocus(state.view !== 'grid' ? tileByLogin(state.main) : audibleTile());
      return true;
    case 'c':
    case 'C':
      setView(state.view === 'facecam' ? 'grid' : 'facecam');
      return true;
    case 'g':
    case 'G':
      setView('grid');
      return true;
    case 'i':
    case 'I':
      setChromeHidden(!state.settings.ui.chromeHidden);
      return true;
    case 'm':
    case 'M':
      setMutedAll(!state.mutedAll);
      return true;
    case 'ArrowUp':
    case 'ArrowDown': {
      const tile = audibleTile();
      if (!tile) return false;
      controller.setVolume(tile, Math.max(0, Math.min(1, tile.volume + (key.key === 'ArrowUp' ? 0.05 : -0.05))));
      return true;
    }
    default:
      if (/^[1-9]$/.test(key.key)) {
        const tile = state.tiles[Number(key.key) - 1];
        if (tile) {
          if (key.alt) toggleMix(tile);
          else solo(tile);
          return true;
        }
      }
      return false;
  }
}

function installKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (isTyping(e.target)) return;
    if (hasOverlay()) {
      if (e.key === 'Escape' && closePopover()) e.preventDefault();
      return;
    }
    const handled = handleKey({ key: e.key, alt: e.altKey, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey });
    if (handled) e.preventDefault();
  });
}

// ------------------------------------------------------------------ menu

function onMenu(command, arg) {
  switch (command) {
    case 'add-channel':
      focusAddInput();
      break;
    case 'add-login':
      if (typeof arg === 'string') addChannels(parseChannels(arg));
      break;
    case 'toggle-focus':
      toggleFocus(state.view !== 'grid' ? tileByLogin(state.main) : audibleTile());
      break;
    case 'view':
      setView(state.view === arg && arg !== 'grid' ? 'grid' : arg);
      break;
    case 'toggle-chrome':
      setChromeHidden(!state.settings.ui.chromeHidden);
      break;
    case 'audio-solo': {
      const tile = state.tiles[arg];
      if (tile) solo(tile);
      break;
    }
    case 'mute-all':
      setMutedAll(!state.mutedAll);
      break;
    case 'toggle-sync':
      setSyncEnabled(!state.settings.sync.enabled);
      toast(state.settings.sync.enabled ? 'Auto-Sync ist an.' : 'Auto-Sync ist aus – Streams laufen ungebremst.', { icon: 'sync', duration: 2200 });
      break;
    case 'resync-all':
      resyncAll();
      break;
    case 'reload-streams':
      state.tiles.forEach((t, i) => setTimeout(() => t.reload(), i * 120));
      chat.reloadAll();
      break;
    case 'clear-channels':
      clearChannels();
      break;
    case 'toggle-sidebar':
      setSidebar(els.app.dataset.sidebar === 'collapsed' ? 'expanded' : 'collapsed');
      break;
    case 'toggle-chat':
      setChatOpen(els.app.dataset.chat !== 'open');
      break;
    case 'settings':
      showSettings(arg || undefined);
      break;
    default:
      break;
  }
}

// -------------------------------------------------------------- settings

function showSettings(pane) {
  if (state.settingsView) state.settingsView.close();
  state.settingsView = openSettings(
    {
      appInfo: state.appInfo,
      settings: () => state.settings,
      auth: () => state.auth,
      adblockStats: () => state.adblock,
      extensions: () => state.extensions,
      update: (patch) => updateSettings(patch),
      setSyncEnabled,
      setTileChrome,
      setChromeHidden,
      setDefaultQuality(value) {
        updateSettings({ playback: { quality: value } });
        state.tiles.forEach((t, i) => {
          if (t.quality) return;
          t.resolvedQuality = null;
          t.qualityRetried = false;
          setTimeout(() => t.reload(), i * 150);
        });
      },
      resyncAll,
      resetOffsets,
      login,
      logout: async () => {
        await logout();
      },
      async addExtension() {
        state.extensions = await api.extensions.add();
        if (state.extensions.loaded.length) toast('Erweiterung geladen. Player laden neu, damit sie greift.', { icon: 'puzzle' });
        state.tiles.forEach((t, i) => setTimeout(() => t.reload(), i * 150));
        return state.extensions;
      },
      async removeExtension(dir) {
        state.extensions = await api.extensions.remove(dir);
        return state.extensions;
      },
      onBlockedTick(fn) {
        state.blockedTick = fn;
      },
      openExternal: (url) => api.openExternal(url),
    },
    pane,
  );
  const close = state.settingsView.close;
  state.settingsView.close = () => {
    close();
    state.settingsView = null;
  };
}

// ------------------------------------------------------------------ boot

function paintStaticIcons() {
  $('#brand .brand-mark').innerHTML = brandMark(22);
  $('#add-box .add-icon').innerHTML = icons.search;
  els.btnSidebar.innerHTML = icons.sidebar;
  els.btnResync.innerHTML = icons.resync;
  els.btnMute.innerHTML = icons.volume;
  els.btnChat.innerHTML = icons.chat;
  els.btnSettings.innerHTML = icons.settings;
  els.btnChrome.innerHTML = icons.eye;
  for (const btn of els.viewSeg.querySelectorAll('button')) btn.innerHTML = icons[btn.dataset.icon];
  $('#btn-chat-close').innerHTML = icons.chevronRight;
}

async function boot() {
  Object.assign(els, {
    app: $('#app'),
    grid: $('#grid'),
    empty: $('#empty'),
    stage: $('#stage'),
    chat: $('#chat'),
    addInput: $('#add-input'),
    suggest: $('#suggest'),
    rail: $('#rail'),
    railMarkers: $('#rail-markers'),
    railTarget: $('#rail-target'),
    syncCluster: $('#sync-cluster'),
    syncValue: $('#sync-value'),
    syncToggle: $('#sync-toggle'),
    btnSidebar: $('#btn-sidebar'),
    btnResync: $('#btn-resync-all'),
    btnMute: $('#btn-mute'),
    btnChat: $('#btn-chat'),
    btnSettings: $('#btn-settings'),
    btnChrome: $('#btn-chrome'),
    viewSeg: $('#view-seg'),
  });

  installTooltips();
  paintStaticIcons();

  const init = await api.init();
  state.settings = init.settings;
  state.auth = init.auth;
  state.appInfo = init.app;
  state.adblock = init.adblock;
  state.extensions = init.extensions;
  els.app.classList.toggle('is-fullscreen', Boolean(init.fullscreen));

  const ui = state.settings.ui;
  els.app.dataset.sidebar = ui.sidebar === 'collapsed' ? 'collapsed' : 'expanded';
  els.app.dataset.chat = ui.chatOpen ? 'open' : 'closed';
  els.btnChat.classList.toggle('is-on', ui.chatOpen);
  setChatWidth(ui.chatWidth || 340);
  els.syncToggle.checked = state.settings.sync.enabled;
  api.setMenuState({ syncEnabled: state.settings.sync.enabled });

  sidebar = new Sidebar($('#sidebar'), sidebarController);
  chat = new ChatPanel({
    tabsEl: $('#chat-tabs'),
    bodyEl: $('#chat-body'),
    onSelect: (login) => updateSettings({ ui: { chatTab: login } }),
  });

  // Restore the previous session
  state.mutedAll = Boolean(state.settings.mutedAll);
  state.audio = new Set(state.settings.audio || []);
  for (const ch of state.settings.channels || []) {
    if (!ch || !LOGIN_RE.test(ch.login) || tileByLogin(ch.login) || state.tiles.length >= MAX_TILES) continue;
    state.tiles.push(new Tile(ch, { color: nextColor(), controller }));
  }
  // Older versions stored only `focus`.
  const legacyFocus = state.settings.focus && tileByLogin(state.settings.focus) ? state.settings.focus : null;
  state.view = VIEWS.includes(state.settings.view) ? state.settings.view : legacyFocus ? 'focus' : 'grid';
  state.main = tileByLogin(state.settings.main) ? state.settings.main : legacyFocus;
  if (state.view !== 'grid' && !state.main) state.view = 'grid';
  if (![...state.audio].some((l) => tileByLogin(l)) && state.tiles.length) state.audio = new Set([state.tiles[0].login]);
  for (const tile of state.tiles) tile.setAudible(state.audio.has(tile.login));
  setMutedAll(state.mutedAll);
  if (state.settings.ui.chromeHidden) {
    els.btnChrome.innerHTML = icons.eyeOff;
    els.btnChrome.classList.add('is-warn');
  }
  layout();
  updateChatChannels();
  if (ui.chatTab) chat.select(ui.chatTab);

  engine = new SyncEngine({
    getTiles: () => state.tiles,
    getSettings: () => state.settings,
    onUpdate: renderSync,
  });
  engine.start();

  // Wiring
  els.btnSidebar.addEventListener('click', () => onMenu('toggle-sidebar'));
  els.btnChat.addEventListener('click', () => onMenu('toggle-chat'));
  $('#btn-chat-close').addEventListener('click', () => setChatOpen(false));
  els.btnSettings.addEventListener('click', () => showSettings());
  els.btnMute.addEventListener('click', () => setMutedAll(!state.mutedAll));
  els.btnResync.addEventListener('click', () => resyncAll());
  els.btnChrome.addEventListener('click', () => setChromeHidden(!state.settings.ui.chromeHidden));
  els.viewSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (btn) setView(btn.dataset.view);
  });
  els.syncToggle.addEventListener('change', () => setSyncEnabled(els.syncToggle.checked));
  installAddBox();
  installKeyboard();
  installChatResizer();

  let raf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => layout(false));
  }).observe(els.grid);

  api.onMenu(onMenu);
  api.onFullscreen((on) => els.app.classList.toggle('is-fullscreen', on));
  api.auth.onChange(onAuthChanged);
  api.adblock.onCount((count) => {
    state.adblock.blocked = count;
    sidebar.setBlocked(count);
    if (state.blockedTick) state.blockedTick(count);
  });

  if (state.appInfo.translated) {
    toast(
      'Diese TwitchSync-Version ist für Intel-Macs und läuft hier über Rosetta – Streams laden dadurch sehr langsam. Bitte die Universal-Version laden.',
      {
        kind: 'warn',
        duration: 0,
        actions: [{ label: 'Download', primary: true, onClick: () => api.openExternal(`${state.appInfo.repo}/releases/latest`) }],
      },
    );
  }

  renderSidebar();
  renderEmpty();
  refreshInfo();
  refreshFollowed();
  refreshTop();
  setInterval(refreshInfo, 60_000);
  setInterval(() => refreshFollowed(), 60_000);
  setInterval(refreshTop, 5 * 60_000);

  // Debug handle for development builds (and TWITCHSYNC_DEBUG=1).
  if (state.appInfo.debug) window.__twitchsync = { state, addChannels, removeTile, layout, engine, parseChannels };
}

boot().catch((err) => {
  console.error(err);
  document.body.append(h('pre', { style: { position: 'fixed', inset: '80px 20px auto', color: '#ff4b55', whiteSpace: 'pre-wrap' }, text: `TwitchSync konnte nicht starten:\n${err.stack || err}` }));
});
