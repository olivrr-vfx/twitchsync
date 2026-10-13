'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  protocol,
  screen,
  shell,
} = require('electron');

const {
  PARTITION,
  USER_AGENT,
  RENDERER_DIR,
  PRELOAD_DIR,
  REPO_URL,
} = require('./constants');
const { Store } = require('./store');
const { AdBlocker } = require('./adblock');
const { TwitchApi, normalizeLogin } = require('./twitch-api');
const { getTwitchSession, setupTwitchSession, loadExtension, unloadExtension } = require('./twitch-session');
const { buildMenu } = require('./menu');

const APP_ORIGIN = 'app://twitchsync';

app.setName('TwitchSync');
// Separate profile for development/testing (keeps the real session untouched).
if (process.env.TWITCHSYNC_USER_DATA) app.setPath('userData', process.env.TWITCHSYNC_USER_DATA);
app.userAgentFallback = USER_AGENT;
// Streams must be allowed to start with sound; muting is handled per webview.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
nativeTheme.themeSource = 'dark';

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();

let mainWindow = null;
let loginWindow = null;
let store = null;
let twitch = null;
const adblock = new AdBlocker();
const extensions = { loaded: [], failed: [] };
const authState = { loggedIn: false, user: null, expired: false };
const menuState = { syncEnabled: true };

// ---------------------------------------------------------------------------
// Helpers

function send(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

function openExternal(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') shell.openExternal(parsed.toString());
  } catch {
    /* ignore malformed urls */
  }
}

function loginFromTwitchUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)twitch\.tv$/.test(u.hostname)) return null;
    const first = u.pathname.split('/').filter(Boolean)[0];
    if (u.hostname === 'player.twitch.tv') return normalizeLogin(u.searchParams.get('channel'));
    return normalizeLogin(first);
  } catch {
    return null;
  }
}

function isTrustedSender(event) {
  const frame = event.senderFrame;
  return Boolean(mainWindow && event.sender === mainWindow.webContents && frame && frame.url.startsWith(APP_ORIGIN));
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) throw new Error('untrusted sender');
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      if (err && err.unauthorized) markLoggedOut(true);
      return { ok: false, error: (err && err.message) || String(err), code: err && err.code };
    }
  });
}

function updateMenu() {
  buildMenu({
    send: (command, arg) => send('menu:command', command, arg),
    state: {
      ...menuState,
      loggedIn: authState.loggedIn,
      userName: authState.user ? authState.user.displayName : null,
    },
    onLogin: () => openLoginWindow(),
    onLogout: () => logout().catch(() => {}),
    onAbout: () => app.showAboutPanel(),
  });
}

// ---------------------------------------------------------------------------
// Auth

function publicAuth() {
  return { ...authState };
}

function markLoggedOut(expired = false) {
  if (!authState.loggedIn && authState.expired === expired) return;
  authState.loggedIn = false;
  authState.user = null;
  authState.expired = expired;
  send('auth:changed', publicAuth());
  updateMenu();
}

async function refreshAuth() {
  const token = await twitch.token();
  if (!token) {
    authState.loggedIn = false;
    authState.user = null;
  } else {
    authState.loggedIn = true;
    authState.expired = false;
    try {
      authState.user = await twitch.viewer();
      if (!authState.user) authState.loggedIn = false;
    } catch (err) {
      if (err.unauthorized) {
        authState.loggedIn = false;
        authState.expired = true;
      }
      // Network problems keep the cookie-based state; the user info follows later.
    }
  }
  send('auth:changed', publicAuth());
  updateMenu();
  return publicAuth();
}

let authRefreshTimer = null;
function scheduleAuthRefresh() {
  clearTimeout(authRefreshTimer);
  authRefreshTimer = setTimeout(() => refreshAuth().catch(() => {}), 600);
}

function openLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }
  loginWindow = new BrowserWindow({
    width: 480,
    height: 780,
    minWidth: 380,
    minHeight: 560,
    parent: mainWindow || undefined,
    title: 'Bei Twitch anmelden',
    backgroundColor: '#0e0e10',
    show: false,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  loginWindow.setMenuBarVisibility(false);
  loginWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (/(^|\.)twitch\.tv$/.test(new URL(url).hostname)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { parent: loginWindow, webPreferences: { partition: PARTITION, sandbox: true } },
        };
      }
    } catch {
      /* fallthrough */
    }
    openExternal(url);
    return { action: 'deny' };
  });
  loginWindow.once('ready-to-show', () => loginWindow && loginWindow.show());
  loginWindow.on('closed', () => {
    loginWindow = null;
    scheduleAuthRefresh();
  });
  loginWindow.loadURL('https://www.twitch.tv/login');
}

async function logout() {
  const ses = getTwitchSession();
  const cookies = await ses.cookies.get({});
  await Promise.all(
    cookies
      .filter((c) => /(^|\.)twitch\.tv$/.test(c.domain.replace(/^\./, '')))
      .map((c) => {
        const url = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path || '/'}`;
        return ses.cookies.remove(url, c.name).catch(() => {});
      }),
  );
  for (const origin of ['https://www.twitch.tv', 'https://passport.twitch.tv', 'https://id.twitch.tv', 'https://player.twitch.tv']) {
    await ses.clearStorageData({ origin }).catch(() => {});
  }
  await ses.cookies.flushStore().catch(() => {});
  authState.loggedIn = false;
  authState.user = null;
  authState.expired = false;
  send('auth:changed', publicAuth());
  updateMenu();
  return publicAuth();
}

// ---------------------------------------------------------------------------
// Extensions

async function loadSavedExtensions() {
  const ses = getTwitchSession();
  const paths = store.get().adblock.extensions || [];
  for (const dir of paths) {
    try {
      extensions.loaded.push(await loadExtension(ses, dir));
    } catch (err) {
      extensions.failed.push({ path: dir, error: err.message });
    }
  }
}

function extensionList() {
  return { loaded: extensions.loaded, failed: extensions.failed };
}

async function addExtension() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Entpackte Erweiterung laden',
    message: 'Wähle den Ordner der entpackten Erweiterung (mit manifest.json).',
    buttonLabel: 'Laden',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return extensionList();
  const dir = result.filePaths[0];
  if (extensions.loaded.some((e) => e.path === dir)) return extensionList();
  const info = await loadExtension(getTwitchSession(), dir);
  extensions.loaded.push(info);
  extensions.failed = extensions.failed.filter((f) => f.path !== dir);
  const saved = store.get().adblock.extensions || [];
  if (!saved.includes(dir)) store.set({ adblock: { extensions: [...saved, dir] } });
  return extensionList();
}

function removeExtension(dir) {
  const ses = getTwitchSession();
  const loaded = extensions.loaded.find((e) => e.path === dir);
  if (loaded) unloadExtension(ses, loaded.id);
  extensions.loaded = extensions.loaded.filter((e) => e.path !== dir);
  extensions.failed = extensions.failed.filter((e) => e.path !== dir);
  store.set({ adblock: { extensions: (store.get().adblock.extensions || []).filter((p) => p !== dir) } });
  return extensionList();
}

// ---------------------------------------------------------------------------
// Webview hardening

function classifyGuestUrl(src) {
  try {
    const u = new URL(src);
    if (u.protocol !== 'https:') return null;
    if (u.hostname === 'player.twitch.tv') return 'player';
    if (u.hostname === 'www.twitch.tv' && /^\/(popout|embed)\/[^/]+\/chat/.test(u.pathname)) return 'chat';
  } catch {
    /* invalid */
  }
  return null;
}

function isAllowedGuestNavigation(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    if (u.hostname === 'player.twitch.tv') return true;
    return u.hostname === 'www.twitch.tv' && /^\/(popout|embed)\//.test(u.pathname);
  } catch {
    return false;
  }
}

function hardenWebContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });

  if (contents.getType() === 'webview') {
    const guard = (event, url) => {
      if (isAllowedGuestNavigation(url)) return;
      event.preventDefault();
      if (/^https:\/\/(www\.)?twitch\.tv\/login/.test(url)) {
        openLoginWindow();
        return;
      }
      // A twitch.tv channel link dropped onto a player or chat adds the channel.
      const login = /^https?:\/\/(www\.)?twitch\.tv\/[^/?#]+\/?$/.test(url) ? loginFromTwitchUrl(url) : null;
      if (login) send('menu:command', 'add-login', login);
      else openExternal(url);
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
  }

  contents.on('will-attach-webview', (event, webPreferences, params) => {
    const kind = classifyGuestUrl(params.src);
    if (!mainWindow || contents !== mainWindow.webContents || !kind) {
      event.preventDefault();
      return;
    }
    delete webPreferences.preloadURL;
    webPreferences.preload = path.join(PRELOAD_DIR, kind === 'player' ? 'player-preload.js' : 'chat-preload.js');
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.backgroundThrottling = false;
    webPreferences.spellcheck = kind === 'chat';
    // Players need the Shape Detection API (FaceDetector) for facecam detection.
    webPreferences.experimentalFeatures = kind === 'player';
    params.partition = PARTITION;
  });
}

// ---------------------------------------------------------------------------
// Main window

function restoreBounds() {
  const saved = store.get().window;
  const defaults = { width: 1440, height: 880 };
  if (!saved || !saved.width || !saved.height) return defaults;
  const display = screen.getDisplayMatching({ x: saved.x || 0, y: saved.y || 0, width: saved.width, height: saved.height });
  const area = display.workArea;
  const visible =
    typeof saved.x === 'number' &&
    saved.x < area.x + area.width - 80 &&
    saved.x + saved.width > area.x + 80 &&
    saved.y >= area.y - 20 &&
    saved.y < area.y + area.height - 80;
  return visible
    ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
    : { width: Math.min(saved.width, area.width), height: Math.min(saved.height, area.height) };
}

function saveBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFullScreen()) return;
  const maximized = mainWindow.isMaximized();
  const bounds = maximized ? (store.get().window || mainWindow.getNormalBounds()) : mainWindow.getBounds();
  store.set({ window: { ...bounds, maximized } });
}

function createMainWindow() {
  const bounds = restoreBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 560,
    title: 'TwitchSync',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 19 },
    backgroundColor: '#07080b',
    show: false,
    webPreferences: {
      preload: path.join(PRELOAD_DIR, 'app-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  if (store.get().window && store.get().window.maximized) mainWindow.maximize();

  mainWindow.once('ready-to-show', () => mainWindow.show());
  let boundsTimer = null;
  const queueBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(saveBounds, 400);
  };
  mainWindow.on('resize', queueBounds);
  mainWindow.on('move', queueBounds);
  mainWindow.on('close', saveBounds);
  mainWindow.on('enter-full-screen', () => send('window:fullscreen', true));
  mainWindow.on('leave-full-screen', () => send('window:fullscreen', false));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Dropping a twitch.tv link onto the window adds the channel instead of navigating away.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(APP_ORIGIN)) return;
    event.preventDefault();
    const login = loginFromTwitchUrl(url);
    if (login) send('menu:command', 'add-login', login);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] renderer gone:', details.reason);
    if (details.reason !== 'clean-exit' && mainWindow) mainWindow.reload();
  });

  mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
}

// ---------------------------------------------------------------------------
// IPC

function registerIpc() {
  handle('app:init', async () => ({
    settings: store.get(),
    auth: publicAuth(),
    adblock: adblock.stats(),
    extensions: extensionList(),
    fullscreen: Boolean(mainWindow && mainWindow.isFullScreen()),
    app: {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      platform: process.platform,
      locale: app.getLocale(),
      repo: REPO_URL,
      debug: !app.isPackaged || process.env.TWITCHSYNC_DEBUG === '1',
    },
  }));
  handle('store:set', (patch) => store.set(patch));
  handle('auth:state', () => refreshAuth());
  handle('auth:login', () => openLoginWindow());
  handle('auth:logout', () => logout());
  handle('twitch:followed', () => twitch.followedLive());
  handle('twitch:channels', (logins) => twitch.channels(Array.isArray(logins) ? logins : []));
  handle('twitch:search', (term) => twitch.search(term));
  handle('twitch:top', () => twitch.topStreams(app.getLocale()));
  handle('adblock:stats', () => adblock.stats());
  handle('ext:list', () => extensionList());
  handle('ext:add', () => addExtension());
  handle('ext:remove', (dir) => removeExtension(String(dir)));

  ipcMain.on('menu:state', (event, state) => {
    if (!isTrustedSender(event) || !state || typeof state !== 'object') return;
    menuState.syncEnabled = Boolean(state.syncEnabled);
    updateMenu();
  });
  ipcMain.on('app:open-external', (event, url) => {
    if (isTrustedSender(event)) openExternal(String(url));
  });
}

// ---------------------------------------------------------------------------
// Startup

function serveRenderer() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'twitchsync') return new Response('Not found', { status: 404 });
    const relative = path.normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
    const file = path.join(RENDERER_DIR, relative || 'index.html');
    if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    headers.set('Cache-Control', 'no-cache');
    return new Response(res.body, { status: res.status, headers });
  });
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on('web-contents-created', (_event, contents) => hardenWebContents(contents));

app.whenReady().then(async () => {
  if (!hasInstanceLock) return;
  store = new Store(app.getPath('userData'));
  adblock.configure(store.get().adblock);
  store.on('change', (data) => adblock.configure(data.adblock));
  adblock.on('count', (count) => send('adblock:count', count));

  app.setAboutPanelOptions({
    applicationName: 'TwitchSync',
    applicationVersion: app.getVersion(),
    copyright: '© 2026 olivrr-vfx · MIT-Lizenz',
    credits: 'Multiview für Twitch mit synchronisierten Streams.\nNicht mit Twitch Interactive, Inc. verbunden.',
    website: REPO_URL,
  });

  const ses = setupTwitchSession(adblock);
  twitch = new TwitchApi(ses);
  ses.cookies.on('changed', (_e, cookie) => {
    if (cookie.name === 'auth-token' && /twitch\.tv$/.test(cookie.domain)) scheduleAuthRefresh();
  });

  serveRenderer();
  registerIpc();
  await loadSavedExtensions();
  menuState.syncEnabled = store.get().sync.enabled;
  updateMenu();
  createMainWindow();
  refreshAuth().catch(() => {});

  app.on('activate', () => {
    if (!mainWindow) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  saveBounds();
  if (store) store.flush();
});
