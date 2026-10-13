'use strict';

const { app, Menu, shell } = require('electron');
const { REPO_URL } = require('./constants');

function buildMenu({ send, state, onLogin, onLogout, onAbout }) {
  const cmd = (name, extra) => () => send(name, extra);
  const audioItems = Array.from({ length: 9 }, (_, i) => ({
    label: `Ton auf Stream ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    click: cmd('audio-solo', i),
  }));

  const template = [
    {
      label: app.name,
      submenu: [
        { label: `Über ${app.name}`, click: onAbout },
        { type: 'separator' },
        { label: 'Einstellungen …', accelerator: 'CmdOrCtrl+,', click: cmd('settings') },
        { type: 'separator' },
        { role: 'services', label: 'Dienste' },
        { type: 'separator' },
        { role: 'hide', label: `${app.name} ausblenden` },
        { role: 'hideOthers', label: 'Andere ausblenden' },
        { role: 'unhide', label: 'Alle einblenden' },
        { type: 'separator' },
        { role: 'quit', label: `${app.name} beenden` },
      ],
    },
    {
      label: 'Bearbeiten',
      submenu: [
        { role: 'undo', label: 'Widerrufen' },
        { role: 'redo', label: 'Wiederholen' },
        { type: 'separator' },
        { role: 'cut', label: 'Ausschneiden' },
        { role: 'copy', label: 'Kopieren' },
        { role: 'paste', label: 'Einsetzen' },
        { role: 'selectAll', label: 'Alles auswählen' },
      ],
    },
    {
      label: 'Streams',
      submenu: [
        { label: 'Kanal hinzufügen …', accelerator: 'CmdOrCtrl+L', click: cmd('add-channel') },
        { label: 'Grid', click: cmd('view', 'grid') },
        { label: 'Fokus-Modus', accelerator: 'CmdOrCtrl+Return', click: cmd('toggle-focus') },
        { label: 'Facecam-Modus', accelerator: 'CmdOrCtrl+Shift+F', click: cmd('view', 'facecam') },
        { type: 'separator' },
        ...audioItems,
        { label: 'Alle stummschalten', accelerator: 'CmdOrCtrl+Shift+M', click: cmd('mute-all') },
        { type: 'separator' },
        {
          label: 'Auto-Sync',
          type: 'checkbox',
          checked: Boolean(state.syncEnabled),
          accelerator: 'CmdOrCtrl+Shift+S',
          click: cmd('toggle-sync'),
        },
        { label: 'Alle neu synchronisieren', accelerator: 'CmdOrCtrl+Shift+R', click: cmd('resync-all') },
        { label: 'Streams neu laden', accelerator: 'CmdOrCtrl+R', click: cmd('reload-streams') },
        { type: 'separator' },
        { label: 'Alle Kanäle entfernen', click: cmd('clear-channels') },
      ],
    },
    {
      label: 'Ansicht',
      submenu: [
        { label: 'Kanäle-Leiste', accelerator: 'CmdOrCtrl+B', click: cmd('toggle-sidebar') },
        { label: 'Chat', accelerator: 'CmdOrCtrl+Shift+C', click: cmd('toggle-chat') },
        { label: 'Kachel-Infos ein/aus', accelerator: 'CmdOrCtrl+Shift+I', click: cmd('toggle-chrome') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Vollbild' },
        ...(app.isPackaged
          ? []
          : [{ type: 'separator' }, { role: 'toggleDevTools', label: 'Entwicklertools' }, { role: 'forceReload', label: 'Oberfläche neu laden' }]),
      ],
    },
    {
      label: 'Konto',
      submenu: state.loggedIn
        ? [
            { label: state.userName ? `Angemeldet als ${state.userName}` : 'Angemeldet', enabled: false },
            { type: 'separator' },
            { label: 'Abmelden', click: onLogout },
          ]
        : [{ label: 'Bei Twitch anmelden …', click: onLogin }],
    },
    { role: 'windowMenu', label: 'Fenster' },
    {
      role: 'help',
      label: 'Hilfe',
      submenu: [
        { label: 'Tastenkürzel', click: cmd('settings', 'shortcuts') },
        { label: 'TwitchSync auf GitHub', click: () => shell.openExternal(REPO_URL) },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
