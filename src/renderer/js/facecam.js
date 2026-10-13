// Turns face detections from a few video frames into a facecam crop.
//
// Webcam overlays sit at a fixed spot while game footage changes, so the face
// that shows up at the same place in most sampled frames is the streamer's.
// The crop is framed around it like a webcam shot: face in the upper third,
// shoulders visible.

export const CAM_ASPECT = 4 / 3;

const SAME_SPOT = 0.06; // max centre distance (fraction of frame width) to count as the same face
const WIDTH_FACTOR = 3.3; // crop width relative to face width

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// frames: [[{x, y, w, h}]] normalised to the frame; frameAspect = width / height
export function cropFromFaces(frames, frameAspect = 16 / 9, camAspect = CAM_ASPECT) {
  const clusters = [];
  frames.forEach((faces, frameIndex) => {
    for (const f of faces) {
      if (f.w < 0.012 || f.h < 0.012) continue; // tiny false positives
      const cx = f.x + f.w / 2;
      const cy = f.y + f.h / 2;
      const hit = clusters.find(
        (c) => Math.hypot(c.cx - cx, (c.cy - cy) / frameAspect) < SAME_SPOT && !c.frames.has(frameIndex),
      );
      if (hit) {
        hit.faces.push(f);
        hit.frames.add(frameIndex);
        hit.cx = median(hit.faces.map((g) => g.x + g.w / 2));
        hit.cy = median(hit.faces.map((g) => g.y + g.h / 2));
      } else {
        clusters.push({ cx, cy, faces: [f], frames: new Set([frameIndex]) });
      }
    }
  });
  if (!clusters.length) return null;

  const needed = frames.length >= 3 ? 2 : 1;
  const stable = clusters.filter((c) => c.frames.size >= needed);
  if (!stable.length) return null;
  stable.sort((a, b) => b.frames.size - a.frames.size || median(b.faces.map((f) => f.w)) - median(a.faces.map((f) => f.w)));
  const best = stable[0];

  const fw = median(best.faces.map((f) => f.w));
  const fh = median(best.faces.map((f) => f.h));
  // Work in frame-height units so the aspect maths is simple.
  const faceW = fw * frameAspect;
  let cropW = Math.min(frameAspect, Math.max(faceW * WIDTH_FACTOR, 0.25));
  let cropH = cropW / camAspect;
  if (cropH > 1) {
    cropH = 1;
    cropW = camAspect;
  }
  const centerX = best.cx * frameAspect;
  const centerY = best.cy + fh * 0.55; // face sits in the upper part of the shot
  let left = centerX - cropW / 2;
  let top = centerY - cropH / 2;
  left = Math.max(0, Math.min(frameAspect - cropW, left));
  top = Math.max(0, Math.min(1 - cropH, top));

  return {
    x: left / frameAspect,
    y: top,
    w: cropW / frameAspect,
    h: cropH,
    hits: best.frames.size,
    samples: frames.length,
  };
}

export function sameCrop(a, b) {
  if (!a || !b) return false;
  return ['x', 'y', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) < 0.03);
}
