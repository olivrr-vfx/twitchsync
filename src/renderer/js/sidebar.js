import { icons } from './icons.js';
import { h, avatar, formatViewers, uptime } from './ui.js';

export class Sidebar {
  constructor(root, controller) {
    this.root = root;
    this.controller = controller;
  }

  item(user, inGrid, index) {
    const s = user.stream;
    const tip = [user.displayName, s && s.title, s && [s.game, uptime(s.startedAt)].filter(Boolean).join(' · ')]
      .filter(Boolean)
      .join('\n');
    return h(
      'button',
      {
        class: `ch-item ${inGrid ? 'in-grid' : ''}`,
        style: { '--i': index },
        'data-tip': inGrid ? `${tip}\n✓ Im Grid` : tip,
        onClick: (e) => this.controller.onSidebarPick(user, e),
      },
      [
        avatar(user.avatar, user.displayName, { live: Boolean(s) }),
        h('div', { class: 'ch-main' }, [
          h('div', { class: 'ch-name', text: user.displayName }),
          h('div', { class: 'ch-sub', text: (s && (s.game || s.title)) || '' }),
        ]),
        s ? h('span', { class: 'ch-viewers', text: formatViewers(s.viewers) }) : null,
      ],
    );
  }

  section({ key, title, count, open = true, onToggle, onRefresh, refreshing, body }) {
    const head = h('div', { class: 'side-head' }, [
      h('span', { class: 'eyebrow', text: title }),
      typeof count === 'number' ? h('span', { class: 'side-count', text: String(count) }) : null,
      onRefresh
        ? h('button', {
            class: 'icon-btn',
            html: icons.refresh,
            'data-tip': 'Aktualisieren',
            style: refreshing ? { animation: 'blink .8s steps(2) infinite' } : null,
            onClick: onRefresh,
          })
        : null,
      onToggle
        ? h('button', { class: 'icon-btn', html: `<span class="chev">${icons.chevron}</span>`, 'data-tip': open ? 'Einklappen' : 'Ausklappen', onClick: onToggle })
        : null,
    ]);
    return h('section', { class: `side-section ${open ? '' : 'is-closed'}`, dataset: { key } }, [head, body]);
  }

  render(state) {
    const { auth, followed, followedError, followedLoading, top, inGrid, discoverOpen, adblock } = state;
    const scroll = h('div', { class: 'side-scroll' });

    if (auth.loggedIn) {
      const list = h('div', { class: 'side-list' });
      if (followed && followed.length) {
        followed.forEach((u, i) => list.append(this.item(u, inGrid.has(u.login), i)));
      } else {
        list.append(
          h('div', {
            class: 'side-note',
            text: followedError
              ? `Konnte gefolgte Kanäle nicht laden: ${followedError}`
              : followedLoading || !followed
                ? 'Lade gefolgte Kanäle …'
                : 'Gerade ist niemand live, dem du folgst.',
          }),
        );
      }
      scroll.append(
        this.section({
          key: 'followed',
          title: 'Live · Gefolgt',
          count: followed ? followed.length : undefined,
          onRefresh: () => this.controller.refreshFollowed(true),
          refreshing: followedLoading,
          body: list,
        }),
      );
    } else {
      scroll.append(
        h('div', { class: 'login-card' }, [
          h('div', { class: 'eyebrow', text: auth.expired ? 'Sitzung abgelaufen' : 'Dein Twitch' }),
          h('h3', { text: 'Gefolgte Kanäle, Turbo & Sub-Emotes' }),
          h('p', {
            text: 'Melde dich einmal an – die Sitzung bleibt gespeichert. Turbo und Abos wirken dann automatisch in allen Playern und im Chat.',
          }),
          h('button', {
            class: 'btn primary block',
            html: `${icons.login}<span>Mit Twitch anmelden</span>`,
            'data-tip': 'Bei Twitch anmelden',
            onClick: () => this.controller.login(),
          }),
        ]),
      );
    }

    if (top && top.length) {
      const list = h('div', { class: 'side-list' });
      top.forEach((u, i) => list.append(this.item(u, inGrid.has(u.login), i)));
      scroll.append(
        this.section({
          key: 'discover',
          title: 'Gerade beliebt',
          open: discoverOpen,
          onToggle: () => this.controller.toggleDiscover(),
          body: list,
        }),
      );
    }

    const foot = h('div', { class: 'side-foot' });
    if (auth.loggedIn && auth.user) {
      const u = auth.user;
      foot.append(
        avatar(u.avatar, u.displayName, { size: 'md' }),
        h('div', { class: 'who' }, [
          h('div', { class: 'ch-name', text: u.displayName }),
          h('div', { class: 'foot-extra', style: { display: 'flex', gap: '4px', marginTop: '2px' } }, [
            u.turbo ? h('span', { class: 'badge violet', text: 'Turbo' }) : null,
            h('span', { class: 'badge muted blocked-count', text: blockedText(adblock.blocked) }),
          ]),
        ]),
        h('button', { class: 'icon-btn small', html: icons.logout, 'data-tip': 'Abmelden', onClick: () => this.controller.logout() }),
      );
    } else if (auth.loggedIn) {
      foot.append(
        h('div', { class: 'who' }, [h('div', { class: 'ch-sub', text: 'Angemeldet' })]),
        h('button', { class: 'icon-btn small', html: icons.logout, 'data-tip': 'Abmelden', onClick: () => this.controller.logout() }),
      );
    } else {
      foot.append(
        h('span', { class: 'avatar md', html: `<span class="initial">${icons.user}</span>` }),
        h('div', { class: 'who' }, [
          h('div', { class: 'ch-sub', text: 'Nicht angemeldet' }),
          h('div', { class: 'foot-extra' }, [h('span', { class: 'badge muted blocked-count', text: blockedText(adblock.blocked) })]),
        ]),
        h('button', { class: 'icon-btn small', html: icons.login, 'data-tip': 'Anmelden', onClick: () => this.controller.login() }),
      );
    }

    // Only play the entrance animation when the lists actually changed.
    const signature = [auth.loggedIn, ...(followed || []).map((u) => u.login), '|', ...(top || []).map((u) => u.login)].join(',');
    if (signature === this.signature) scroll.classList.add('calm');
    this.signature = signature;

    const prevScroll = this.root.querySelector('.side-scroll');
    const scrollTop = prevScroll ? prevScroll.scrollTop : 0;
    this.root.replaceChildren(scroll, foot);
    scroll.scrollTop = scrollTop;
  }

  setBlocked(count) {
    for (const el of this.root.querySelectorAll('.blocked-count')) el.textContent = blockedText(count);
  }
}

function blockedText(count) {
  return `${Number(count || 0).toLocaleString('de-DE')} blockiert`;
}
