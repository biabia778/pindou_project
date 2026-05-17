/**
 * 四角采样 + 向内深度限制的连通去背（比「整圈边框均值」更不易误伤主体）。
 * 依赖 color.js：rgbToLab / squaredLabDelta
 *
 * @param {Uint8ClampedArray} data RGBA
 * @param {number} w
 * @param {number} h
 * @param {number} thresholdSqLab 与任一角背景色的 LAB² 距离上限
 * @param {{ maxInwardFrac?: number, maxRemoveFrac?: number }} [opts]
 * @returns {Uint8Array} 1 = 判定为背景
 */
function computeCornerBackgroundMask(data, w, h, thresholdSqLab, opts) {
  const maxInwardFrac = opts?.maxInwardFrac ?? 0.45;
  const maxRemoveFrac = opts?.maxRemoveFrac ?? 0.72;
  const pad = Math.max(3, Math.floor(Math.min(w, h) * 0.1));
  const total = w * h;

  /** @type {[number, number, number][]} */
  const bgLabs = [];

  /** @param {number} x0 @param {number} y0 */
  function sampleCorner(x0, y0) {
    let sL = 0;
    let sA = 0;
    let sB = 0;
    let n = 0;
    for (let y = y0; y < y0 + pad && y < h; y++) {
      for (let x = x0; x < x0 + pad && x < w; x++) {
        const di = (y * w + x) * 4;
        if (data[di + 3] < 128) continue;
        const lab = rgbToLab(data[di], data[di + 1], data[di + 2]);
        sL += lab[0];
        sA += lab[1];
        sB += lab[2];
        n++;
      }
    }
    if (n > 0) bgLabs.push([sL / n, sA / n, sB / n]);
  }

  sampleCorner(0, 0);
  sampleCorner(Math.max(0, w - pad), 0);
  sampleCorner(0, Math.max(0, h - pad));
  sampleCorner(Math.max(0, w - pad), Math.max(0, h - pad));

  if (bgLabs.length === 0) return new Uint8Array(total);

  /** @param {number} di */
  function similarToBg(di) {
    const lab = rgbToLab(data[di], data[di + 1], data[di + 2]);
    let best = Infinity;
    for (let k = 0; k < bgLabs.length; k++) {
      const d = squaredLabDelta(lab, bgLabs[k]);
      if (d < best) best = d;
    }
    return best < thresholdSqLab;
  }

  const maxDepth = Math.max(4, Math.floor(Math.min(w, h) * maxInwardFrac));
  const maskBg = new Uint8Array(total);
  /** @type {Int16Array} */
  const depth = new Int16Array(total);
  depth.fill(-1);
  const q = [];

  /** @param {number} ix @param {number} iy @param {number} d0 */
  function seed(ix, iy, d0) {
    const id = iy * w + ix;
    if (depth[id] >= 0) return;
    const di = id * 4;
    if (!similarToBg(di)) return;
    depth[id] = d0;
    maskBg[id] = 1;
    q.push(id);
  }

  for (let y = 0; y < pad && y < h; y++) {
    for (let x = 0; x < pad && x < w; x++) seed(x, y, 0);
    for (let x = Math.max(0, w - pad); x < w; x++) seed(x, y, 0);
  }
  for (let y = Math.max(0, h - pad); y < h; y++) {
    for (let x = 0; x < pad && x < w; x++) seed(x, y, 0);
    for (let x = Math.max(0, w - pad); x < w; x++) seed(x, y, 0);
  }

  for (let head = 0; head < q.length; head++) {
    const id = q[head];
    const d0 = depth[id];
    if (d0 >= maxDepth) continue;
    const iy = (id / w) | 0;
    const ix = id - iy * w;
    const nd = d0 + 1;
    if (ix + 1 < w) tryN(ix + 1, iy, nd);
    if (ix - 1 >= 0) tryN(ix - 1, iy, nd);
    if (iy + 1 < h) tryN(ix, iy + 1, nd);
    if (iy - 1 >= 0) tryN(ix, iy - 1, nd);
  }

  function tryN(ix, iy, nd) {
    const id = iy * w + ix;
    if (depth[id] >= 0) return;
    const di = id * 4;
    if (!similarToBg(di)) return;
    depth[id] = nd;
    maskBg[id] = 1;
    q.push(id);
  }

  let removed = 0;
  for (let id = 0; id < total; id++) if (maskBg[id]) removed++;
  if (removed / total > maxRemoveFrac) {
    if (thresholdSqLab < 48) return new Uint8Array(total);
    return computeCornerBackgroundMask(data, w, h, thresholdSqLab * 0.55, {
      maxInwardFrac: maxInwardFrac * 0.85,
      maxRemoveFrac: 1,
    });
  }

  return maskBg;
}

/**
 * @param {CanvasRenderingContext2D} cx
 * @param {number} thresholdSqLab
 */
function removeBorderConnectedBackground(cx, thresholdSqLab) {
  const canvas = cx.canvas;
  const w = canvas.width;
  const h = canvas.height;
  if (w < 3 || h < 3) return;

  const img = cx.getImageData(0, 0, w, h);
  const maskBg = computeCornerBackgroundMask(img.data, w, h, thresholdSqLab);

  for (let id = 0; id < w * h; id++) {
    if (!maskBg[id]) continue;
    const p = id * 4;
    img.data[p + 3] = 0;
  }

  cx.putImageData(img, 0, 0);
}
