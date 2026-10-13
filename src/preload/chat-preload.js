'use strict';

// Runs inside the popout chat <webview>. Forces Twitch's dark theme and blends
// the chat into the app's panel colors. Everything else is plain twitch.tv.

const { webFrame } = require('electron');

try {
  window.localStorage.setItem('twilight.theme', '1');
} catch {
  /* storage unavailable */
}

const CHAT_CSS = `
  :root, .tw-root--theme-dark, .tw-root--theme-dark * {
    --color-background-base: #0c0e13 !important;
    --color-background-body: #0c0e13 !important;
    --color-background-alt: #11141b !important;
    --color-background-alt-2: #161a23 !important;
    --color-border-base: rgba(255, 255, 255, 0.07) !important;
  }
  html, body { background: #0c0e13 !important; }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.12); border-radius: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
`;

function injectCss() {
  try {
    webFrame.insertCSS(CHAT_CSS);
  } catch {
    /* ignore */
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectCss, { once: true });
else injectCss();
