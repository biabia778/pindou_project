/**
 * 本地裁切 + 手动画蒙版（纯前端）。
 * 蒙版外区域在生成前设为透明，由 drawSourceToWorkCanvas 映射为「留白背景」色。
 */
(function () {
  const MAX_EDIT_PX = 1024;
  const MIN_CROP = 24;

  /** @type {HTMLCanvasElement | null} */
  let sourceCanvas = null;
  /** @type {HTMLCanvasElement | null} */
  let maskCanvas = null;
  /** @type {{ x: number, y: number, w: number, h: number }} */
  let cropRect = { x: 0, y: 0, w: 0, h: 0 };

  /** @type {'crop' | 'mask'} */
  let mode = 'crop';
  let brushSize = 28;
  /** @type {'keep' | 'erase'} */
  let brushMode = 'keep';
  /** @type {'brush' | 'wand'} */
  let maskTool = 'brush';
  let wandTolerance = 22;

  const MAX_UNDO = 36;
  /** @type {ImageData[]} */
  const undoStack = [];
  /** @type {ImageData[]} */
  const redoStack = [];

  let viewScale = 1;
  /** @type {{ x: number, y: number }} */
  let viewOffset = { x: 0, y: 0 };

  /** @type {null | { kind: string, sx: number, sy: number, rect: { x: number, y: number, w: number, h: number } }} */
  let drag = null;
  let painting = false;
  /** @type {{ x: number, y: number } | null} */
  let lastPaintPt = null;
  /** iOS/Android 触摸跟踪（Safari 上 pointer 事件不可靠） */
  let activeTouchId = null;
  let suppressMouseUntil = 0;
  let scrollLocked = false;
  const isCoarsePointer =
    typeof window !== 'undefined' &&
    (window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window);

  /** @type {(() => void) | null} */
  let onChange = null;

  /** @type {ReturnType<typeof setTimeout> | null} */
  let debounceTimer = null;

  const els = {
    panel: /** @type {HTMLElement | null} */ (document.getElementById('edit-panel')),
    view: /** @type {HTMLCanvasElement | null} */ (document.getElementById('edit-view')),
    brush: /** @type {HTMLInputElement | null} */ (document.getElementById('brush-size')),
    brushVal: /** @type {HTMLElement | null} */ (document.getElementById('brush-size-val')),
    applyCrop: /** @type {HTMLButtonElement | null} */ (document.getElementById('apply-crop')),
    maskFill: /** @type {HTMLButtonElement | null} */ (document.getElementById('mask-fill')),
    maskClear: /** @type {HTMLButtonElement | null} */ (document.getElementById('mask-clear')),
    modeCrop: /** @type {HTMLButtonElement | null} */ (document.getElementById('edit-mode-crop')),
    modeMask: /** @type {HTMLButtonElement | null} */ (document.getElementById('edit-mode-mask')),
    brushKeep: /** @type {HTMLButtonElement | null} */ (document.getElementById('brush-keep')),
    brushErase: /** @type {HTMLButtonElement | null} */ (document.getElementById('brush-erase')),
    maskUndo: /** @type {HTMLButtonElement | null} */ (document.getElementById('mask-undo')),
    maskRedo: /** @type {HTMLButtonElement | null} */ (document.getElementById('mask-redo')),
    toolBrush: /** @type {HTMLButtonElement | null} */ (document.getElementById('mask-tool-brush')),
    toolWand: /** @type {HTMLButtonElement | null} */ (document.getElementById('mask-tool-wand')),
    wandTol: /** @type {HTMLInputElement | null} */ (document.getElementById('wand-tolerance')),
    wandTolVal: /** @type {HTMLElement | null} */ (document.getElementById('wand-tolerance-val')),
    autoCornerBg: /** @type {HTMLButtonElement | null} */ (document.getElementById('mask-auto-corner')),
    protectCenter: /** @type {HTMLButtonElement | null} */ (document.getElementById('mask-protect-center')),
    cropTouchUi: /** @type {HTMLElement | null} */ (document.getElementById('crop-touch-ui')),
    cropX: /** @type {HTMLInputElement | null} */ (document.getElementById('crop-x')),
    cropY: /** @type {HTMLInputElement | null} */ (document.getElementById('crop-y')),
    cropW: /** @type {HTMLInputElement | null} */ (document.getElementById('crop-w')),
    cropH: /** @type {HTMLInputElement | null} */ (document.getElementById('crop-h')),
    cropXOut: /** @type {HTMLElement | null} */ (document.getElementById('crop-x-out')),
    cropYOut: /** @type {HTMLElement | null} */ (document.getElementById('crop-y-out')),
    cropWOut: /** @type {HTMLElement | null} */ (document.getElementById('crop-w-out')),
    cropHOut: /** @type {HTMLElement | null} */ (document.getElementById('crop-h-out')),
  };

  const viewCtx = els.view?.getContext('2d');

  function notifyChange() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      onChange?.();
    }, 280);
  }

  function notifyChangeImmediate() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    onChange?.();
  }

  function clampCrop() {
    if (!sourceCanvas) return;
    const W = sourceCanvas.width;
    const H = sourceCanvas.height;
    cropRect.w = Math.max(MIN_CROP, Math.min(cropRect.w, W));
    cropRect.h = Math.max(MIN_CROP, Math.min(cropRect.h, H));
    cropRect.x = Math.max(0, Math.min(cropRect.x, W - cropRect.w));
    cropRect.y = Math.max(0, Math.min(cropRect.y, H - cropRect.h));
  }

  function syncCropSlidersFromRect() {
    if (!sourceCanvas) return;
    const W = sourceCanvas.width;
    const H = sourceCanvas.height;
    if (els.cropX) {
      els.cropX.max = String(Math.max(0, W - MIN_CROP));
      els.cropX.value = String(Math.round(cropRect.x));
      if (els.cropXOut) els.cropXOut.textContent = els.cropX.value;
    }
    if (els.cropY) {
      els.cropY.max = String(Math.max(0, H - MIN_CROP));
      els.cropY.value = String(Math.round(cropRect.y));
      if (els.cropYOut) els.cropYOut.textContent = els.cropY.value;
    }
    if (els.cropW) {
      els.cropW.max = String(W);
      els.cropW.value = String(Math.round(cropRect.w));
      if (els.cropWOut) els.cropWOut.textContent = els.cropW.value;
    }
    if (els.cropH) {
      els.cropH.max = String(H);
      els.cropH.value = String(Math.round(cropRect.h));
      if (els.cropHOut) els.cropHOut.textContent = els.cropH.value;
    }
  }

  function applyCropSlidersToRect() {
    if (!sourceCanvas) return;
    const W = sourceCanvas.width;
    const H = sourceCanvas.height;
    if (els.cropX) cropRect.x = Number(els.cropX.value) || 0;
    if (els.cropY) cropRect.y = Number(els.cropY.value) || 0;
    if (els.cropW) cropRect.w = Number(els.cropW.value) || MIN_CROP;
    if (els.cropH) cropRect.h = Number(els.cropH.value) || MIN_CROP;
    clampCrop();
    syncCropSlidersFromRect();
    renderView();
  }

  function lockPageScroll() {
    if (scrollLocked) return;
    scrollLocked = true;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
  }

  function unlockPageScroll() {
    if (!scrollLocked) return;
    scrollLocked = false;
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
  }

  function layoutView() {
    if (!els.view || !sourceCanvas) return;
    const wrap = els.view.parentElement;
    if (!wrap) return;
    const maxW = Math.max(200, wrap.clientWidth - 4);
    const maxH = Math.max(160, Math.min(320, window.innerHeight * 0.38));
    viewScale = Math.min(maxW / sourceCanvas.width, maxH / sourceCanvas.height, 1);
    const dw = Math.round(sourceCanvas.width * viewScale);
    const dh = Math.round(sourceCanvas.height * viewScale);
    els.view.width = dw;
    els.view.height = dh;
    viewOffset.x = 0;
    viewOffset.y = 0;
  }

  function renderView() {
    if (!viewCtx || !els.view || !sourceCanvas || !maskCanvas) return;
    const dw = els.view.width;
    const dh = els.view.height;
    viewCtx.clearRect(0, 0, dw, dh);
    viewCtx.imageSmoothingEnabled = true;
    viewCtx.drawImage(sourceCanvas, 0, 0, dw, dh);

    if (mode === 'mask') {
      const mctx = maskCanvas.getContext('2d');
      if (mctx) {
        const md = mctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
        viewCtx.fillStyle = 'rgba(220, 48, 72, 0.42)';
        for (let y = 0; y < maskCanvas.height; y++) {
          for (let x = 0; x < maskCanvas.width; x++) {
            const i = (y * maskCanvas.width + x) * 4;
            if (md.data[i] < 128) {
              const vx = Math.floor(x * viewScale);
              const vy = Math.floor(y * viewScale);
              const vw = Math.max(1, Math.ceil(viewScale));
              const vh = Math.max(1, Math.ceil(viewScale));
              viewCtx.fillRect(vx, vy, vw, vh);
            }
          }
        }
      }
    }

    if (mode === 'crop') {
      const rx = cropRect.x * viewScale;
      const ry = cropRect.y * viewScale;
      const rw = cropRect.w * viewScale;
      const rh = cropRect.h * viewScale;
      viewCtx.fillStyle = 'rgba(12, 16, 40, 0.48)';
      viewCtx.fillRect(0, 0, dw, ry);
      viewCtx.fillRect(0, ry + rh, dw, dh - ry - rh);
      viewCtx.fillRect(0, ry, rx, rh);
      viewCtx.fillRect(rx + rw, ry, dw - rx - rw, rh);
      viewCtx.strokeStyle = '#4a69d6';
      viewCtx.lineWidth = 2;
      viewCtx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
      const hs = isCoarsePointer ? 18 : 8;
      const handles = [
        [rx, ry],
        [rx + rw, ry],
        [rx, ry + rh],
        [rx + rw, ry + rh],
        [rx + rw / 2, ry],
        [rx + rw / 2, ry + rh],
        [rx, ry + rh / 2],
        [rx + rw, ry + rh / 2],
      ];
      viewCtx.fillStyle = '#fff';
      viewCtx.strokeStyle = '#4a69d6';
      for (const [hx, hy] of handles) {
        viewCtx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
        viewCtx.strokeRect(hx - hs / 2 + 0.5, hy - hs / 2 + 0.5, hs - 1, hs - 1);
      }
    }
  }

  /**
   * @param {number} clientX
   * @param {number} clientY
   */
  function clientXYToSource(clientX, clientY) {
    if (!els.view || !sourceCanvas) return { x: 0, y: 0 };
    const rect = els.view.getBoundingClientRect();
    const nx = (clientX - rect.left) / Math.max(1, rect.width);
    const ny = (clientY - rect.top) / Math.max(1, rect.height);
    return {
      x: Math.max(0, Math.min(sourceCanvas.width - 1, nx * sourceCanvas.width)),
      y: Math.max(0, Math.min(sourceCanvas.height - 1, ny * sourceCanvas.height)),
    };
  }

  /**
   * 裁切命中：角点 + 四边宽带（触屏更易点中）
   * @param {number} clientX
   * @param {number} clientY
   */
  function hitCropHandle(clientX, clientY) {
    if (!els.view || !sourceCanvas) return null;
    const rect = els.view.getBoundingClientRect();
    const slopPx = isCoarsePointer ? 44 : 14;
    const edgePx = isCoarsePointer ? 32 : 12;
    const r = cropRect;
    const W = sourceCanvas.width;
    const H = sourceCanvas.height;

    /** @param {number} sx @param {number} sy */
    function toScreen(sx, sy) {
      return {
        x: rect.left + (sx / W) * rect.width,
        y: rect.top + (sy / H) * rect.height,
      };
    }

    const corners = [
      ['nw', r.x, r.y],
      ['ne', r.x + r.w, r.y],
      ['sw', r.x, r.y + r.h],
      ['se', r.x + r.w, r.y + r.h],
    ];
    for (const [k, hx, hy] of corners) {
      const sc = toScreen(hx, hy);
      if (Math.hypot(clientX - sc.x, clientY - sc.y) <= slopPx) return k;
    }

    const tl = toScreen(r.x, r.y);
    const br = toScreen(r.x + r.w, r.y + r.h);
    const x1 = tl.x;
    const y1 = tl.y;
    const x2 = br.x;
    const y2 = br.y;

    if (clientY >= y1 - edgePx && clientY <= y1 + edgePx && clientX >= x1 - slopPx && clientX <= x2 + slopPx) {
      return 'n';
    }
    if (clientY >= y2 - edgePx && clientY <= y2 + edgePx && clientX >= x1 - slopPx && clientX <= x2 + slopPx) {
      return 's';
    }
    if (clientX >= x1 - edgePx && clientX <= x1 + edgePx && clientY >= y1 - slopPx && clientY <= y2 + slopPx) {
      return 'w';
    }
    if (clientX >= x2 - edgePx && clientX <= x2 + edgePx && clientY >= y1 - slopPx && clientY <= y2 + slopPx) {
      return 'e';
    }

    const pt = clientXYToSource(clientX, clientY);
    if (pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) return 'move';
    return null;
  }

  /** @param {number} sx @param {number} sy */
  function paintMask(sx, sy) {
    if (!maskCanvas) return;
    const mctx = maskCanvas.getContext('2d');
    if (!mctx) return;
    const fillStyle = brushMode === 'keep' ? '#ffffff' : '#000000';
    mctx.save();
    mctx.fillStyle = fillStyle;
    mctx.strokeStyle = fillStyle;
    mctx.lineCap = 'round';
    mctx.lineJoin = 'round';
    mctx.lineWidth = brushSize;

    if (lastPaintPt) {
      mctx.beginPath();
      mctx.moveTo(lastPaintPt.x, lastPaintPt.y);
      mctx.lineTo(sx, sy);
      mctx.stroke();
    }
    mctx.beginPath();
    mctx.arc(sx, sy, brushSize / 2, 0, Math.PI * 2);
    mctx.fill();
    mctx.restore();
    lastPaintPt = { x: sx, y: sy };
    renderView();
    notifyChange();
  }

  function setMode(next) {
    mode = next;
    els.modeCrop?.classList.toggle('active', mode === 'crop');
    els.modeMask?.classList.toggle('active', mode === 'mask');
    els.applyCrop?.classList.toggle('hidden', mode !== 'crop');
    document.querySelectorAll('.edit-mask-only').forEach((n) => {
      n.classList.toggle('hidden', mode !== 'mask');
    });
    document.querySelectorAll('.edit-crop-only').forEach((n) => {
      n.classList.toggle('hidden', mode !== 'crop');
    });
    if (els.cropTouchUi) {
      els.cropTouchUi.classList.toggle('hidden', mode !== 'crop' || !isCoarsePointer);
    }
    if (els.view) els.view.style.cursor = mode === 'mask' && maskTool === 'wand' ? 'cell' : 'crosshair';
    renderView();
  }

  function setMaskTool(tool) {
    maskTool = tool;
    els.toolBrush?.classList.toggle('active', tool === 'brush');
    els.toolWand?.classList.toggle('active', tool === 'wand');
    document.querySelectorAll('.edit-brush-only').forEach((n) => {
      n.classList.toggle('hidden', tool !== 'brush');
    });
    document.querySelectorAll('.edit-wand-only').forEach((n) => {
      n.classList.toggle('hidden', tool !== 'wand');
    });
    if (els.view) els.view.style.cursor = tool === 'wand' ? 'cell' : 'crosshair';
  }

  function applyCrop() {
    if (!sourceCanvas || !maskCanvas) return;
    clampCrop();
    const { x, y, w, h } = cropRect;
    const next = document.createElement('canvas');
    next.width = Math.round(w);
    next.height = Math.round(h);
    const nx = next.getContext('2d');
    if (!nx) return;
    nx.drawImage(sourceCanvas, x, y, w, h, 0, 0, w, h);
    sourceCanvas = next;

    const nm = document.createElement('canvas');
    nm.width = next.width;
    nm.height = next.height;
    const nmx = nm.getContext('2d');
    if (nmx) {
      nmx.fillStyle = '#ffffff';
      nmx.fillRect(0, 0, nm.width, nm.height);
    }
    maskCanvas = nm;

    cropRect = { x: 0, y: 0, w: next.width, h: next.height };
    undoStack.length = 0;
    redoStack.length = 0;
    updateUndoButtons();
    syncCropSlidersFromRect();
    layoutView();
    renderView();
    notifyChangeImmediate();
  }

  function captureMaskState() {
    if (!maskCanvas) return null;
    const mctx = maskCanvas.getContext('2d');
    if (!mctx) return null;
    return mctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
  }

  /** @param {ImageData} img */
  function restoreMaskState(img) {
    if (!maskCanvas) return;
    const mctx = maskCanvas.getContext('2d');
    if (!mctx) return;
    mctx.putImageData(img, 0, 0);
    renderView();
  }

  function updateUndoButtons() {
    if (els.maskUndo) els.maskUndo.disabled = undoStack.length === 0;
    if (els.maskRedo) els.maskRedo.disabled = redoStack.length === 0;
  }

  function pushUndo() {
    const snap = captureMaskState();
    if (!snap) return;
    undoStack.push(snap);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    updateUndoButtons();
  }

  function undoMask() {
    const cur = captureMaskState();
    if (!cur || undoStack.length === 0) return;
    redoStack.push(cur);
    const prev = undoStack.pop();
    restoreMaskState(prev);
    updateUndoButtons();
    notifyChangeImmediate();
  }

  function redoMask() {
    const cur = captureMaskState();
    if (!cur || redoStack.length === 0) return;
    undoStack.push(cur);
    const next = redoStack.pop();
    restoreMaskState(next);
    updateUndoButtons();
    notifyChangeImmediate();
  }

  function fillMask(v) {
    if (!maskCanvas) return;
    pushUndo();
    const mctx = maskCanvas.getContext('2d');
    if (!mctx) return;
    mctx.fillStyle = v ? '#ffffff' : '#000000';
    mctx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    renderView();
    notifyChangeImmediate();
  }

  /**
   * @param {number} thresholdSqLab
   * @param {{ skipUndo?: boolean }} [opts]
   */
  function applyCornerBgToMask(thresholdSqLab, opts) {
    if (!sourceCanvas || !maskCanvas) return;
    const sctx = sourceCanvas.getContext('2d');
    const mctx = maskCanvas.getContext('2d');
    if (!sctx || !mctx) return;
    if (typeof computeCornerBackgroundMask !== 'function') return;

    if (!opts?.skipUndo) pushUndo();

    const w = sourceCanvas.width;
    const h = sourceCanvas.height;
    const src = sctx.getImageData(0, 0, w, h);
    const bg = computeCornerBackgroundMask(src.data, w, h, thresholdSqLab);
    const md = mctx.getImageData(0, 0, w, h);

    for (let id = 0; id < w * h; id++) {
      if (!bg[id]) continue;
      const i = id * 4;
      md.data[i] = 0;
      md.data[i + 1] = 0;
      md.data[i + 2] = 0;
    }
    mctx.putImageData(md, 0, 0);
    renderView();
    notifyChangeImmediate();
  }

  function protectCenterMask() {
    if (!maskCanvas) return;
    pushUndo();
    const mctx = maskCanvas.getContext('2d');
    if (!mctx) return;
    const w = maskCanvas.width;
    const h = maskCanvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const rx = w * 0.34;
    const ry = h * 0.38;
    mctx.save();
    mctx.fillStyle = '#ffffff';
    mctx.beginPath();
    mctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    mctx.fill();
    mctx.restore();
    renderView();
    notifyChangeImmediate();
  }

  /**
   * @param {number} sx
   * @param {number} sy
   */
  function magicWandAt(sx, sy) {
    if (!sourceCanvas || !maskCanvas) return;
    const sctx = sourceCanvas.getContext('2d');
    const mctx = maskCanvas.getContext('2d');
    if (!sctx || !mctx) return;

    const w = sourceCanvas.width;
    const h = sourceCanvas.height;
    const ix = Math.floor(sx);
    const iy = Math.floor(sy);
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) return;

    pushUndo();

    const src = sctx.getImageData(0, 0, w, h);
    const md = mctx.getImageData(0, 0, w, h);
    const seedI = (iy * w + ix) * 4;
    const seedLab = rgbToLab(src.data[seedI], src.data[seedI + 1], src.data[seedI + 2]);
    const tol = wandTolerance * wandTolerance;
    const visited = new Uint8Array(w * h);
    const q = [iy * w + ix];
    visited[iy * w + ix] = 1;
    const fillVal = brushMode === 'keep' ? 255 : 0;

    for (let head = 0; head < q.length; head++) {
      const id = q[head];
      const i = id * 4;
      md.data[i] = fillVal;
      md.data[i + 1] = fillVal;
      md.data[i + 2] = fillVal;
      const y = (id / w) | 0;
      const x = id - y * w;
      const neighbors = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ];
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nid = ny * w + nx;
        if (visited[nid]) continue;
        const ni = nid * 4;
        const lab = rgbToLab(src.data[ni], src.data[ni + 1], src.data[ni + 2]);
        if (squaredLabDelta(lab, seedLab) > tol) continue;
        visited[nid] = 1;
        q.push(nid);
      }
    }

    mctx.putImageData(md, 0, 0);
    renderView();
    notifyChangeImmediate();
  }

  /**
   * @param {CanvasImageSource} img
   * @param {() => void} changeCb
   */
  function loadFromImage(img, changeCb) {
    onChange = changeCb;
    const el = /** @type {HTMLImageElement} */ (img);
    const iw = Math.max(1, el.naturalWidth || el.width || 1);
    const ih = Math.max(1, el.naturalHeight || el.height || 1);
    const scale = Math.min(1, MAX_EDIT_PX / Math.max(iw, ih));
    const w = Math.max(1, Math.round(iw * scale));
    const h = Math.max(1, Math.round(ih * scale));

    sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = w;
    sourceCanvas.height = h;
    const sctx = sourceCanvas.getContext('2d');
    if (sctx) sctx.drawImage(img, 0, 0, w, h);

    maskCanvas = document.createElement('canvas');
    maskCanvas.width = w;
    maskCanvas.height = h;
    fillMask(true);

    cropRect = { x: 0, y: 0, w, h };
    mode = 'crop';
    setMode('crop');

    undoStack.length = 0;
    redoStack.length = 0;
    updateUndoButtons();
    setMaskTool('brush');

    syncCropSlidersFromRect();
    if (isCoarsePointer) document.documentElement.classList.add('coarse-ui');

    if (els.panel) els.panel.hidden = false;
    layoutView();
    renderView();
  }

  function reset() {
    sourceCanvas = null;
    maskCanvas = null;
    undoStack.length = 0;
    redoStack.length = 0;
    if (els.panel) els.panel.hidden = true;
    onChange = null;
  }

  /** @returns {HTMLCanvasElement | null} */
  function getPreparedCanvas() {
    if (!sourceCanvas || !maskCanvas) return null;
    const out = document.createElement('canvas');
    out.width = sourceCanvas.width;
    out.height = sourceCanvas.height;
    const octx = out.getContext('2d');
    if (!octx) return null;
    octx.drawImage(sourceCanvas, 0, 0);
    const img = octx.getImageData(0, 0, out.width, out.height);
    const md = maskCanvas.getContext('2d')?.getImageData(0, 0, out.width, out.height);
    if (!md) return out;
    for (let i = 0; i < img.data.length; i += 4) {
      if (md.data[i] < 128) img.data[i + 3] = 0;
    }
    octx.putImageData(img, 0, 0);
    return out;
  }

  function getAspect() {
    if (!sourceCanvas) return 1;
    return sourceCanvas.width / Math.max(1, sourceCanvas.height);
  }

  function isActive() {
    return Boolean(sourceCanvas && maskCanvas);
  }

  /**
   * @param {number} clientX
   * @param {number} clientY
   */
  function beginInteraction(clientX, clientY) {
    if (!sourceCanvas || !els.view) return;
    const pt = clientXYToSource(clientX, clientY);
    if (mode === 'mask') {
      if (maskTool === 'wand') {
        magicWandAt(pt.x, pt.y);
        return;
      }
      pushUndo();
      painting = true;
      lastPaintPt = null;
      paintMask(pt.x, pt.y);
      return;
    }
    const hit = hitCropHandle(clientX, clientY);
    if (hit) {
      drag = { kind: hit, sx: pt.x, sy: pt.y, rect: { ...cropRect } };
      lockPageScroll();
    }
  }

  /**
   * @param {number} clientX
   * @param {number} clientY
   */
  function moveInteraction(clientX, clientY) {
    if (!sourceCanvas || (!drag && !painting)) return;
    const pt = clientXYToSource(clientX, clientY);
    if (painting && mode === 'mask') {
      paintMask(pt.x, pt.y);
      return;
    }
    if (!drag) return;
    const dx = pt.x - drag.sx;
    const dy = pt.y - drag.sy;
    const r0 = drag.rect;
    let { x, y, w, h } = { ...r0 };

    if (drag.kind === 'move') {
      x = r0.x + dx;
      y = r0.y + dy;
    } else {
      if (drag.kind.includes('e')) w = r0.w + dx;
      if (drag.kind.includes('w')) {
        w = r0.w - dx;
        x = r0.x + dx;
      }
      if (drag.kind.includes('s')) h = r0.h + dy;
      if (drag.kind.includes('n')) {
        h = r0.h - dy;
        y = r0.y + dy;
      }
    }
    cropRect = { x, y, w, h };
    clampCrop();
    syncCropSlidersFromRect();
    renderView();
  }

  function endInteraction() {
    unlockPageScroll();
    if (painting) {
      painting = false;
      lastPaintPt = null;
      notifyChangeImmediate();
    }
    if (drag) {
      drag = null;
      notifyChangeImmediate();
    }
  }

  /** @param {TouchList} list @param {number} id */
  function findTouch(list, id) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].identifier === id) return list[i];
    }
    return null;
  }

  /** @param {TouchEvent} e */
  function onTouchStart(e) {
    if (!els.view || activeTouchId !== null) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const rect = els.view.getBoundingClientRect();
    if (
      t.clientX < rect.left ||
      t.clientX > rect.right ||
      t.clientY < rect.top ||
      t.clientY > rect.bottom
    ) {
      return;
    }
    activeTouchId = t.identifier;
    suppressMouseUntil = Date.now() + 900;
    e.preventDefault();
    beginInteraction(t.clientX, t.clientY);
  }

  /** @param {TouchEvent} e */
  function onTouchMove(e) {
    if (activeTouchId === null) return;
    const t = findTouch(e.touches, activeTouchId) || findTouch(e.changedTouches, activeTouchId);
    if (!t) return;
    if (drag || painting) e.preventDefault();
    moveInteraction(t.clientX, t.clientY);
  }

  /** @param {TouchEvent} e */
  function onTouchEnd(e) {
    if (activeTouchId === null) return;
    let ended = false;
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === activeTouchId) ended = true;
    }
    if (!ended) return;
    activeTouchId = null;
    e.preventDefault();
    endInteraction();
  }

  /** @param {PointerEvent} ev */
  function onPointerDown(ev) {
    if (!els.view) return;
    if (Date.now() < suppressMouseUntil) return;
    if (ev.pointerType === 'touch') return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    ev.preventDefault();
    try {
      els.view.setPointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    beginInteraction(ev.clientX, ev.clientY);
  }

  /** @param {PointerEvent} ev */
  function onPointerMove(ev) {
    if (!drag && !painting) return;
    if (ev.pointerType === 'touch') return;
    if (drag || painting) ev.preventDefault();
    moveInteraction(ev.clientX, ev.clientY);
  }

  /** @param {PointerEvent} ev */
  function onPointerUp(ev) {
    if (ev.pointerType === 'touch') return;
    if (els.view && ev.pointerId != null) {
      try {
        if (els.view.hasPointerCapture(ev.pointerId)) {
          els.view.releasePointerCapture(ev.pointerId);
        }
      } catch {
        /* ignore */
      }
    }
    endInteraction();
  }

  function wire() {
    if (!els.view) return;

    const view = els.view;
    view.style.touchAction = 'none';

    view.addEventListener('touchstart', onTouchStart, { passive: false });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: false });
    window.addEventListener('touchcancel', onTouchEnd, { passive: false });

    view.addEventListener('pointerdown', onPointerDown);
    view.addEventListener('pointermove', onPointerMove);
    view.addEventListener('pointerup', onPointerUp);
    view.addEventListener('pointercancel', onPointerUp);

    els.modeCrop?.addEventListener('click', () => setMode('crop'));
    els.modeMask?.addEventListener('click', () => setMode('mask'));
    els.brushKeep?.addEventListener('click', () => {
      brushMode = 'keep';
      els.brushKeep?.classList.add('active');
      els.brushErase?.classList.remove('active');
    });
    els.brushErase?.addEventListener('click', () => {
      brushMode = 'erase';
      els.brushErase?.classList.add('active');
      els.brushKeep?.classList.remove('active');
    });
    els.brush?.addEventListener('input', () => {
      brushSize = Number(els.brush?.value) || 28;
      if (els.brushVal) els.brushVal.textContent = String(brushSize);
    });
    els.applyCrop?.addEventListener('click', applyCrop);
    for (const id of ['crop-x', 'crop-y', 'crop-w', 'crop-h']) {
      const inp = document.getElementById(id);
      if (!inp) continue;
      inp.addEventListener('input', () => {
        applyCropSlidersToRect();
        notifyChange();
      });
    }
    els.maskFill?.addEventListener('click', () => fillMask(true));
    els.maskClear?.addEventListener('click', () => fillMask(false));
    els.maskUndo?.addEventListener('click', undoMask);
    els.maskRedo?.addEventListener('click', redoMask);
    els.toolBrush?.addEventListener('click', () => setMaskTool('brush'));
    els.toolWand?.addEventListener('click', () => setMaskTool('wand'));
    els.autoCornerBg?.addEventListener('click', () => {
      const thrInp = document.getElementById('bg-rm-sensitive');
      const thr = thrInp ? Number(/** @type {HTMLInputElement} */ (thrInp).value) : 600;
      applyCornerBgToMask(Number.isFinite(thr) ? thr : 600);
    });
    els.protectCenter?.addEventListener('click', protectCenterMask);
    els.wandTol?.addEventListener('input', () => {
      wandTolerance = Number(els.wandTol?.value) || 22;
      if (els.wandTolVal) els.wandTolVal.textContent = String(wandTolerance);
    });

    window.addEventListener('keydown', (e) => {
      if (mode !== 'mask' || !sourceCanvas) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) redoMask();
      else undoMask();
    });

    window.addEventListener('resize', () => {
      if (!sourceCanvas) return;
      layoutView();
      renderView();
    });

    if (els.brush) {
      if (isCoarsePointer && Number(els.brush.value) < 36) {
        els.brush.value = '40';
      }
      brushSize = Number(els.brush.value) || 28;
      if (els.brushVal) els.brushVal.textContent = String(brushSize);
    }
    if (els.wandTol) {
      wandTolerance = Number(els.wandTol.value) || 22;
      if (els.wandTolVal) els.wandTolVal.textContent = String(wandTolerance);
    }
    els.brushKeep?.classList.add('active');
    setMaskTool('brush');
    updateUndoButtons();
  }

  window.imageEditor = {
    loadFromImage,
    reset,
    getPreparedCanvas,
    getAspect,
    isActive,
    applyCornerBgToMask,
    wire,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
