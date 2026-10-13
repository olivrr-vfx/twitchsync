// Hand-drawn 24px stroke icons. Kept as strings so they can be dropped into
// templates without a build step.

const s = (body, extra = '') =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;

export const icons = {
  plus: s('<path d="M12 5v14M5 12h14"/>'),
  x: s('<path d="M6 6l12 12M18 6L6 18"/>'),
  search: s('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'),
  sidebar: s('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>'),
  chat: s('<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17h-6.5L8 20.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z"/><path d="M8 10h8M8 13h5"/>'),
  settings: s('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
  volume: s('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
  volumeLow: s('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/>'),
  mute: s('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  focus: s('<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>'),
  unfocus: s('<path d="M9 4v3.5A1.5 1.5 0 0 1 7.5 9H4M20 9h-3.5A1.5 1.5 0 0 1 15 7.5V4M15 20v-3.5a1.5 1.5 0 0 1 1.5-1.5H20M4 15h3.5A1.5 1.5 0 0 1 9 16.5V20"/>'),
  resync: s('<path d="M4.5 12a7.5 7.5 0 0 1 12.8-5.3L19.5 9"/><path d="M19.5 4.5V9H15"/><path d="M19.5 12a7.5 7.5 0 0 1-12.8 5.3L4.5 15"/><path d="M4.5 19.5V15H9"/>'),
  partners: s('<rect x="3.5" y="7.5" width="11" height="9" rx="2"/><path d="M9.5 7.5V6A1.5 1.5 0 0 1 11 4.5h8A1.5 1.5 0 0 1 20.5 6v7a1.5 1.5 0 0 1-1.5 1.5h-4.5"/>'),
  grip: s('<circle cx="9" cy="7" r=".9" fill="currentColor"/><circle cx="15" cy="7" r=".9" fill="currentColor"/><circle cx="9" cy="12" r=".9" fill="currentColor"/><circle cx="15" cy="12" r=".9" fill="currentColor"/><circle cx="9" cy="17" r=".9" fill="currentColor"/><circle cx="15" cy="17" r=".9" fill="currentColor"/>'),
  refresh: s('<path d="M20 11.5A8 8 0 1 0 17.6 17"/><path d="M20 5v6.5h-6.5"/>'),
  chevron: s('<path d="M7 10l5 5 5-5"/>'),
  chevronRight: s('<path d="M10 7l5 5-5 5"/>'),
  login: s('<path d="M14 4.5h3.5A1.5 1.5 0 0 1 19 6v12a1.5 1.5 0 0 1-1.5 1.5H14"/><path d="M4.5 12H14M10.5 8l4 4-4 4"/>'),
  logout: s('<path d="M10 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H10"/><path d="M19.5 12H10M15.5 8l4 4-4 4"/>'),
  user: s('<circle cx="12" cy="8.5" r="3.5"/><path d="M5 19.5c1-3.5 4-5 7-5s6 1.5 7 5"/>'),
  shield: s('<path d="M12 3.5l7 2.5v5.5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-2.5z"/><path d="M9 12l2 2 4-4.5"/>'),
  puzzle: s('<path d="M9 4.5h3v1.5a1.5 1.5 0 0 0 3 0V4.5h3.5A1.5 1.5 0 0 1 20 6v3.5h-1.5a1.5 1.5 0 0 0 0 3H20V18a1.5 1.5 0 0 1-1.5 1.5H15V18a1.5 1.5 0 0 0-3 0v1.5H5.5A1.5 1.5 0 0 1 4 18v-3.5h1.5a1.5 1.5 0 0 0 0-3H4V6a1.5 1.5 0 0 1 1.5-1.5H9z"/>'),
  play: s('<path d="M7.5 5.5v13l11-6.5-11-6.5z"/>'),
  sync: s('<path d="M3.5 8h13M3.5 16h17M12.5 12h8"/><path d="M16.5 4v8M12.5 9.5V14"/>'),
  keyboard: s('<rect x="3" y="6.5" width="18" height="11" rx="2"/><path d="M7 10.5h.01M10.5 10.5h.01M14 10.5h.01M17 10.5h.01M8 14h8"/>'),
  info: s('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>'),
  alert: s('<path d="M12 4l9 15.5H3L12 4z"/><path d="M12 10v4M12 17h.01"/>'),
  check: s('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  external: s('<path d="M14 4.5h5.5V10M19.5 4.5L11 13"/><path d="M17 14v4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 18V8.5A1.5 1.5 0 0 1 6.5 7H10"/>'),
  sliders: s('<path d="M5 20v-6M5 10V4M12 20v-9M12 7V4M19 20v-4M19 12V4M3 14h4M10 7h4M17 16h4"/>'),
  radio: s('<circle cx="12" cy="12" r="2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.5 5.5a9.2 9.2 0 0 0 0 13M18.5 5.5a9.2 9.2 0 0 1 0 13"/>'),
  sparkle: s('<path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2-5.2-1.8 5.2-1.8L12 3.5z"/><path d="M19 16v4M17 18h4"/>'),
  heart: s('<path d="M12 19.5s-7.5-4.4-7.5-10A4.2 4.2 0 0 1 12 7a4.2 4.2 0 0 1 7.5 2.5c0 5.6-7.5 10-7.5 10z"/>'),
  trash: s('<path d="M5 7h14M10 7V5.5h4V7M7 7l1 12.5h8L17 7"/>'),
  folder: s('<path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h4l2 2h7A1.5 1.5 0 0 1 20 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-10z"/>'),
  swap: s('<path d="M4 8h13.5M14 4.5L17.5 8 14 11.5"/><path d="M20 16H6.5M10 12.5L6.5 16l3.5 3.5"/>'),
  crop: s('<path d="M7 3.5V17h13.5"/><path d="M3.5 7H17v13.5"/>'),
  facecam: s('<rect x="3" y="5" width="13" height="10" rx="1.5"/><rect x="16.5" y="5" width="4.5" height="4" rx="1"/><rect x="16.5" y="11" width="4.5" height="4" rx="1"/><rect x="16.5" y="17" width="4.5" height="3" rx="1"/><path d="M3 18.5h11"/>'),
  grid: s('<rect x="3.5" y="4.5" width="7.5" height="6.5" rx="1.5"/><rect x="13" y="4.5" width="7.5" height="6.5" rx="1.5"/><rect x="3.5" y="13" width="7.5" height="6.5" rx="1.5"/><rect x="13" y="13" width="7.5" height="6.5" rx="1.5"/>'),
  focusLayout: s('<rect x="3.5" y="4.5" width="17" height="10" rx="1.5"/><rect x="3.5" y="16.5" width="5" height="3" rx="1"/><rect x="9.5" y="16.5" width="5" height="3" rx="1"/><rect x="15.5" y="16.5" width="5" height="3" rx="1"/>'),
  eye: s('<path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>'),
  eyeOff: s('<path d="M4 4l16 16"/><path d="M9.6 6A9.8 9.8 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.8M6.2 7.6A16.6 16.6 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4-.9"/><path d="M10 10a2.8 2.8 0 0 0 4 4"/>'),
  snow: s('<path d="M12 3.5v17M4.6 7.75l14.8 8.5M4.6 16.25l14.8-8.5"/><path d="M9.5 5l2.5 2 2.5-2M9.5 19l2.5-2 2.5 2"/>'),
};

// The brand mark: three stream timelines, offset, pinned by one sync line.
export function brandMark(size = 22) {
  return `<svg viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true">
    <rect x="3" y="7" width="15" height="4" rx="2" fill="#eef0f4" opacity=".92"/>
    <rect x="9" y="14" width="18" height="4" rx="2" fill="#eef0f4" opacity=".55"/>
    <rect x="5" y="21" width="13" height="4" rx="2" fill="#eef0f4" opacity=".3"/>
    <rect x="17" y="3.5" width="3" height="25" rx="1.5" fill="#c8ff3c"/>
  </svg>`;
}
