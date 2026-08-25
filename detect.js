/* PanelView — panel detection module. MIT. */

export const IMG_RE = /\.(png|jpe?g|webp|gif|avif)$/i;

export function detectPanels(img) {
  const scale = Math.min(1, 640 / img.naturalWidth);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  let data;
  try { data = ctx.getImageData(0, 0, w, h).data; }
  catch { return null; }

  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    lum[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  const isGutterLine = (idx, len, stride) => {
    let sum = 0, sumSq = 0;
    for (let j = 0; j < len; j++) { const v = lum[idx + j * stride]; sum += v; sumSq += v * v; }
    const mean = sum / len;
    const variance = sumSq / len - mean * mean;
    return variance < 220 && (mean > 216 || mean < 40);
  };
  const rowGutter = new Uint8Array(h);
  for (let y = 0; y < h; y++) rowGutter[y] = isGutterLine(y * w, w, 1) ? 1 : 0;
  const bands = runsOf(rowGutter, 0, h, Math.round(h * 0.04));
  if (!bands.length) return null;
  const rects = [];
  for (const [y0, y1] of bands) {
    const colGutter = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
      let g = 1;
      let sum = 0, sumSq = 0; const len = y1 - y0;
      for (let y = y0; y < y1; y++) { const v = lum[y * w + x]; sum += v; sumSq += v * v; }
      const mean = sum / len, variance = sumSq / len - mean * mean;
      g = variance < 220 && (mean > 216 || mean < 40) ? 1 : 0;
      colGutter[x] = g;
    }
    const cols = runsOf(colGutter, 0, w, Math.round(w * 0.06));
    for (const [x0, x1] of cols) {
      rects.push({
        x: x0 / scale, y: y0 / scale,
        width: (x1 - x0) / scale, height: (y1 - y0) / scale,
      });
    }
  }
  if (!rects.length || rects.length > 12) return null;
  const pageArea = img.naturalWidth * img.naturalHeight;
  const covered = rects.reduce((s, r) => s + r.width * r.height, 0);
  if (covered < pageArea * 0.35) return null;
  return rects;
}

export function runsOf(flags, start, end, minLen) {
  const out = [];
  let runStart = -1;
  for (let i = start; i <= end; i++) {
    const isContent = i < end && flags[i] === 0;
    if (isContent && runStart < 0) runStart = i;
    if (!isContent && runStart >= 0) {
      if (i - runStart >= minLen) out.push([runStart, i]);
      runStart = -1;
    }
  }
  return out;
}
