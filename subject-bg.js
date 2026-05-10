/**
 * 粗略「主体分离」：将图像中与「整条外边界平均值」色差足够小，
 * 且能从外边界沿四连通走到的像素设为背景透明（alpha=0）。
 * 适合纯色/虚化背景、主体尽量不贴边的照片；不等同于语义抠图模型。
 *
 * 依赖 color.js 中的 rgbToLab / squaredLabDelta（全局）。
 *
 * @param {CanvasRenderingContext2D} cx
 * @param {number} thresholdSqLab 与边界均色的 LAB 欧氏距离的平方阈值，越大越容易整体被擦掉
 */
function removeBorderConnectedBackground(cx, thresholdSqLab) {
  const canvas = cx.canvas;
  const w = canvas.width;
  const h = canvas.height;
  if (w < 3 || h < 3) return;

  const img = cx.getImageData(0, 0, w, h);
  const d = img.data;

  const edgeLabs = [];
  /** @param {number} i */
  function pushLab(i) {
    edgeLabs.push(rgbToLab(d[i], d[i + 1], d[i + 2]));
  }

  for (let x = 0; x < w; x++) {
    pushLab((0 * w + x) * 4);
    pushLab(((h - 1) * w + x) * 4);
  }
  for (let y = 1; y < h - 1; y++) {
    pushLab((y * w + 0) * 4);
    pushLab((y * w + (w - 1)) * 4);
  }

  let sL = 0;
  let sA = 0;
  let sB = 0;
  for (let ei = 0; ei < edgeLabs.length; ei++) {
    const L = edgeLabs[ei];
    sL += L[0];
    sA += L[1];
    sB += L[2];
  }
  const n = edgeLabs.length;
  const avgLab = [sL / n, sA / n, sB / n];

  const total = w * h;
  const maskBg = new Uint8Array(total);
  const q = [];

  /** @param {number} i */
  function similar(di) {
    return squaredLabDelta(rgbToLab(d[di], d[di + 1], d[di + 2]), avgLab) < thresholdSqLab;
  }

  function enqueue(ix, iy) {
    const id = iy * w + ix;
    if (maskBg[id]) return;
    const di = id * 4;
    if (!similar(di)) return;
    maskBg[id] = 1;
    q.push(id);
  }

  for (x = 0; x < w; x++) {
    enqueue(x, 0);
    enqueue(x, h - 1);
  }
  for (y = 0; y < h; y++) {
    enqueue(0, y);
    enqueue(w - 1, y);
  }

  for (let head = 0; head < q.length; head++) {
    const id = q[head];
    const iy = (id / w) | 0;
    const ix = id - iy * w;
    if (ix + 1 < w) enqueue(ix + 1, iy);
    if (ix - 1 >= 0) enqueue(ix - 1, iy);
    if (iy + 1 < h) enqueue(ix, iy + 1);
    if (iy - 1 >= 0) enqueue(ix, iy - 1);
  }

  for (let id = 0; id < total; id++) {
    if (!maskBg[id]) continue;
    const p = id * 4;
    d[p + 3] = 0;
  }

  cx.putImageData(img, 0, 0);
}
