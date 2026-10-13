// Auto-sync controller.
//
// Every stream reports its latency to the broadcaster. Streams can only be
// delayed further (slower playback or a short freeze) or – while they still
// have buffered video – sped up a little. So the group aligns to the stream
// with the highest latency: everybody else slows down until they show the
// same moment. Manual offsets shift a single stream relative to the group.
//
// With "minimize latency" enabled the whole group catches up together as long
// as every stream keeps a safe buffer, so latency doesn't creep upwards after
// one stream rebuffered.

const TICK_MS = 250;
const SAFE_BUFFER = 3.5; // seconds every stream keeps when the group catches up
const CATCHUP_START = 1.0;
const CATCHUP_STOP = 0.35;
const MAX_DELAY = 120; // larger gaps are treated as unsyncable
const STALL_EXCLUDE_MS = 4000;
const HOLD_LEAD = 0.12; // playback keeps running briefly after a rate change

export class SyncEngine {
  constructor({ getTiles, getSettings, onUpdate }) {
    this.getTiles = getTiles;
    this.getSettings = getSettings;
    this.onUpdate = onUpdate;
    this.catchingUp = false;
    this.timer = null;
    this.status = { enabled: false, state: 'off', items: [] };
  }

  start() {
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  exclusion(tile, now) {
    const m = tile.metrics;
    if (!m || now - tile.metricsAt > 1500) return 'wait';
    if (tile.state === 'loading' || tile.state === 'error') return 'wait';
    if (m.status === 'offline' || m.status === 'ended') return 'offline';
    if (m.ad) return 'ad';
    if (!m.playing) return 'wait';
    if (typeof m.latency !== 'number' || !Number.isFinite(m.latency) || m.samples < 2) return 'wait';
    if (tile.stalledSince && now - tile.stalledSince > STALL_EXCLUDE_MS) return 'stalled';
    return null;
  }

  tick() {
    const settings = this.getSettings();
    const cfg = settings.sync;
    const now = performance.now();
    const tiles = this.getTiles();

    const usable = [];
    for (const tile of tiles) {
      const m = tile.metrics;
      if (m && m.stalled) tile.stalledSince = tile.stalledSince || now;
      else tile.stalledSince = 0;

      const reason = this.exclusion(tile, now);
      tile.sync.reason = reason;
      tile.sync.latency = m && typeof m.latency === 'number' ? m.latency : null;
      if (!reason) {
        const effective = m.latency - (tile.offset || 0);
        tile.sync.effective = effective;
        // How close this stream could get to live: latency minus buffered video.
        const edge = m.latency - (typeof m.ahead === 'number' ? m.ahead : 0) - (tile.offset || 0);
        tile.edgeHistory.push({ at: now, edge });
        while (tile.edgeHistory.length && now - tile.edgeHistory[0].at > 6000) tile.edgeHistory.shift();
        usable.push(tile);
      } else {
        tile.sync.effective = null;
        tile.edgeHistory.length = 0;
      }
    }

    const active = cfg.enabled && usable.length >= 2;
    if (!active) {
      this.catchingUp = false;
      for (const tile of tiles) {
        tile.sync.mode = 'idle';
        tile.applyRate(null);
        tile.sync.state = tile.sync.reason ? mapReason(tile.sync.reason) : 'off';
        tile.sync.delta = null;
        tile.sync.ref = false;
      }
      this.publish(cfg, tiles, usable, null, active);
      return;
    }

    let reference = usable[0];
    for (const tile of usable) if (tile.sync.effective > reference.sync.effective) reference = tile;
    let target = reference.sync.effective;

    if (cfg.minimizeLatency) {
      // Lowest common target that leaves every stream SAFE_BUFFER seconds of video.
      let lowest = -Infinity;
      for (const tile of usable) {
        const worstEdge = Math.max(...tile.edgeHistory.map((e) => e.edge));
        lowest = Math.max(lowest, worstEdge + SAFE_BUFFER);
      }
      const excess = target - lowest;
      if (this.catchingUp ? excess > CATCHUP_STOP : excess > CATCHUP_START) {
        this.catchingUp = true;
        target = Math.max(lowest, target - 0.6);
      } else {
        this.catchingUp = false;
      }
    }

    const tol = Math.max(0.05, cfg.tolerance);
    for (const tile of tiles) {
      tile.sync.ref = tile === reference && !this.catchingUp;
      if (tile.sync.reason) {
        tile.sync.mode = 'idle';
        tile.sync.delta = null;
        tile.sync.state = mapReason(tile.sync.reason);
        tile.applyRate(null);
        continue;
      }
      const d = target - tile.sync.effective; // > 0: stream is ahead and must be delayed
      tile.sync.delta = -d;
      const freezeAt = tile.isAudible() ? Math.max(cfg.freezeThreshold * 2, 3) : cfg.freezeThreshold;
      const ahead = typeof tile.metrics.ahead === 'number' ? tile.metrics.ahead : 0;
      const canSpeedUp = ahead > 1.6;
      let mode = tile.sync.mode || 'idle';

      if (tile.isHolding()) mode = 'freeze';
      else if (d > MAX_DELAY) mode = 'far';
      else if (d > freezeAt) mode = 'hold';
      else if (mode === 'slow' ? d > tol * 0.35 : d > tol) mode = 'slow';
      else if ((mode === 'fast' ? d < -tol * 0.35 : d < -tol) && canSpeedUp) mode = 'fast';
      else mode = 'idle';

      if (mode === 'hold') {
        // Freeze for exactly the gap; small leftovers are smoothed by slowing down.
        tile.hold(Math.max(0.05, d - HOLD_LEAD));
        mode = 'freeze';
      } else if (mode !== 'freeze') {
        let rate = null;
        if (mode === 'slow') rate = Math.max(cfg.maxSlowdown, 1 - Math.max(0.03, d * 0.35));
        else if (mode === 'fast') rate = Math.min(cfg.maxSpeedup, 1 + Math.max(0.03, -d * 0.25));
        tile.applyRate(rate);
      }
      tile.sync.mode = mode;

      if (mode === 'far') tile.sync.state = 'far';
      else if (mode === 'freeze') tile.sync.state = 'freeze';
      else if (mode !== 'idle') tile.sync.state = 'adjust';
      else tile.sync.state = tile.sync.ref ? 'ref' : 'ok';
    }

    this.publish(cfg, tiles, usable, target, active);
  }

  publish(cfg, tiles, usable, target, active) {
    let state = 'off';
    let spread = 0;
    let adjusting = 0;
    if (cfg.enabled) {
      if (!active) state = tiles.length < 2 ? 'idle' : 'wait';
      else {
        adjusting = usable.filter((t) => t.sync.mode !== 'idle').length;
        spread = Math.max(...usable.map((t) => Math.abs(t.sync.delta || 0)));
        state = adjusting ? 'adjust' : 'ok';
      }
    }
    this.status = {
      enabled: cfg.enabled,
      state,
      spread,
      adjusting,
      usable: usable.length,
      target,
      catchingUp: this.catchingUp,
      items: tiles.map((t) => ({
        login: t.login,
        name: t.displayName(),
        color: t.color,
        effective: t.sync.effective,
        latency: t.sync.latency,
        state: t.sync.state,
        ref: t.sync.ref,
      })),
    };
    this.onUpdate(this.status);
  }
}

function mapReason(reason) {
  return { ad: 'ad', offline: 'offline', stalled: 'wait', wait: 'wait' }[reason] || 'wait';
}
