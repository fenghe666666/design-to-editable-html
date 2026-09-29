#!/usr/bin/env node
/*
  psd.cjs —— 把图层稿导出成「文字可以进 PS 直接改」的 PSD

    node psd.cjs 稿.html [--out 名.psd] [--width design|2k|4k|8k|3840] [--dpi N]
                         [--units print|px|both] [--lines shape|bitmap] [--no-preview] [--no-board]

    例：node psd.cjs 稿.html                       -> 稿.psd + 稿-通用.psd（默认两版都出）
        node psd.cjs 稿.html --units print         -> 只出印刷版（PS 用）
        node psd.cjs 稿.html --width 4k            -> 稿-4096px.psd + 稿-4096px-通用.psd
        node psd.cjs 稿.html --no-preview          -> 不带压平预览，文件小一半
        node psd.cjs 稿.html --lines bitmap         -> 线段只出一层像素（默认是 PS 直线工具那种形状层）

  两版字号相同（都写设计像素数字），只差**文档分辨率元数据**：印刷版写「设计像素每英寸」（菜单稿 300），
  PS「图像大小」里纸张就是 scene.page 的毫米数；通用版写 72，Illustrator / CorelDRAW / 看图软件那类
  真按 dpi 换算 pt 的应用里字画得一样大。为什么字号不写 pt：实测 Photoshop 排版时不按文档分辨率换算
  pt（13.3pt 在 300dpi 和 72dpi 下占同样多的像素），写 pt 只会让印刷版的字小 dpi/72 倍。
  版面像素、位图、预览两版完全相同。

  层结构自下而上：底板（位图）→ 稿件里的图层顺序（文字层＝真·可改字，线段层＝位图）。
  字号与行距＝设计像素，描边宽度写 Pixels；--width 放大时位图与像素数字同比放大。
  排版由页面自己算（#manifest 模式），Node 这边不再量字，免得两套字体度量把版面挪偏。
*/
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const { decodePng, fromDataUri } = require('./png.cjs');

function args(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else a._.push(argv[i]);
  }
  return a;
}
function die(m) { console.error('ERR ' + m); process.exit(1); }
const PRESET = { '2k': 2048, '4k': 3840, '8k': 7680, '16k': 15360 };
const r2 = v => Math.round(v * 100) / 100;
function restrictedCodexProcess() {
  if (!process.env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY || !process.env.USERPROFILE) return false;
  try { fs.realpathSync(process.env.USERPROFILE); return false; }
  catch (e) { return e.code === 'EPERM'; }
}
const chromeSandbox = restrictedCodexProcess() ? ['--no-sandbox'] : [];
/* 兜底也要纯 ASCII：中文家族名写进 TiKi 会让 PS 解析失败、把那一层直接栅格化（"无法读取某些文字图层"） */
const psSafeFamily = f => String(f || '').split(',')[0].replace(/["'\s]/g, '').replace(/[^ -~]/g, '').slice(0, 60) || 'Arial';

function findChrome() {
  const cands = [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'];
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  const r = cp.spawnSync('cmd.exe', ['/d', '/c', 'where chrome'], { encoding: 'utf8' });
  const f = (r.stdout || '').split(/\r?\n/).find(Boolean);
  if (f && fs.existsSync(f)) return f;
  die('找不到 Chrome/Edge，可设置环境变量 CHROME_PATH');
}

/* 成品 HTML 已内联同版本 ag-psd：直接复用，命令行无需再找或安装 node_modules。 */
function loadPsd(src, dirs) {
  const embedded = /\/\* ag-psd v[^\n]*浏览器包[^\n]*\*\/\s*([\s\S]*?)<\/script>/.exec(src);
  if (embedded) {
    const Module = require('module');
    const packed = new Module('ag-psd-inline', module);
    packed.filename = path.join(__dirname, 'ag-psd-inline.js');
    packed.paths = module.paths;
    packed._compile(embedded[1], packed.filename);
    if (packed.exports && typeof packed.exports.writePsd === 'function') return packed.exports;
  }
  /* 兼容旧稿（可能没有内联包）：再从环境安装位置查找。 */
  const cands = [process.env.AG_PSD_DIR];
  for (const d of dirs) {
    let p = path.resolve(d);
    for (let i = 0; i < 6; i++) { cands.push(path.join(p, 'node_modules', 'ag-psd')); p = path.dirname(p); }
  }
  cands.push(path.join(os.homedir(), '.qoder', 'ag-psd', 'node_modules', 'ag-psd'));
  for (const c of cands) {
    if (!c || !fs.existsSync(path.join(c, 'package.json'))) continue;
    try { return require(c); } catch (e) { /* 换下一个候选 */ }
  }
  die('稿件没有内联 ag-psd，且环境里未找到 ag-psd；请用当前 skill 重新 build');
}

function chromeRun(chrome, base, tmp) {
  let r = cp.spawnSync(chrome, base('--headless=new'), { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (!r.stdout || /Internal error|Failed to write/.test(r.stderr || '')) {
    r = cp.spawnSync(chrome, base('--headless'), { encoding: 'utf8', maxBuffer: 1 << 28 });
  }
  return r;
}

/* ---------- 排版清单：页面在 #manifest 模式下把每层的生效样式与基线吐成一段 base64 ---------- */
function getManifest(chrome, html, tmp) {
  const url = 'file:///' + html.replace(/\\/g, '/') + '#manifest';
  const base = head => [head, '--disable-gpu', ...chromeSandbox, '--hide-scrollbars', '--force-device-scale-factor=1',
    '--virtual-time-budget=20000', '--user-data-dir=' + tmp, '--window-size=1600,1200', '--dump-dom', url];
  const out = (chromeRun(chrome, base, tmp).stdout || '');
  const m = /\[\[\[PSD\]\]\]([A-Za-z0-9+\/=]+)\[\[\[\/PSD\]\]\]/.exec(out);
  if (!m) die('读不到排版清单：页面没能跑起来（检查 HTML 是否为本 skill 生成、有无脚本报错）');
  return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
}

/* ---------- 截图 → RGBA（底板非内联 PNG、或要放大出图时走这条路） ---------- */
function shoot(chrome, html, tmp, hash, W, H, transparent) {
  const png = path.join(tmp, 'shot.png');
  const base = head => [head, '--disable-gpu', ...chromeSandbox, '--hide-scrollbars', '--force-device-scale-factor=1',
    '--virtual-time-budget=20000', '--user-data-dir=' + tmp, '--window-size=' + W + ',' + H,
    '--screenshot=' + png, 'file:///' + html.replace(/\\/g, '/') + hash].concat(transparent ? ['--default-background-color=00000000'] : []);
  let r = chromeRun(chrome, base, tmp);
  if (!fs.existsSync(png)) { fs.rmSync(png, { force: true }); r = cp.spawnSync(chrome, base('--headless'), { encoding: 'utf8' }); }
  if (!fs.existsSync(png)) die('截图失败：' + ((r.stderr || r.stdout || '').split('\n').slice(-3).join(' ') || '无输出'));
  try { return decodePng(fs.readFileSync(png)); } catch (e) { die('截图解码失败：' + e.message); }
}

/* ---------- 颜色 ----------
   ag-psd 里两套颜色口径不一样，写错不报错、只是颜色全变黑：
   - 文字样式 fillColor（text.js 的 encodeColor）吃 **0~255**，它自己再除以 255
   - 图层样式颜色（psdWriter 的 writeColor）吃 **0~1**，它自己再乘 257 */
function rgb(hex) {
  let s = String(hex || '#000').trim().replace(/^#/, '');
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  if (s.length > 6) s = s.slice(0, 6);
  const n = parseInt(s, 16);
  if (!isFinite(n) || s.length !== 6) return { r: 0, g: 0, b: 0 };
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}
const rgb8 = hex => { const c = rgb(hex); return { r: c.r * 255, g: c.g * 255, b: c.b * 255 }; };
const bytes = c => [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];

/* ---------- 线段：Node 没有 canvas，按「到线的距离」自己画一条带虚线节奏的 AA 线 ----------
   虚线不能只判「落不落在画的那一段里」：round 端头会把点向外撑半个线宽，
   菜单里那种 dash=[0.01, 12.5] 的点线，画段本身只有 0.01 像素，靠端头才长成圆点。
   所以先算像素到最近「画段」的轴向距离 ds，再和垂距合成真实距离。 */
function gapTo(s, pat, T) {                 /* 轴向：s 处到最近一段「画」的距离（0＝在画段内） */
  let r = s % T; if (r < 0) r += T;
  let acc = 0;
  for (let i = 0; i < pat.length; i++) {
    const a = acc, b = acc + pat[i]; acc = b;
    if (i % 2 === 0) { if (r >= a && r <= b) return 0; }
    else if (r > a && r < b) return Math.min(r - a, b - r);
  }
  return Math.min(r, T - r);
}
/* 线段 → PS「直线工具」那种形状层字段：开路径 + 描边（宽度/端头/虚线/颜色都能在 PS 里改）。
   照抄桌面真实 PS 稿里的形状层：fillEnabled=false 但 vectorFill 照给一个颜色（PS 自己也这么存）。 */
function lineVec(L, S) {
  const k = (x, y) => ({ linked: true, points: [x, y, x, y, x, y] });
  const cap = L.cap === 'round' ? 'round' : L.cap === 'square' ? 'square' : 'butt';
  return {
    vectorMask: { paths: [{ open: true, operation: 'combine', fillRule: 'even-odd', knots: [k(L.x1 * S, L.y1 * S), k(L.x2 * S, L.y2 * S)] }], fillStartsWithAllPixels: false },
    vectorStroke: {
      strokeEnabled: true, fillEnabled: false, lineWidth: { value: r2(Math.max(0.7, L.w * S)), units: 'Pixels' },
      lineDashOffset: { value: 0, units: 'Pixels' }, miterLimit: 100, lineCapType: cap,
      lineJoinType: 'miter', lineAlignment: 'center', scaleLock: false, strokeAdjust: false,
      lineDashSet: (L.dash || []).map(v => ({ value: r2(v * S), units: 'Pixels' })),
      blendMode: 'normal', opacity: 1, content: { type: 'color', color: rgb8(L.color) }, resolution: 72
    },
    vectorFill: { type: 'color', color: { r: 0, g: 0, b: 0 } },
    vectorOrigination: { keyDescriptorList: [{ keyShapeInvalidated: true }] },
    nameSource: 'shap'
  };
}

function lineLayer(L, S, W, H) {
  const x1 = L.x1 * S, y1 = L.y1 * S, x2 = L.x2 * S, y2 = L.y2 * S;
  const w = Math.max(0.7, L.w * S), half = w / 2;
  const pad = Math.ceil(w + 2);
  let left = Math.max(0, Math.floor(Math.min(x1, x2)) - pad), top = Math.max(0, Math.floor(Math.min(y1, y2)) - pad);
  let right = Math.min(W, Math.ceil(Math.max(x1, x2)) + pad), bottom = Math.min(H, Math.ceil(Math.max(y1, y2)) + pad);
  if (right - left < 1 || bottom - top < 1) return null;
  const cw = right - left, ch = bottom - top;
  const data = new Uint8ClampedArray(cw * ch * 4);
  const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy, len = Math.sqrt(L2);
  const ux = len ? dx / len : 1, uy = len ? dy / len : 0;      // 单位方向，垂距用叉积算
  const pat = (L.dash || []).map(d => d * S);
  let T = 0; for (const v of pat) T += v;
  const round = (L.cap || 'butt') === 'round', butt = (L.cap || 'butt') === 'butt';
  const [cr, cg, cb] = bytes(rgb(L.color));
  for (let yy = 0; yy < ch; yy++) {
    const py = top + yy + 0.5;
    for (let xx = 0; xx < cw; xx++) {
      const px = left + xx + 0.5;
      const vx = px - x1, vy = py - y1;
      const s = len ? vx * ux + vy * uy : 0;
      const perp = len ? Math.abs(vx * uy - vy * ux) : Math.hypot(vx, vy);
      const out = s < 0 ? -s : (s > len ? s - len : 0);         // 到线段两端的轴向超出量
      const gap = (pat.length && T > 0) ? gapTo(s, pat, T) : 0;
      let a;
      if (round) a = half + 0.5 - Math.hypot(perp, gap + out);
      else if (butt) a = (gap === 0 && out === 0) ? half + 0.5 - perp : -1;
      else a = (gap <= half && out <= half) ? half + 0.5 - perp : -1;   // square：端头向外补半个线宽
      a = Math.max(0, Math.min(1, a));
      if (a <= 0) continue;
      const o = (yy * cw + xx) * 4;
      data[o] = cr; data[o + 1] = cg; data[o + 2] = cb; data[o + 3] = Math.round(a * 255);
    }
  }
  const lay = { name: L.name || '线段', left, top, right, bottom, blendMode: 'normal',
    imageData: { width: cw, height: ch, data } };
  if (VEC) Object.assign(lay, lineVec(L, S));
  return lay;
}

/* ---------- 文字层 ----------
   层的矩形一律给「整幅画布」：PSD 的文字定位矩阵在不同解读下是相对文档还是相对图层原点，
   矩形从 (0,0) 起时两种解读完全重合，位置不可能跑偏。图层不带位图，PS 打开时自己按活字重排。 */
function textLayer(L, S, pt, W, H) {
  const lines = L.lines || [];
  /* 段落层写原文（见 stage.html 同处注释）：拼回来的折行在 PS 里是硬回车，改框宽不回流、断行也各排各的 */
  const text = L.para || L.direction === 'vertical' ? String(L.text == null ? '' : L.text) : lines.map(x => x.t).join('\n');
  if (!text.trim()) return null;
  const size = Math.max(0.5, pt(L.size));
  const lead = Math.max(size, pt(L.size * (L.lh || 1)));
  /* PSD 里两端对齐交给 PS 自己的段落引擎（justify-left＝末行不拉伸，和页面口径一致）。
     ag-psd 的枚举带连字符，写 'justifyLeft' 会 indexOf 不到而编成 -1。 */
  const align = L.align === 'center' ? 'center' : L.align === 'right' ? 'right'
    : L.align === 'justify' ? 'justify-left' : 'left';
  const ax = align === 'center' ? L.box.x + L.box.w / 2
    : align === 'right' ? L.box.x + L.box.w
      : Math.min.apply(null, lines.map(x => x.x));
  /* 段落文本要在 PS 里也是段落文本。真实 PS 稿回读到的口径（详情页.psd / 1000p4.psd 等）：
     boxBounds = [0,0,框宽,框高]（相对变换原点），transform 的 tx/ty = 框左上角在文档里的位置（不是基线），
     首行缩进走 firstLineIndent，标点悬挂走 burasagari（＝我们的"宽松"；"无"这一档 PS 没有对应开关）。 */
  const para = !!L.para, b = L.box || { x: 0, y: 0, w: 1, h: 1 };
  const pstyle = { justification: align };
  if (para) { if (+L.fi > 0) pstyle.firstLineIndent = r2(L.fi * S);
    pstyle.burasagari = (L.kin || 'strict') === 'loose';
    /* 页面是"一行一行贪心填满"，对应 PS 的「逐行合成器」 */
    pstyle.everyLineComposer = true; }
  const lay = {
    name: L.name || text.replace(/\s+/g, ' ').slice(0, 20),
    left: 0, top: 0, right: W, bottom: H, blendMode: 'normal',
    text: {
      text: text, shapeType: para ? 'box' : 'point', orientation: L.direction || 'horizontal', antiAlias: 'smooth',
      transform: para ? [1, 0, 0, 1, r2(b.x * S), r2(b.y * S)]
        : L.direction === 'vertical' ? [1, 0, 0, 1, r2((b.x + b.w) * S), r2(b.y * S)]
          : [1, 0, 0, 1, r2(ax * S), r2(lines[0].base * S)],
      ...(para ? { boxBounds: [0, 0, Math.max(1, r2(b.w * S)), Math.max(1, r2(b.h * S))] } : {}),
      style: {
        /* PS 只认 PostScript 名（清单里的 ps，来自 fonts.cjs 的 facePs，页面那边已保证非空且纯 ASCII：
           写中文家族名会让 PS 解析失败、把文字层直接栅格化，可改字就没了） */
        font: { name: String(L.ps || '').replace(/[^ -~]/g, '') || psSafeFamily(L.font) },
        fontSize: r2(size), autoLeading: false, leading: r2(lead),
        tracking: Math.round((L.ls || 0) / L.size * 1000),
        fillColor: rgb8(L.color), fauxBold: +L.weight >= 600
      },
      paragraphStyle: pstyle
    }
  };
  if (+L.ow > 0) {
    /* 字段名是 effects（不是 layerEffects），写错会被 ag-psd 静默丢掉 */
    lay.effects = {
      stroke: [{
        enabled: true, fillType: 'color', color: rgb(L.oc || L.color),
        position: L.opos === 'center' ? 'center' : L.opos === 'inside' ? 'inside' : 'outside',
        size: { units: 'Pixels', value: r2(L.ow * S) }, blendMode: 'normal', opacity: 255
      }]
    };
  }
  return lay;
}

/* ================= 主流程 ================= */
const A = args(process.argv.slice(2));
const html = A._[0] ? path.resolve(A._[0]) : null;
if (!html || !fs.existsSync(html)) die('用法: node psd.cjs 稿.html [--out 名.psd] [--width 4k] [--preview]');

const src = fs.readFileSync(html, 'utf8');
const sm = /\/\*<<<SCENE>>>\*\/([\s\S]*?)\/\*<<<END SCENE>>>\*\//.exec(src);
if (!sm) die('读不到数据块（HTML 不是本 skill 生成的，或被改坏了）');
let scene;
try { scene = JSON.parse(sm[1]); } catch (e) { die('数据块 JSON 解析失败：' + e.message); }

const chrome = findChrome();
const PSD = loadPsd(src, [path.dirname(html), process.cwd(), __dirname]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd2psd-'));
let m;
try { m = getManifest(chrome, html, tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

const W0 = m.w, H0 = m.h;
if (!W0 || !H0) die('数据块缺少 design.w / design.h');
const PPI = +A.dpi || m.dpi || 72;                 /* 设计像素每英寸；没有 page 字段时按 72（1pt = 1 设计像素） */
const pt = v => v * S;                      /* 设计像素 → PSD 字号数字：PS 排版时 1pt 当 1 像素用，两版相同 */
const target = PRESET[String(A.width || 'design').toLowerCase()] || parseInt(A.width, 10) || W0;
const S = target / W0;
const W = Math.round(W0 * S), H = Math.round(H0 * S);

/* 两种**文档分辨率元数据**，默认都出（--units print|px 只出一种）。字号两版都写设计像素
   （1pt 当 1 像素用）—— 实测 Photoshop 不按文档分辨率换算 pt，写 pt 只会让字小 dpi/72 倍：
   print  分辨率＝设计像素每英寸 × 放大 → PS「图像大小」里纸张就是 scene.page（印刷商要这个）
   px     分辨率写 72 → Illustrator / CorelDRAW 那类真按 dpi 换算的软件里也不会走样
   两版的像素、位图、压平预览完全相同。 */
const MODES = A.units === 'print' ? ['print'] : A.units === 'px' ? ['px'] : ['print', 'px'];
const MODE_CN = { print: '印刷版', px: '通用版' };
const VEC = A.lines !== 'bitmap';    /* 线段默认转成 PS 形状层（直线工具那种）；--lines bitmap 回到只有一层像素 */

/* 位图与字号无关，只算一次（底板、线段、压平预览） */
let boardLayer = null;
if (!A['no-board']) {
  let img = null;
  if (S === 1) img = fromDataUri(scene.board);     /* 内联底板就是 PNG 且正好是设计尺寸：直接解，省一次 Chrome */
  if (!img || img.width !== W || img.height !== H) {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'd2psd-'));
    try { img = shoot(chrome, html, t, '#export&board', W, H, false); }
    finally { fs.rmSync(t, { recursive: true, force: true }); }
  }
  if (img && img.width && img.height)
    boardLayer = { name: '底板', left: 0, top: 0, right: img.width, bottom: img.height,
      blendMode: 'normal', imageData: { width: img.width, height: img.height, data: img.data } };
}
const lineObjs = new Map();
let nL = 0, nS = 0;
(m.layers || []).forEach((L, i) => {
  if (L.kind !== 'line') return;
  const o = lineLayer(L, S, W, H);
  if (o) { lineObjs.set(i, o); nL++; } else nS++;
});
let flat = null;
if (!A['no-preview']) {
  /* 压平预览默认带上：别的软件不重排活字层，只看这张合成图，有它才不会出现"PSD 打开是另一个样子" */
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'd2psd-'));
  try { const f = shoot(chrome, html, t, '#export', W, H, false);
    if (f.width === W && f.height === H) flat = f; else console.log('   预览尺寸 ' + f.width + 'x' + f.height + ' 与画布不符，已跳过');
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
}

const baseOut = (A.out ? path.resolve(String(A.out)) : html.replace(/\.html?$/i, '') + (S === 1 ? '' : '-' + W + 'px'))
  .replace(/\.psd$/i, '');                        /* --out 带不带 .psd 都行：后缀要按模式补，别拼成 x.psd-通用.psd */
for (const mode of MODES) {
  const DPI = r2(mode === 'px' ? 72 : PPI * S);
  /* 组合 → PS 的「图层编组」：组号栈内层在前，所以从后往前走到最外层；
     组节点在它第一个成员出现的位置落位，children[0] 是最底下那层（PSD 自下而上存）。
     混合模式 pass through 与 PS 自己新建的组一致（真实 PS 稿回读到的都是这个）。 */
  const root = { kids: [], sub: new Map() };
  const put = (L, x) => { let p = root; const st = L.g || [];
    for (let i = st.length - 1; i >= 0; i--) { let n = p.sub.get(st[i]);
      if (!n) { n = { grp: true, name: '组 ' + st[i], kids: [], sub: new Map() }; p.sub.set(st[i], n); p.kids.push(n); }
      p = n; }
    p.kids.push(x); };
  const fold = n => n.kids.map(k => k.grp ? { name: k.name, blendMode: 'pass through', opened: true, children: fold(k) } : k);
  const countG = a => a.reduce((s, x) => s + (x.children ? 1 + countG(x.children) : 0), 0);
  if (boardLayer) root.kids.push(boardLayer);
  let nT = 0;
  (m.layers || []).forEach((L, i) => {
    if (L.kind === 'line') { const o = lineObjs.get(i); if (o) put(L, o); return; }
    const lay = textLayer(L, S, pt, W, H);
    if (!lay) { return; }
    nT++; put(L, lay);
  });
  const children = fold(root), nG = countG(children);
  const psd = {
    width: W, height: H, channels: 4, bitsPerChannel: 8, colorMode: 3,
    imageResources: { resolutionInfo: { horizontalResolution: DPI, verticalResolution: DPI,
      horizontalResolutionUnit: 'PPI', verticalResolutionUnit: 'PPI', widthUnit: 'Inches', heightUnit: 'Inches' } },
    children: children
  };
  if (flat) psd.imageData = { width: W, height: H, data: flat.data };

  const out = baseOut + (mode === 'px' ? '-通用.psd' : '.psd');
  let buf;
  try { buf = PSD.writePsd(psd); } catch (e) { die('写 PSD 失败：' + e.message); }
  fs.writeFileSync(out, Buffer.from(buf));

  /* 自检：再读一遍，确认层数、字号、字体没在编码里丢掉（活字层不带位图，读回来只能看这些）。
     有了编组之后 children 是树，先摊平再数，并把"读回来还有几个组"一起报出来。 */
  let chk = '';
  try {
    const back = PSD.readPsd(Buffer.from(buf), { skipLayerImageData: true, skipCompositeImageData: true, useImageData: !!psd.imageData });
    const leaves = []; let nGb = 0;
    (function walk(a) { (a || []).forEach(l => { if (l.children) { nGb++; walk(l.children); } else leaves.push(l); }); })(back.children);
    const t1 = leaves.filter(l => l.text);
    const e1 = t1.filter(l => l.effects && l.effects.stroke && l.effects.stroke.length).length;
    const pb = t1.filter(l => l.text.shapeType === 'box').length;
    const vert = t1.filter(l => l.text.orientation === 'vertical').length;
    chk = `回读 ${leaves.length} 层 / 文字层 ${t1.length}（段落 ${pb}、竖排 ${vert}） / 描边 ${e1} / 编组 ${nGb}`;
    const f = leaves.find(l => l.text);
    const b = f && t1.find(l => l.text.text === f.text.text);
    if (b) chk += `，首层字号 ${b.text.style.fontSize}（PS 里显示为 pt，等于设计像素） ${b.text.style.font.name}`;
  } catch (e) { chk = '回读失败：' + e.message; }

  const sz = fs.statSync(out).size;
  console.log(`OK ${out}\n   PSD ${MODE_CN[mode]} · ${W}x${H}px · ${DPI}dpi${mode === 'print' && m.paper && m.paper.wmm ? `（纸张 ${m.paper.wmm}×${m.paper.hmm}mm）` : ''} · 字号＝设计像素（PS 把 1pt 当 1px） · 文字层 ${nT} · 线段层 ${nL}（${VEC ? '形状，可拖端点' : '位图'}） · 图层编组 ${nG}` +
    (flat ? ' · 含压平预览' : '') + (nS ? ` · 空层跳过 ${nS}` : '') + `\n   ${chk} · ${(sz / 1048576).toFixed(2)}MB`);
}
if (m.dpi) console.log('   提示：PS 里改字需本机装有稿件用的字体，否则会弹「替换字体」；字号/位置不受影响。');
