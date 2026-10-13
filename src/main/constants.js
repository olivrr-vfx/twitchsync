'use strict';

const path = require('path');

const PARTITION = 'persist:twitch';

// Public client ID of the twitch.tv web app. The login cookie (`auth-token`) is
// issued for this client, so every authenticated GQL call has to use it.
const TWITCH_WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

const chromeMajor = String(process.versions.chrome || '144').split('.')[0];

// A plain desktop Chrome user agent matching the bundled Chromium version –
// the default Electron UA contains "Electron/x.y" and an app token, which
// Twitch's login treats as an unknown browser.
const USER_AGENT =
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;

const ROOT = path.join(__dirname, '..');

module.exports = {
  PARTITION,
  TWITCH_WEB_CLIENT_ID,
  USER_AGENT,
  chromeMajor,
  RENDERER_DIR: path.join(ROOT, 'renderer'),
  PRELOAD_DIR: path.join(ROOT, 'preload'),
  REPO_URL: 'https://github.com/olivrr-vfx/twitchsync',
};
