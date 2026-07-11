/**
 * 本地裁切（Cropper.js）+ 手动画蒙版 + AI 抠图（纯前端）。
 * 蒙版外区域在生成前设为透明，由 drawSourceToWorkCanvas 映射为「留白背景」色。
 */
(function () {
  const MAX_EDIT_PX = 1024;
  const MODULE_V = '12';

  /** @type {HTMLCanvasElement | null} */
  let sourceCanvas = null;
  /** @type {HTMLCanvasElement | null} */
  let maskCanvas = null;

  /** @type {InstanceType<typeof Cropper> | null} */
  let cropper = null;

  /** @type {'crop' | 'mask'} */
  let mode = 'crop';
  let brushSize = 28;
  /** @type {'keep' | 'erase'} */
  let brushMode = 'keep';
  /** @type {'brush' | 'wand'} */
  let maskTool = 'brush';
  let wandTolerance = 22;
  let aiBusy = false;
  let maskDirty = false;

  const MAX_SOURCE_UNDO = 12;
  const MAX_UNDO = 36;
  /** @type {HTMLCanvasElement[]} */
  const sourceUndoStack = [];
  /** @type {HTMLCanvasElement[]} */
  const sourceRedoStack = [];
  /** @type {ImageData[]} */
  const undoStack = [];
  /** @type {ImageData[]} */
  const redoStack = [];

  let viewScale = 1;

  let painting = false;
  /** @type {{ x: number, y: number } | null} */
  let lastPaintPt = null;
  /** iOS/Android 触摸跟踪（蒙版模式） */
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
    cropWrap: /** @type {HTMLElement | null} */ (document.getElementById('crop-wrap')),
    cropImage: /** @type {HTMLImageElement | null} */ (document.getElementById('crop-image')),
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
    aiBgBtn: /** @type {HTMLButtonElement | null} */ (document.getElementById('mask-ai-bg')),
    editAiStatus: /** @type {HTMLElement | null} */ (document.getElementById('edit-ai-status')),
    aiCartoonBtn: /** @type {HTMLButtonElement | null} */ (document.getElementById('ai-cartoon')),
    cartoonStyle: /** @type {HTMLSelectElement | null} */ (document.getElementById('cartoon-style')),
    fastCartoonBtn: /** @type {HTMLButtonElement | null} */ (document.getElementById('fast-cartoon')),
    sourceUndoBtn: /** @type {HTMLButtonElement | null} */ (document.getElementById('source-undo')),
    sourceRedoBtn: /** @type {HTMLButtonElement | null} */ (document.getElementById('source-redo')),
    autoCornerBg: /** @type {HTMLButtonElement | null} */ (document.getElementById('mask-auto-corner')),
    protectCenter: /** @type {HTMLButtonElement | null} */ (document.getElementById('mask-protect-center')),
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

  /** @param {string} msg @param {boolean} [show] */
  function setEditStatus(msg, show = true) {
    if (!els.editAiStatus) return;
    els.editAiStatus.textContent = msg;
    els.editAiStatus.classList.toggle('hidden', !show || !msg);
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

  function destroyCropper() {
    if (cropper) {
      cropper.destroy();
      cropper = null;
    }
  }

  function initCropper() {
    if (!els.cropImage || !sourceCanvas || typeof Cropper === 'undefined') return;
    destroyCropper();
    els.cropImage.removeAttribute('crossorigin');
    els.cropImage.src = sourceCanvas.toDataURL('image/png');
    try {
      cropper = new Cropper(els.cropImage, {
        viewMode: 1,
        dragMode: 'move',
        autoCropArea: 0.94,
        responsive: true,
        restore: false,
        guides: true,
        center: true,
        highlight: true,
        cropBoxMovable: true,
        cropBoxResizable: true,
        toggleDragModeOnDblclick: false,
        zoomOnTouch: true,
        zoomOnWheel: true,
        movable: true,
        scalable: true,
      });
    } catch (err) {
      console.error('Cropper init failed', err);
      cropper = null;
    }
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
  }

  function renderView() {
    if (!viewCtx || !els.view || !sourceCanvas || !maskCanvas) return;
    const dw = els.view.width;
    const dh = els.view.height;
    viewCtx.clearRect(0, 0, dw, dh);
    viewCtx.imageSmoothingEnabled = true;
    viewCtx.drawImage(sourceCanvas, 0, 0, dw, dh);

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

  /** @param {number} sx @param {number} sy */
  function paintMask(sx, sy) {
    if (!maskCanvas) return;
    maskDirty = true;
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

    if (mode === 'crop') {
      setEditStatus('', false);
      els.cropWrap?.classList.remove('hidden');
      els.view?.classList.add('hidden');
      initCropper();
    } else {
      destroyCropper();
      els.cropWrap?.classList.add('hidden');
      els.view?.classList.remove('hidden');
      layoutView();
      renderView();
    }

    if (els.view) els.view.style.cursor = maskTool === 'wand' ? 'cell' : 'crosshair';
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
    let cropped = /** @type {HTMLCanvasElement | null} */ (null);
    if (cropper && typeof Cropper !== 'undefined') {
      cropped = cropper.getCroppedCanvas({
        maxWidth: MAX_EDIT_PX,
        maxHeight: MAX_EDIT_PX,
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'high',
      });
    }
    if (!cropped || cropped.width < 1 || cropped.height < 1) return;

    const next = document.createElement('canvas');
    next.width = cropped.width;
    next.height = cropped.height;
    const nx = next.getContext('2d');
    if (!nx) return;
    nx.drawImage(cropped, 0, 0);
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
    maskDirty = false;

    undoStack.length = 0;
    redoStack.length = 0;
    sourceUndoStack.length = 0;
    sourceRedoStack.length = 0;
    updateUndoButtons();
    updateSourceUndoButtons();
    initCropper();
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

  function seedMaskCanvas() {
    if (!maskCanvas) return;
    const mctx = maskCanvas.getContext('2d');
    if (!mctx) return;
    mctx.fillStyle = '#ffffff';
    mctx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    maskDirty = false;
  }

  function fillMask(v, opts) {
    if (!maskCanvas) return;
    if (!opts?.skipUndo) pushUndo();
    maskDirty = true;
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
    maskDirty = true;

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
    maskDirty = true;
    renderView();
    notifyChangeImmediate();
  }

  function captureSourceCanvas() {
    if (!sourceCanvas) return null;
    const snap = document.createElement('canvas');
    snap.width = sourceCanvas.width;
    snap.height = sourceCanvas.height;
    const ctx = snap.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(sourceCanvas, 0, 0);
    return snap;
  }

  function updateSourceUndoButtons() {
    if (els.sourceUndoBtn) els.sourceUndoBtn.disabled = sourceUndoStack.length === 0;
    if (els.sourceRedoBtn) els.sourceRedoBtn.disabled = sourceRedoStack.length === 0;
  }

  function pushSourceUndo() {
    const snap = captureSourceCanvas();
    if (!snap) return;
    sourceUndoStack.push(snap);
    if (sourceUndoStack.length > MAX_SOURCE_UNDO) sourceUndoStack.shift();
    sourceRedoStack.length = 0;
    updateSourceUndoButtons();
  }

  /** @param {HTMLCanvasElement} next */
  function replaceSourceCanvas(next) {
    if (!sourceCanvas || !maskCanvas) return;
    sourceCanvas = next;
    if (mode === 'crop') {
      initCropper();
    } else {
      layoutView();
      renderView();
    }
    notifyChangeImmediate();
  }

  function undoSource() {
    if (!sourceCanvas || sourceUndoStack.length === 0) return;
    const cur = captureSourceCanvas();
    if (cur) sourceRedoStack.push(cur);
    const prev = sourceUndoStack.pop();
    replaceSourceCanvas(prev);
    updateSourceUndoButtons();
  }

  function redoSource() {
    if (!sourceCanvas || sourceRedoStack.length === 0) return;
    const cur = captureSourceCanvas();
    if (cur) sourceUndoStack.push(cur);
    const next = sourceRedoStack.pop();
    replaceSourceCanvas(next);
    updateSourceUndoButtons();
  }

  async function applyFastCartoon() {
    if (!sourceCanvas || aiBusy) return;
    aiBusy = true;
    if (els.fastCartoonBtn) els.fastCartoonBtn.disabled = true;
    if (els.aiCartoonBtn) els.aiCartoonBtn.disabled = true;
    setEditStatus('快速卡通处理中…');
    try {
      const { fastCartoonize } = await import(`./fast-cartoon.js?v=${MODULE_V}`);
      pushSourceUndo();
      const out = fastCartoonize(sourceCanvas);
      replaceSourceCanvas(out);
      setEditStatus('快速卡通完成，可撤销原图或继续抠图');
    } catch (err) {
      console.error('Fast cartoon failed', err);
      const msg = err instanceof Error ? err.message : String(err);
      setEditStatus(`快速卡通失败：${msg.slice(0, 120)}`);
      if (sourceUndoStack.length) sourceUndoStack.pop();
      updateSourceUndoButtons();
    } finally {
      aiBusy = false;
      if (els.fastCartoonBtn) els.fastCartoonBtn.disabled = false;
      if (els.aiCartoonBtn) els.aiCartoonBtn.disabled = false;
    }
  }

  function updateCartoonStyleOptions() {
    const faceOpt = els.cartoonStyle?.querySelector('option[value="faceportrait"]');
    const hint = document.getElementById('file-protocol-hint');
    const onFile = location.protocol === 'file:';
    if (faceOpt) {
      faceOpt.disabled = onFile;
      faceOpt.textContent = onFile
        ? '动漫人像（需 http:// 打开）'
        : '动漫人像 · 人像最佳（约 8MB）';
    }
    if (onFile && els.cartoonStyle?.value === 'faceportrait') {
      els.cartoonStyle.value = 'cartoongan';
    }
    if (hint) hint.classList.toggle('hidden', !onFile);
  }

  async function applyAiCartoon() {
    if (!sourceCanvas || aiBusy) return;
    const style = /** @type {'cartoongan'|'hayao'|'faceportrait'} */ (
      els.cartoonStyle?.value || 'cartoongan'
    );
    if (style === 'faceportrait' && location.protocol === 'file:') {
      setEditStatus(
        '「动漫人像」在 Safari file:// 下不可用。请用 python3 -m http.server 8765 后打开 http://127.0.0.1:8765',
      );
      return;
    }
    aiBusy = true;
    if (els.fastCartoonBtn) els.fastCartoonBtn.disabled = true;
    if (els.aiCartoonBtn) els.aiCartoonBtn.disabled = true;
    setEditStatus('准备 AI 卡通模型…');
    try {
      const mod = window.pindouAiCartoon;
      if (!mod?.aiCartoonizeStyle) {
        throw new Error('AI 卡通模块未加载，请刷新页面');
      }
      pushSourceUndo();
      const out = await mod.aiCartoonizeStyle(sourceCanvas, style, (msg) => setEditStatus(msg));
      replaceSourceCanvas(out);
      setEditStatus('AI 卡通完成，可撤销原图或继续抠图');
    } catch (err) {
      console.error('AI cartoon failed', err);
      const msg = err instanceof Error ? err.message : String(err);
      setEditStatus(`AI 卡通失败：${msg.slice(0, 140)}`);
      if (sourceUndoStack.length) sourceUndoStack.pop();
      updateSourceUndoButtons();
    } finally {
      aiBusy = false;
      if (els.fastCartoonBtn) els.fastCartoonBtn.disabled = false;
      if (els.aiCartoonBtn) els.aiCartoonBtn.disabled = false;
    }
  }

  async function applyAiBgToMask() {
    if (!sourceCanvas || !maskCanvas || aiBusy) return;
    aiBusy = true;
    if (els.aiBgBtn) els.aiBgBtn.disabled = true;

    if (!window.crossOriginIsolated) {
      setEditStatus('正在启用 AI 运行环境，页面将自动刷新一次…');
      aiBusy = false;
      if (els.aiBgBtn) els.aiBgBtn.disabled = false;
      return;
    }

    setEditStatus('准备 AI 模型（首次约 40MB，请稍候）…');

    try {
      if (mode === 'crop') setMode('mask');
      const { aiRemoveBackground } = await import(`./ai-bg-remove.js?v=${MODULE_V}`);
      const blob = await aiRemoveBackground(sourceCanvas, (key, cur, total) => {
        if (total > 0) {
          setEditStatus(`下载 ${key}… ${Math.min(100, Math.round((100 * cur) / total))}%`);
        } else {
          setEditStatus('AI 抠图中…');
        }
      });

      setEditStatus('写入蒙版…');
      pushUndo();

      const bmp = await createImageBitmap(blob);
      const tw = sourceCanvas.width;
      const th = sourceCanvas.height;
      const temp = document.createElement('canvas');
      temp.width = tw;
      temp.height = th;
      const tctx = temp.getContext('2d');
      if (!tctx) throw new Error('canvas');
      tctx.drawImage(bmp, 0, 0, tw, th);
      if (typeof bmp.close === 'function') bmp.close();

      const alphaImg = tctx.getImageData(0, 0, tw, th);
      const mctx = maskCanvas.getContext('2d');
      if (!mctx) return;
      const md = mctx.getImageData(0, 0, tw, th);

      for (let i = 0; i < md.data.length; i += 4) {
        const a = alphaImg.data[i + 3];
        const v = a >= 96 ? 255 : 0;
        md.data[i] = v;
        md.data[i + 1] = v;
        md.data[i + 2] = v;
      }
      mctx.putImageData(md, 0, 0);
      maskDirty = true;
      renderView();
      notifyChangeImmediate();
      setEditStatus('AI 抠图完成，可用画笔微调');
    } catch (err) {
      console.error('AI background removal failed', err);
      const msg = err instanceof Error ? err.message : String(err);
      setEditStatus(`AI 抠图失败：${msg.slice(0, 120)}`);
    } finally {
      aiBusy = false;
      if (els.aiBgBtn) els.aiBgBtn.disabled = false;
      updateUndoButtons();
    }
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
    maskDirty = true;
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
    maskDirty = true;
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
    seedMaskCanvas();

    undoStack.length = 0;
    redoStack.length = 0;
    sourceUndoStack.length = 0;
    sourceRedoStack.length = 0;
    updateUndoButtons();
    updateSourceUndoButtons();
    setMaskTool('brush');
    setEditStatus('', false);

    if (els.panel) els.panel.hidden = true;
    try {
      setMode('crop');
    } catch (err) {
      console.error('Edit panel init failed', err);
      mode = 'crop';
    }
  }

  function reset() {
    destroyCropper();
    sourceCanvas = null;
    maskCanvas = null;
    undoStack.length = 0;
    redoStack.length = 0;
    sourceUndoStack.length = 0;
    sourceRedoStack.length = 0;
    maskDirty = false;
    setEditStatus('', false);
    if (els.panel) els.panel.hidden = true;
    onChange = null;
  }

  /** @returns {HTMLCanvasElement | null} */
  function getSourceCanvas() {
    return sourceCanvas;
  }

  function isMaskDirty() {
    return maskDirty;
  }

  /** @returns {HTMLCanvasElement | null} */
  function getPreparedCanvas() {
    if (!sourceCanvas || !maskCanvas) return null;
    if (!maskDirty) return sourceCanvas;
    const out = document.createElement('canvas');
    out.width = sourceCanvas.width;
    out.height = sourceCanvas.height;
    const octx = out.getContext('2d');
    if (!octx) return sourceCanvas;
    octx.drawImage(sourceCanvas, 0, 0);
    try {
      const img = octx.getImageData(0, 0, out.width, out.height);
      const md = maskCanvas.getContext('2d')?.getImageData(0, 0, out.width, out.height);
      if (!md) return out;
      for (let i = 0; i < img.data.length; i += 4) {
        if (md.data[i] < 128) img.data[i + 3] = 0;
      }
      octx.putImageData(img, 0, 0);
      return out;
    } catch (err) {
      console.error('getPreparedCanvas failed, using source canvas', err);
      return sourceCanvas;
    }
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
    if (!sourceCanvas || !els.view || mode !== 'mask') return;
    const pt = clientXYToSource(clientX, clientY);
    if (maskTool === 'wand') {
      magicWandAt(pt.x, pt.y);
      return;
    }
    pushUndo();
    painting = true;
    lastPaintPt = null;
    paintMask(pt.x, pt.y);
  }

  /**
   * @param {number} clientX
   * @param {number} clientY
   */
  function moveInteraction(clientX, clientY) {
    if (!sourceCanvas || !painting || mode !== 'mask') return;
    const pt = clientXYToSource(clientX, clientY);
    paintMask(pt.x, pt.y);
  }

  function endInteraction() {
    unlockPageScroll();
    if (painting) {
      painting = false;
      lastPaintPt = null;
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
    if (!els.view || activeTouchId !== null || mode !== 'mask') return;
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
    lockPageScroll();
    beginInteraction(t.clientX, t.clientY);
  }

  /** @param {TouchEvent} e */
  function onTouchMove(e) {
    if (activeTouchId === null || mode !== 'mask') return;
    const t = findTouch(e.touches, activeTouchId) || findTouch(e.changedTouches, activeTouchId);
    if (!t) return;
    if (painting) e.preventDefault();
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
    if (!els.view || mode !== 'mask') return;
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
    if (!painting || mode !== 'mask') return;
    if (ev.pointerType === 'touch') return;
    if (painting) ev.preventDefault();
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
    els.maskFill?.addEventListener('click', () => fillMask(true));
    els.maskClear?.addEventListener('click', () => fillMask(false));
    els.maskUndo?.addEventListener('click', undoMask);
    els.maskRedo?.addEventListener('click', redoMask);
    els.toolBrush?.addEventListener('click', () => setMaskTool('brush'));
    els.toolWand?.addEventListener('click', () => setMaskTool('wand'));
    els.aiBgBtn?.addEventListener('click', () => {
      void applyAiBgToMask();
    });
    els.aiCartoonBtn?.addEventListener('click', () => {
      void applyAiCartoon();
    });
    els.fastCartoonBtn?.addEventListener('click', () => {
      void applyFastCartoon();
    });
    els.sourceUndoBtn?.addEventListener('click', undoSource);
    els.sourceRedoBtn?.addEventListener('click', redoSource);
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
      if (mode === 'mask') {
        layoutView();
        renderView();
      }
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
    updateCartoonStyleOptions();
    updateUndoButtons();
    updateSourceUndoButtons();
  }

  /**
   * 静物/食物简化预处理（供一键转拼豆图）。
   * @param {{ levels?: number, blurPasses?: number, skipUndo?: boolean }} [opts]
   */
  function simplifySource(opts) {
    if (!sourceCanvas) return false;
    const proc = window.pindouBeadProcess;
    if (!proc?.simplifyCanvas) return false;
    if (!opts?.skipUndo) pushSourceUndo();
    const out = proc.simplifyCanvas(sourceCanvas, {
      levels: opts?.levels ?? 10,
      blurPasses: opts?.blurPasses ?? 1,
    });
    replaceSourceCanvas(out);
    return true;
  }

  window.imageEditor = {
    loadFromImage,
    reset,
    getPreparedCanvas,
    getSourceCanvas,
    isMaskDirty,
    getAspect,
    isActive,
    applyCornerBgToMask,
    simplifySource,
    wire,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
