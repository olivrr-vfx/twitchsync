'use strict';

const { EventEmitter } = require('events');

// Third-party ad, analytics and tracking hosts. Matching is by hostname suffix,
// so "doubleclick.net" also blocks "pubads.g.doubleclick.net".
// Twitch's own video and API hosts are intentionally never on this list: the
// stream itself is not touched, ad-free playback comes from the logged-in
// account (Turbo / subscriptions).
const DEFAULT_DOMAINS = [
  // Google ads & analytics
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'google-analytics.com',
  'googletagmanager.com',
  'googletagservices.com',
  'adservice.google.com',
  'imasdk.googleapis.com',
  // Amazon ads
  'amazon-adsystem.com',
  'aax-eu.amazon.com',
  // Measurement / tracking
  'scorecardresearch.com',
  'comscore.com',
  'quantserve.com',
  'quantcount.com',
  'moatads.com',
  'moatpixel.com',
  'adsafeprotected.com',
  'doubleverify.com',
  'nr-data.net',
  'hotjar.com',
  'segment.io',
  'demdex.net',
  'omtrdc.net',
  'everesttech.net',
  'krxd.net',
  'bluekai.com',
  'rlcdn.com',
  'liadm.com',
  'id5-sync.com',
  'tapad.com',
  'agkn.com',
  'mathtag.com',
  'crwdcntrl.net',
  // Ad exchanges / SSPs
  'adsrvr.org',
  'adnxs.com',
  'criteo.com',
  'criteo.net',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'casalemedia.com',
  'indexww.com',
  'bidswitch.net',
  '33across.com',
  'sharethrough.com',
  'smartadserver.com',
  'teads.tv',
  'yieldmo.com',
  'taboola.com',
  'outbrain.com',
  // Social pixels
  'connect.facebook.net',
  'ads-twitter.com',
  'analytics.twitter.com',
  'static.ads-twitter.com',
];

// Twitch first-party telemetry. Off by default because watch-time events are
// also what Drops progress relies on.
const TWITCH_TELEMETRY = [
  'spade.twitch.tv',
  'client-event-reporter.twitch.tv',
  'science.twitch.tv',
];

const HOST_RE = /^[a-z0-9.-]+$/;

function normalizeDomain(input) {
  if (typeof input !== 'string') return null;
  let d = input.trim().toLowerCase();
  if (!d || d.startsWith('#')) return null;
  d = d.replace(/^\|\|/, '').replace(/^[a-z]+:\/\//, '').replace(/^\*\./, '').replace(/^\./, '');
  d = d.split(/[/^$?#:]/)[0];
  return HOST_RE.test(d) && d.includes('.') ? d : null;
}

class AdBlocker extends EventEmitter {
  constructor() {
    super();
    this.enabled = true;
    this.blocked = 0;
    this.hosts = new Set();
    this.lastEmit = 0;
    this.pending = null;
    this.configure({});
  }

  configure({ enabled = this.enabled, blockTwitchTelemetry = false, customDomains = [] }) {
    this.enabled = Boolean(enabled);
    const list = [...DEFAULT_DOMAINS];
    if (blockTwitchTelemetry) list.push(...TWITCH_TELEMETRY);
    for (const d of customDomains) {
      const n = normalizeDomain(d);
      if (n) list.push(n);
    }
    this.hosts = new Set(list);
  }

  matches(hostname) {
    let h = hostname.toLowerCase();
    for (;;) {
      if (this.hosts.has(h)) return true;
      const dot = h.indexOf('.');
      if (dot < 0) return false;
      h = h.slice(dot + 1);
    }
  }

  shouldBlock(details) {
    if (!this.enabled || details.resourceType === 'mainFrame') return false;
    let host;
    try {
      host = new URL(details.url).hostname;
    } catch {
      return false;
    }
    if (!host || !this.matches(host)) return false;
    this.blocked += 1;
    this.notify();
    return true;
  }

  notify() {
    if (this.pending) return;
    const wait = Math.max(0, 1000 - (Date.now() - this.lastEmit));
    this.pending = setTimeout(() => {
      this.pending = null;
      this.lastEmit = Date.now();
      this.emit('count', this.blocked);
    }, wait);
  }

  stats() {
    return { enabled: this.enabled, blocked: this.blocked, rules: this.hosts.size };
  }
}

module.exports = { AdBlocker, DEFAULT_DOMAINS, TWITCH_TELEMETRY, normalizeDomain };
