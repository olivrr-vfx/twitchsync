import { icons } from './icons.js';
import { h, avatar } from './ui.js';

const MAX_LIVE_CHATS = 4; // keep memory in check – older chats are unloaded

export class ChatPanel {
  constructor({ tabsEl, bodyEl, onSelect }) {
    this.tabsEl = tabsEl;
    this.bodyEl = bodyEl;
    this.onSelect = onSelect;
    this.views = new Map(); // login -> { webview, usedAt }
    this.active = null;
    this.channels = [];
    this.emptyEl = h('div', { class: 'chat-empty' }, [
      h('div', {}, [
        h('div', { class: 'glyph', html: icons.chat }),
        h('div', { text: 'Füge einen Kanal hinzu – sein Chat erscheint hier. Mit deinem Login inklusive Sub-Emotes.' }),
      ]),
    ]);
    this.bodyEl.append(this.emptyEl);
  }

  // channels: [{ login, name, avatar, color }]
  setChannels(channels) {
    this.channels = channels;
    const logins = new Set(channels.map((c) => c.login));
    for (const [login, view] of this.views) {
      if (!logins.has(login)) {
        view.webview.remove();
        this.views.delete(login);
      }
    }
    if (this.active && !logins.has(this.active)) this.active = null;
    if (!this.active && channels.length) this.active = channels[0].login;
    this.renderTabs();
    this.showActive();
  }

  select(login) {
    if (!this.channels.some((c) => c.login === login)) return;
    if (this.active === login) return;
    this.active = login;
    this.renderTabs();
    this.showActive();
    this.onSelect && this.onSelect(login);
  }

  renderTabs() {
    this.tabsEl.replaceChildren(
      ...this.channels.map((c) =>
        h(
          'button',
          {
            class: `chat-tab ${c.login === this.active ? 'is-active' : ''}`,
            style: { '--tab-color': c.color },
            'data-tip': `Chat von ${c.name}`,
            onClick: () => this.select(c.login),
          },
          [avatar(c.avatar, c.name, { size: 'sm' }), h('span', { text: c.name })],
        ),
      ),
    );
    const activeTab = this.tabsEl.querySelector('.is-active');
    if (activeTab) activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  showActive() {
    this.emptyEl.hidden = Boolean(this.active);
    for (const [login, view] of this.views) view.webview.classList.toggle('is-active', login === this.active);
    if (!this.active) return;
    let view = this.views.get(this.active);
    if (!view) {
      const webview = document.createElement('webview');
      webview.setAttribute('partition', 'persist:twitch');
      webview.setAttribute('allowpopups', '');
      webview.setAttribute('src', `https://www.twitch.tv/popout/${encodeURIComponent(this.active)}/chat?popout=`);
      webview.classList.add('is-active');
      this.bodyEl.append(webview);
      view = { webview };
      this.views.set(this.active, view);
    }
    view.usedAt = Date.now();
    this.trim();
  }

  trim() {
    if (this.views.size <= MAX_LIVE_CHATS) return;
    const byAge = [...this.views.entries()].filter(([l]) => l !== this.active).sort((a, b) => a[1].usedAt - b[1].usedAt);
    while (this.views.size > MAX_LIVE_CHATS && byAge.length) {
      const [login, view] = byAge.shift();
      view.webview.remove();
      this.views.delete(login);
    }
  }

  reloadAll() {
    for (const view of this.views.values()) {
      try {
        view.webview.reload();
      } catch {
        /* not attached */
      }
    }
  }
}
