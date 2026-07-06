/**
 * AI 卡通化（White-box CartoonGAN + TensorFlow.js，模型约 1.5MB）。
 */
const TF_VER = '4.22.0';
const MODEL_URL =
  'https://cdn.jsdelivr.net/gh/pratapvardhan/cartoonizer-with-tfjs@master/models/CartoonGAN/web-uint8/model.json';
const INFER_SIZE = 256;

/** @type {Promise<typeof import('@tensorflow/tfjs')> | null} */
let tfPromise = null;
/** @type {Promise<import('@tensorflow/tfjs').GraphModel> | null} */
let modelPromise = null;

/**
 * @returns {Promise<typeof import('@tensorflow/tfjs')>}
 */
async function loadTf() {
  if (!tfPromise) {
    tfPromise = (async () => {
      const tf = await import(`https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@${TF_VER}/+esm`);
      await import(`https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@${TF_VER}/+esm`);
      await tf.setBackend('wasm');
      await tf.ready();
      return tf;
    })();
  }
  return tfPromise;
}

/**
 * @param {(msg: string) => void} [onProgress]
 * @returns {Promise<import('@tensorflow/tfjs').GraphModel>}
 */
async function loadModel(onProgress) {
  if (!modelPromise) {
    modelPromise = (async () => {
      const tf = await loadTf();
      onProgress?.('下载 AI 卡通模型（约 1.5MB）…');
      const model = await tf.loadGraphModel(MODEL_URL);
      const warm = tf.zeros([1, INFER_SIZE, INFER_SIZE, 3]);
      const warmOut = model.predict({ 'input_photo:0': warm });
      if (Array.isArray(warmOut)) warmOut.forEach((t) => t.dispose());
      else warmOut.dispose();
      warm.dispose();
      return model;
    })();
  }
  return modelPromise;
}

/**
 * @param {import('@tensorflow/tfjs').Tensor3D | import('@tensorflow/tfjs').Tensor4D} img
 * @param {typeof import('@tensorflow/tfjs')} tf
 * @returns {import('@tensorflow/tfjs').Tensor4D}
 */
function normalizeInput(img, tf) {
  const shape = img.shape;
  const height = shape[0];
  const width = shape[1];
  const pad =
    width > height
      ? [
          [0, 0],
          [width - height, 0],
          [0, 0],
        ]
      : [
          [height - width, 0],
          [0, 0],
          [0, 0],
        ];
  let t = /** @type {import('@tensorflow/tfjs').Tensor3D} */ (img.pad(pad));
  t = tf.image.resizeBilinear(t, [INFER_SIZE, INFER_SIZE]);
  t = t.reshape([1, INFER_SIZE, INFER_SIZE, 3]);
  const offset = tf.scalar(127.5);
  return t.sub(offset).div(offset);
}

/**
 * @param {HTMLCanvasElement} sourceCanvas
 * @param {(msg: string) => void} [onProgress]
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function aiCartoonize(sourceCanvas, onProgress) {
  const tf = await loadTf();
  const model = await loadModel(onProgress);
  onProgress?.('AI 卡通化处理中…');

  const origW = sourceCanvas.width;
  const origH = sourceCanvas.height;

  let img = tf.browser.fromPixels(sourceCanvas);
  const norm = normalizeInput(img, tf);
  img.dispose();

  const raw = model.predict({ 'input_photo:0': norm });
  norm.dispose();

  let tensor = Array.isArray(raw) ? raw[0] : raw;
  if (Array.isArray(raw)) {
    for (let i = 1; i < raw.length; i++) raw[i].dispose();
  }

  tensor = tensor.squeeze();
  let result = tensor.sub(tf.scalar(-1)).div(tf.scalar(2)).clipByValue(0, 1);
  tensor.dispose();

  const pad = Math.round((Math.abs(origW - origH) / Math.max(origW, origH)) * INFER_SIZE);
  const slice = origW > origH ? [0, pad, 0] : [pad, 0, 0];
  result = result.slice(slice);

  const temp = document.createElement('canvas');
  temp.width = result.shape[1];
  temp.height = result.shape[0];
  await tf.browser.toPixels(result, temp);
  result.dispose();

  const result = document.createElement('canvas');
  result.width = origW;
  result.height = origH;
  const ctx = result.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(temp, 0, 0, origW, origH);
  return result;
}
