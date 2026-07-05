/**
 * 浏览器内 AI 抠图（@imgly/background-removal）。
 * 依赖 COOP/COEP（见 coi-serviceworker.min.js）以启用 SharedArrayBuffer。
 */
const PKG_VERSION = '1.6.0';
const ORT_VERSION = '1.21.0';

/** @type {Promise<Record<string, unknown>> | null} */
let loaderPromise = null;

/**
 * @returns {Promise<Function>}
 */
async function loadRemoveBackground() {
  if (!loaderPromise) {
    loaderPromise = import(
      `https://cdn.jsdelivr.net/npm/@imgly/background-removal@${PKG_VERSION}/dist/index.mjs`
    );
  }
  const mod = await loaderPromise;
  const removeBackground = mod.removeBackground || mod.default;
  if (typeof removeBackground !== 'function') {
    throw new Error('AI 模块加载异常');
  }
  return removeBackground;
}

/**
 * @param {string | HTMLCanvasElement | Blob | ImageData} imageSource
 * @param {(key: string, current: number, total: number) => void} [onProgress]
 * @returns {Promise<Blob>}
 */
export async function aiRemoveBackground(imageSource, onProgress) {
  if (!window.crossOriginIsolated) {
    throw new Error(
      '浏览器未启用跨域隔离（SharedArrayBuffer 不可用）。请刷新页面等待自动重载，或换用非无痕模式。',
    );
  }

  const removeBackground = await loadRemoveBackground();

  /** @type {Record<string, unknown>} */
  const config = {
    publicPath: `https://staticimgly.com/@imgly/background-removal-data/${PKG_VERSION}/dist/`,
    model: 'isnet_quint8',
    device: 'cpu',
    debug: false,
    output: {
      format: 'image/png',
      type: 'foreground',
    },
    progress: onProgress,
    fetchArgs: {
      mode: 'cors',
      credentials: 'omit',
    },
  };

  const src =
    imageSource instanceof HTMLCanvasElement
      ? imageSource
      : imageSource;

  return removeBackground(src, config);
}

export { PKG_VERSION, ORT_VERSION };
