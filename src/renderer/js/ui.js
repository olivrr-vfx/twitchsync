import { icons } from './icons.js';

// ---------------------------------------------------------------- helpers

export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, v);
        else el.style[prop] = v;
      }
    }
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const compact = new Intl.NumberFormat('de-DE', { notation: 'compact', maximumFractionDigits: 1 });
export function formatViewers(n) {
  return compact.format(n || 0).replace(/\s/g, '').replace('Tsd.', 'K').replace('Mio.', 'M');
}

export function formatSeconds(value, digits = 1) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '–';
  return `${value.toFixed(digits).replace('.', ',')} s`;
}

export function formatSigned(value, digits = 1) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '–';
  const v = Math.abs(value) < 0.05 && digits === 1 ? 0 : value;
  return `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(digits).replace('.', ',')} s`;
}

export function uptime(startedAt) {
  if (!startedAt) return '';
  const mins = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 60000));
  const hrs = Math.floor(mins / 60);
  return hrs ? `${hrs}:${String(mins % 60).padStart(2, '0')} h` : `${mins} min`;
}

export function avatar(url, name, { live = false, size = '' } = {}) {
  const el = h('span', { class: `avatar ${size} ${live ? 'is-live' : ''}` });
  if (url) el.style.backgroundImage = `url("${String(url).replace(/"/g, '')}")`;
  else el.append(h('span', { class: 'initial', text: (name || '?').slice(0, 1).toUpperCase() }));
  return el;
}

export function debounce(fn, wait) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export function isTyping(target = document.activeElement) {
  return Boolean(
    target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.tagName === 'WEBVIEW'),
  );
}

// ---------------------------------------------------------------- toasts

export function toast(message, { kind = 'info', icon, actions = [], duration = 5200 } = {}) {
  const root = document.getElementById('toasts');
  const iconName = icon || { info: 'check', warn: 'alert', error: 'alert', partner: 'partners' }[kind] || 'info';
  const el = h('div', { class: `toast ${kind}`, role: 'status' }, [
    h('span', { class: 't-icon', html: icons[iconName] }),
    h('div', { class: 't-text', html: message }),
  ]);
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    if (el.classList.contains('is-leaving')) return;
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 220);
  };
  if (actions.length) {
    const wrap = h('div', { class: 't-actions' });
    for (const action of actions) {
      wrap.append(
        h('button', {
          class: `btn ${action.primary ? 'primary' : action.violet ? 'violet' : 'ghost'}`,
          text: action.label,
          onClick: () => {
            action.onClick && action.onClick();
            close();
          },
        }),
      );
    }
    el.append(wrap);
  }
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => {
    if (duration) timer = setTimeout(close, 2200);
  });
  root.append(el);
  while (root.children.length > 4) root.firstElementChild.remove();
  if (duration) timer = setTimeout(close, duration);
  return close;
}

// --------------------------------------------------------------- tooltips

let tipTarget = null;
let tipTimer = null;

function placeTip(target) {
  const tip = document.getElementById('tooltip');
  const text = target.getAttribute('data-tip');
  if (!text) return;
  tip.textContent = text;
  tip.hidden = false;
  const r = target.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const below = r.bottom + 8 + t.height < window.innerHeight;
  let left = r.left + r.width / 2 - t.width / 2;
  left = Math.max(8, Math.min(window.innerWidth - t.width - 8, left));
  tip.style.left = `${left}px`;
  tip.style.top = `${below ? r.bottom + 8 : r.top - t.height - 8}px`;
}

export function hideTip() {
  clearTimeout(tipTimer);
  tipTarget = null;
  const tip = document.getElementById('tooltip');
  if (tip) tip.hidden = true;
}

export function installTooltips() {
  document.addEventListener('pointerover', (e) => {
    const target = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
    if (target === tipTarget) return;
    hideTip();
    if (!target) return;
    tipTarget = target;
    tipTimer = setTimeout(() => tipTarget === target && placeTip(target), 450);
  });
  document.addEventListener('pointerdown', hideTip, true);
  window.addEventListener('blur', hideTip);
}

// --------------------------------------------------------------- popovers

let activePopover = null;

export function closePopover() {
  if (!activePopover) return false;
  const { el, onClose } = activePopover;
  activePopover = null;
  el.remove();
  onClose && onClose();
  return true;
}

export function popover(anchor, content, { align = 'start', onClose, className = '' } = {}) {
  closePopover();
  const el = h('div', { class: `popover ${className}` }, [content]);
  document.getElementById('layer').append(el);
  const r = anchor.getBoundingClientRect();
  const p = el.getBoundingClientRect();
  let left = align === 'end' ? r.right - p.width : r.left;
  left = Math.max(10, Math.min(window.innerWidth - p.width - 10, left));
  let top = r.bottom + 8;
  if (top + p.height > window.innerHeight - 10) top = Math.max(10, r.top - p.height - 8);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  activePopover = { el, anchor, onClose };
  return el;
}

document.addEventListener(
  'pointerdown',
  (e) => {
    if (!activePopover) return;
    const { el, anchor } = activePopover;
    if (el.contains(e.target) || anchor.contains(e.target)) return;
    closePopover();
  },
  true,
);
window.addEventListener('blur', () => {
  // Clicking into a webview blurs the host window – treat it as "outside".
  setTimeout(() => {
    if (document.activeElement && document.activeElement.tagName === 'WEBVIEW') closePopover();
  }, 0);
});

// ------------------------------------------------------------------ modal

export function modal(content, { onClose, className = '' } = {}) {
  const backdrop = h('div', { class: 'modal-backdrop' }, [content]);
  if (className) content.classList.add(className);
  const close = () => {
    if (!backdrop.isConnected) return;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose && onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey, true);
  document.getElementById('layer').append(backdrop);
  return close;
}

export function confirmDialog({ title, text, confirm = 'OK', cancel = 'Abbrechen', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const box = h('div', { class: 'confirm', role: 'alertdialog' }, [
      h('h4', { text: title }),
      h('p', { text }),
      h('div', { class: 'actions' }, [
        h('button', { class: 'btn ghost', text: cancel, onClick: () => close() }),
        h('button', {
          class: `btn ${danger ? 'danger' : 'primary'}`,
          text: confirm,
          onClick: () => {
            result = true;
            close();
          },
        }),
      ]),
    ]);
    const close = modal(box, { onClose: () => resolve(result) });
    setTimeout(() => box.querySelector('.btn:last-child').focus(), 30);
  });
}

export function hasOverlay() {
  return Boolean(activePopover || document.querySelector('.modal-backdrop'));
}
