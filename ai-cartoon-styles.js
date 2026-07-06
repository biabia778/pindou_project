/**
 * 多风格 AI 卡通化（纯前端，浏览器本地推理）。
 *
 * 支持的风格：
 *   - cartoongan   : White-box CartoonGAN（TF.js，约 1.5MB，插画风）
 *   - hayao        : AnimeGAN 宫崎骏风（TF.js graph model，约 16MB，需自定义 MirrorPad 算子）
 *   - faceportrait : AnimeGANv2 FacePortraitV2（ONNX Runtime Web，约 8MB，固定 512×512，人像最佳）
 *
 * 统一入口：aiCartoonizeStyle(sourceCanvas, style, onProgress) -> HTMLCanvasElement
 */

const TF_VER = '4.22.0';
const ORT_VER = '1.17.0';

/** @typedef {'cartoongan' | 'hayao' | 'faceportrait'} CartoonStyle */

const CARTOONGAN_URL =
  'https://cdn.jsdelivr.net/gh/pratapvardhan/cartoonizer-with-tfjs@master/models/CartoonGAN/web-uint8/model.json';
const CARTOONGAN_SIZE = 256;

const HAYAO_URL =
  'https://cdn.jsdelivr.net/gh/TonyLianLong/AnimeGAN.js@master/public/model_full/model.json';
// 长边缩放尺寸（越大越清晰但越慢）
const HAYAO_LONG_SIDE = 512;

const FACE_URL =
  'https://cdn.jsdelivr.net/gh/josephrocca/anime-gan-v2-web@main/anime-gan-v2.onnx';
const FACE_SIZE = 512;

function vendorBase() {
  if (typeof window !== 'undefined' && window.PINDOU_VENDOR_BASE) {
    return window.PINDOU_VENDOR_BASE;
  }
  return './vendor/';
}

const FILE_PROTOCOL = typeof location !== 'undefined' && location.protocol === 'file:';
const FACE_PORTRAIT_FILE_MSG =
  '「动漫人像」在 Safari 的 file:// 下无法加载 ONNX 模块。请在项目目录运行 python3 -m http.server 8765，再打开 http://127.0.0.1:8765';

const CARTOON_STYLE_META = {
  cartoongan: { label: '插画卡通（CartoonGAN）', size: '约 1.5MB', runtime: 'tfjs' },
  hayao: { label: '宫崎骏风（AnimeGAN Hayao）', size: '约 16MB', runtime: 'tfjs' },
  faceportrait: { label: '动漫人像（FacePortrait）', size: '约 8MB', runtime: 'onnx' },
};

/* ------------------------------------------------------------------ */
/* TensorFlow.js 懒加载                                                */
/* ------------------------------------------------------------------ */

/** @type {Promise<any> | null} */
let tfPromise = null;

async function loadTf() {
  if (!tfPromise) {
    tfPromise = (async () => {
      const tf = window.tf;
      if (!tf) throw new Error('TensorFlow.js 未加载，请刷新页面');
      if (!tf.getBackend()) {
        // file:// 下 WASM worker 易被 Safari 拦截，改用 CPU 后端更稳。
        const backend = location.protocol === 'file:' ? 'cpu' : 'wasm';
        if (backend === 'wasm' && tf.wasm?.setWasmPaths) {
          tf.wasm.setWasmPaths(vendorBase());
        }
        await tf.setBackend(backend);
      }
      await tf.ready();
      return tf;
    })();
  }
  return tfPromise;
}

/* ------------------------------------------------------------------ */
/* 风格 1：CartoonGAN（插画风）                                         */
/* ------------------------------------------------------------------ */

/** @type {Promise<any> | null} */
let cartoonganModelPromise = null;

async function loadCartoonGan(tf, onProgress) {
  if (!cartoonganModelPromise) {
    cartoonganModelPromise = (async () => {
      onProgress?.('下载插画卡通模型（约 1.5MB）…');
      const model = await tf.loadGraphModel(CARTOONGAN_URL);
      const warm = tf.zeros([1, CARTOONGAN_SIZE, CARTOONGAN_SIZE, 3]);
      const warmOut = model.predict({ 'input_photo:0': warm });
      if (Array.isArray(warmOut)) warmOut.forEach((t) => t.dispose());
      else warmOut.dispose();
      warm.dispose();
      return model;
    })();
  }
  return cartoonganModelPromise;
}

function cartoonganNormalize(img, tf) {
  const shape = img.shape;
  const height = shape[0];
  const width = shape[1];
  const pad =
    width > height
      ? [[0, 0], [width - height, 0], [0, 0]]
      : [[height - width, 0], [0, 0], [0, 0]];
  let t = img.pad(pad);
  t = tf.image.resizeBilinear(t, [CARTOONGAN_SIZE, CARTOONGAN_SIZE]);
  t = t.reshape([1, CARTOONGAN_SIZE, CARTOONGAN_SIZE, 3]);
  const offset = tf.scalar(127.5);
  return t.sub(offset).div(offset);
}

async function runCartoonGan(sourceCanvas, onProgress) {
  const tf = await loadTf();
  const model = await loadCartoonGan(tf, onProgress);
  onProgress?.('插画卡通处理中…');

  const origW = sourceCanvas.width;
  const origH = sourceCanvas.height;

  const img = tf.browser.fromPixels(sourceCanvas);
  const norm = cartoonganNormalize(img, tf);
  img.dispose();

  const raw = model.predict({ 'input_photo:0': norm });
  norm.dispose();

  let tensor = Array.isArray(raw) ? raw[0] : raw;
  if (Array.isArray(raw)) {
    for (let i = 1; i < raw.length; i++) raw[i].dispose();
  }

  tensor = tensor.squeeze();
  let outTensor = tensor.sub(tf.scalar(-1)).div(tf.scalar(2)).clipByValue(0, 1);
  tensor.dispose();

  const pad = Math.round((Math.abs(origW - origH) / Math.max(origW, origH)) * CARTOONGAN_SIZE);
  const slice = origW > origH ? [0, pad, 0] : [pad, 0, 0];
  outTensor = outTensor.slice(slice);

  const temp = document.createElement('canvas');
  temp.width = outTensor.shape[1];
  temp.height = outTensor.shape[0];
  await tf.browser.toPixels(outTensor, temp);
  outTensor.dispose();

  return drawScaled(temp, origW, origH);
}

/* ------------------------------------------------------------------ */
/* 风格 2：AnimeGAN 宫崎骏（Hayao）                                     */
/* ------------------------------------------------------------------ */

/** @type {Promise<any> | null} */
let hayaoModelPromise = null;
let mirrorPadRegistered = false;

function registerMirrorPad(tf) {
  if (mirrorPadRegistered) return;
  const registerOp = tf.registerOp;
  if (typeof registerOp !== 'function') {
    throw new Error('TensorFlow.js converter 未加载，无法运行宫崎骏风模型');
  }
  // AnimeGAN 图里用到 reflect 模式的 MirrorPad，tfjs 默认不支持，需自定义。
  // 实现参考 TonyLianLong/AnimeGAN.js。
  const mirrorPadFunc = (input, padArr) =>
    tf.tidy(() => {
      let out = input;
      for (let i = 0; i < 4; i++) {
        if (padArr[i][0] !== 0 || padArr[i][1] !== 0) {
          let sliceSize = [-1, -1, -1, -1];
          sliceSize[i] = padArr[i][0];
          const sliceBeginLeft = [0, 0, 0, 0];
          const left = out.slice(sliceBeginLeft, sliceSize);

          sliceSize = [-1, -1, -1, -1];
          sliceSize[i] = padArr[i][1];
          const sliceBeginRight = [0, 0, 0, 0];
          sliceBeginRight[i] = out.shape[i] - padArr[i][1];
          const right = out.slice(sliceBeginRight, sliceSize);

          out = tf.concat([left, out, right], i);
        }
      }
      return out;
    });

  registerOp('MirrorPad', async (node) => {
    if (node.attrs.mode !== 'reflect') {
      throw new Error('MirrorPad only supports reflect mode');
    }
    const padArr = await node.inputs[1].array();
    return mirrorPadFunc(node.inputs[0], padArr);
  });
  mirrorPadRegistered = true;
}

async function loadHayao(tf, onProgress) {
  if (!hayaoModelPromise) {
    hayaoModelPromise = (async () => {
      registerMirrorPad(tf);
      onProgress?.('下载宫崎骏风模型（约 16MB，首次较慢）…');
      return tf.loadGraphModel(HAYAO_URL);
    })();
  }
  return hayaoModelPromise;
}

async function runHayao(sourceCanvas, onProgress) {
  const tf = await loadTf();
  const model = await loadHayao(tf, onProgress);
  onProgress?.('宫崎骏风处理中（约 10~30 秒）…');

  const origW = sourceCanvas.width;
  const origH = sourceCanvas.height;

  const imgTensor = tf.browser.fromPixels(sourceCanvas);
  const longSide = Math.max(origW, origH);
  const scale = longSide / HAYAO_LONG_SIDE;
  const scaledH = Math.max(1, Math.round(origH / scale));
  const scaledW = Math.max(1, Math.round(origW / scale));

  const input = tf.tidy(() =>
    tf.image.resizeBilinear(imgTensor, [scaledH, scaledW]).expandDims(0).div(255),
  );
  imgTensor.dispose();

  const generated = await model.executeAsync({ test: input });
  input.dispose();

  const out = tf.tidy(() => generated.squeeze(0).add(1).div(2).clipByValue(0, 1));
  generated.dispose();

  const temp = document.createElement('canvas');
  temp.width = out.shape[1];
  temp.height = out.shape[0];
  await tf.browser.toPixels(out, temp);
  out.dispose();

  return drawScaled(temp, origW, origH);
}

/* ------------------------------------------------------------------ */
/* 风格 3：AnimeGANv2 FacePortrait（ONNX，人像）                        */
/* ------------------------------------------------------------------ */

/** @type {Promise<any> | null} */
let ortPromise = null;
/** @type {Promise<any> | null} */
let faceSessionPromise = null;

async function loadOrt() {
  if (!ortPromise) {
    ortPromise = Promise.resolve().then(() => {
      const ort = window.ort;
      if (!ort) throw new Error('ONNX Runtime 未加载，请刷新页面');
      if (ort.env?.wasm) {
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.simd = true;
        ort.env.wasm.proxy = false;
      }
      return ort;
    });
  }
  return ortPromise;
}

async function loadFaceSession(ort, onProgress) {
  if (!faceSessionPromise) {
    faceSessionPromise = (async () => {
      onProgress?.('下载动漫人像模型（约 8MB，首次较慢）…');
      return ort.InferenceSession.create(FACE_URL, { executionProviders: ['wasm'] });
    })();
  }
  return faceSessionPromise;
}

async function runFacePortrait(sourceCanvas, onProgress) {
  if (FILE_PROTOCOL) {
    throw new Error(FACE_PORTRAIT_FILE_MSG);
  }
  const ort = await loadOrt();
  const session = await loadFaceSession(ort, onProgress);
  onProgress?.('动漫人像处理中…');

  const origW = sourceCanvas.width;
  const origH = sourceCanvas.height;

  // 该模型固定输入 512×512（含 contain 居中，避免拉伸变形）。
  const inCanvas = document.createElement('canvas');
  inCanvas.width = FACE_SIZE;
  inCanvas.height = FACE_SIZE;
  const inCtx = inCanvas.getContext('2d', { willReadFrequently: true });
  if (!inCtx) throw new Error('无法创建画布');
  inCtx.fillStyle = '#ffffff';
  inCtx.fillRect(0, 0, FACE_SIZE, FACE_SIZE);
  const scale = Math.min(FACE_SIZE / origW, FACE_SIZE / origH);
  const dw = Math.round(origW * scale);
  const dh = Math.round(origH * scale);
  const dx = Math.floor((FACE_SIZE - dw) / 2);
  const dy = Math.floor((FACE_SIZE - dh) / 2);
  inCtx.imageSmoothingEnabled = true;
  inCtx.imageSmoothingQuality = 'high';
  inCtx.drawImage(sourceCanvas, dx, dy, dw, dh);

  const { data } = inCtx.getImageData(0, 0, FACE_SIZE, FACE_SIZE);
  const channel = FACE_SIZE * FACE_SIZE;
  const chw = new Float32Array(channel * 3);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    chw[p] = (data[i] / 255) * 2 - 1;
    chw[p + channel] = (data[i + 1] / 255) * 2 - 1;
    chw[p + channel * 2] = (data[i + 2] / 255) * 2 - 1;
  }

  const feeds = { 'input.1': new ort.Tensor('float32', chw, [1, 3, FACE_SIZE, FACE_SIZE]) };
  const results = await session.run(feeds);
  const outName = session.outputNames[0];
  const outData = results[outName].data;

  const rgba = new Uint8ClampedArray(channel * 4);
  for (let i = 0; i < channel; i++) {
    rgba[i * 4] = clamp255((outData[i] * 0.5 + 0.5) * 255);
    rgba[i * 4 + 1] = clamp255((outData[i + channel] * 0.5 + 0.5) * 255);
    rgba[i * 4 + 2] = clamp255((outData[i + channel * 2] * 0.5 + 0.5) * 255);
    rgba[i * 4 + 3] = 255;
  }

  const full = document.createElement('canvas');
  full.width = FACE_SIZE;
  full.height = FACE_SIZE;
  const fctx = full.getContext('2d');
  if (!fctx) throw new Error('无法创建画布');
  fctx.putImageData(new ImageData(rgba, FACE_SIZE, FACE_SIZE), 0, 0);

  // 裁掉之前的 contain 留白，恢复原始宽高比。
  const crop = document.createElement('canvas');
  crop.width = dw;
  crop.height = dh;
  const cctx = crop.getContext('2d');
  if (!cctx) throw new Error('无法创建画布');
  cctx.drawImage(full, dx, dy, dw, dh, 0, 0, dw, dh);

  return drawScaled(crop, origW, origH);
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** 把 src canvas 高质量缩放绘制到 origW×origH 的新 canvas。 */
function drawScaled(src, origW, origH) {
  const out = document.createElement('canvas');
  out.width = origW;
  out.height = origH;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, origW, origH);
  return out;
}

/* ------------------------------------------------------------------ */
/* 统一入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {HTMLCanvasElement} sourceCanvas
 * @param {'cartoongan' | 'hayao' | 'faceportrait'} style
 * @param {(msg: string) => void} [onProgress]
 * @returns {Promise<HTMLCanvasElement>}
 */
async function aiCartoonizeStyle(sourceCanvas, style, onProgress) {
  switch (style) {
    case 'hayao':
      return runHayao(sourceCanvas, onProgress);
    case 'faceportrait':
      return runFacePortrait(sourceCanvas, onProgress);
    case 'cartoongan':
    default:
      return runCartoonGan(sourceCanvas, onProgress);
  }
}

window.pindouAiCartoon = {
  aiCartoonizeStyle,
  CARTOON_STYLE_META,
  isFacePortraitAvailable: () => !FILE_PROTOCOL,
};
