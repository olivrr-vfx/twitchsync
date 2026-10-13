'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res || !res.ok) throw new Error((res && res.error) || 'Unbekannter Fehler');
  return res.data;
}

function on(channel, fn) {
  const listener = (_event, ...args) => fn(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('tsync', {
  init: () => invoke('app:init'),
  settings: {
    set: (patch) => invoke('store:set', patch),
  },
  auth: {
    state: () => invoke('auth:state'),
    login: () => invoke('auth:login'),
    logout: () => invoke('auth:logout'),
    onChange: (fn) => on('auth:changed', fn),
  },
  twitch: {
    followed: () => invoke('twitch:followed'),
    channels: (logins) => invoke('twitch:channels', logins),
    search: (term) => invoke('twitch:search', term),
    top: () => invoke('twitch:top'),
  },
  adblock: {
    stats: () => invoke('adblock:stats'),
    onCount: (fn) => on('adblock:count', fn),
  },
  extensions: {
    list: () => invoke('ext:list'),
    add: () => invoke('ext:add'),
    remove: (dir) => invoke('ext:remove', dir),
  },
  onMenu: (fn) => on('menu:command', fn),
  onFullscreen: (fn) => on('window:fullscreen', fn),
  setMenuState: (state) => ipcRenderer.send('menu:state', state),
  openExternal: (url) => ipcRenderer.send('app:open-external', url),
});
