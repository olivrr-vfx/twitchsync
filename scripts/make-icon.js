'use strict';

// Renders build/icon.svg into build/icon.png (1024²) and build/icon.icns.
// Usage: npm run icon   (runs inside Electron, uses macOS sips + iconutil)

const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUILD = path.join(__dirname, '..', 'build');
const RENDER = 2048; // supersampled, then scaled down to 1024 for smooth gradients

// Software rendering avoids GPU tile seams in the dark gradients.
app.disableHardwareAcceleration();



app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(BUILD, 'icon.svg'), 'utf8');
  const html = `<!doctype html><html><head><style>html,body{margin:0;overflow:hidden;background:transparent}svg{display:block;width:${RENDER}px;height:${RENDER}px}</style></head><body>${svg}</body></html>`;
  const win = new BrowserWindow({
    width: RENDER,
    height: RENDER,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 400));
  const image = (await win.webContents.capturePage()).resize({ width: 1024, height: 1024, quality: 'best' });
  const png = path.join(BUILD, 'icon.png');
  fs.writeFileSync(png, image.toPNG());

  const iconset = fs.mkdtempSync(path.join(os.tmpdir(), 'twitchsync-')) + '/icon.iconset';
  fs.mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = size * scale;
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
      execFileSync('sips', ['-z', String(px), String(px), png, '--out', path.join(iconset, name)], { stdio: 'ignore' });
    }
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(BUILD, 'icon.icns')]);
  fs.rmSync(path.dirname(iconset), { recursive: true, force: true });
  console.log('✓ build/icon.png und build/icon.icns erzeugt');
  app.quit();
});
