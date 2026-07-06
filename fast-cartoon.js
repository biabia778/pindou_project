/**
 * 快速卡通滤镜：平滑 + 色阶量化 + 描边（纯 canvas，无需下载模型）。
 */

/**
 * @param {HTMLCanvasElement} source
 * @param {{ levels?: number, blurPasses?: number, edgeStrength?: number }} [opts]
 * @returns {HTMLCanvasElement}
 */
export function fastCartoonize(source, opts) {
  const levels = opts?.levels ?? 7;
  const blurPasses = opts?.blurPasses ?? 2;
  const edgeStrength = opts?.edgeStrength ?? 0.55;
  const maxSide = 768;

  const sw = source.width;
  const sh = source.height;
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));

  const work = document.createElement('canvas');
  work.width = w;
  work.height = h;
  const wctx = work.getContext('2d', { willReadFrequently: true });
  if (!wctx) return source;

  wctx.drawImage(source, 0, 0, w, h);
  let data = wctx.getImageData(0, 0, w, h);
  const gray = new Float32Array(w * h);

  for (let p = 0; p < blurPasses; p++) {
    boxBlurRgb(data.data, w, h);
  }

  const step = Math.max(8, Math.round(255 / Math.max(3, levels)));
  posterizeRgb(data.data, step);

  for (let i = 0, j = 0; i < data.data.length; i += 4, j++) {
    gray[j] =
      0.299 * data.data[i] + 0.587 * data.data[i + 1] + 0.114 * data.data[i + 2];
  }

  const edges = sobelEdges(gray, w, h);
  for (let j = 0, i = 0; j < w * h; j++, i += 4) {
    const e = edges[j] * edgeStrength;
    if (e < 18) continue;
    const k = Math.min(1, e / 255);
    data.data[i] *= 1 - k;
    data.data[i + 1] *= 1 - k;
    data.data[i + 2] *= 1 - k;
  }

  wctx.putImageData(data, 0, 0);

  const out = document.createElement('canvas');
  out.width = sw;
  out.height = sh;
  const octx = out.getContext('2d');
  if (!octx) return work;
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(work, 0, 0, sw, sh);
  return out;
}

/**
 * @param {Uint8ClampedArray} px
 * @param {number} w
 * @param {number} h
 */
function boxBlurRgb(px, w, h) {
  const tmp = new Uint8ClampedArray(px.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const i = (ny * w + nx) * 4;
          r += px[i];
          g += px[i + 1];
          b += px[i + 2];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      tmp[o] = (r / n) | 0;
      tmp[o + 1] = (g / n) | 0;
      tmp[o + 2] = (b / n) | 0;
      tmp[o + 3] = px[o + 3];
    }
  }
  px.set(tmp);
}

/**
 * @param {Uint8ClampedArray} px
 * @param {number} step
 */
function posterizeRgb(px, step) {
  for (let i = 0; i < px.length; i += 4) {
    px[i] = Math.round(px[i] / step) * step;
    px[i + 1] = Math.round(px[i + 1] / step) * step;
    px[i + 2] = Math.round(px[i + 2] / step) * step;
  }
}

/**
 * @param {Float32Array} gray
 * @param {number} w
 * @param {number} h
 * @returns {Float32Array}
 */
function sobelEdges(gray, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = gray[i - w - 1];
      const b = gray[i - w];
      const c = gray[i - w + 1];
      const d = gray[i - 1];
      const f = gray[i + 1];
      const g = gray[i + w - 1];
      const h2 = gray[i + w];
      const k = gray[i + w + 1];
      const gx = -a - 2 * d - g + c + 2 * f + k;
      const gy = -a - 2 * b - c + g + 2 * h2 + k;
      out[i] = Math.min(255, Math.hypot(gx, gy));
    }
  }
  return out;
}
