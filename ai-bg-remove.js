/**
 * 浏览器内 AI 抠图（@imgly/background-removal，模型由 IMG.LY CDN 按需加载）。
 */
const PKG_VERSION = '1.6.0';

/** @type {Promise<{ default: Function }> | null} */
let loaderPromise = null;

/**
 * @param {string | HTMLCanvasElement | Blob | ImageData} imageSource
 * @param {(key: string, current: number, total: number) => void} [onProgress]
 * @returns {Promise<Blob>}
 */
export async function aiRemoveBackground(imageSource, onProgress) {
  if (!loaderPromise) {
    loaderPromise = import(
      `https://cdn.jsdelivr.net/npm/@imgly/background-removal@${PKG_VERSION}/+esm`
    );
  }
  const mod = await loaderPromise;
  const removeBackground = mod.default;

  /** @type {Record<string, unknown>} */
  const config = {
    publicPath: `https://staticimgly.com/@imgly/background-removal-data/${PKG_VERSION}/dist/`,
    model: 'isnet_quint8',
    output: {
      format: 'image/png',
      type: 'foreground',
    },
    progress: onProgress,
  };

  return removeBackground(imageSource, config);
}
