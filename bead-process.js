/**
 * 拼豆图生成增强：块平均取色、简化预处理、色相感知色数合并、上传图分析。
 */
(function () {
  const SS = 4;

  function clampGrid(n, min, max) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return min;
    return Math.max(min, Math.min(max, v));
  }

  function rgbToHueFamily(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (d < 18 && max < 72) return 'black';
    if (d < 22 && max > 200) return 'white';
    if (d < 28) return 'gray';
    let h = 0;
    if (d > 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    if (h < 18 || h >= 342) return 'red';
    if (h < 48) return 'orange';
    if (h < 78) return 'yellow';
    if (h < 150) return 'green';
    if (h < 195) return 'cyan';
    if (h < 255) return 'blue';
    if (h < 300) return 'purple';
    return 'magenta';
  }

  function hueMergePenalty(fa, fb) {
    if (fa === fb) return 1;
    const warm = new Set(['red', 'orange', 'yellow', 'magenta']);
    const cool = new Set(['green', 'cyan', 'blue', 'purple']);
    const bad = [
      ['green', 'orange'],
      ['green', 'red'],
      ['green', 'yellow'],
      ['green', 'gray'],
      ['red', 'gray'],
      ['red', 'blue'],
      ['red', 'purple'],
      ['orange', 'blue'],
      ['orange', 'purple'],
      ['yellow', 'purple'],
      ['yellow', 'blue'],
    ];
    for (const [a, b] of bad) {
      if ((fa === a && fb === b) || (fa === b && fb === a)) return 4.5;
    }
    if ((warm.has(fa) && cool.has(fb)) || (cool.has(fa) && warm.has(fb))) return 2.2;
    if ((fa === 'gray' && (warm.has(fb) || fb === 'green')) || (fb === 'gray' && (warm.has(fa) || fa === 'green')))
      return 3.2;
    return 1.35;
  }

  function smartMergeDistance(rowA, rowB) {
    const labD = squaredLabDelta(rowA.lab, rowB.lab);
    const fa = rgbToHueFamily(rowA.rgb[0], rowA.rgb[1], rowA.rgb[2]);
    const fb = rgbToHueFamily(rowB.rgb[0], rowB.rgb[1], rowB.rgb[2]);
    return labD * hueMergePenalty(fa, fb);
  }

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

  function posterizeRgb(px, step) {
    for (let i = 0; i < px.length; i += 4) {
      px[i] = Math.round(px[i] / step) * step;
      px[i + 1] = Math.round(px[i + 1] / step) * step;
      px[i + 2] = Math.round(px[i + 2] / step) * step;
    }
  }

  /**
   * 食物/静物简化：轻模糊 + 色阶量化（无描边）。
   * @param {HTMLCanvasElement} source
   * @param {{ levels?: number, blurPasses?: number }} [opts]
   */
  function simplifyCanvas(source, opts) {
    const levels = opts?.levels ?? 10;
    const blurPasses = opts?.blurPasses ?? 1;
    const maxSide = 900;
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
    const data = wctx.getImageData(0, 0, w, h);
    for (let p = 0; p < blurPasses; p++) boxBlurRgb(data.data, w, h);
    const step = Math.max(6, Math.round(255 / Math.max(4, levels)));
    posterizeRgb(data.data, step);
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
   * @param {HTMLCanvasElement} canvas
   * @param {number} w grid cols
   * @param {number} h grid rows
   * @param {string} fitMode
   * @param {[number, number, number] | null} bgRgb
   */
  function buildSampleCanvas(canvas, w, h, fitMode, bgRgb) {
    const tw = w * SS;
    const th = h * SS;
    const temp = document.createElement('canvas');
    temp.width = tw;
    temp.height = th;
    const tctx = temp.getContext('2d', { willReadFrequently: true });
    if (!tctx) return null;

    const [br, bgG, bb] = bgRgb ?? [255, 255, 255];
    tctx.fillStyle = `rgb(${br},${bgG},${bb})`;
    tctx.fillRect(0, 0, tw, th);

    const iw = canvas.width;
    const ih = canvas.height;
    let dw = tw;
    let dh = th;
    let dx = 0;
    let dy = 0;
    if (fitMode === 'contain') {
      const scale = Math.min(tw / iw, th / ih);
      dw = Math.max(1, Math.round(iw * scale));
      dh = Math.max(1, Math.round(ih * scale));
      dx = Math.floor((tw - dw) / 2);
      dy = Math.floor((th - dh) / 2);
    } else if (fitMode === 'cover') {
      const scale = Math.max(tw / iw, th / ih);
      dw = Math.max(1, Math.round(iw * scale));
      dh = Math.max(1, Math.round(ih * scale));
      dx = Math.floor((tw - dw) / 2);
      dy = Math.floor((th - dh) / 2);
    }
    tctx.imageSmoothingEnabled = fitMode !== 'stretch';
    tctx.drawImage(canvas, 0, 0, iw, ih, dx, dy, dw, dh);
    return temp;
  }

  /**
   * 块平均取色栅格化。
   * @param {HTMLCanvasElement} sourceCanvas 已含蒙版透明
   * @param {number} w
   * @param {number} h
   * @param {string} fitMode
   * @param {[number, number, number] | null} bgRgb
   * @param {(r: number, g: number, b: number, a: number) => any} mapColor
   */
  function rasterizeAreaAverage(sourceCanvas, w, h, fitMode, bgRgb, mapColor) {
    const temp = buildSampleCanvas(sourceCanvas, w, h, fitMode, bgRgb);
    if (!temp) return [];
    const tctx = temp.getContext('2d', { willReadFrequently: true });
    if (!tctx) return [];
    const { data } = tctx.getImageData(0, 0, temp.width, temp.height);
    const tw = temp.width;
    const th = temp.height;
    const grid = new Array(w * h);

    for (let gy = 0; gy < h; gy++) {
      for (let gx = 0; gx < w; gx++) {
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let sa = 0;
        let n = 0;
        const x0 = gx * SS;
        const y0 = gy * SS;
        for (let py = 0; py < SS; py++) {
          for (let px = 0; px < SS; px++) {
            const x = x0 + px;
            const y = y0 + py;
            if (x >= tw || y >= th) continue;
            const i = (y * tw + x) * 4;
            const a = data[i + 3] / 255;
            if (a < 0.04) continue;
            sr += data[i] * a;
            sg += data[i + 1] * a;
            sb += data[i + 2] * a;
            sa += a;
            n++;
          }
        }
        let r;
        let g;
        let b;
        let a;
        if (n === 0 || sa < 0.08) {
          const bg = bgRgb ?? [255, 255, 255];
          r = bg[0];
          g = bg[1];
          b = bg[2];
          a = 0;
        } else {
          r = sr / sa;
          g = sg / sa;
          b = sb / sa;
          a = (sa / n) * 255;
        }
        grid[gy * w + gx] = mapColor(r, g, b, a);
      }
    }
    return grid;
  }

  /**
   * 色相感知色数合并。
   * @param {any[]} beadGrid
   * @param {number} maxColors
   * @param {Map<string, any>} rowByCode
   */
  function applySmartColorCountCap(beadGrid, maxColors, rowByCode) {
    if (!maxColors || maxColors < 2 || maxColors > 221) return;

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
      const rareRow = rowByCode.get(rareCode);
      if (!rareRow) break;

      let bestCode = '';
      let bestD = Infinity;
      for (const code of count.keys()) {
        if (code === rareCode) continue;
        const other = rowByCode.get(code);
        if (!other) continue;
        const d = smartMergeDistance(rareRow, other);
        if (d < bestD || (d === bestD && code.localeCompare(bestCode) < 0)) {
          bestD = d;
          bestCode = code;
        }
      }
      const replaceRow = rowByCode.get(bestCode);
      if (!replaceRow) break;

      for (let i = 0; i < beadGrid.length; i++) {
        if (beadGrid[i]?.code === rareCode) beadGrid[i] = replaceRow;
      }
      count.delete(rareCode);
      count.set(bestCode, (count.get(bestCode) || 0) + rareN);
    }
  }

  function sampleCornerRgb(data, w, h, x0, y0, pad) {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = y0; y < y0 + pad && y < h; y++) {
      for (let x = x0; x < x0 + pad && x < w; x++) {
        const i = (y * w + x) * 4;
        if (data[i + 3] < 128) continue;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        n++;
      }
    }
    if (!n) return null;
    return [r / n, g / n, b / n];
  }

  function colorDist(a, b) {
    const dr = a[0] - b[0];
    const dg = a[1] - b[1];
    const db = a[2] - b[2];
    return dr * dr + dg * dg + db * db;
  }

  /**
   * 分析上传图，给出推荐参数。
   * @param {HTMLCanvasElement | HTMLImageElement} img
   */
  function analyzeImage(img) {
    const iw = img instanceof HTMLCanvasElement ? img.width : img.naturalWidth || img.width || 1;
    const ih = img instanceof HTMLCanvasElement ? img.height : img.naturalHeight || img.height || 1;
    const aspect = iw / Math.max(1, ih);
    const pixels = iw * ih;

    let longTarget = 56;
    if (pixels > 2_500_000) longTarget = 72;
    else if (pixels > 900_000) longTarget = 64;
    else if (pixels < 350_000) longTarget = 48;

    let gridW;
    let gridH;
    if (aspect >= 1) {
      gridW = longTarget;
      gridH = clampGrid(longTarget / aspect, 12, 256);
    } else {
      gridH = longTarget;
      gridW = clampGrid(longTarget * aspect, 12, 256);
    }

    const sample = document.createElement('canvas');
    const sw = 160;
    const sh = Math.max(1, Math.round(sw / aspect));
    sample.width = sw;
    sample.height = sh;
    const sctx = sample.getContext('2d', { willReadFrequently: true });
    let colorCap = 24;
    let removeBg = false;
    let bgSens = 520;
    let fit = 'contain';
    let simplifyLevels = 10;
    let simplifyBlur = 1;
    let portraitLike = false;

    if (sctx) {
      sctx.drawImage(img, 0, 0, sw, sh);
      const { data } = sctx.getImageData(0, 0, sw, sh);
      const pad = Math.max(3, Math.floor(Math.min(sw, sh) * 0.12));
      const corners = [
        sampleCornerRgb(data, sw, sh, 0, 0, pad),
        sampleCornerRgb(data, sw, sh, sw - pad, 0, pad),
        sampleCornerRgb(data, sw, sh, 0, sh - pad, pad),
        sampleCornerRgb(data, sw, sh, sw - pad, sh - pad, pad),
      ].filter(Boolean);

      const cx = Math.floor(sw * 0.4);
      const cy = Math.floor(sh * 0.35);
      const cw = Math.floor(sw * 0.2);
      const ch = Math.floor(sh * 0.3);
      let cr = 0;
      let cg = 0;
      let cb = 0;
      let cn = 0;
      for (let y = cy; y < cy + ch; y++) {
        for (let x = cx; x < cx + cw; x++) {
          const i = (y * sw + x) * 4;
          cr += data[i];
          cg += data[i + 1];
          cb += data[i + 2];
          cn++;
        }
      }
      const center = cn ? [cr / cn, cg / cn, cb / cn] : [128, 128, 128];

      if (corners.length >= 2) {
        let cornerSpread = 0;
        for (let i = 0; i < corners.length; i++) {
          for (let j = i + 1; j < corners.length; j++) {
            cornerSpread += colorDist(corners[i], corners[j]);
          }
        }
        cornerSpread /= Math.max(1, (corners.length * (corners.length - 1)) / 2);
        let cornerCenterDist = 0;
        for (const c of corners) cornerCenterDist += colorDist(c, center);
        cornerCenterDist /= corners.length;
        if (cornerSpread < 2800 && cornerCenterDist > 2200) {
          removeBg = true;
          bgSens = cornerCenterDist > 6000 ? 680 : cornerCenterDist > 4000 ? 560 : 480;
        }
      }

      const buckets = new Set();
      let warm = 0;
      let green = 0;
      let samples = 0;
      for (let i = 0; i < data.length; i += 16) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (data[i + 3] < 128) continue;
        const fam = rgbToHueFamily(r, g, b);
        buckets.add(fam);
        if (fam === 'red' || fam === 'orange' || fam === 'yellow') warm++;
        if (fam === 'green') green++;
        samples++;
        const qr = (r >> 4) << 4;
        const qg = (g >> 4) << 4;
        const qb = (b >> 4) << 4;
        buckets.add(`q${qr}-${qg}-${qb}`);
      }
      const diversity = buckets.size;
      if (diversity > 42) colorCap = 32;
      else if (diversity > 28) colorCap = 24;
      else if (diversity > 16) colorCap = 16;
      else colorCap = 12;

      if (samples > 0) {
        const warmRatio = warm / samples;
        const greenRatio = green / samples;
        if (warmRatio > 0.22 && greenRatio > 0.06) {
          colorCap = Math.max(colorCap, 28);
          simplifyLevels = 12;
        }
        if (warmRatio > 0.35) simplifyLevels = 11;
      }

      const skinLike =
        center[0] > 95 && center[0] < 245 && center[1] > 60 && center[2] > 40 && center[0] > center[1] + 8;
      const faceFill = (center[0] + center[1] + center[2]) / 3;
      portraitLike = skinLike && faceFill > 90 && faceFill < 220 && aspect > 0.55 && aspect < 1.35;
      if (portraitLike) {
        colorCap = Math.max(20, Math.min(28, colorCap));
        simplifyLevels = 9;
        simplifyBlur = 1;
        fit = 'contain';
      } else if (removeBg) {
        fit = 'contain';
      } else {
        fit = 'cover';
      }
    }

    const notes = [];
    notes.push(`${gridW}×${gridH} 格`);
    notes.push(`约 ${colorCap} 色`);
    if (removeBg) notes.push('四角去背');
    notes.push(portraitLike ? '人像优化' : '静物/食物简化');
    if (fit === 'cover') notes.push('铺满裁切');

    return {
      gridW,
      gridH,
      colorCap,
      removeBg,
      bgSens,
      fit,
      simplifyLevels,
      simplifyBlur,
      portraitLike,
      summary: notes.join(' · '),
    };
  }

  window.pindouBeadProcess = {
    analyzeImage,
    simplifyCanvas,
    rasterizeAreaAverage,
    applySmartColorCountCap,
    smartMergeDistance,
  };
})();
