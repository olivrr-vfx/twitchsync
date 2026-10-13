// Layout math: places N 16:9 tiles into a rectangle as large as possible.

export const ASPECT = 16 / 9;

// Largest tile of the given picture aspect (plus a fixed header strip of
// `extraH` px) that fits into w × h.
function fit(w, h, aspect = ASPECT, extraH = 0) {
  let tw = w;
  let th = tw / aspect + extraH;
  if (th > h) {
    th = h;
    tw = Math.max(0, h - extraH) * aspect;
  }
  return { w: Math.max(0, tw), h: Math.max(0, th) };
}

// Best column count for n tiles in an area; returns tile size and rows.
export function bestGrid(n, width, height, gap, aspect = ASPECT, extraH = 0) {
  let best = null;
  for (let cols = 1; cols <= n; cols += 1) {
    const rows = Math.ceil(n / cols);
    const cellW = (width - gap * (cols - 1)) / cols;
    const cellH = (height - gap * (rows - 1)) / rows;
    if (cellW <= 0 || cellH <= 0) continue;
    const size = fit(cellW, cellH, aspect, extraH);
    // Prefer bigger tiles; on a tie prefer fewer empty slots.
    const score = size.w * size.h - (cols * rows - n) * 0.5;
    if (!best || score > best.score + 0.01) best = { cols, rows, ...size, score };
  }
  return best || { cols: 1, rows: n, w: 0, h: 0, score: 0 };
}

// Rects for a centred grid inside {x, y, width, height}.
export function gridRects(n, area, gap, { aspect = ASPECT, extraH = 0 } = {}) {
  if (!n) return [];
  const g = bestGrid(n, area.width, area.height, gap, aspect, extraH);
  const totalH = g.rows * g.h + (g.rows - 1) * gap;
  const top = area.y + (area.height - totalH) / 2;
  const rects = [];
  for (let r = 0; r < g.rows; r += 1) {
    const inRow = Math.min(g.cols, n - r * g.cols);
    const rowW = inRow * g.w + (inRow - 1) * gap;
    const left = area.x + (area.width - rowW) / 2;
    for (let c = 0; c < inRow; c += 1) {
      rects.push({ x: left + c * (g.w + gap), y: top + r * (g.h + gap), w: g.w, h: g.h });
    }
  }
  return rects;
}

// Focus / facecam mode: one large tile, the others as a strip on the side or
// bottom. `stripAspect` is the picture aspect of the strip tiles (facecams are 4:3).
export function focusRects(n, focusIndex, area, gap, { extraH = 0, stripAspect = ASPECT, fractions } = {}) {
  if (n <= 1 || focusIndex < 0 || focusIndex >= n) return gridRects(n, area, gap, { extraH });
  const others = n - 1;
  let best = null;

  const evaluate = (mode, fraction) => {
    const side = mode === 'right' ? Math.round(area.width * fraction) : Math.round(area.height * fraction);
    const mainArea =
      mode === 'right'
        ? { x: area.x, y: area.y, width: area.width - side - gap, height: area.height }
        : { x: area.x, y: area.y, width: area.width, height: area.height - side - gap };
    const stripArea =
      mode === 'right'
        ? { x: area.x + area.width - side, y: area.y, width: side, height: area.height }
        : { x: area.x, y: area.y + area.height - side, width: area.width, height: side };
    if (mainArea.width <= 0 || mainArea.height <= 0) return;
    const main = fit(mainArea.width, mainArea.height, ASPECT, extraH);
    const strip = bestGrid(others, stripArea.width, stripArea.height, gap, stripAspect, extraH);
    if (strip.w < 120) return;
    const score = main.w * main.h + 0.3 * others * strip.w * strip.h;
    if (!best || score > best.score) best = { mode, mainArea, stripArea, main, score };
  };

  for (const fraction of fractions || [0.16, 0.2, 0.24, 0.28, 0.32]) {
    evaluate('right', fraction);
    evaluate('bottom', fraction);
  }
  if (!best) return gridRects(n, area, gap, { extraH });

  const { mode, mainArea, stripArea, main } = best;
  // Pull the strip towards the main tile so nothing floats in empty space.
  const mainRect = {
    x: mode === 'right' ? mainArea.x + (mainArea.width - main.w) : mainArea.x + (mainArea.width - main.w) / 2,
    y: mode === 'right' ? mainArea.y + (mainArea.height - main.h) / 2 : mainArea.y + (mainArea.height - main.h),
    w: main.w,
    h: main.h,
  };
  if (mode === 'right') {
    const freeLeft = mainRect.x - mainArea.x;
    mainRect.x -= freeLeft / 2;
    stripArea.x -= freeLeft / 2;
  } else {
    const freeTop = mainRect.y - mainArea.y;
    mainRect.y -= freeTop / 2;
    stripArea.y -= freeTop / 2;
  }
  const thumbs = gridRects(others, stripArea, gap, { aspect: stripAspect, extraH });
  const rects = [];
  let t = 0;
  for (let i = 0; i < n; i += 1) rects.push(i === focusIndex ? mainRect : thumbs[t++]);
  return rects;
}
