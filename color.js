/** sRGB 0–255 → CIELAB（D65）用于感知上更接近的色号匹配 */

function sRgbChannelToLin(c) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function rgbToLab(r, g, b) {
  const rl = sRgbChannelToLin(r);
  const gl = sRgbChannelToLin(g);
  const bl = sRgbChannelToLin(b);

  let X = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375;
  let Y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175;
  let Z = rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041;

  X /= 0.95047;
  Z /= 1.08883;

  const fx = pivot(X);
  const fy = pivot(Y);
  const fz = pivot(Z);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function pivot(t) {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

function squaredLabDelta(labA, labB) {
  const dL = labA[0] - labB[0];
  const da = labA[1] - labB[1];
  const db = labA[2] - labB[2];
  return dL * dL + da * da + db * db;
}

function parseHexRgb(hex) {
  const raw = hex.replace(/^#/, '');
  if (raw.length !== 6 || !/^[0-9a-fA-F]+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
