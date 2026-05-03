<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>拼豆像素图 · Mard 色卡</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <header class="site-head">
      <div class="brand">
        <h1>拼豆像素图</h1>
        <p class="tagline">
          将照片转为 Mard 拼豆色号网格，含用料统计与导出。色卡数据来源：
          <a href="https://www.doudougongfang.com/kb/beads/mard-palette" target="_blank" rel="noreferrer noopener">
            豆豆工坊 · Mard 拼豆色卡
          </a>
          （站内工具，非官方）。
        </p>
      </div>
    </header>

    <main class="layout">
      <section class="panel controls" aria-label="参数设置">
        <div
          id="drop-zone"
          class="drop"
          tabindex="0"
          role="button"
          aria-label="选择或拖入图片"
        >
          <p><strong>点击或拖放图片到这里</strong></p>
          <p class="hint">支持 JPG / PNG / WebP · 全流程在浏览器完成，不上传服务器</p>
        </div>
        <input id="file" type="file" accept="image/*" hidden />

        <div class="field-row">
          <label for="grid-w">宽度（格）</label>
          <input id="grid-w" type="range" min="12" max="256" value="48" />
          <output id="grid-w-val" for="grid-w">48</output>
        </div>
        <div class="field-row">
          <label for="grid-h">高度（格）</label>
          <input id="grid-h" type="range" min="12" max="256" value="48" />
          <output id="grid-h-val" for="grid-h">48</output>
        </div>

        <label class="check">
          <input id="lock-aspect" type="checkbox" checked />
          <span>锁定原图宽高比（改宽度自动算高度）</span>
        </label>

        <div class="field">
          <label for="fit">适配方式</label>
          <select id="fit">
            <option value="contain" selected>包含（居中，留白用背景）</option>
            <option value="cover">铺满（裁剪）</option>
            <option value="stretch">拉伸（填满）</option>
          </select>
        </div>

        <div class="field-inline">
          <label for="bg-color">留白背景</label>
          <input id="bg-color" type="color" value="#ffffff" />
        </div>

        <label class="check">
          <input id="remove-bg" type="checkbox" />
          <span>粗略移除背景（沿边缘连通区域，纯色/虚化背景更合适；物体贴图缘时慎用）</span>
        </label>
        <div id="bg-rm-sens-row" class="field-row opt-row is-off-opaque">
          <label for="bg-rm-sensitive">背景灵敏度 LAB²</label>
          <input id="bg-rm-sensitive" type="range" min="450" max="3200" step="50" value="1200" disabled />
          <output id="bg-rm-sensitive-val">1200</output>
        </div>
        <p class="hint opt-hint">
          主体与四角颜色太近时调高数字；擦掉过多主体则调低。
        </p>

        <label class="check">
          <input id="show-grid" type="checkbox" checked />
          <span>图纸模式：四边行列号；每第 10 条线加粗；格内色号在格数特别多时会自动省略以免卡顿（见清单）。大图在预览区内滚动查看原字号。</span>
        </label>

        <div class="btn-row">
          <button id="regenerate" type="button" class="ghost" disabled>重新生成</button>
          <button id="download-png" type="button" disabled>下载 PNG</button>
          <button id="copy-list" type="button" disabled>复制用料表</button>
        </div>

        <p class="footnote">
          可直接双击 <code>index.html</code> 用 <code>file://</code> 打开（本页已不使用 ES Module）。若仍遇限制，也可用本地静态服务：
          <code>python3 -m http.server 8080</code>。
        </p>
      </section>

      <section class="panel preview-wrap" aria-label="预览">
        <div class="preview-head">
          <span id="stats" class="stats muted">请先上传一张图片</span>
        </div>
        <div class="preview-canvas-box">
          <canvas id="preview-canvas" width="48" height="48"></canvas>
        </div>
        <div class="legend-block">
          <h2 class="legend-title">材料清单（按用量）</h2>
          <div id="legend" class="legend"></div>
        </div>
      </section>
    </main>

    <script src="./palette-data.js"></script>
    <script src="./color.js"></script>
    <script src="./subject-bg.js"></script>
    <script src="./app.js"></script>
    <script>
      void (function bindRangeOutputs() {
        [
          ['grid-w', 'grid-w-val'],
          ['grid-h', 'grid-h-val'],
          ['bg-rm-sensitive', 'bg-rm-sensitive-val'],
        ].forEach(([id, oid]) => {
          const inp = document.getElementById(id);
          const out = document.getElementById(oid);
          if (!inp || !out) return;
          const sync = () => (out.textContent = inp.value);
          inp.addEventListener('input', sync);
          sync();
        });
      })();
    </script>
  </body>
</html>
