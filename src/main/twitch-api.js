'use strict';

const { TWITCH_WEB_CLIENT_ID } = require('./constants');

const GQL_URL = 'https://gql.twitch.tv/gql';
const LOGIN_RE = /^[a-z0-9_]{2,25}$/;
const ID_RE = /^\d{1,20}$/;
// Twitch rejects queries with more than 15 aliased root fields.
const MAX_ROOT_FIELDS = 15;

const USER_FIELDS = 'id login displayName profileImageURL(width: 70)';
const STREAM_FIELDS = 'stream { id title viewersCount createdAt type game { id displayName } }';

const LANGUAGES = new Set([
  'EN', 'DE', 'FR', 'ES', 'IT', 'PT', 'NL', 'PL', 'RU', 'TR', 'JA', 'KO', 'ZH', 'SV', 'NO',
  'DA', 'FI', 'CS', 'HU', 'EL', 'UK', 'RO', 'BG', 'SK', 'TH', 'VI', 'ID', 'AR',
]);

class GqlError extends Error {
  constructor(message, { status, code, unauthorized } = {}) {
    super(message);
    this.name = 'GqlError';
    this.status = status;
    this.code = code;
    this.unauthorized = Boolean(unauthorized);
  }
}

function normalizeLogin(value) {
  const login = String(value || '').trim().toLowerCase();
  return LOGIN_RE.test(login) ? login : null;
}

function uniqueLogins(list, max = 100) {
  const out = [];
  for (const item of list || []) {
    const login = normalizeLogin(item);
    if (login && !out.includes(login)) out.push(login);
    if (out.length >= max) break;
  }
  return out;
}

function mapStream(stream) {
  if (!stream || !stream.id) return null;
  return {
    id: stream.id,
    title: stream.title || '',
    viewers: stream.viewersCount || 0,
    startedAt: stream.createdAt || null,
    type: stream.type || 'live',
    game: stream.game ? stream.game.displayName : null,
  };
}

function mapUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    login: user.login,
    displayName: user.displayName || user.login,
    avatar: user.profileImageURL || null,
    stream: mapStream(user.stream),
  };
}

// "@name" mentions and twitch.tv/name links inside a stream title.
function titleMentions(title) {
  const found = new Set();
  if (!title) return found;
  for (const m of title.matchAll(/(?:^|[^\w@])@([a-z0-9_]{3,25})\b/gi)) found.add(m[1].toLowerCase());
  for (const m of title.matchAll(/twitch\.tv\/([a-z0-9_]{3,25})\b/gi)) found.add(m[1].toLowerCase());
  return found;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

class TwitchApi {
  constructor(session) {
    this.session = session;
  }

  async cookie(name) {
    const cookies = await this.session.cookies.get({ name });
    const match = cookies.find((c) => /(^|\.)twitch\.tv$/.test(c.domain.replace(/^\./, '')));
    return match ? match.value : null;
  }

  token() {
    return this.cookie('auth-token');
  }

  async request(query, variables = {}, { auth = true } = {}) {
    const headers = {
      'Client-Id': TWITCH_WEB_CLIENT_ID,
      'Content-Type': 'text/plain;charset=UTF-8',
      Accept: 'application/json',
    };
    const [token, deviceId] = await Promise.all([auth ? this.token() : null, this.cookie('unique_id')]);
    if (token) headers.Authorization = `OAuth ${token}`;
    if (deviceId) headers['X-Device-Id'] = deviceId;

    let res;
    try {
      res = await this.session.fetch(GQL_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      throw new GqlError(`Twitch ist nicht erreichbar (${err.message})`);
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* handled below */
    }
    if (res.status === 401 || (json && /oauth token/i.test(json.message || ''))) {
      throw new GqlError('Die Twitch-Anmeldung ist abgelaufen.', { status: 401, unauthorized: true });
    }
    if (!res.ok || !json) {
      throw new GqlError(`Twitch-API antwortet mit HTTP ${res.status}`, { status: res.status });
    }
    if (Array.isArray(json.errors) && json.errors.length && !json.data) {
      const first = json.errors[0] || {};
      const code = first.extensions && first.extensions.code;
      throw new GqlError(first.message || 'Unbekannter Twitch-API-Fehler', { status: res.status, code });
    }
    return json.data || {};
  }

  async viewer() {
    const token = await this.token();
    if (!token) return null;
    const data = await this.request(
      `query { currentUser { ${USER_FIELDS} hasTurbo hasPrime } }`,
    );
    const user = data.currentUser;
    if (!user) return null;
    return { ...mapUser(user), turbo: Boolean(user.hasTurbo), prime: Boolean(user.hasPrime) };
  }

  async followedLive() {
    const token = await this.token();
    if (!token) return [];
    const query = (first) => `query { currentUser { id followedLiveUsers(first: ${first}) {
      edges { node { ${USER_FIELDS} ${STREAM_FIELDS} } } } } }`;
    let data;
    try {
      data = await this.request(query(100));
    } catch (err) {
      if (!/first/i.test(err.message)) throw err;
      data = await this.request(query(50));
    }
    const edges = (data.currentUser && data.currentUser.followedLiveUsers && data.currentUser.followedLiveUsers.edges) || [];
    return edges
      .map((e) => mapUser(e && e.node))
      .filter((u) => u && u.stream)
      .sort((a, b) => b.stream.viewers - a.stream.viewers);
  }

  async topStreams(locale) {
    const lang = String(locale || '').slice(0, 2).toUpperCase();
    const query = `query($langs: [Language!]) { streams(first: 12, options: { languages: $langs }) {
      edges { node { id title viewersCount createdAt type game { id displayName } broadcaster { ${USER_FIELDS} } } } } }`;
    let data;
    try {
      data = await this.request(query, { langs: LANGUAGES.has(lang) ? [lang] : null }, { auth: false });
    } catch {
      data = await this.request(query, { langs: null }, { auth: false });
    }
    const edges = (data.streams && data.streams.edges) || [];
    return edges
      .filter((e) => e && e.node && e.node.broadcaster)
      .map((e) => ({ ...mapUser(e.node.broadcaster), stream: mapStream(e.node) }));
  }

  async search(term) {
    const q = String(term || '').trim().replace(/^@/, '');
    if (q.length < 2) return [];
    const data = await this.request(
      `query($q: String!) { searchFor(userQuery: $q, platform: "web", options: { targets: [{ index: CHANNEL }] }) {
        channels { edges { item { ... on User { ${USER_FIELDS} ${STREAM_FIELDS} } } } } } }`,
      { q: q.slice(0, 60) },
      { auth: false },
    );
    const edges = (data.searchFor && data.searchFor.channels && data.searchFor.channels.edges) || [];
    return edges.map((e) => mapUser(e && e.item)).filter(Boolean).slice(0, 8);
  }

  async users(list) {
    const logins = uniqueLogins(list, 100);
    if (!logins.length) return [];
    const data = await this.request(
      `query($logins: [String!]) { users(logins: $logins) { ${USER_FIELDS} ${STREAM_FIELDS} } }`,
      { logins },
      { auth: false },
    );
    return (data.users || []).map(mapUser).filter(Boolean);
  }

  async sharedChatSessions(ids) {
    const out = new Map();
    for (const group of chunk(ids.filter((id) => ID_RE.test(id)), MAX_ROOT_FIELDS)) {
      const defs = group.map((_, i) => `$c${i}: ID!`).join(', ');
      const fields = group
        .map((_, i) => `c${i}: sharedChatSession(channelID: $c${i}) { id participants { channel { id name displayName } } }`)
        .join(' ');
      const vars = Object.fromEntries(group.map((id, i) => [`c${i}`, id]));
      try {
        const data = await this.request(`query(${defs}) { ${fields} }`, vars, { auth: false });
        group.forEach((id, i) => {
          const session = data[`c${i}`];
          if (session && Array.isArray(session.participants)) {
            out.set(id, {
              id: session.id,
              logins: session.participants
                .map((p) => p && p.channel && normalizeLogin(p.channel.name))
                .filter(Boolean),
            });
          }
        });
      } catch (err) {
        console.warn('[twitch] shared chat lookup failed:', err.message);
      }
    }
    return out;
  }

  // Stream info plus "who is live together with whom" for the channels in the grid.
  async channels(list) {
    const logins = uniqueLogins(list, 50);
    if (!logins.length) return {};
    const data = await this.request(
      `query($logins: [String!]) { users(logins: $logins) { ${USER_FIELDS} ${STREAM_FIELDS}
        channel { guestStarSessionCall { id host { login } guests { user { login } } } } } }`,
      { logins },
      { auth: false },
    );

    const result = {};
    const liveIds = [];
    for (const raw of data.users || []) {
      const user = mapUser(raw);
      if (!user) continue;
      const together = raw.channel && raw.channel.guestStarSessionCall;
      const togetherLogins = new Set();
      if (together) {
        if (together.host && together.host.login) togetherLogins.add(together.host.login.toLowerCase());
        for (const g of together.guests || []) {
          if (g && g.user && g.user.login) togetherLogins.add(g.user.login.toLowerCase());
        }
      }
      result[user.login] = {
        ...user,
        exists: true,
        live: Boolean(user.stream),
        sessions: {
          together: together ? { id: together.id, logins: [...togetherLogins] } : null,
          sharedChat: null,
        },
        mentions: user.stream ? [...titleMentions(user.stream.title)] : [],
        partners: [],
      };
      if (user.stream) liveIds.push(user.id);
    }
    for (const login of logins) {
      if (!result[login]) result[login] = { login, exists: false, live: false, partners: [] };
    }

    const shared = await this.sharedChatSessions(liveIds);
    for (const info of Object.values(result)) {
      if (info.id && shared.has(info.id)) info.sessions.sharedChat = shared.get(info.id);
    }

    // Collect partner candidates and resolve whether they are live.
    const sources = new Map(); // login -> Map(channel -> Set(source))
    const add = (channel, login, source) => {
      if (!login || login === channel) return;
      if (!sources.has(login)) sources.set(login, new Map());
      const byChannel = sources.get(login);
      if (!byChannel.has(channel)) byChannel.set(channel, new Set());
      byChannel.get(channel).add(source);
    };
    for (const info of Object.values(result)) {
      if (!info.exists || !info.live) continue;
      for (const l of info.sessions.together ? info.sessions.together.logins : []) add(info.login, l, 'together');
      for (const l of info.sessions.sharedChat ? info.sessions.sharedChat.logins : []) add(info.login, l, 'sharedChat');
      for (const l of info.mentions) add(info.login, l, 'title');
    }
    if (!sources.size) return result;

    const known = new Map();
    for (const info of Object.values(result)) if (info.exists) known.set(info.login, info);
    const unknown = [...sources.keys()].filter((l) => !known.has(l));
    try {
      for (const user of await this.users(unknown)) known.set(user.login, user);
    } catch (err) {
      console.warn('[twitch] partner lookup failed:', err.message);
    }

    for (const [login, byChannel] of sources) {
      const user = known.get(login);
      if (!user || !user.stream) continue;
      for (const [channel, srcs] of byChannel) {
        result[channel].partners.push({
          login: user.login,
          displayName: user.displayName,
          avatar: user.avatar,
          stream: user.stream,
          sources: [...srcs],
        });
      }
    }
    for (const info of Object.values(result)) {
      info.partners.sort((a, b) => (b.stream ? b.stream.viewers : 0) - (a.stream ? a.stream.viewers : 0));
    }
    return result;
  }
}

module.exports = { TwitchApi, GqlError, normalizeLogin, titleMentions };
