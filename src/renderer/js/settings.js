import { icons, brandMark } from './icons.js';
import { h, modal, avatar, toast, escapeHtml } from './ui.js';

const PANES = [
  { id: 'playback', label: 'Wiedergabe', icon: 'play' },
  { id: 'sync', label: 'Sync', icon: 'sync' },
  { id: 'adblock', label: 'Werbeblocker', icon: 'shield' },
  { id: 'account', label: 'Konto', icon: 'user' },
  { id: 'shortcuts', label: 'Tastenkürzel', icon: 'keyboard' },
  { id: 'about', label: 'Über', icon: 'info' },
];

function toggle(checked, onChange) {
  const input = h('input', { type: 'checkbox' });
  input.checked = Boolean(checked);
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'switch' }, [input, h('span', { class: 'switch-ui' })]);
}

function slider({ min, max, step, value, format, onChange }) {
  const out = h('span', { class: 's-value', text: format(value) });
  const input = h('input', { class: 'range signal', type: 'range', min, max, step, value: String(value) });
  const paint = () => {
    const p = ((Number(input.value) - min) / (max - min)) * 100;
    input.style.setProperty('--p', `${p}%`);
    out.textContent = format(Number(input.value));
  };
  input.addEventListener('input', paint);
  input.addEventListener('change', () => onChange(Number(input.value)));
  input.style.width = '150px';
  paint();
  return [input, out];
}

function select(options, value, onChange) {
  const el = h('select', { class: 'select' });
  for (const [v, label] of options) {
    const opt = h('option', { value: v, text: label });
    if (String(v) === String(value)) opt.selected = true;
    el.append(opt);
  }
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

function setting(title, desc, control) {
  return h('div', { class: 'setting' }, [
    h('div', { class: 's-text' }, [h('div', { class: 's-title', text: title }), desc ? h('div', { class: 's-desc', html: desc }) : null]),
    h('div', { class: 's-control' }, [].concat(control)),
  ]);
}

const sec = (v) => `${v.toFixed(2).replace('.', ',')} s`;

export function openSettings(ctrl, initial = 'playback') {
  let current = PANES.some((p) => p.id === initial) ? initial : 'playback';
  const body = h('div', { class: 'modal-body' });
  const nav = h('nav', { class: 'modal-nav' }, [h('h2', { text: 'Einstellungen' })]);
  const navButtons = new Map();
  for (const pane of PANES) {
    const btn = h('button', {
      class: 'nav-item',
      html: `${icons[pane.icon]}<span>${pane.label}</span>`,
      onClick: () => show(pane.id),
    });
    navButtons.set(pane.id, btn);
    nav.append(btn);
  }
  nav.append(h('div', { class: 'nav-foot' }, [h('span', { class: 'eyebrow', text: `v${ctrl.appInfo.version}` })]));

  const panel = h('div', { class: 'modal' }, [
    nav,
    h('div', { class: 'modal-main' }, [
      h('button', { class: 'icon-btn modal-close', html: icons.x, 'data-tip': 'Schließen · Esc', onClick: () => close() }),
      body,
    ]),
  ]);

  const renderers = {
    playback() {
      const s = ctrl.settings();
      return [
        h('h3', { text: 'Wiedergabe' }),
        h('p', { class: 'lede', text: 'Wie Streams geladen werden und wohin Ton und Chat folgen.' }),
        setting(
          'Standardqualität',
          'Gilt für neu geladene Player. Pro Stream änderbar über „Mehr“ in der Kachel oder das Zahnrad im Player. Niedrigere Qualität spart Bandbreite und CPU bei vielen Streams.',
          select(
            [
              ['auto', 'Automatisch'],
              ['chunked', 'Quelle'],
              ['1080', '1080p'],
              ['720', '720p'],
              ['480', '480p'],
              ['360', '360p'],
              ['160', '160p'],
            ],
            s.playback.quality,
            (v) => ctrl.setDefaultQuality(v),
          ),
        ),
        setting(
          'Kachel-Infos',
          'Kanalname, Latenz und Bedienelemente als <b>Leiste über dem Bild</b> (verdeckt nichts) oder als Overlay <b>auf dem Bild</b>, das beim Überfahren erscheint. Mit <span class="mono">I</span> blendest du alles komplett aus.',
          [
            select(
              [
                ['bar', 'Leiste über dem Bild'],
                ['overlay', 'Overlay auf dem Bild'],
              ],
              s.playback.tileChrome,
              (v) => ctrl.setTileChrome(v),
            ),
            toggle(!s.ui.chromeHidden, (v) => ctrl.setChromeHidden(!v)),
          ],
        ),
        setting('Ton folgt dem Fokus', 'Im Fokus-Modus bekommt der große Stream automatisch den Ton.', toggle(s.playback.audioFollowsFocus, (v) => ctrl.update({ playback: { audioFollowsFocus: v } }))),
        setting('Chat folgt dem Ton', 'Der Chat-Tab wechselt zum Stream, den du gerade hörst.', toggle(s.playback.chatFollowsAudio, (v) => ctrl.update({ playback: { chatFollowsAudio: v } }))),
        setting(
          'Multistream-Hinweise',
          'Meldung, wenn ein Kanal per Stream Together, Shared Chat oder im Titel mit anderen live ist.',
          toggle(s.playback.partnerToasts, (v) => ctrl.update({ playback: { partnerToasts: v } })),
        ),
        h('div', { class: 'callout', html: `${icons.info}<div>Der <b>Low-Latency-Modus</b> des Twitch-Players ist für alle Streams fest deaktiviert. Der normale Modus puffert stabiler – das ist die Grundlage für eine saubere Synchronisation.</div>` }),
      ];
    },

    sync() {
      const s = ctrl.settings().sync;
      return [
        h('h3', { text: 'Synchronisation' }),
        h('p', {
          class: 'lede',
          text: 'TwitchSync misst bei jedem Stream die Latenz zum Streamer und gleicht alle an den langsamsten an: schnellere Streams spielen kurz langsamer oder halten einen Moment an.',
        }),
        setting('Auto-Sync', 'Streams laufend angleichen. Manueller Versatz pro Stream gilt zusätzlich.', toggle(s.enabled, (v) => ctrl.setSyncEnabled(v))),
        setting(
          'Toleranz',
          'Abweichung, ab der korrigiert wird. Kleinere Werte = genauer, aber häufigere Mini-Korrekturen.',
          slider({ min: 0.05, max: 0.5, step: 0.05, value: s.tolerance, format: sec, onChange: (v) => ctrl.update({ sync: { tolerance: v } }) }),
        ),
        setting(
          'Anhalten ab',
          'Größere Abstände werden durch kurzes Anhalten geschlossen statt durch Verlangsamen. Für den Stream mit Ton gilt der doppelte Wert.',
          slider({ min: 0.5, max: 5, step: 0.5, value: s.freezeThreshold, format: sec, onChange: (v) => ctrl.update({ sync: { freezeThreshold: v } }) }),
        ),
        setting(
          'Tempo beim Angleichen',
          'Wie stark ein Stream höchstens verlangsamt wird (Tonhöhe bleibt erhalten).',
          select(
            [
              ['0.95', 'Sanft · 0,95×'],
              ['0.9', 'Normal · 0,90×'],
              ['0.85', 'Zügig · 0,85×'],
              ['0.75', 'Schnell · 0,75×'],
            ],
            String(s.maxSlowdown),
            (v) => ctrl.update({ sync: { maxSlowdown: Number(v) } }),
          ),
        ),
        setting(
          'Latenz minimieren',
          'Haben alle Streams genug Puffer, holt die ganze Gruppe gemeinsam auf (bis 1,08×) – so wächst die Verzögerung nach Hängern nicht dauerhaft an.',
          toggle(s.minimizeLatency, (v) => ctrl.update({ sync: { minimizeLatency: v } })),
        ),
        h('div', { class: 'callout', html: `${icons.sync}<div><b>So liest du die Anzeige:</b> Jede Kachel zeigt ihre Latenz. <span class="mono" style="color:var(--cyan)">●</span> Referenz (langsamster Stream), <span class="mono" style="color:var(--signal)">●</span> synchron, <span class="mono" style="color:var(--amber)">●</span> gleicht an. Mit den Tasten <span class="mono">±0,1</span> / <span class="mono">±1</span> verschiebst du einen Stream manuell – z. B. wenn ein Streamer selbst eine Verzögerung eingestellt hat.</div>` }),
        h('div', { style: { display: 'flex', gap: '8px', marginTop: '6px' } }, [
          h('button', { class: 'btn', html: `${icons.resync}<span>Alle neu synchronisieren</span>`, onClick: () => ctrl.resyncAll() }),
          h('button', { class: 'btn ghost', text: 'Alle Versätze zurücksetzen', onClick: () => ctrl.resetOffsets() }),
        ]),
      ];
    },

    adblock() {
      const s = ctrl.settings().adblock;
      const stats = ctrl.adblockStats();
      const ext = ctrl.extensions();
      const statBlocked = h('div', { class: 'num signal', text: stats.blocked.toLocaleString('de-DE') });
      ctrl.onBlockedTick((n) => {
        statBlocked.textContent = n.toLocaleString('de-DE');
      });

      const textarea = h('textarea', {
        class: 'textarea',
        spellcheck: 'false',
        placeholder: 'eine Domain pro Zeile, z. B.\nads.example.com',
      });
      textarea.value = (s.customDomains || []).join('\n');
      textarea.addEventListener('change', () => {
        const domains = textarea.value
          .split(/[\s,]+/)
          .map((d) => d.trim())
          .filter(Boolean);
        ctrl.update({ adblock: { customDomains: domains } });
        toast(`${domains.length} eigene Domain${domains.length === 1 ? '' : 's'} gespeichert.`);
      });

      const extList = h('div', { class: 'ext-list' });
      const renderExt = (list) => {
        extList.replaceChildren();
        if (!list.loaded.length && !list.failed.length) {
          extList.append(h('div', { class: 's-desc', text: 'Keine Erweiterungen geladen.' }));
        }
        for (const e of list.loaded) {
          extList.append(
            h('div', { class: 'ext' }, [
              h('span', { html: icons.puzzle, style: { color: 'var(--signal)' } }),
              h('div', { class: 'ext-main' }, [
                h('div', { class: 's-title', text: `${e.name}${e.version ? ` · ${e.version}` : ''}` }),
                h('div', { class: 'ext-path', text: e.path }),
              ]),
              h('button', { class: 'icon-btn small', html: icons.trash, 'data-tip': 'Entfernen', onClick: () => ctrl.removeExtension(e.path).then(renderExt) }),
            ]),
          );
        }
        for (const f of list.failed) {
          extList.append(
            h('div', { class: 'ext failed' }, [
              h('span', { html: icons.alert, style: { color: 'var(--live)' } }),
              h('div', { class: 'ext-main' }, [h('div', { class: 's-title', text: f.error }), h('div', { class: 'ext-path', text: f.path })]),
              h('button', { class: 'icon-btn small', html: icons.trash, 'data-tip': 'Entfernen', onClick: () => ctrl.removeExtension(f.path).then(renderExt) }),
            ]),
          );
        }
      };
      renderExt(ext);

      return [
        h('h3', { text: 'Werbeblocker' }),
        h('p', {
          class: 'lede',
          text: 'Blockiert bekannte Werbe- und Tracking-Domains in der Twitch-Sitzung. Der Videostream selbst wird nicht verändert – werbefrei schaust du über Turbo oder deine Abos, sobald du angemeldet bist.',
        }),
        h('div', { class: 'stat-row' }, [
          h('div', { class: 'stat' }, [h('div', { class: 'eyebrow', text: 'Blockiert' }), statBlocked]),
          h('div', { class: 'stat' }, [h('div', { class: 'eyebrow', text: 'Regeln' }), h('div', { class: 'num', text: String(stats.rules) })]),
          h('div', { class: 'stat' }, [h('div', { class: 'eyebrow', text: 'Erweiterungen' }), h('div', { class: 'num', text: String(ext.loaded.length) })]),
        ]),
        setting('Request-Blocker', 'Werbe-, Analyse- und Tracking-Domains (Google Ads, Amazon Ads, Comscore …) blockieren.', toggle(s.enabled, (v) => ctrl.update({ adblock: { enabled: v } }))),
        setting(
          'Twitch-Telemetrie blockieren',
          'Blockiert auch Twitchs eigene Nutzungsstatistik. <b>Achtung:</b> Drops-Fortschritt basiert darauf.',
          toggle(s.blockTwitchTelemetry, (v) => ctrl.update({ adblock: { blockTwitchTelemetry: v } })),
        ),
        h('div', { class: 'setting', style: { display: 'block' } }, [
          h('div', { class: 's-title', text: 'Eigene Domains' }),
          h('div', { class: 's-desc', text: 'Zusätzliche Hosts, die blockiert werden sollen (inkl. Subdomains).', style: { marginBottom: '10px' } }),
          textarea,
        ]),
        h('div', { class: 'setting', style: { display: 'block' } }, [
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } }, [
            h('div', { class: 's-text', style: { flex: '1' } }, [
              h('div', { class: 's-title', text: 'Browser-Erweiterungen' }),
              h('div', {
                class: 's-desc',
                text: 'Entpackte Chrome-Erweiterung laden, z. B. uBlock Origin (Release-ZIP „chromium“ entpacken). Electron unterstützt nur einen Teil der Extension-APIs.',
              }),
            ]),
            h('button', {
              class: 'btn',
              html: `${icons.folder}<span>Ordner wählen …</span>`,
              onClick: () =>
                ctrl
                  .addExtension()
                  .then((list) => {
                    renderExt(list);
                  })
                  .catch((err) => toast(escapeHtml(err.message), { kind: 'error' })),
            }),
          ]),
          extList,
        ]),
      ];
    },

    account() {
      const auth = ctrl.auth();
      if (!auth.loggedIn) {
        return [
          h('h3', { text: 'Konto' }),
          h('p', { class: 'lede', text: 'Melde dich in einem normalen Twitch-Anmeldefenster an. Die Sitzung wird dauerhaft gespeichert und von allen Playern und Chats genutzt.' }),
          h('div', { class: 'account-card' }, [
            h('span', { class: 'avatar', html: `<span class="initial">${icons.user}</span>` }),
            h('div', { class: 'who' }, [
              h('div', { class: 'name', text: auth.expired ? 'Sitzung abgelaufen' : 'Nicht angemeldet' }),
              h('div', { class: 's-desc', text: 'Turbo, Abo-Werbefreiheit und Sub-Emotes greifen nach dem Login automatisch.' }),
            ]),
            h('button', { class: 'btn primary', html: `${icons.login}<span>Anmelden</span>`, onClick: () => ctrl.login() }),
          ]),
          h('div', { class: 'callout', html: `${icons.shield}<div>Dein Passwort gibst du direkt bei twitch.tv ein – TwitchSync sieht es nicht. Gespeichert wird nur das Sitzungs-Cookie von Twitch in deinem Benutzerprofil.</div>` }),
        ];
      }
      const u = auth.user || {};
      return [
        h('h3', { text: 'Konto' }),
        h('p', { class: 'lede', text: 'Du bist angemeldet. Alle Player und Chats nutzen diese Sitzung.' }),
        h('div', { class: 'account-card' }, [
          avatar(u.avatar, u.displayName || '?'),
          h('div', { class: 'who' }, [
            h('div', { class: 'name', text: u.displayName || 'Angemeldet' }),
            h('div', { class: 'badges' }, [
              u.turbo ? h('span', { class: 'badge violet', text: 'Turbo aktiv' }) : h('span', { class: 'badge muted', text: 'Kein Turbo' }),
              u.prime ? h('span', { class: 'badge', text: 'Prime' }) : null,
            ]),
          ]),
          h('button', { class: 'btn danger', html: `${icons.logout}<span>Abmelden</span>`, onClick: () => ctrl.logout().then(() => show('account')) }),
        ]),
        h('div', {
          class: 'callout',
          html: `${icons.info}<div>Werbefreiheit hängt von deinem Konto ab: <b>Turbo</b> entfernt Werbung überall, ein <b>Abo</b> beim jeweiligen Kanal. Bei Kanälen ohne Abo kann Twitch weiterhin Werbung zeigen – sie wird von der Sync-Logik erkannt und übersprungen.</div>`,
        }),
      ];
    },

    shortcuts() {
      const rows = [
        ['Kanal hinzufügen', '⌘ L'],
        ['Ton auf Stream 1–9', '⌘ 1 … 9  ·  1 … 9'],
        ['Stream zum Mix hinzufügen', '⌥ Klick'],
        ['Fokus-Modus', '⌘ ↩  ·  F  ·  Doppelklick'],
        ['Facecam-Modus', '⇧ ⌘ F  ·  C'],
        ['Zurück zum Grid', 'Esc  ·  G'],
        ['Kachel-Infos ein/aus', '⇧ ⌘ I  ·  I'],
        ['Alle stummschalten', '⇧ ⌘ M  ·  M'],
        ['Lautstärke aktiver Stream', '↑ ↓  ·  ⌥ Scrollen'],
        ['Auto-Sync an/aus', '⇧ ⌘ S'],
        ['Alle neu synchronisieren', '⇧ ⌘ R'],
        ['Streams neu laden', '⌘ R'],
        ['Kanäle-Leiste', '⌘ B'],
        ['Chat', '⇧ ⌘ C'],
        ['Einstellungen', '⌘ ,'],
      ];
      const grid = h('div', { class: 'keys' });
      for (const [label, keys] of rows) {
        grid.append(
          h('div', { text: label }),
          h(
            'div',
            {},
            keys.split('  ·  ').map((combo, i) =>
              h('span', { style: { marginLeft: i ? '10px' : '0' } }, combo.split(' ').map((k) => h('kbd', { text: k }))),
            ),
          ),
        );
      }
      return [
        h('h3', { text: 'Tastenkürzel' }),
        h('p', { class: 'lede', text: 'Einzeltasten funktionieren, solange kein Eingabefeld oder Chat fokussiert ist.' }),
        grid,
      ];
    },

    about() {
      const info = ctrl.appInfo;
      return [
        h('div', { class: 'about-hero' }, [
          h('span', { class: 'mark', html: brandMark(64) }),
          h('div', {}, [
            h('div', { class: 'word', html: 'Twitch<b>Sync</b>' }),
            h('div', { class: 'eyebrow', text: `Version ${info.version} · Electron ${info.electron}` }),
          ]),
        ]),
        h('p', { class: 'lede', text: 'Viele Streams. Ein Moment. Multiview für Twitch mit automatischer Latenz-Angleichung, Multistream-Erkennung und deinem eigenen Login.' }),
        h('div', { class: 'callout', html: `${icons.info}<div>TwitchSync ist ein inoffizielles Projekt und steht in keiner Verbindung zu Twitch Interactive, Inc. Streams laufen über den offiziellen eingebetteten Twitch-Player.</div>` }),
        h('div', { style: { display: 'flex', gap: '8px' } }, [
          h('button', { class: 'btn', html: `${icons.external}<span>Projekt auf GitHub</span>`, onClick: () => ctrl.openExternal(info.repo) }),
          h('button', { class: 'btn ghost', text: 'Lizenz: MIT', onClick: () => ctrl.openExternal(`${info.repo}/blob/main/LICENSE`) }),
        ]),
      ];
    },
  };

  function show(id) {
    current = id;
    ctrl.onBlockedTick(null);
    for (const [pid, btn] of navButtons) btn.classList.toggle('is-active', pid === id);
    body.replaceChildren(h('div', { class: 'pane' }, renderers[id]()));
    body.scrollTop = 0;
  }

  const close = modal(panel, { onClose: () => ctrl.onBlockedTick(null) });
  show(current);
  return { close, show, refresh: () => show(current) };
}
