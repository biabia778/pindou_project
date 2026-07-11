/** @typedef {{ code: string, hex: string, rgb: [number, number, number], lab: [number, number, number] }} PaletteRow */

/** @type {PaletteRow[]} */
const PALETTE_ROWS = MARD_PALETTE.map((row) => ({
  ...row,
  rgb: /** @type {[number, number, number]} */ (row.rgb),
  lab: rgbToLab(row.rgb[0], row.rgb[1], row.rgb[2]),
}));

/** @type {(PaletteRow | null)[] | null} */
let lastGrid = null;

/** 预览可读性提示（由 paintBeadCanvas 写入，refreshLegend 展示） */
let previewReadabilityNote = '';

const GRID_MIN = 12;
const GRID_MAX = 256;

/** @type {Map<string, PaletteRow>} */
const ROW_BY_CODE = new Map(PALETTE_ROWS.map((r) => [r.code, r]));

/** 画布材料区无数据时的占位（仅用于胶囊底色与字色） */
const LEGEND_EMPTY_CHIP_ROW = /** @type {PaletteRow} */ ({
  code: '—',
  hex: '#e8eaef',
  rgb: [232, 234, 239],
  lab: [0, 0, 0],
});

const els = {
  drop: /** @type {HTMLElement} */ (document.getElementById('drop-zone')),
  file: /** @type {HTMLInputElement} */ (document.getElementById('file')),
  previewCanvas: /** @type {HTMLCanvasElement} */ (document.getElementById('preview-canvas')),
  download: /** @type {HTMLButtonElement} */ (document.getElementById('download-png')),
  copyList: /** @type {HTMLButtonElement} */ (document.getElementById('copy-list')),
  width: /** @type {HTMLInputElement} */ (document.getElementById('grid-w')),
  widthNum: /** @type {HTMLInputElement} */ (document.getElementById('grid-w-num')),
  height: /** @type {HTMLInputElement} */ (document.getElementById('grid-h')),
  heightNum: /** @type {HTMLInputElement} */ (document.getElementById('grid-h-num')),
  lockAspect: /** @type {HTMLInputElement} */ (document.getElementById('lock-aspect')),
  fit: /** @type {HTMLSelectElement} */ (document.getElementById('fit')),
  colorCap: /** @type {HTMLSelectElement} */ (document.getElementById('color-cap')),
  bg: /** @type {HTMLInputElement} */ (document.getElementById('bg-color')),
  removeBg: /** @type {HTMLInputElement} */ (document.getElementById('remove-bg')),
  bgRmSensitive: /** @type {HTMLInputElement} */ (document.getElementById('bg-rm-sensitive')),
  bgRmSensRow: /** @type {HTMLElement | null} */ (document.getElementById('bg-rm-sens-row')),
  stats: /** @type {HTMLElement} */ (document.getElementById('stats')),
  legend: /** @type {HTMLElement} */ (document.getElementById('legend')),
  regenerate: /** @type {HTMLButtonElement} */ (document.getElementById('regenerate')),
  quickActions: /** @type {HTMLElement | null} */ (document.getElementById('quick-actions')),
  autoBeads: /** @type {HTMLButtonElement | null} */ (document.getElementById('auto-beads')),
  autoStatus: /** @type {HTMLElement | null} */ (document.getElementById('auto-status')),
  toggleCustomize: /** @type {HTMLButtonElement | null} */ (document.getElementById('toggle-customize')),
  customizePanel: /** @type {HTMLElement | null} */ (document.getElementById('customize-panel')),
};

const ctx = els.previewCanvas.getContext('2d', { willReadFrequently: true });

let sourceImage = null;
let naturalAspect = 1;
let autoRunning = false;
let customizeOpen = false;

function clampGridDim(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return GRID_MIN;
  return Math.max(GRID_MIN, Math.min(GRID_MAX, n));
}

function compareMardCode(a, b) {
  const ma = /^([A-Z]+)(\d+)$/i.exec(a);
  const mb = /^([A-Z]+)(\d+)$/i.exec(b);
  if (!ma || !mb) return a.localeCompare(b);
  const g = ma[1].localeCompare(mb[1]);
  if (g !== 0) return g;
  return Number(ma[2]) - Number(mb[2]);
}

/**
 * @param {(PaletteRow | null)[]} beadGrid
 * @returns {Array<{ code: string, row: PaletteRow, n: number }>}
 */
function getMaterialTallySortedByUsage(beadGrid) {
  /** @type {Map<string, { row: PaletteRow, n: number }>} */
  const tally = new Map();
  for (const row of beadGrid) {
    if (!row) continue;
    const prev = tally.get(row.code);
    if (prev) prev.n += 1;
    else tally.set(row.code, { row, n: 1 });
  }
  return [...tally.entries()]
    .map(([code, x]) => ({ code, row: x.row, n: x.n }))
    .sort((a, b) => b.n - a.n || compareMardCode(a.code, b.code));
}

/**
 * @param {unknown} v
 * @param {{ applyAspect?: boolean }} [opts]
 */
function setWidthDim(v, opts) {
  const vv = clampGridDim(v);
  els.width.value = String(vv);
  els.widthNum.value = String(vv);
  const o = document.getElementById('grid-w-val');
  if (o) o.textContent = String(vv);
  if (opts?.applyAspect && els.lockAspect.checked && sourceImage) {
    const hh = Math.max(GRID_MIN, Math.round(vv / naturalAspect));
    setHeightDim(hh);
  }
}

/** @param {unknown} v */
function setHeightDim(v) {
  const vv = clampGridDim(v);
  els.height.value = String(vv);
  els.heightNum.value = String(vv);
  const o = document.getElementById('grid-h-val');
  if (o) o.textContent = String(vv);
}

/**
 * 将用量最少的色号逐步合并到 LAB 最接近的其它已用色上，直到种类 ≤ maxColors。
 * @param {(PaletteRow | null)[]} beadGrid
 * @param {number} maxColors
 */
function applyColorCountCap(beadGrid, maxColors) {
  if (!maxColors || maxColors < 2 || maxColors > 221) return;

  /** @type {Map<string, number>} */
  const count = new Map();
  for (let i = 0; i < beadGrid.length; i++) {
    const cell = beadGrid[i];
    if (!cell) continue;
    count.set(cell.code, (count.get(cell.code) || 0) + 1);
  }

  while (count.size > maxColors) {
    let rareCode = '';
    let rareN = Infinity;
    for (const [code, n] of count) {
      if (n < rareN || (n === rareN && code.localeCompare(rareCode) < 0)) {
        rareN = n;
        rareCode = code;
      }
    }
    const rareRow = ROW_BY_CODE.get(rareCode);
    if (!rareRow) break;

    let bestCode = '';
    let bestD = Infinity;
    for (const code of count.keys()) {
      if (code === rareCode) continue;
      const other = ROW_BY_CODE.get(code);
      if (!other) continue;
      const d = squaredLabDelta(rareRow.lab, other.lab);
      if (d < bestD || (d === bestD && code.localeCompare(bestCode) < 0)) {
        bestD = d;
        bestCode = code;
      }
    }
    const replaceRow = ROW_BY_CODE.get(bestCode);
    if (!replaceRow) break;

    for (let i = 0; i < beadGrid.length; i++) {
      if (beadGrid[i]?.code === rareCode) beadGrid[i] = replaceRow;
    }

    count.delete(rareCode);
    count.set(bestCode, (count.get(bestCode) || 0) + rareN);
  }
}

/** 单张预览画布允许的最大「珠子区」像素乘积 w×h×cell²（防内存/卡顿） */
const MAX_BEAD_CANVAS_PX = 28_000_000;
/** 格内写色号的珠格数上限（之上仅画颜色+网格+坐标） */
const MAX_CELLS_INCODES = 85_000;
const MIN_CELL_PX = 6;
/** 图纸模式希望的单格下限（会再被内存上限压下去） */
const PAPER_CELL_FLOOR = 12;

/**
 * @param {CanvasRenderingContext2D} p
 * @param {string} [fontPrefix] 如 `bold `，须与最终绘制时一致以便 measureText 准确
 */
function fitFontPxToWidth(p, text, pxHigh, pxLow, maxW, fontPrefix = '') {
  const hi = Math.max(pxLow, Math.min(pxHigh, 64));
  const stack = 'ui-sans-serif, system-ui, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif';
  for (let s = hi; s >= pxLow; s--) {
    p.font = `${fontPrefix}${s}px ${stack}`;
    if (p.measureText(text).width <= maxW) return s;
  }
  return pxLow;
}

/**
 * 优先保证「能读」：图纸模式单格尽量不低于 PAPER_CELL_FLOOR，再按浏览器宽度与内存上限收缩。
 */
function solveCellPx(w, h, wantPaper) {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const usable = Math.max(400, vw * 0.9 - 40);

  let cellPx = Math.floor(usable / Math.max(w, h));
  if (wantPaper) cellPx = Math.max(cellPx, PAPER_CELL_FLOOR);
  cellPx = Math.min(88, Math.max(MIN_CELL_PX, cellPx));

  while (w * h * cellPx * cellPx > MAX_BEAD_CANVAS_PX && cellPx > MIN_CELL_PX) cellPx -= 1;
  return cellPx;
}

/** 导出 PNG 时单格上限（可高于预览的 88，仍受总像素预算约束） */
const EXPORT_MAX_CELL_PX = 120;

/**
 * 导出用单格尺寸：按总像素与画布单边上限尽量放大，不随浏览器窗口变窄。
 * @param {number} w
 * @param {number} h
 * @param {boolean} wantPaper
 */
function solveExportCellPx(w, h, wantPaper) {
  const dim = Math.max(w, h);
  const wh = Math.max(1, w * h);
  let cellPx = Math.floor(Math.sqrt(MAX_BEAD_CANVAS_PX / wh));
  cellPx = Math.min(EXPORT_MAX_CELL_PX, cellPx);
  cellPx = Math.min(cellPx, Math.floor(16384 / Math.max(dim, 1)));
  cellPx = Math.max(MIN_CELL_PX, cellPx);
  if (wantPaper) cellPx = Math.max(cellPx, PAPER_CELL_FLOOR);
  while (w * h * cellPx * cellPx > MAX_BEAD_CANVAS_PX && cellPx > MIN_CELL_PX) cellPx -= 1;
  return cellPx;
}

/** @param {[number, number, number]} rgb */
function beadLabelInk(rgb) {
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  return lum > 0.55 ? '#0f0f0f' : '#fafafa';
}

/**
 * @param {(PaletteRow | null)[]} beadGrid
 * @param {number} w
 * @param {number} h
 * @param {Array<{ code: string, row: PaletteRow, n: number }>} materials
 * @param {{ toCanvas: HTMLCanvasElement, cellPxOverride?: number } | null} [exportTarget] 离屏高分辨率导出（不影响预览）
 */
function paintBeadCanvas(beadGrid, w, h, materials, exportTarget) {
  const isExport = Boolean(exportTarget && exportTarget.toCanvas);
  const outCanvas = isExport ? exportTarget.toCanvas : els.previewCanvas;
  const outCtx = isExport ? outCanvas.getContext('2d', { willReadFrequently: true }) : ctx;
  if (!outCtx) return;

  if (!isExport) previewReadabilityNote = '';
  const wantPaper = true;
  const cellPx = isExport
    ? Number.isFinite(exportTarget.cellPxOverride)
      ? Math.max(MIN_CELL_PX, Math.round(Number(exportTarget.cellPxOverride)))
      : solveExportCellPx(w, h, wantPaper)
    : solveCellPx(w, h, wantPaper);
  /** 始终图纸模式：网格、行列号、格内色号（格数过多时省略色号） */
  const drawHeavy = true;
  let drawCodes = drawHeavy && w * h <= MAX_CELLS_INCODES;

  const probe = document.createElement('canvas').getContext('2d');
  const beadW = w * cellPx;
  const beadH = h * cellPx;

  let marginTop = 0;
  let marginBottom = 0;
  let marginLeft = 0;
  let marginRight = 0;
  /** 行号、列号共用同一字号，避免行号偏大；两者都需在「单列宽度」内可读 */
  let axisFontPx = 12;

  if (drawHeavy && probe) {
    const budget = Math.max(10, cellPx - 8);
    const hi = Math.min(20, Math.max(7, cellPx - 2));
    const fitW = fitFontPxToWidth(probe, String(w), hi, 6, budget);
    const fitH = fitFontPxToWidth(probe, String(h), hi, 6, budget);
    axisFontPx = Math.min(fitW, fitH);

    probe.font = `${axisFontPx}px ui-sans-serif, system-ui, sans-serif`;
    const tw = probe.measureText(String(w)).width;
    const th = probe.measureText(String(h)).width;
    const sideW = Math.ceil(Math.max(tw, th) + 16);
    marginLeft = Math.max(26, sideW);
    marginRight = marginLeft;
    marginTop = Math.max(22, Math.ceil(axisFontPx * 1.45));
    marginBottom = marginTop;
  }

  const LIST_CHIP_FONT_PREFIX = 'bold ';
  const listStack = 'ui-sans-serif, system-ui, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif';
  /** 材料区占画布宽度比例；每行固定列数（与格内每 10 格加粗线一致） */
  const MATERIALS_WIDTH_FRAC = 0.9;
  const MATERIALS_COLS = 10;

  const cwPre = Math.round(marginLeft + beadW + marginRight);
  const listW = Math.max(120, Math.round(cwPre * MATERIALS_WIDTH_FRAC));
  const listXPre = Math.round((cwPre - listW) / 2);
  const listPadX = Math.max(10, Math.min(32, Math.round(listW * 0.028)));
  const chipGap = Math.max(4, Math.min(14, Math.round(cwPre * 0.0045)));
  const innerList = Math.max(60, listW - 2 * listPadX);
  let slotW = Math.floor((innerList - (MATERIALS_COLS - 1) * chipGap) / MATERIALS_COLS);
  slotW = Math.max(22, slotW);
  const rowContentW = MATERIALS_COLS * slotW + (MATERIALS_COLS - 1) * chipGap;
  const rowOffset = Math.max(0, Math.floor((innerList - rowContentW) / 2));

  let longestChipLabel = 'M99 (999999)';
  for (const m of materials) {
    const t = `${m.code} (${m.n})`;
    if (t.length > longestChipLabel.length) longestChipLabel = t;
  }

  const chipTextMaxW = Math.max(14, slotW - 6);
  const chipFontHi = isExport
    ? Math.min(44, Math.max(11, Math.floor(cellPx * 0.3)))
    : Math.min(18, Math.max(10, Math.floor(cellPx * 0.22)));
  const chipFontLo = 7;
  let listFontPx = 12;
  if (drawHeavy && probe) {
    listFontPx = Math.max(
      8,
      Math.min(
        chipFontHi,
        fitFontPxToWidth(probe, longestChipLabel, chipFontHi, chipFontLo, chipTextMaxW, LIST_CHIP_FONT_PREFIX),
      ),
    );
  }

  const chipH = Math.ceil(listFontPx * 1.58);
  const matRowGap = Math.max(chipGap, Math.round(listFontPx * 0.48));
  const listGapTop = Math.max(12, Math.round(listFontPx * 0.92));
  const listPadY = Math.max(10, Math.round(listFontPx * 0.68));

  /** @type {Array<Array<{ text: string, w: number, row: PaletteRow }>>} */
  let listRows = [];
  if (materials.length === 0) {
    listRows = [[{ text: '无', w: slotW, row: LEGEND_EMPTY_CHIP_ROW }]];
  } else {
    for (let i = 0; i < materials.length; i += MATERIALS_COLS) {
      const slice = materials.slice(i, i + MATERIALS_COLS);
      listRows.push(
        slice.map((m) => ({
          text: `${m.code} (${m.n})`,
          w: slotW,
          row: m.row,
        })),
      );
    }
  }

  const listBlockH = listPadY * 2 + listRows.length * chipH + Math.max(0, listRows.length - 1) * matRowGap;
  const cw = cwPre;
  const ch = Math.round(marginTop + beadH + marginBottom + listGapTop + listBlockH);

  outCanvas.width = cw;
  outCanvas.height = ch;

  outCtx.imageSmoothingEnabled = false;

  const ML = marginLeft;
  const MT = marginTop;
  const MR = ML + beadW;
  const MB = MT + beadH;

  /** @type {PaletteRow} */
  let row;

  if (drawHeavy) {
    outCtx.fillStyle = '#faf7f3';
    outCtx.fillRect(0, 0, cw, ch);
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      row = beadGrid[y * w + x];
      if (!row) continue;
      outCtx.fillStyle = row.hex;
      outCtx.fillRect(ML + x * cellPx, MT + y * cellPx, cellPx, cellPx);
    }
  }

  let longestCode = 'M15';
  for (let i = 0; i < beadGrid.length; i++) {
    const c = beadGrid[i];
    if (c && c.code.length > longestCode.length) longestCode = c.code;
  }

  const CODE_FONT_PREFIX = 'bold ';
  const codeInner = Math.max(4, cellPx - 5);
  const codePxHigh = Math.min(52, Math.max(8, Math.floor(cellPx * 0.52)));
  const codePxLow = Math.max(5, Math.min(11, Math.floor(cellPx * 0.28)));

  let codeFontPx = 10;
  if (drawCodes) {
    if (!probe) {
      drawCodes = false;
    } else {
      codeFontPx = fitFontPxToWidth(
        probe,
        longestCode,
        codePxHigh,
        codePxLow,
        codeInner,
        CODE_FONT_PREFIX,
      );
      if (codeFontPx < 5) drawCodes = false;
    }
  }

  const notes = [];
  if (wantPaper && cellPx < PAPER_CELL_FLOOR) {
    notes.push(`单格已压缩到 ${cellPx}px`);
  }
  if (drawHeavy && w * h > MAX_CELLS_INCODES) {
    notes.push('格数过多已省略格内心色号（见材料清单）');
  }
  if (drawHeavy) {
    notes.push('预览区可横向/纵向滚动查看原尺寸；下载 PNG 为更高像素单格，便于放大查看');
  }
  if (!isExport) previewReadabilityNote = [...new Set(notes)].join('；');

  const LINE_THIN = 1;
  const LINE_THICK = 2;

  outCtx.strokeStyle = '#000000';
  outCtx.lineJoin = 'miter';

  for (let gx = 0; gx <= w; gx++) {
    if (gx % 10 === 0) continue;
    const vx = ML + gx * cellPx + 0.5;
    outCtx.lineWidth = LINE_THIN;
    outCtx.beginPath();
    outCtx.moveTo(vx, MT);
    outCtx.lineTo(vx, MB);
    outCtx.stroke();
  }
  for (let gx = 0; gx <= w; gx++) {
    if (gx % 10 !== 0) continue;
    const vx = ML + gx * cellPx + 0.5;
    outCtx.lineWidth = LINE_THICK;
    outCtx.beginPath();
    outCtx.moveTo(vx, MT);
    outCtx.lineTo(vx, MB);
    outCtx.stroke();
  }

  for (let gy = 0; gy <= h; gy++) {
    if (gy % 10 === 0) continue;
    const vy = MT + gy * cellPx + 0.5;
    outCtx.lineWidth = LINE_THIN;
    outCtx.beginPath();
    outCtx.moveTo(ML, vy);
    outCtx.lineTo(MR, vy);
    outCtx.stroke();
  }
  for (let gy = 0; gy <= h; gy++) {
    if (gy % 10 !== 0) continue;
    const vy = MT + gy * cellPx + 0.5;
    outCtx.lineWidth = LINE_THICK;
    outCtx.beginPath();
    outCtx.moveTo(ML, vy);
    outCtx.lineTo(MR, vy);
    outCtx.stroke();
  }

  if (drawCodes) {
    const codeStack =
      'ui-sans-serif, system-ui, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif';
    outCtx.font = `${CODE_FONT_PREFIX}${codeFontPx}px ${codeStack}`;
    outCtx.textAlign = 'center';
    outCtx.textBaseline = 'middle';
    outCtx.lineJoin = 'round';

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        row = beadGrid[y * w + x];
        if (!row) continue;
        const cx = ML + x * cellPx + cellPx / 2;
        const cy = MT + y * cellPx + cellPx / 2;
        const ink = beadLabelInk(row.rgb);
        const outlineMain = ink === '#0f0f0f' ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.78)';
        const outlineGlow = ink === '#0f0f0f' ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.38)';
        const lwMain = Math.max(2.5, Math.min(6, codeFontPx * 0.3));
        outCtx.lineWidth = lwMain + 2;
        outCtx.strokeStyle = outlineGlow;
        outCtx.strokeText(row.code, cx, cy);
        outCtx.lineWidth = lwMain;
        outCtx.strokeStyle = outlineMain;
        outCtx.strokeText(row.code, cx, cy);
        outCtx.fillStyle = ink;
        outCtx.fillText(row.code, cx, cy);
      }
    }
  }

  outCtx.fillStyle = '#1a1816';

  outCtx.font = `${axisFontPx}px ui-sans-serif, system-ui, sans-serif`;
  outCtx.textAlign = 'center';
  outCtx.textBaseline = 'bottom';
  const topTextY = MT - 5;
  for (let x = 0; x < w; x++) {
    outCtx.fillText(String(x + 1), ML + x * cellPx + cellPx / 2, topTextY);
  }
  outCtx.textBaseline = 'top';
  const botTextY = MB + 5;
  for (let x = 0; x < w; x++) {
    outCtx.fillText(String(x + 1), ML + x * cellPx + cellPx / 2, botTextY);
  }

  outCtx.textAlign = 'right';
  outCtx.textBaseline = 'middle';
  const leftTextX = ML - 6;
  for (let y = 0; y < h; y++) {
    outCtx.fillText(String(y + 1), leftTextX, MT + y * cellPx + cellPx / 2);
  }
  outCtx.textAlign = 'left';
  const rightTextX = MR + 6;
  for (let y = 0; y < h; y++) {
    outCtx.fillText(String(y + 1), rightTextX, MT + y * cellPx + cellPx / 2);
  }

  const listX = listXPre;
  const listY = MB + marginBottom + listGapTop;

  outCtx.fillStyle = '#f2f5ff';
  outCtx.fillRect(listX, listY, listW, listBlockH);
  outCtx.strokeStyle = '#d4dbf5';
  outCtx.lineWidth = Math.max(1, Math.round(listFontPx / 20));
  outCtx.strokeRect(listX + 0.5, listY + 0.5, listW - 1, listBlockH - 1);

  outCtx.font = `${LIST_CHIP_FONT_PREFIX}${listFontPx}px ${listStack}`;
  outCtx.textAlign = 'center';
  outCtx.textBaseline = 'middle';
  const chipR = chipH / 2;
  const rowStartX = listX + listPadX + rowOffset;
  let rowY = listY + listPadY;
  for (const row of listRows) {
    let x = rowStartX;
    const cy = rowY + chipH / 2;
    for (const chip of row) {
      const ink = beadLabelInk(chip.row.rgb);
      outCtx.fillStyle = chip.row.hex;
      outCtx.strokeStyle = 'rgba(15, 16, 26, 0.16)';
      outCtx.lineWidth = Math.max(1, Math.round(listFontPx / 18));
      outCtx.beginPath();
      outCtx.roundRect(x + 0.5, rowY + 0.5, chip.w - 1, chipH - 1, chipR);
      outCtx.fill();
      outCtx.stroke();
      outCtx.fillStyle = ink;
      outCtx.fillText(chip.text, x + chip.w / 2, cy);
      x += chip.w + chipGap;
    }
    rowY += chipH + matRowGap;
  }
}

/** @returns {PaletteRow} */
function nearestPaletteRow(r, g, b, a) {
  if (a < 128) {
    const rgb = parseHexRgb(els.bg.value) ?? [255, 255, 255];
    r = rgb[0];
    g = rgb[1];
    b = rgb[2];
  }
  const lab = rgbToLab(r, g, b);
  let best = PALETTE_ROWS[0];
  let bestD = Infinity;
  for (const row of PALETTE_ROWS) {
    const d = squaredLabDelta(lab, row.lab);
    if (d < bestD) {
      bestD = d;
      best = row;
    }
  }
  return best;
}

/**
 * @param {CanvasImageSource} img
 * @param {number} w
 * @param {number} h
 * @param {string} fitMode
 */
function drawSourceToWorkCanvas(img, w, h, fitMode) {
  const work = document.createElement('canvas');
  work.width = w;
  work.height = h;
  const wCtx = work.getContext('2d');
  if (!wCtx) return work;

  const bg = parseHexRgb(els.bg.value);
  const [br, bgG, bb] = bg ?? [255, 255, 255];
  wCtx.fillStyle = `rgb(${br},${bgG},${bb})`;
  wCtx.fillRect(0, 0, w, h);

  const { iw, ih } = imagePixelSize(img);

  let dw = w;
  let dh = h;
  let dx = 0;
  let dy = 0;

  if (fitMode === 'contain') {
    const scale = Math.min(w / iw, h / ih);
    dw = Math.max(1, Math.round(iw * scale));
    dh = Math.max(1, Math.round(ih * scale));
    dx = Math.floor((w - dw) / 2);
    dy = Math.floor((h - dh) / 2);
  } else if (fitMode === 'cover') {
    const scale = Math.max(w / iw, h / ih);
    dw = Math.max(1, Math.round(iw * scale));
    dh = Math.max(1, Math.round(ih * scale));
    dx = Math.floor((w - dw) / 2);
    dy = Math.floor((h - dh) / 2);
  }

  wCtx.imageSmoothingEnabled = fitMode !== 'stretch';

  wCtx.drawImage(img, 0, 0, iw, ih, dx, dy, dw, dh);
  return work;
}

/**
 * @param {HTMLCanvasElement} workCanvas
 * @param {number} w
 * @param {number} h
 */
function rasterize(workCanvas, w, h) {
  const wCtx = workCanvas.getContext('2d');
  if (!wCtx || !ctx) return;

  const { data } = wCtx.getImageData(0, 0, w, h);

  /** @type {(PaletteRow | null)[]} */
  const beadGrid = new Array(w * h).fill(null);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const row = nearestPaletteRow(data[i], data[i + 1], data[i + 2], data[i + 3]);
      beadGrid[y * w + x] = row;
    }
  }

  const colorCap = parseInt(els.colorCap.value, 10) || 0;
  if (colorCap >= 2) {
    const proc = window.pindouBeadProcess;
    if (proc?.applySmartColorCountCap) proc.applySmartColorCountCap(beadGrid, colorCap, ROW_BY_CODE);
    else applyColorCountCap(beadGrid, colorCap);
  }
  const materials = getMaterialTallySortedByUsage(beadGrid);

  paintBeadCanvas(beadGrid, w, h, materials);

  lastGrid = beadGrid;
  refreshLegend(w, h, materials);
  els.download.disabled = false;
  els.copyList.disabled = false;
}

/**
 * @param {number} w
 * @param {number} h
 * @param {Array<{ code: string, row: PaletteRow, n: number }>} materials
 */
function refreshLegend(w, h, materials) {
  if (!lastGrid) return;

  const baseStats = `${w}×${h} · ${materials.length} 种颜色 · 按用量排序 · Mard ${MARD_PALETTE.length} 色`;
  els.stats.textContent = previewReadabilityNote ? `${baseStats} · ${previewReadabilityNote}` : baseStats;

  els.legend.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const x of materials) {
    const li = document.createElement('div');
    li.className = 'legend-row';

    const sw = document.createElement('span');
    sw.className = 'legend-swatch';
    sw.style.backgroundColor = x.row.hex;

    const line = document.createElement('span');
    line.className = 'legend-line';
    line.textContent = `${x.code}\t${x.row.hex}\t${x.n}`;

    li.append(sw, line);
    frag.appendChild(li);
  }
  els.legend.appendChild(frag);
}

/** @returns {CanvasImageSource | null} */
function getPipelineImageSource() {
  if (typeof imageEditor !== 'undefined' && imageEditor.isActive?.()) {
    try {
      const prepared = imageEditor.getPreparedCanvas?.();
      if (prepared && prepared.width > 0 && prepared.height > 0) return prepared;
      const src = imageEditor.getSourceCanvas?.();
      if (src && src.width > 0 && src.height > 0) return src;
    } catch (err) {
      console.error('getPipelineImageSource failed', err);
    }
  }
  return sourceImage;
}

/**
 * @param {CanvasImageSource} img
 * @returns {{ iw: number, ih: number }}
 */
function imagePixelSize(img) {
  if (img instanceof HTMLCanvasElement) {
    return { iw: Math.max(1, img.width), ih: Math.max(1, img.height) };
  }
  const el = /** @type {{ naturalWidth?: number, naturalHeight?: number, width?: number, height?: number }} */ (
    img
  );
  return {
    iw: Math.max(1, el.naturalWidth || el.width || 1),
    ih: Math.max(1, el.naturalHeight || el.height || 1),
  };
}

/**
 * @returns {HTMLCanvasElement | null}
 */
function getPipelineCanvas() {
  const src = getPipelineImageSource();
  if (!src) return null;
  if (src instanceof HTMLCanvasElement) return src;
  const { iw, ih } = imagePixelSize(src);
  const c = document.createElement('canvas');
  c.width = iw;
  c.height = ih;
  const cx = c.getContext('2d');
  if (!cx) return null;
  cx.drawImage(src, 0, 0, iw, ih);
  return c;
}

function setAutoStatus(msg) {
  if (els.autoStatus) els.autoStatus.textContent = msg;
}

function applyAnalysisToControls(analysis) {
  setWidthDim(analysis.gridW, { applyAspect: false });
  setHeightDim(analysis.gridH);
  els.colorCap.value = String(analysis.colorCap);
  els.fit.value = analysis.fit;
  els.removeBg.checked = analysis.removeBg;
  els.bgRmSensitive.value = String(analysis.bgSens);
  const sensOut = document.getElementById('bg-rm-sensitive-val');
  if (sensOut) sensOut.textContent = String(analysis.bgSens);
  syncRemoveBgSensitivityRow();
}

/**
 * @param {{ skipEnhance?: boolean }} [opts]
 */
async function runAutoBeadPipeline(opts) {
  if (!sourceImage || autoRunning) return;
  const proc = window.pindouBeadProcess;
  if (!proc?.analyzeImage) {
    runPipeline();
    return;
  }

  autoRunning = true;
  if (els.autoBeads) els.autoBeads.disabled = true;
  setAutoStatus('正在分析图片…');

  try {
    const analysisCanvas =
      typeof imageEditor !== 'undefined' && imageEditor.getSourceCanvas?.()
        ? imageEditor.getSourceCanvas()
        : getPipelineCanvas();
    const analysisImg = analysisCanvas || sourceImage;
    const analysis = proc.analyzeImage(analysisImg);
    applyAnalysisToControls(analysis);

    if (!opts?.skipEnhance && typeof imageEditor !== 'undefined' && imageEditor.isActive?.()) {
      setAutoStatus('正在优化画面（简化色块）…');
      imageEditor.simplifySource?.({
        levels: analysis.simplifyLevels,
        blurPasses: analysis.simplifyBlur,
        skipUndo: true,
      });
      if (analysis.removeBg) {
        setAutoStatus('正在去除背景…');
        imageEditor.applyCornerBgToMask?.(analysis.bgSens, { skipUndo: true });
        els.removeBg.checked = true;
        syncRemoveBgSensitivityRow();
      }
    }

    setAutoStatus(`已应用：${analysis.summary}`);
    runPipeline();
  } catch (err) {
    console.error('runAutoBeadPipeline failed', err);
    setAutoStatus('自动处理失败，已尝试直接生成');
    runPipeline();
  } finally {
    autoRunning = false;
    if (els.autoBeads) els.autoBeads.disabled = false;
  }
}

function showQuickActions(show) {
  if (els.quickActions) els.quickActions.hidden = !show;
}

function setCustomizeOpen(open) {
  customizeOpen = open;
  if (els.customizePanel) els.customizePanel.hidden = !open;
  const editPanel = document.getElementById('edit-panel');
  if (editPanel) editPanel.hidden = !open;
  if (els.toggleCustomize) {
    els.toggleCustomize.textContent = open ? '收起个性化设置' : '个性化更改';
    els.toggleCustomize.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
}

function runPipeline() {
  if (!sourceImage) return;
  try {
    const w = clampGridDim(els.width.value);
    const h = clampGridDim(els.height.value);
    const fit = els.fit.value;
    const proc = window.pindouBeadProcess;
    const pipelineCanvas = getPipelineCanvas();
    const bg = parseHexRgb(els.bg.value);

    if (proc?.rasterizeAreaAverage && pipelineCanvas) {
      const beadGrid = proc.rasterizeAreaAverage(
        pipelineCanvas,
        w,
        h,
        fit,
        bg,
        (r, g, b, a) => nearestPaletteRow(r, g, b, a),
      );
      const colorCap = parseInt(els.colorCap.value, 10) || 0;
      if (colorCap >= 2) {
        if (proc.applySmartColorCountCap) proc.applySmartColorCountCap(beadGrid, colorCap, ROW_BY_CODE);
        else applyColorCountCap(beadGrid, colorCap);
      }
      const materials = getMaterialTallySortedByUsage(beadGrid);
      paintBeadCanvas(beadGrid, w, h, materials);
      lastGrid = beadGrid;
      refreshLegend(w, h, materials);
      els.download.disabled = false;
      els.copyList.disabled = false;
      return;
    }

    const src = getPipelineImageSource();
    if (!src) return;
    const work = drawSourceToWorkCanvas(src, w, h, fit);
    if (
      els.removeBg.checked &&
      !(typeof imageEditor !== 'undefined' && imageEditor.isActive()) &&
      typeof removeBorderConnectedBackground === 'function'
    ) {
      const wCx = work.getContext('2d');
      if (wCx) {
        const thr = Number(els.bgRmSensitive.value);
        removeBorderConnectedBackground(wCx, Number.isFinite(thr) ? thr : 520);
      }
    }
    rasterize(work, w, h);
  } catch (err) {
    console.error('runPipeline failed', err);
    if (els.stats) els.stats.textContent = '生成预览失败，请换一张图片或刷新页面重试';
  }
}

function syncAutoRemoveBgToMask() {
  if (!els.removeBg.checked) return;
  if (typeof imageEditor === 'undefined' || !imageEditor.isActive?.()) return;
  if (!imageEditor.applyCornerBgToMask) return;
  const thr = Number(els.bgRmSensitive.value);
  imageEditor.applyCornerBgToMask(Number.isFinite(thr) ? thr : 520);
}

function syncRemoveBgSensitivityRow() {
  const on = els.removeBg.checked;
  els.bgRmSensitive.disabled = !on;
  if (els.bgRmSensRow) els.bgRmSensRow.classList.toggle('is-off-opaque', !on);
}

/**
 * @param {File | undefined | null} file
 */
function isImageFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith('image/')) return true;
  return /\.(jpe?g|png|gif|webp|heic|heif|bmp|avif)$/i.test(file.name || '');
}

/**
 * @param {File} file
 */
function loadImageFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    sourceImage = img;

    const afterReady = () => {
      showQuickActions(true);
      setCustomizeOpen(false);
      els.regenerate.disabled = false;
      void runAutoBeadPipeline();
    };

    const fallbackReady = () => {
      naturalAspect = img.naturalWidth / Math.max(1, img.naturalHeight);
      showQuickActions(true);
      setCustomizeOpen(false);
      els.regenerate.disabled = false;
      void runAutoBeadPipeline();
    };

    if (typeof imageEditor !== 'undefined' && imageEditor.loadFromImage) {
      try {
        imageEditor.loadFromImage(img, () => {
          try {
            naturalAspect = imageEditor.getAspect();
          } catch {
            naturalAspect = img.naturalWidth / Math.max(1, img.naturalHeight);
          }
          if (!autoRunning) runPipeline();
        });
        try {
          naturalAspect = imageEditor.getAspect();
        } catch {
          naturalAspect = img.naturalWidth / Math.max(1, img.naturalHeight);
        }
        afterReady();
      } catch (err) {
        console.error('imageEditor.loadFromImage failed', err);
        fallbackReady();
      }
    } else {
      fallbackReady();
    }
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    if (els.stats) els.stats.textContent = '图片加载失败，请换一张试试';
  };
  img.src = url;
}

function wireUi() {
  els.drop.addEventListener('click', () => els.file.click());
  els.drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      els.file.click();
    }
  });

  els.file.addEventListener('change', (e) => {
    const input = /** @type {HTMLInputElement} */ (e.target);
    const file = input.files?.[0];
    if (isImageFile(file)) loadImageFile(file);
    input.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    els.drop.addEventListener(ev, (e) => {
      e.preventDefault();
      els.drop.classList.add('drag');
    }),
  );

  els.drop.addEventListener('dragleave', () => els.drop.classList.remove('drag'));
  els.drop.addEventListener('drop', (e) => {
    e.preventDefault();
    els.drop.classList.remove('drag');
    const file = e.dataTransfer?.files?.[0];
    if (isImageFile(file)) loadImageFile(file);
  });

  els.width.addEventListener('input', () => {
    setWidthDim(els.width.value, { applyAspect: true });
    if (sourceImage) runPipeline();
  });
  els.widthNum.addEventListener('change', () => {
    setWidthDim(els.widthNum.value, { applyAspect: true });
    if (sourceImage) runPipeline();
  });

  els.height.addEventListener('input', () => {
    setHeightDim(els.height.value);
    if (sourceImage) runPipeline();
  });
  els.heightNum.addEventListener('change', () => {
    setHeightDim(els.heightNum.value);
    if (sourceImage) runPipeline();
  });

  els.fit.addEventListener('change', () => {
    if (sourceImage) runPipeline();
  });
  els.colorCap.addEventListener('change', () => {
    if (sourceImage) runPipeline();
  });
  els.bg.addEventListener('input', () => {
    if (sourceImage) runPipeline();
  });
  els.removeBg.addEventListener('change', () => {
    syncRemoveBgSensitivityRow();
    if (sourceImage && els.removeBg.checked) syncAutoRemoveBgToMask();
    if (sourceImage) runPipeline();
  });
  els.bgRmSensitive.addEventListener('input', () => {
    if (sourceImage && els.removeBg.checked) syncAutoRemoveBgToMask();
    if (sourceImage) runPipeline();
  });
  syncRemoveBgSensitivityRow();

  els.lockAspect.addEventListener('change', () => {
    if (!sourceImage || !els.lockAspect.checked) return;
    setWidthDim(els.width.value, { applyAspect: true });
    runPipeline();
  });

  els.regenerate.addEventListener('click', runPipeline);

  els.autoBeads?.addEventListener('click', () => {
    void runAutoBeadPipeline();
  });

  els.toggleCustomize?.addEventListener('click', () => {
    setCustomizeOpen(!customizeOpen);
  });

  els.download.addEventListener('click', () => {
    if (!lastGrid) return;
    const w = clampGridDim(els.width.value);
    const h = clampGridDim(els.height.value);
    const materials = getMaterialTallySortedByUsage(lastGrid);
    const exportCell = solveExportCellPx(w, h, true);
    const exportCanvas = document.createElement('canvas');
    paintBeadCanvas(lastGrid, w, h, materials, { toCanvas: exportCanvas, cellPxOverride: exportCell });

    const link = document.createElement('a');
    link.download = `pindou-mard-${els.width.value}x${els.height.value}.png`;
    link.href = exportCanvas.toDataURL('image/png');
    link.click();
  });

  els.copyList.addEventListener('click', async () => {
    if (!lastGrid) return;
    const materials = getMaterialTallySortedByUsage(lastGrid);
    const lines = materials.map((x) => `${x.code}\t${x.row.hex}\t${x.n}`);

    try {
      await navigator.clipboard.writeText(`${['色号', 'HEX', '粒数'].join('\t')}\n${lines.join('\n')}`);
      els.copyList.textContent = '已复制';
    } catch {
      els.copyList.textContent = '复制失败（需 HTTPS）';
    }
    window.setTimeout(() => {
      els.copyList.textContent = '复制用料表';
    }, 1400);
  });

  setWidthDim(els.width.value, { applyAspect: false });
  setHeightDim(els.height.value);
}

wireUi();
