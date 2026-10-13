'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULTS = Object.freeze({
  version: 1,
  // Grid order. Each entry: { login, offset (s), volume (0..1), quality, crop }
  channels: [],
  // Logins whose audio is audible (click = solo, ⌥-click = mix)
  audio: [],
  mutedAll: false,
  view: 'grid', // 'grid' | 'focus' | 'facecam'
  main: null, // the big stream in focus / facecam view
  ui: {
    chromeHidden: false,
    sidebar: 'expanded', // 'expanded' | 'collapsed'
    chatOpen: true,
    chatWidth: 340,
    chatTab: null,
    discoverOpen: true,
  },
  playback: {
    quality: 'auto', // auto | chunked | 1080 | 720 | 480 | 360 | 160
    tileChrome: 'bar', // 'bar' = info strip above the picture, 'overlay' = on top of it
    audioFollowsFocus: true,
    chatFollowsAudio: true,
    partnerToasts: true,
  },
  sync: {
    enabled: true,
    tolerance: 0.15, // seconds, allowed deviation before correcting
    freezeThreshold: 1.5, // seconds, larger gaps are closed by freezing (muted streams)
    maxSlowdown: 0.9, // lowest playback rate used for gentle corrections
    maxSpeedup: 1.08,
    minimizeLatency: true, // let the whole group catch up when everyone has buffer to spare
  },
  adblock: {
    enabled: true,
    blockTwitchTelemetry: false,
    customDomains: [],
    extensions: [], // absolute paths of unpacked extensions
  },
  window: null,
});

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

class Store extends EventEmitter {
  constructor(dir) {
    super();
    this.file = path.join(dir, 'settings.json');
    this.data = merge(structuredClone(DEFAULTS), this.read());
    this.timer = null;
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  get() {
    return structuredClone(this.data);
  }

  set(patch) {
    if (!isPlainObject(patch)) return this.get();
    this.data = merge(this.data, patch);
    this.scheduleSave();
    this.emit('change', this.data);
    return this.get();
  }

  scheduleSave() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] could not save settings:', err);
    }
  }
}

module.exports = { Store, DEFAULTS };
