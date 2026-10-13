'use strict';

const fs = require('fs');
const path = require('path');
const { session } = require('electron');
const { PARTITION, USER_AGENT } = require('./constants');

const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'clipboard-read', 'fullscreen']);

function getTwitchSession() {
  return session.fromPartition(PARTITION);
}

function setupTwitchSession(adblock) {
  const ses = getTwitchSession();
  ses.setUserAgent(USER_AGENT, 'de-DE,de,en-US,en');

  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: adblock.shouldBlock(details) });
  });

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

  return ses;
}

function extensionsApi(ses) {
  // Electron >= 35 moved the API to `session.extensions`.
  return ses.extensions && typeof ses.extensions.loadExtension === 'function' ? ses.extensions : ses;
}

function readManifest(dir) {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) {
    throw new Error('Im gewählten Ordner liegt keine manifest.json – bitte den entpackten Erweiterungsordner wählen.');
  }
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  return manifest;
}

// Resolves "__MSG_extName__" style names from the extension's _locales folder.
function displayName(dir, name) {
  const match = /^__MSG_(.+)__$/.exec(name || '');
  if (!match) return name || path.basename(dir);
  for (const locale of ['de', 'en', 'en_US', 'en_GB']) {
    try {
      const messages = JSON.parse(fs.readFileSync(path.join(dir, '_locales', locale, 'messages.json'), 'utf8'));
      const key = Object.keys(messages).find((k) => k.toLowerCase() === match[1].toLowerCase());
      if (key && messages[key].message) return messages[key].message;
    } catch {
      /* try next locale */
    }
  }
  return path.basename(dir);
}

async function loadExtension(ses, dir) {
  const manifest = readManifest(dir);
  const api = extensionsApi(ses);
  const ext = await api.loadExtension(dir, { allowFileAccess: true });
  return {
    id: ext.id,
    name: displayName(dir, ext.name || manifest.name),
    version: ext.version || manifest.version || '',
    manifestVersion: manifest.manifest_version || null,
    path: dir,
  };
}

function unloadExtension(ses, id) {
  const api = extensionsApi(ses);
  try {
    api.removeExtension(id);
  } catch (err) {
    console.warn('[extensions] remove failed:', err.message);
  }
}

module.exports = { getTwitchSession, setupTwitchSession, loadExtension, unloadExtension };
