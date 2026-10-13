import { icons } from './icons.js';
import { h, formatSeconds, formatSigned, formatViewers, uptime, escapeHtml } from './ui.js';

// The embed player requires a `parent` parameter. Running top-level inside a
// <webview> it is not checked against an ancestor frame, so any stable domain works.
const PLAYER_PARENT = 'twitchsync.app';
const MIN_PLAYER_W = 540;
const MIN_PLAYER_H = 304;

export const STREAM_COLORS = ['#59dcff', '#ff7ad9', '#ffb547', '#a796ff', '#3ee6b0', '#ff7a59', '#6fa8ff', '#e8d27a'];

export function playerUrl(login, { quality, gain }) {
  const params = new URLSearchParams({
    channel: login,
    parent: PLAYER_PARENT,
    muted: 'false',
    autoplay: 'true',
  });
  const cfg = encodeURIComponent(JSON.stringify({ quality: quality || null, gain }));
  return `https://player.twitch.tv/?${params}#tsync=${cfg}`;
}

const QUALITY_GROUPS = {
  chunked: 'chunked',
  1080: '1080p60',
  720: '720p60',
  480: '480p30',
  360: '360p30',
  160: '160p30',
};

export function qualityGroup(pref) {
  if (!pref || pref === 'auto') return null;
  return QUALITY_GROUPS[pref] || pref;
}

export class Tile {
  constructor(channel, { color, controller }) {
    this.login = channel.login;
    this.offset = channel.offset || 0;
    this.volume = typeof channel.volume === 'number' ? channel.volume : 1;
    this.quality = channel.quality || null;
    this.color = color;
    this.controller = controller;

    this.info = null;
    this.metrics = null;
    this.metricsAt = 0;
    this.qualities = [];
    this.state = 'loading';
    this.sync = { state: 'wait', mode: 'idle', delta: null, latency: null, effective: null, ref: false, reason: 'wait' };
    this.edgeHistory = [];
    this.stalledSince = 0;
    this.sentRate = undefined;
    this.sentRateAt = 0;
    this.holdUntil = 0;
    this.failedAt = 0;
    this.failCount = 0;
    this.audible = false;
    this.hover = { guest: false, host: false };
    this.hoverTimer = null;
    this.idleTimer = null;
    this.qualityRetried = false;
    this.resolvedQuality = null;
    this.role = 'tile'; // 'tile' | 'main' | 'cam'
    this.crop = channel.crop || null; // facecam crop, normalised to the video frame
    this.camStatus = this.crop ? 'found' : 'idle'; // idle | detecting | found | none | unsupported
    this.rect = null;
    this.requests = new Map();
    this.requestSeq = 0;

    this.build();
  }

  // ------------------------------------------------------------------ DOM

  build() {
    this.el = h('div', { class: 'tile', dataset: { login: this.login, state: 'loading' } });
    this.el.style.setProperty('--tile-color', this.color);

    this.webview = document.createElement('webview');
    this.webview.setAttribute('partition', 'persist:twitch');
    this.webview.setAttribute('allowpopups', '');
    this.bindWebview();

    this.stateBox = h('div', { class: 'state-box' });
    const stateLayer = h('div', { class: 'tile-state' }, [this.stateBox]);
    this.media = h('div', { class: 'tile-media' }, [this.webview, stateLayer]);

    this.tally = h('span', { class: 'tally' }, [
      h('span', { class: 'swatch' }),
      h('span', { class: 'live' }),
      (this.nameEl = h('span', { class: 'name', text: this.login })),
      h('span', { class: 'eq', html: '<i></i><i></i><i></i>' }),
    ]);
    this.metaEl = h('span', { class: 'tile-meta hover-only' });
    this.titleEl = h('div', { class: 'tile-title hover-only' });

    this.partnersChip = h('button', {
      class: 'chip partners',
      hidden: true,
      'data-tip': 'Zusammen live – klicken für alle Partner',
      onClick: (e) => {
        e.stopPropagation();
        this.controller.showPartners(this, this.partnersChip);
      },
    });
    this.latencyChip = h(
      'button',
      {
        class: 'chip latency',
        dataset: { sync: 'wait' },
        onClick: (e) => {
          e.stopPropagation();
          this.controller.showSyncPanel(this, this.latencyChip);
        },
      },
      [h('span', { class: 'dot' }), (this.latencyText = h('span', { text: '…' }))],
    );
    this.camChip = h('button', {
      class: 'chip cam',
      hidden: true,
      onClick: (e) => {
        e.stopPropagation();
        this.controller.editCrop(this);
      },
    });

    const action = (name, icon, tip, cls = '') =>
      h('button', {
        class: `icon-btn ${cls}`,
        html: icons[icon],
        'data-tip': tip,
        dataset: { action: name },
        onClick: (e) => {
          e.stopPropagation();
          this.controller.onTileAction(this, name, e.currentTarget, e);
        },
      });

    this.audioBtn = action('audio', 'volume', 'Ton auf diesen Stream (⌥-Klick: dazumischen)');
    this.focusBtn = action('focus', 'focus', 'Fokus-Modus (Doppelklick)');
    const grip = action('grip', 'grip', 'Ziehen zum Umsortieren', 'grip');
    grip.addEventListener('pointerdown', (e) => this.controller.startDrag(this, e));
    this.mainBtn = action('main', 'swap', 'Als Hauptbild (Doppelklick)', 'cam-only');
    this.cropBtn = action('crop', 'crop', 'Facecam-Ausschnitt anpassen', 'cam-only');
    this.actions = h('div', { class: 'tile-actions hover-only' }, [
      grip,
      this.audioBtn,
      this.mainBtn,
      this.cropBtn,
      this.focusBtn,
      action('chat', 'chat', 'Chat öffnen', 'chat-btn'),
      action('more', 'sliders', 'Mehr'),
      action('remove', 'x', 'Entfernen', 'danger'),
    ]);

    const top = h('div', { class: 'tile-top' }, [
      h('div', { class: 'tile-info' }, [h('div', { class: 'row' }, [this.tally, this.metaEl]), this.titleEl]),
      this.camChip,
      this.partnersChip,
      this.latencyChip,
      this.actions,
    ]);

    // Sync dock
    this.readoutVal = h('span', { class: 'val', text: '–' });
    this.readoutLabel = h('span', { class: 'eyebrow', text: 'Latenz' });
    const step = (delta, label, cls = '') =>
      h('button', {
        class: `step ${cls}`,
        text: label,
        'data-tip': `Versatz ${delta > 0 ? '+' : '−'}${String(Math.abs(delta)).replace('.', ',')} s`,
        onClick: (e) => {
          e.stopPropagation();
          this.controller.nudgeOffset(this, delta);
        },
      });
    this.offsetBtn = h('button', {
      class: 'offset-val',
      'data-tip': 'Manueller Versatz · Klick setzt zurück',
      onClick: (e) => {
        e.stopPropagation();
        this.controller.nudgeOffset(this, -this.offset);
      },
    });
    this.volIcon = h('button', {
      class: 'icon-btn small',
      html: icons.volume,
      'data-tip': 'Ton auf diesen Stream',
      onClick: (e) => {
        e.stopPropagation();
        this.controller.onTileAction(this, 'audio', e.currentTarget, e);
      },
    });
    this.volRange = h('input', {
      class: 'range',
      type: 'range',
      min: '0',
      max: '100',
      step: '1',
      'aria-label': 'Lautstärke',
      onInput: (e) => this.controller.setVolume(this, Number(e.target.value) / 100),
    });
    const dock = h('div', { class: 'tile-dock' }, [
      h('div', { class: 'dock-readout' }, [this.readoutLabel, this.readoutVal]),
      h('span', { class: 'dock-sep' }),
      step(-1, '−1', 'coarse'),
      step(-0.1, '−0,1'),
      this.offsetBtn,
      step(0.1, '+0,1'),
      step(1, '+1', 'coarse'),
      h('span', { class: 'dock-sep' }),
      h('button', {
        class: 'icon-btn small',
        html: icons.resync,
        'data-tip': 'Resync – Stream neu verbinden und angleichen',
        onClick: (e) => {
          e.stopPropagation();
          this.controller.resync(this);
        },
      }),
      h('span', { class: 'dock-sep' }),
      h('div', { class: 'vol' }, [this.volIcon, this.volRange]),
    ]);

    const shield = h('div', { class: 'tile-shield' });
    this.el.append(this.media, h('div', { class: 'tile-frame' }), top, dock, shield);

    for (const zone of [top, dock]) {
      zone.addEventListener('pointerenter', () => this.setHover('host', true));
      zone.addEventListener('pointerleave', () => this.setHover('host', false));
    }
    shield.addEventListener('pointerenter', () => this.controller.dragOver(this));

    this.renderState();
    this.renderInfo();
    this.renderOffset();
    this.renderVolume();
  }

  // Starts loading the player. Called once the tile is in the DOM; the app
  // staggers this so a restored session doesn't hit Twitch with 16 loads at once.
  start() {
    if (this.started) return;
    this.started = true;
    this.webview.src = this.url();
  }

  url() {
    const quality = this.resolvedQuality || qualityGroup(this.quality || this.controller.defaultQuality());
    return playerUrl(this.login, { quality, gain: this.volume });
  }

  bindWebview() {
    const wv = this.webview;
    wv.addEventListener('did-attach', () => this.applyAudio());
    wv.addEventListener('dom-ready', () => {
      this.applyAudio();
      this.send({ type: 'gain', value: this.volume });
      if (this.bare) this.send({ type: 'bare', value: true });
    });
    wv.addEventListener('did-start-loading', () => {
      // Chromium's own error page also "loads" – keep the error state visible.
      if (Date.now() - this.failedAt < 1500) return;
      this.sentRate = undefined;
      this.holdUntil = 0;
      this.metrics = null;
      if (this.state !== 'missing') this.setState('loading');
    });
    wv.addEventListener('did-fail-load', (e) => {
      if (!e.isMainFrame || e.errorCode === -3) return;
      this.failedAt = Date.now();
      this.failCount += 1;
      const retry = this.failCount <= 3;
      this.setState(
        'error',
        `Verbindung fehlgeschlagen (${e.errorDescription || e.errorCode}).${retry ? ' Neuer Versuch gleich …' : ''}`,
      );
      clearTimeout(this.retryTimer);
      if (retry) this.retryTimer = setTimeout(() => this.reload(), 2500 * this.failCount);
    });
    wv.addEventListener('render-process-gone', () => {
      this.setState('error', 'Der Player ist abgestürzt.');
      clearTimeout(this.crashTimer);
      this.crashTimer = setTimeout(() => this.reload(), 2500);
    });
    wv.addEventListener('ipc-message', (e) => this.onMessage(e.channel, e.args[0]));
  }

  // --------------------------------------------------------------- guest io

  send(cmd) {
    try {
      this.webview.send('cmd', cmd);
    } catch {
      /* webview not ready yet */
    }
  }

  onMessage(channel, payload) {
    if (channel === 'metrics') {
      if (payload.qualities) this.qualities = payload.qualities;
      this.metrics = payload;
      this.metricsAt = performance.now();
      if (this.state === 'loading' && (payload.playing || payload.status === 'offline')) this.setState('ready');
      if (payload.playing) this.failCount = 0;
      if (payload.playerMuted && this.audible) this.send({ type: 'unmute' });
      this.checkQuality(payload);
      this.renderMetrics();
    } else if (channel === 'pointer') {
      this.onPointer(payload);
    } else if (channel === 'key') {
      this.controller.onGuestKey(this, payload);
    } else if (channel === 'player-event') {
      if (payload.name === 'offline' && this.state === 'loading') this.setState('ready');
    } else if (channel === 'faces' || channel === 'snapshot') {
      const pending = this.requests.get(payload && payload.id);
      if (pending) {
        this.requests.delete(payload.id);
        clearTimeout(pending.timer);
        pending.resolve(payload);
      }
    }
  }

  // Round-trip request to the player preload (face detection, still frames).
  request(type, params = {}, timeoutMs = 15000) {
    const id = ++this.requestSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error('Zeitüberschreitung'));
      }, timeoutMs);
      this.requests.set(id, { resolve, timer });
      this.send({ type, id, ...params });
    });
  }

  onPointer(evt) {
    switch (evt.type) {
      case 'click':
        this.controller.onTileClick(this, evt);
        break;
      case 'dblclick':
      case 'focus':
        this.controller.toggleFocus(this);
        break;
      case 'enter':
      case 'move':
        this.setHover('guest', true);
        this.restartIdle();
        break;
      case 'leave':
        this.setHover('guest', false);
        break;
      case 'wheel':
        this.controller.setVolume(this, Math.max(0, Math.min(1, this.volume - Math.sign(evt.deltaY) * 0.05)));
        break;
      default:
        break;
    }
  }

  // When the configured quality group doesn't exist for this stream (e.g.
  // 720p30 instead of 720p60), reload once with the closest available group.
  checkQuality(m) {
    if (this.qualityRetried || !m.playing || !this.qualities.length) return;
    const wanted = qualityGroup(this.quality || this.controller.defaultQuality());
    if (!wanted || m.quality === wanted) return;
    const groups = this.qualities.map((q) => q.group).filter((g) => g && g !== 'auto');
    if (groups.includes(wanted)) return;
    const height = parseInt(wanted, 10);
    let best = null;
    for (const g of groups) {
      const gh = g === 'chunked' ? 1080 : parseInt(g, 10);
      if (!gh) continue;
      if (!best || Math.abs(gh - height) < Math.abs(best.h - height)) best = { g, h: gh };
    }
    this.qualityRetried = true;
    if (best && best.g !== m.quality) {
      this.resolvedQuality = best.g;
      this.webview.src = this.url();
    }
  }

  // ----------------------------------------------------------------- actions

  applyRate(rate) {
    const value = rate === null || rate === undefined ? null : Math.round(rate * 200) / 200;
    const now = performance.now();
    if (this.holdUntil > now) {
      if (value === 0) return; // hold already running inside the player
      this.holdUntil = 0;
    } else if (this.holdUntil && value === null) {
      // The player released the hold on its own.
      this.holdUntil = 0;
      this.sentRate = null;
      this.sentRateAt = now;
      return;
    }
    if (value === this.sentRate && now - this.sentRateAt < 4000) return;
    this.sentRate = value;
    this.sentRateAt = now;
    this.send({ type: 'rate', value });
  }

  // Freeze for `seconds`; the player times the release itself.
  hold(seconds) {
    const ms = Math.round(seconds * 1000);
    this.holdUntil = performance.now() + ms;
    this.sentRate = 0;
    this.sentRateAt = performance.now();
    this.send({ type: 'hold', ms });
  }

  isHolding() {
    return this.holdUntil > performance.now();
  }

  applyAudio() {
    const audible = this.audible && !this.controller.isMutedAll();
    try {
      this.webview.setAudioMuted(!audible);
    } catch {
      /* not attached yet */
    }
    if (audible) this.send({ type: 'unmute' });
    this.el.classList.toggle('is-audio', this.audible);
    this.el.classList.toggle('is-muted-all', this.controller.isMutedAll());
    this.audioBtn.classList.toggle('is-on', this.audible);
    this.audioBtn.innerHTML = this.audible ? icons.volume : icons.mute;
    this.volIcon.innerHTML = this.audible ? (this.volume < 0.5 ? icons.volumeLow : icons.volume) : icons.mute;
    this.volRange.classList.toggle('signal', this.audible);
  }

  setAudible(on) {
    this.audible = on;
    this.applyAudio();
  }

  isAudible() {
    return this.audible && !this.controller.isMutedAll();
  }

  setVolume(volume) {
    this.volume = volume;
    this.send({ type: 'gain', value: volume });
    this.renderVolume();
    this.applyAudio();
  }

  setOffset(offset) {
    this.offset = Math.round(offset * 10) / 10;
    this.renderOffset();
  }

  setQuality(quality) {
    this.quality = quality;
    this.resolvedQuality = null;
    this.qualityRetried = false;
    this.reload();
  }

  reload() {
    if (!this.started) return;
    this.metrics = null;
    this.sentRate = undefined;
    this.edgeHistory.length = 0;
    this.setState('loading');
    this.webview.src = this.url();
  }

  setRect(rect) {
    this.rect = rect;
    const s = this.el.style;
    s.left = `${Math.round(rect.x)}px`;
    s.top = `${Math.round(rect.y)}px`;
    s.width = `${Math.round(rect.w)}px`;
    s.height = `${Math.round(rect.h)}px`;
    this.applyMedia();
  }

  // Sizes and positions the player inside the tile's picture area.
  applyMedia() {
    if (!this.rect) return;
    const barH = this.controller.barHeight();
    const vw = Math.max(1, Math.round(this.rect.w));
    const vh = Math.max(1, Math.round(this.rect.h - barH));
    const ws = this.webview.style;
    ws.transformOrigin = '0 0';

    if (this.role === 'cam' && this.crop) {
      // Facecam: render the full player large enough that the crop region
      // covers the tile, then move the crop into view.
      const c = this.crop;
      const aspect = (this.metrics && this.metrics.aspect) || 16 / 9;
      let pw = Math.max(vw / c.w, (vh / c.h) * aspect, MIN_PLAYER_W);
      pw = Math.min(pw, 2560);
      const ph = pw / aspect;
      const scale = Math.max(vw / (c.w * pw), vh / (c.h * ph));
      const tx = vw / 2 - (c.x + c.w / 2) * pw * scale;
      const ty = vh / 2 - (c.y + c.h / 2) * ph * scale;
      ws.width = `${Math.round(pw)}px`;
      ws.height = `${Math.round(ph)}px`;
      ws.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${scale.toFixed(4)})`;
      return;
    }

    // Twitch refuses to autoplay (and pauses) embeds smaller than 400×300.
    // Small tiles render the player at the minimum size and scale it down.
    const scale = Math.max(1, MIN_PLAYER_W / vw, MIN_PLAYER_H / vh);
    if (scale > 1.001) {
      ws.width = `${Math.ceil(vw * scale)}px`;
      ws.height = `${Math.ceil(vh * scale)}px`;
      ws.transform = `scale(${1 / scale})`;
    } else {
      ws.width = '100%';
      ws.height = '100%';
      ws.transform = '';
    }
  }

  setRole(role) {
    if (role === this.role) return;
    this.role = role;
    this.el.dataset.role = role;
    this.setBare(role === 'cam' || this.controller.chromeHidden());
    this.renderCam();
    this.applyMedia();
  }

  setBare(on) {
    this.bare = on;
    this.send({ type: 'bare', value: on });
  }

  setCrop(crop, status) {
    this.crop = crop;
    if (status) this.camStatus = status;
    this.renderCam();
    this.applyMedia();
  }

  renderCam() {
    const isCam = this.role === 'cam';
    const show = isCam && !this.crop && this.camStatus !== 'idle';
    this.camChip.hidden = !show;
    if (show) {
      const text = {
        detecting: 'Suche Facecam …',
        none: 'Keine Facecam',
        unsupported: 'Erkennung n. v.',
      }[this.camStatus] || 'Facecam wählen';
      this.camChip.innerHTML = `${icons.crop}<span>${text}</span>`;
      this.camChip.dataset.status = this.camStatus;
      this.camChip.setAttribute('data-tip', 'Klicken, um den Facecam-Ausschnitt selbst festzulegen');
    }
    this.el.classList.toggle('has-crop', isCam && Boolean(this.crop));
  }

  flash() {
    this.el.classList.remove('flash');
    void this.el.offsetWidth;
    this.el.classList.add('flash');
  }

  setFocused(on) {
    this.focusBtn.innerHTML = on ? icons.unfocus : icons.focus;
    this.focusBtn.classList.toggle('is-on', on);
  }

  destroy() {
    clearTimeout(this.retryTimer);
    clearTimeout(this.hoverTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.crashTimer);
    this.el.remove();
  }

  // ------------------------------------------------------------------ hover

  setHover(source, on) {
    this.hover[source] = on;
    clearTimeout(this.hoverTimer);
    if (this.hover.guest || this.hover.host) {
      this.el.classList.add('is-hover');
    } else {
      this.hoverTimer = setTimeout(() => this.el.classList.remove('is-hover'), 160);
    }
  }

  restartIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.hover.host) {
        this.hover.guest = false;
        this.el.classList.remove('is-hover');
      }
    }, 2800);
  }

  // ------------------------------------------------------------------ render

  displayName() {
    return (this.info && this.info.displayName) || this.login;
  }

  setInfo(info) {
    this.info = info;
    if (info && info.exists === false) this.setState('missing');
    this.renderInfo();
  }

  setState(state, message) {
    this.state = state;
    this.stateMessage = message || '';
    this.el.dataset.state = state;
    this.renderState();
  }

  renderState() {
    const box = this.stateBox;
    box.replaceChildren();
    if (this.state === 'loading') {
      box.append(
        h('div', { class: 'loader', html: '<i></i><i></i><i></i><i></i><i></i>' }),
        h('div', { class: 'eyebrow', text: `Verbinde · ${this.displayName()}` }),
      );
    } else if (this.state === 'error' || this.state === 'missing') {
      const missing = this.state === 'missing';
      box.append(
        h('div', { class: 'state-title', text: missing ? 'Kanal nicht gefunden' : 'Stream nicht verfügbar' }),
        h('div', {
          class: 'state-text',
          text: missing ? `„${this.login}“ existiert auf Twitch nicht.` : this.stateMessage || 'Bitte erneut versuchen.',
        }),
        h('div', { style: { display: 'flex', gap: '8px' } }, [
          missing
            ? null
            : h('button', { class: 'btn primary', html: `${icons.refresh}<span>Neu laden</span>`, onClick: () => this.reload() }),
          h('button', { class: 'btn', text: 'Entfernen', onClick: () => this.controller.removeTile(this) }),
        ]),
      );
    }
  }

  renderInfo() {
    const info = this.info;
    this.nameEl.textContent = this.displayName();
    const live = Boolean(info && info.live);
    this.el.classList.toggle('is-live', live);
    if (info && info.stream) {
      const s = info.stream;
      this.metaEl.innerHTML = [
        s.game ? escapeHtml(s.game) : null,
        `<span class="mono">${formatViewers(s.viewers)}</span>`,
        s.startedAt ? `<span class="mono">${uptime(s.startedAt)}</span>` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      this.titleEl.textContent = s.title;
    } else {
      this.metaEl.textContent = info ? (info.exists === false ? 'unbekannt' : 'offline') : '';
      this.titleEl.textContent = '';
    }
    const partners = this.controller.visiblePartners(this);
    this.partnersChip.hidden = partners.length === 0;
    if (partners.length) {
      const sig = partners.map((p) => p.login).join(',');
      if (sig !== this.partnerSig) {
        this.partnersChip.classList.remove('is-new');
        void this.partnersChip.offsetWidth;
        this.partnersChip.classList.add('is-new');
      }
      this.partnerSig = sig;
      this.partnersChip.innerHTML = `${icons.partners}<span>+${partners.length}</span>`;
    } else {
      this.partnerSig = '';
    }
    if (this.state === 'loading') this.renderState();
  }

  renderMetrics() {
    const st = this.sync.state;
    const m = this.metrics;
    let text = '…';
    let tip = 'Messe Latenz …';
    if (st === 'ad') {
      text = 'Werbung';
      tip = 'Werbepause – wird nicht synchronisiert';
    } else if (st === 'offline' || (m && m.status === 'offline')) {
      text = 'Offline';
      tip = 'Kanal ist offline';
    } else if (typeof this.sync.latency === 'number') {
      text = formatSeconds(this.sync.latency);
      const label = {
        ref: 'Referenz – alle anderen gleichen sich an diesen Stream an',
        ok: 'Synchron',
        adjust: 'Gleicht an …',
        freeze: 'Hält kurz an, um aufzuschließen',
        far: 'Abstand zu groß für Auto-Sync',
        off: 'Auto-Sync aus',
        wait: 'Messe Latenz …',
      }[st];
      tip = `${label}\nLatenz zum Streamer: ${formatSeconds(this.sync.latency, 2)}`;
      if (m && typeof m.ahead === 'number') tip += `\nPuffer: ${formatSeconds(m.ahead, 1)}`;
      if (m && m.resolution) tip += `\n${m.resolution}${m.fps ? ` · ${m.fps} fps` : ''}`;
    }
    this.latencyChip.dataset.sync = st;
    this.latencyText.textContent = text;
    this.latencyChip.setAttribute('data-tip', tip);

    // dock readout
    if (typeof this.sync.latency === 'number') {
      this.readoutLabel.textContent = st === 'ref' ? 'Referenz' : st === 'freeze' ? 'Hält an' : st === 'adjust' ? 'Gleicht an' : 'Latenz';
      const delta = typeof this.sync.delta === 'number' && st !== 'ref' && st !== 'off' ? formatSigned(this.sync.delta, 2) : '';
      this.readoutVal.innerHTML = `${escapeHtml(formatSeconds(this.sync.latency, 2))}${delta ? `<small>${escapeHtml(delta)}</small>` : ''}`;
    } else {
      this.readoutLabel.textContent = st === 'ad' ? 'Werbung' : st === 'offline' ? 'Offline' : 'Latenz';
      this.readoutVal.textContent = '–';
    }
  }

  renderOffset() {
    this.offsetBtn.textContent = formatSigned(this.offset);
    this.offsetBtn.classList.toggle('is-set', Math.abs(this.offset) >= 0.05);
  }

  renderVolume() {
    const pct = Math.round(this.volume * 100);
    this.volRange.value = String(pct);
    this.volRange.style.setProperty('--p', `${pct}%`);
    this.volRange.setAttribute('data-tip', `Lautstärke ${pct} %`);
  }
}
