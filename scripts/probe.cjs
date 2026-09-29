#!/usr/bin/env node
/* probe.cjs —— 一次命令量出「文字在哪、多大、什么色」，并把要读的字裁成图。
   替代以前手写的一堆像素脚本（core/ink/diffrect/fontprobe/crop）。

   用法：
     node scripts/probe.cjs --ref 参考图.png --board 底板.png [--out probe] [--cluster]
     node scripts/probe.cjs --ref 参考图.png                # 没底板时退回单图墨迹模式
     node scripts/probe.cjs --fit probe/scene.json [--cluster] [--unify]
     node scripts/probe.cjs --ref 参考图.png --board 底板.png --out probe --cluster --from 上一版.html   # 量图 + 搬旧稿的字 + 校字号

   填字两条路（按顺序）：① `--from 上一版.html｜scene.json` 按锚点把旧稿核对过的 text/字体搬过来（老 fill.cjs 干的事）；
   ② 全新稿就读 `sheetNN.png` 把 text 写进 scene.json。两条路填完都会自动接着做 `--fit`。
   （以前这里还有第三条 `--ocr`：用 Windows 自带 OCR 先读一遍，实测 82% 一字不差 / 8% 读错 / 10% 读空。
     2026-09-28 按用户要求**整个移除**了 —— 读空的那 10% 会让跑的人回头自己写脚本补，比省下的 10 秒贵得多。）

   --from   上一版图层稿（.html 或 probe 的 scene.json）：按锚点就近一对一搬 text/font/weight，容差 `--fromtol 14` 设计像素；
            只搬"量不出来的东西"，坐标字号颜色仍以这次像素量出来的为准；旧稿坐标按新旧设计尺寸等比缩放。

   --cluster  样式聚类：把「其实只有一套」的参数并成一套（字色/底色/线宽/点距无条件并，字号只在
              只差 3% 以内并，见 CLUSTER 分支的实测注释），并把公共字号公共色收进 sc.text，
              每次跑完打一张台账 + 给每层写角色名（段落/大标题/菜名/引导点线/价格/线段）。
   --unify    配合 --cluster：让整组用同一个字号（省参数但降还原度，默认不开）。
   --nosnap   只统计不改值，用来看这份稿子本来有几套参数。      --tol 0.06  聚类容差。

   原理：
     有底板时  差异掩码 = |参考图 - 底板| > T —— 白字黑底、红底金字、任意极性都能量，
              因为文字是两张图唯一的差别。
     没底板时  按亮度取墨迹，并自动判断极性（背景暗就找亮字，背景亮就找暗字）。

   产出（只有三种图层：点文本 / 段落文本 / 线段）：
     stdout        文字块一行摘要（y/x/行高/建议字号/建议行距/字色/底色）+ 线段块一行（两端/粗细/样式/点距）
     <out>/blocks.json   机器可读的全量细节（含每一行的框、每块对应哪些层的 fits）
     <out>/scene.json    可直接改的图层骨架（文字的 text 是 "?"，读完裁图填进去；线段层不用填）
     <out>/sheetNN.png   裁好的文字条，按块顺序堆叠，供读字用
*/
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const A = process.argv.slice(2);
const get = (k, d) => { const i = A.indexOf('--' + k); return i < 0 ? d : A[i + 1]; };
const flag = k => A.indexOf('--' + k) >= 0;
function die(m) { console.error('ERR ' + m); process.exit(1); }

/* 一个字符占几个 em：全角汉字/标点 1 个，半角数字字母 0.55 个左右。
   墨迹高推字号会随字体不同偏 5% 上下，墨迹宽 ÷ 字数才是这个字体真正的 em。 */
function adv(s) { let v = 0;
  for (const ch of String(s)) { const c = ch.codePointAt(0);
    if (c >= 0x2E80 || (c >= 0xFF01 && c <= 0xFF60) || (c >= 0x2460 && c <= 0x24FF)) v += 1;
    else if (ch === ' ' || ch === ' ') v += 0.28;
    else if (/[A-Z]/.test(ch)) v += 0.72;
    else if (/[.,:;'"|!()\[\]\/\\-]/.test(ch)) v += 0.33;
    else v += 0.55; }
  return v; }

/* --fit scene.json：字填完之后按「墨迹宽 ÷ 字数」重算每层字号，就地改回 scene.json。
   层序和块序不一致（一块能拆出三层），所以靠 blocks.json 的 fits 对号：
   fits[块序] = [ [层序, 该层墨迹宽, 行数], … ]。没填字的层（text 是 "?"）跳过。
   加 --cluster 再做一件事：把同一样式（字号档 × 字色 × 对齐）里只差 3% 以内的并到组中位数，
   并把离组超过 6% 的单独列出来——那要么是真例外，要么这层的字填错/漏了。
   （试过更激进的"整组联立解一个字号"，实测反而更差：见下面 CLU 分支的注释。） */
const FIT = get('fit', '');
if (FIT) {
  const CLU = flag('cluster'), UNIFY = flag('unify');
  const sp = path.resolve(FIT), bj = path.join(path.dirname(sp), 'blocks.json');
  if (!fs.existsSync(sp)) die('找不到 --fit ' + FIT);
  if (!fs.existsSync(bj)) die('--fit 要和同一次 probe 的 blocks.json 放在同一个目录');
  const jd = JSON.parse(fs.readFileSync(bj, 'utf8'));
  if (!jd.fits) die('这份 blocks.json 没有 fits（旧版 probe 的产物），重跑一次 probe 再 fit');
  const want = new Map();
  (jd.blocks || []).forEach((b, i) => (jd.fits[i] || []).forEach(t => want.set(t[0], t)));
  const sc = JSON.parse(fs.readFileSync(sp, 'utf8'));
  const dft = (sc.text || {}).size || 0;
  let chg = 0, skip = 0;
  const est = new Map();                       // 层序 → 这一层自己量出来的字号
  (sc.layers || []).forEach((L, i) => {
    const t = String(L.text == null ? '' : L.text), m = want.get(i);
    if (!m || !t || t === '?') { skip++; return; }
    const k = Math.max(0.6, adv(t) - 0.1 * m[2]);
    const e = Math.round(m[1] / k * 10) / 10;
    if (e > 4) est.set(i, e);
  });
  const odd = [];
  if (!CLU) {
    est.forEach((e, i) => { const L = sc.layers[i], cur = L.size || dft || 0;
      if (Math.abs(e - cur) / e > 0.02) { L.size = e; chg++; } });
  } else {
    /* 实测过：拿"整组联立"去覆盖逐层结果反而更差（逐层 0.9% 中位误差，联立 4.3%）——
       字已知时连三个字的短行都量得准，误差是 em 模型的系统偏差，取平均只会把准的拖向偏的。
       所以簇在这里只干两件事：① 差 3% 以内的并到组中位数（消灭"同一套字号量出 40 个不同值"），
       ② 差 6% 以上的单独报出来——那要么是真例外，要么这层的字填错了。 */
    const by = new Map();
    est.forEach((e, i) => { const L = sc.layers[i];
      const k = [Math.round((L.size || dft || 0) / 3) * 3, L.color || (sc.text || {}).color || '', L.align || ''].join('|');
      if (!by.has(k)) by.set(k, []); by.get(k).push([i, e]); });
    let merged = 0;
    by.forEach((ms, k) => {
      const vs = ms.map(x => x[1]).sort((a, b) => a - b);
      const rep = vs.length ? vs[vs.length >> 1] : 0;
      ms.forEach(([i, e]) => { const L = sc.layers[i];
        const near = UNIFY && ms.length >= 3 && rep && Math.abs(e - rep) / rep <= 0.03;
        const v = near ? Math.round(rep * 10) / 10 : e;
        if (near && v !== e) merged++;
        if (v > 4 && Math.abs(v - (L.size || dft || 0)) / v > 0.02) { L.size = v; chg++; }
        if (ms.length >= 3 && rep && Math.abs(e - rep) / rep > 0.06) odd.push([i, e, rep, k.split('|')[1]]); });
    });
    console.log(`（${by.size} 组样式；` + (UNIFY ? `${merged} 层并到本组中位数，` : '按 --cluster 默认不并字号（保对位还原度），加 --unify 才并；')
      + `${odd.length} 层离本组超 6% 单独列出）`);
  }
  fs.writeFileSync(sp, JSON.stringify(sc, null, 1));
  console.log(`按墨迹宽重算字号${CLU ? '（含样式聚类）' : ''}：改了 ${chg} 层，跳过 ${skip} 层（线段层和还没填字的层跳过）`);
  if (odd.length) { odd.sort((a, b) => Math.abs((b[1] - b[2]) / b[2]) - Math.abs((a[1] - a[2]) / a[2]));
    console.log(`⚠ ${odd.length} 层和自己那一套的平均值差 6% 以上，值得看一眼（要么真是例外，要么这层的字填错/少了）：`);
    odd.slice(0, 12).forEach(([i, e, rep, c]) => console.log(`   层 ${String(i).padStart(3)}  自己量 ${String(e).padStart(5)}  本套均值 ${String(rep).padStart(5)}  ${c}  「${String(sc.layers[i].text).replace(/\s+/g, ' ').slice(0, 16)}」`));
    if (odd.length > 12) console.log(`   …另 ${odd.length - 12} 层`); }
  process.exit(0);
}

const refP = get('ref', '') || A[0];
const boardP = get('board', '');
if (!refP || !fs.existsSync(refP)) die('缺 --ref 参考图.png');
const OUT = path.resolve(get('out', 'probe'));
const T = +get('T', 24);              // 差异阈值：重采样噪声在 1~8，字边缘在 20 以上
const GAP = +get('gap', 16);          // 块之间允许的空行高
const LGAP = +get('lineGap', 4);      // 行之间允许的空行高
const MININK = +get('minInk', 24);    // 一行的墨迹像素少于此数不算一行
const COLGAP = +get('colgap', 60);    // 同一水平带里拆栏的列间距
const SHEET = +get('sheet', 8);       // 每张裁图堆几个块
const EMH = +get('emh', 0.92);        // 中文字墨迹高 ≈ 0.92 个字号
const FROM = get('from', '');         // 上一版图层稿.html：按位置把里面人核对过的文字/字体搬过来

/* ---------- PNG 解码（8bit 非隔行，colorType 0/2/3/4/6） ---------- */
function decode(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) die(`${path.basename(file)} 不是 PNG（pngOf() 没接住这个格式？看 img2png.ps1 的报错）`);
  let p = 8, ihdr = null, idat = [], pal = null, trns = null;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), data = buf.slice(p + 8, p + 8 + len);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], inter: data[12] };
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') pal = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!ihdr) die('PNG 缺 IHDR');
  if (ihdr.depth !== 8 || ihdr.inter !== 0) die('只支持 8bit 非隔行 PNG');
  const ch = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[ihdr.color];
  if (!ch) die('不支持的 colorType ' + ihdr.color);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const W = ihdr.w, H = ihdr.h, stride = W * ch, out = Buffer.alloc(H * stride);
  let q = 0;
  for (let y = 0; y < H; y++) {
    const f = raw[q++], line = raw.slice(q, q + stride); q += stride;
    const cur = out.slice(y * stride, y * stride + stride), prev = y ? out.slice((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev ? prev[x] : 0, c = prev && x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : pb <= pc ? b : c; }
      cur[x] = v & 255;
    }
  }
  /* 一律摊成 RGB 三通道，调色板/透明都在这一步解决 */
  const rgb = Buffer.alloc(W * H * 3);
  for (let i = 0, j = 0; i < W * H; i++, j += ch) {
    if (ihdr.color === 2) { rgb[i * 3] = out[j]; rgb[i * 3 + 1] = out[j + 1]; rgb[i * 3 + 2] = out[j + 2]; }
    else if (ihdr.color === 0) { rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = out[j]; }
    else if (ihdr.color === 4) { rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = out[j]; }
    else if (ihdr.color === 6) { rgb[i * 3] = out[j]; rgb[i * 3 + 1] = out[j + 1]; rgb[i * 3 + 2] = out[j + 2]; }
    else { const k = out[j]; rgb[i * 3] = pal[k * 3]; rgb[i * 3 + 1] = pal[k * 3 + 1]; rgb[i * 3 + 2] = pal[k * 3 + 2]; }
  }
  return { w: W, h: H, px: rgb };
}
/* ---------- PNG 编码（RGB、filter 0） ---------- */
const CRCT = (() => { const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t; })();
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRCT[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function writePng(file, w, h, px) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; px.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[12] = 0; ihdr[13] = 0; ihdr[14] = 0;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]));
}

/* ---------- 非 PNG 输入（webp / heic / avif）：先摊成 PNG，见 flat.cjs ---------- */
const flat = require('./flat.cjs');
let LOSSY = '';                         /* 参考图是有损格式时记一下：底噪过高会提示换 PNG，见下面差异模式那行 */
function pngOf(file, role) {
  const e = path.extname(file).toLowerCase();
  if (e !== '.png' && role === 'ref') LOSSY = e;
  try { return flat(file, { need: 'png', log: m => console.log('转格式 ' + m), off: flag('noconv') }); }
  catch (e2) { die(e2.message); } }

/* ---------- 掩码：差异模式 / 墨迹模式 ---------- */
const R0 = decode(pngOf(refP, 'ref'));
let R = R0, mask, board = null;
let RN = path.basename(refP), BN = boardP ? path.basename(boardP) : null;
if (boardP) {
  if (!fs.existsSync(boardP)) die('找不到 --board ' + boardP);
  board = decode(pngOf(boardP));
  if (board.w !== R.w || board.h !== R.h) die(`背景图 ${board.w}×${board.h} 与参考图 ${R.w}×${R.h} 尺寸不同，不能相减。请提供同尺寸背景图`);
  /* 底板白平衡：底板常常是"另外一次 AI 生成"，纸色和参考图差几个百分点，直接相减会让整片底色都亮起来，
     量出来的块全是错的（实测有人因此手写二十几个脚本重做量图，白烧 1376 秒）。
     先按逐通道中位数（背景占绝大多数，中位数就是纸色）把底板拉到参考图的白场上再比。 */
  let bal = null;
  if (!flag('nobalance')) {
    const med = a => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1] || 1; };
    const pick = img => { const v = [[], [], []];            /* 每 331 个像素取一个，三通道各一列 */
      for (let p = 0; p + 2 < img.px.length; p += 3) { if ((p / 3) % 331) continue;
        v[0].push(img.px[p]); v[1].push(img.px[p + 1]); v[2].push(img.px[p + 2]); }
      return v; };
    const vr = pick(R), vb = pick(board);
    const g = [0, 1, 2].map(c => Math.max(0.5, Math.min(2, med(vr[c]) / Math.max(1, med(vb[c])))));
    if (Math.max(...g.map(x => Math.abs(x - 1))) > 0.02) {
      for (let j = 0; j < board.px.length; j += 3) for (let c = 0; c < 3; c++)
        board.px[j + c] = Math.max(0, Math.min(255, Math.round(board.px[j + c] * g[c])));
      bal = g.map(x => Math.round(x * 100) / 100);
    }
  }
  mask = new Uint8Array(R.w * R.h);
  let n = 0;
  for (let i = 0, j = 0; i < mask.length; i++, j += 3) {
    const d = Math.max(Math.abs(R.px[j] - board.px[j]), Math.abs(R.px[j + 1] - board.px[j + 1]), Math.abs(R.px[j + 2] - board.px[j + 2]));
    if (d > T) { mask[i] = Math.min(255, d); n++; }
  }
  if (!n) die('两图没有可检测的差异：无需新增图层，或阈值过高、图片给错。背景图已有文字保持原样');
  /* --ref 和 --board 的角色固定。背景图上独有的内容稍后按差异块过滤，
     不自动交换两张图，否则会把背景图原有的字当成新增字。 */
  console.log(`差异模式 T>${T} · 差异像素 ${(100 * n / mask.length).toFixed(2)}% · ${R.w}×${R.h}`);
  /* 有损参考图（jpg/webp）在文字边缘有压缩噪声，整片纸都会"亮"起来 → 块连成一大坨。
     实测同一张 4032 菜单：无损 PNG 在 T=24 量到 322 块；只有 jpg 时 T=24 量到 6 块、T=60 才 107 块。
     不静默改阈值（阈值也影响点线那种细墨迹），但把数字和建议一并打出来，让跑的人一次决定要不要重跑。 */
  if (LOSSY && A.indexOf('--T') < 0 && 100 * n / mask.length > 4)
    console.log(`   ⚠ 参考图是 ${LOSSY}（有损）：底噪 ${(100 * n / mask.length).toFixed(1)}%，字与字之间的噪点会连成一整块。`
      + `加 --T 45 重跑一次；能要到无损 PNG 就别用 ${LOSSY}（同一版面 PNG 量到 322 块、jpg 只量到 6 块）`);
  if (bal) console.log("   底板白平衡 ×" + bal.join("/") + "：底板纸色与参考图不一致，已按逐通道中位数拉平再比（--nobalance 关掉）");
  /* 两图共有文字的像素差值为 0，属于背景图；保留原样，不生成重复图层。 */
  console.log('   口径：背景图已有的文字保持原样，不擦除、不覆盖、不补重复图层；只生成参考图比背景图多出的文字和线段。');
} else {
  /* 单图墨迹模式：先估背景亮度再定极性 */
  const lum = new Uint8Array(R.w * R.h);
  for (let i = 0, j = 0; i < lum.length; i++, j += 3)
    lum[i] = (R.px[j] * 3 + R.px[j + 1] * 6 + R.px[j + 2] * 1) >> 3;
  const hist = new Int32Array(256);
  for (let i = 0; i < lum.length; i++) hist[lum[i]]++;
  let bg = 0, bn = 0; for (let v = 0; v < 256; v++) if (hist[v] > bn) { bn = hist[v]; bg = v; }
  const dark = bg < 128;                       // 深底找亮字，浅底找暗字
  mask = new Uint8Array(R.w * R.h);
  let n = 0;
  for (let i = 0; i < lum.length; i++) { const d = dark ? lum[i] - bg : bg - lum[i]; if (d > T) { mask[i] = Math.min(255, d); n++; } }
  console.log(`墨迹模式（无底板）· 背景亮度≈${bg} → 找${dark ? '亮' : '暗'}字 · T>${T} · 墨迹 ${(100 * n / mask.length).toFixed(2)}%`);
}
const W = R.w, H = R.h;

/* ---------- 积分图 + 递归 XY 切分 ----------
   先按空行切、切不开再按空列切，再对切出来的块重复这一步。
   整页水平投影对多栏版面是没用的（五栏错开的行让每一行都有墨迹，会糊成一整块），
   所以必须递归地切，而不是「先切行再切列」走一遍。 */
const IW = W + 1, II = new Int32Array(IW * (H + 1));
for (let y = 0; y < H; y++) { let run = 0; const cur = (y + 1) * IW, prev = y * IW, r = y * W;
  for (let x = 0; x < W; x++) { run += mask[r + x] ? 1 : 0; II[cur + x + 1] = II[prev + x + 1] + run; } }
const cnt = (x0, y0, x1, y1) => (x1 < x0 || y1 < y0) ? 0 :
  II[(y1 + 1) * IW + x1 + 1] - II[y0 * IW + x1 + 1] - II[(y1 + 1) * IW + x0] + II[y0 * IW + x0];
/* 沿空行（horiz）或空列把矩形切成段；minGap = 多宽的空带才算分隔 */
function segs(x0, y0, x1, y1, horiz, minGap) {
  const n = (horiz ? y1 : x1) - (horiz ? y0 : x0) + 1, runs = [];
  let s = -1, g = 0;
  for (let i = 0; i < n; i++) {
    const ink = horiz ? cnt(x0, y0 + i, x1, y0 + i) : cnt(x0 + i, y0, x0 + i, y1);
    if (ink > 1) { if (s < 0) s = i; g = 0; }
    else if (s >= 0 && ++g >= minGap) { runs.push([s, i - g]); s = -1; g = 0; }
  }
  if (s >= 0) runs.push([s, n - 1]);
  return runs.map(r => horiz ? [x0, y0 + r[0], x1, y0 + r[1]] : [x0 + r[0], y0, x0 + r[1], y1]);
}
function boxLines(x0, y0, x1, y1) {
  const lines = []; let s = -1, g = 0;
  for (let y = y0; y <= y1; y++) {
    if (cnt(x0, y, x1, y) > 1) { if (s < 0) s = y; g = 0; }
    else if (s >= 0 && ++g > LGAP) { if (y - g - s >= 4) lines.push([s, y - g]); s = -1; g = 0; }
  }
  if (s >= 0) lines.push([s, y1]);
  return lines.filter(l => l[1] - l[0] >= 3);
}
/* 一行的列投影：返回 [起, 止, 这段里最高一列的墨迹行数]。
   引导点只有几个像素高，汉字和数字接近整行高，靠这个高度差就能把点线认出来。 */
function runsOf(x0, y0, x1, y1, tol) {
  const hit = new Int32Array(x1 - x0 + 1);
  for (let y = y0; y <= y1; y++) { const r = y * W;
    for (let x = x0; x <= x1; x++) if (mask[r + x]) hit[x - x0]++; }
  const runs = [];
  for (let i = 0; i < hit.length; i++) {
    if (!hit[i]) continue;
    let j = i, th = hit[i];
    while (j + 1 < hit.length) {
      if (hit[j + 1]) { th = Math.max(th, hit[++j]); continue; }
      let k = j + 1; while (k < hit.length && !hit[k]) k++;
      if (k < hit.length && k - j <= tol) { for (let m = j + 1; m <= k; m++) th = Math.max(th, hit[m]); j = k; }
      else break;
    }
    runs.push([x0 + i, x0 + j, th]); i = j;
  }
  return runs;
}
/* 「菜名 ……… 价格」：一段又矮又密的墨迹夹在两段正常高的字中间 */
function leaderOf(x0, y0, x1, y1) {
  const lineH = y1 - y0 + 1, runs = runsOf(x0, y0, x1, y1, 1);
  if (runs.length < 6) return null;
  const isDot = r => r[2] <= Math.max(3, lineH * 0.35) && r[1] - r[0] + 1 <= Math.max(4, lineH * 0.45);
  const dots = runs.filter(isDot), words = runs.filter(r => !isDot(r));
  if (dots.length < 4 || words.length < 2) return null;
  const dX0 = dots[0][0], dX1 = dots[dots.length - 1][1];
  if (dX1 - dX0 < lineH * 2) return null;
  const name = words.filter(r => r[1] < dX0), price = words.filter(r => r[0] > dX1);
  if (!name.length || !price.length) return null;
  /* 点线必须是连续一段：首末点之间还夹着别的字，那是好几行/好几栏被当成了一行 */
  if (words.some(r => r[0] > dX0 && r[1] < dX1)) return null;
  const pitch = []; for (let i = 1; i < dots.length; i++) pitch.push(dots[i][0] - dots[i - 1][0]);
  pitch.sort((a, b) => a - b);
  /* 点线自己占的纵向范围与点径：它要落成一条线段，端点和粗细都得从墨迹上量 */
  let dy0 = 1e9, dy1 = -1;
  for (let x = dX0; x <= dX1; x++) for (let y = y0; y <= y1; y++)
    if (mask[y * W + x]) { if (y < dy0) dy0 = y; if (y > dy1) dy1 = y; }
  return { dotX0: dX0, dotX1: dX1, nameRight: name[name.length - 1][1], priceLeft: price[0][0],
    dotY0: dy0, dotY1: dy1, dotTh: Math.max(1, dy1 - dy0 + 1), dots: dots.length,
    dotGap: pitch[pitch.length >> 1] || Math.max(3, lineH * 0.3) };
}
const leaves = [];
(function cut(x0, y0, x1, y1, d) {
  if (cnt(x0, y0, x1, y1) < MININK) return;
  if (d < 20) {
    let s = segs(x0, y0, x1, y1, true, GAP);
    if (s.length > 1) return void s.forEach(b => cut(b[0], b[1], b[2], b[3], d + 1));
    if (s.length === 1) { x0 = s[0][0]; y0 = s[0][1]; x1 = s[0][2]; y1 = s[0][3]; }
    /* 整行就是一行「菜名 ……… 价格」时，要在拆栏之前认出来：点线之间允许有 60px 以上的
       空白（引导点稀的时候），先拆栏会把一行切成菜名/价格两截。
       判据是「这个框只有一行字高」——多栏错开的版面框高是字高的十倍，不会误判。 */
    const all = runsOf(x0, y0, x1, y1, 1);
    const maxH = all.length ? Math.max(...all.map(r => r[2])) : 0;
    if (maxH && y1 - y0 + 1 <= maxH * 1.6) { const r = runsOf(x0, y0, x1, y1, 12);
      const ld = leaderOf(r[0][0], y0, r[r.length - 1][1], y1);
      if (ld && ld.dots >= 6) return void leaves.push({ x0: r[0][0], y0, x1: r[r.length - 1][1], y1, lead: ld }); }
    s = segs(x0, y0, x1, y1, false, COLGAP);
    if (s.length > 1) return void s.forEach(b => cut(b[0], b[1], b[2], b[3], d + 1));
    if (s.length === 1) { x0 = s[0][0]; y0 = s[0][1]; x1 = s[0][2]; y1 = s[0][3]; }
    /* 到这一步是一栏（或一整行）：逐行认「菜名 ……… 价格」。
       一栏里往往既有「菜名+点线+价格」也有小节标题，只要过半行有点线就按行拆开，别把整栏当成一个段落。 */
    const ls = boxLines(x0, y0, x1, y1);
    const box = ls.map(([a, b]) => { const r = runsOf(x0, a, x1, b, 12);
      return r.length ? { x0: r[0][0], x1: r[r.length - 1][1], y0: a, y1: b } : null; }).filter(Boolean);
    if (box.length) {
      const lead = box.map(b => leaderOf(b.x0, b.y0, b.x1, b.y1));
      const ok = lead.map(v => v && v.dots >= 6 ? v : null);
      if (ok.filter(Boolean).length * 2 >= box.length) {
        box.forEach((b, i) => leaves.push({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, lead: ok[i] }));
        return;
      }
    }
  }
  leaves.push({ x0, y0, x1, y1 });
})(0, 0, W - 1, H - 1, 0);
leaves.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

/* 取色：按 4bit 桶找众数，抗抗锯齿的中间色 */
function modeColor(img, y0, y1, x0, x1, keep) {
  const m = new Map();
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * W + x; if (!keep(i)) continue;
    const j = i * 3, k = (img.px[j] >> 4) + ',' + (img.px[j + 1] >> 4) + ',' + (img.px[j + 2] >> 4);
    const e = m.get(k); if (e) { e[0] += img.px[j]; e[1] += img.px[j + 1]; e[2] += img.px[j + 2]; e[3]++; } else m.set(k, [img.px[j], img.px[j + 1], img.px[j + 2], 1]);
  }
  let best = null; m.forEach(e => { if (!best || e[3] > best[3]) best = e; });
  if (!best) return '#000000';
  return '#' + [0, 1, 2].map(c => ('0' + Math.round(best[c] / best[3]).toString(16)).slice(-2)).join('');
}
/* 仅保留参考图新增的墨迹。用差异块周围两图共有的像素估计局部底色，
   看差异像素在哪张图里更像文字；明显只在背景图上的块直接忽略。 */
let ignoredBoard = 0;
if (board) for (let k = leaves.length - 1; k >= 0; k--) {
  const b = leaves[k], pad = Math.max(8, Math.min(32, Math.ceil((b.y1 - b.y0 + 1) / 2)));
  const x0 = Math.max(0, b.x0 - pad), x1 = Math.min(W - 1, b.x1 + pad);
  const y0 = Math.max(0, b.y0 - pad), y1 = Math.min(H - 1, b.y1 + pad);
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const br = rgb(modeColor(R, y0, y1, x0, x1, i => !mask[i]));
  const bb = rgb(modeColor(board, y0, y1, x0, x1, i => !mask[i]));
  let refVotes = 0, boardVotes = 0;
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) {
    const i = y * W + x; if (!mask[i]) continue;
    const j = i * 3;
    const dr = Math.max(Math.abs(R.px[j] - br[0]), Math.abs(R.px[j + 1] - br[1]), Math.abs(R.px[j + 2] - br[2]));
    const db = Math.max(Math.abs(board.px[j] - bb[0]), Math.abs(board.px[j + 1] - bb[1]), Math.abs(board.px[j + 2] - bb[2]));
    if (dr > db + 24) refVotes++;
    else if (db > dr + 24) boardVotes++;
  }
  if (boardVotes >= 12 && boardVotes > refVotes * 2) {
    leaves.splice(k, 1); ignoredBoard++;
  }
}
if (ignoredBoard) console.log(`   已忽略背景图独有的 ${ignoredBoard} 个差异块；背景图保持原样。`);
const out = [];
let skipped = 0, faint = 0;
const med2 = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
/* 竖着的列投影：竖线要按行分段，不能沿用横排的按列分段 */
function vRuns(x0, x1, y0, y1) { const runs = []; let s = -1;
  for (let y = y0; y <= y1 + 1; y++) { const on = y <= y1 && cnt(x0, y, x1, y) > 0;
    if (on) { if (s < 0) s = y; } else if (s >= 0) { runs.push([s, y - 1]); s = -1; } }
  return runs; }
/* 又细又长、而且两图差得狠的带子是「线段」（分隔线/边框/下划线/虚线），不是字。
   差得太弱的不要：AI 两次出图的色块边缘本来就会差出几个像素，那种线是噪声。 */
function lineBlock(x0, y0, x1, y1, vert) {
  const th = vert ? x1 - x0 + 1 : y1 - y0 + 1, len = vert ? y1 - y0 + 1 : x1 - x0 + 1;
  if (th > 8 || len < th * 6) return null;
  let sum = 0, n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const m = mask[y * W + x]; if (m) { sum += m; n++; } }
  if (!n || sum / n < 70) { faint++; return null; }
  const runs = vert ? vRuns(x0, x1, y0, y1) : runsOf(x0, y0, x1, y1, 1);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const b = { id: out.length + 1, kind: 'line', x0, y0, x1, y1, w: x1 - x0 + 1, inkH: th, lines: 1,
    size: th, rows: [[y0, y1]], lh: 0, color: modeColor(R, y0, y1, x0, x1, i => mask[i] >= 32),
    bg: modeColor(board || R, y0, y1, x0, x1, i => !mask[i]), th: th, style: 'solid', dash: '',
    lx0: vert ? cx : x0, ly0: vert ? y0 : cy, lx1: vert ? cx : x1, ly1: vert ? y1 : cy };
  if (runs.length > 1) {
    const rl = med2(runs.map(r => r[1] - r[0] + 1)), pit = med2(runs.slice(1).map((r, i) => r[0] - runs[i][0]));
    if (rl <= Math.max(3, th * 1.4) && pit <= th * 8) {
      /* 点线：端点落在首末那个点的中心上，dash 的「空」就是量到的点距 */
      b.style = 'dotted'; b.dash = '0.1 ' + pit;
      const f = runs[0], l = runs[runs.length - 1];
      if (vert) { b.ly0 = (f[0] + f[1]) / 2; b.ly1 = (l[0] + l[1]) / 2; }
      else { b.lx0 = (f[0] + f[1]) / 2; b.lx1 = (l[0] + l[1]) / 2; }
    } else { b.style = 'dashed'; b.dash = rl + ' ' + Math.max(1, pit - rl); }
  }
  return b;
}
leaves.forEach(L => {
  const lines = boxLines(L.x0, L.y0, L.x1, L.y1);
  const ls = (lines.length ? lines : [[L.y0, L.y1]]).map(([a, b]) => {
    const r = runsOf(a >= 0 ? L.x0 : 0, a, L.x1, b, 12);
    return r.length ? { y0: a, y1: b, x0: r[0][0], x1: r[r.length - 1][1] } : null; }).filter(Boolean);
  if (!ls.length) return;
  /* 字号用「中位行高」而不是最大行高：一行里有个括号或 g/p 下伸就会把最大值顶高半格 */
  const hs = ls.map(l => l.y1 - l.y0 + 1).sort((a, b) => a - b);
  const inkH = hs[hs.length >> 1];
  const pitch = ls.length > 1 ? (ls[ls.length - 1].y0 - ls[0].y0) / (ls.length - 1) : 0;
  const size = Math.round(inkH / EMH * 10) / 10;
  const x0 = L.lead ? L.x0 : Math.min(...ls.map(l => l.x0)), x1 = L.lead ? L.x1 : Math.max(...ls.map(l => l.x1));
  const bw = x1 - x0 + 1, bh = L.y1 - L.y0 + 1;
  /* 薄带先当线段试一次：一条横带只有一行字高、厚度只有几像素，那就是线 */
  if (Math.min(bw, bh) <= 8) { const lb = lineBlock(x0, L.y0, x1, L.y1, bw < bh);
    if (lb) { out.push(lb); return; } }
  /* 又矮又窄又没成线的：两图差别在图形上而不在字上，别当文字量 */
  if (inkH <= 5 || bw < inkH / 3) { skipped++; return; }
  /* 取字色：只取块内差异最强的一档。底板和参考图的色块本身也有差异（AI 两次出图不会完全一样），
     按固定阈值会把整块底色当成字色。 */
  const vals = [];
  for (let y = L.y0; y <= L.y1; y++) for (let x = x0; x <= x1; x++) { const m = mask[y * W + x]; if (m) vals.push(m); }
  vals.sort((a, b) => a - b);
  const cutv = vals.length ? vals[Math.floor(vals.length * 0.85)] : 255;
  const color = modeColor(R, L.y0, L.y1, x0, x1, i => mask[i] >= Math.max(cutv, 32));
  const bgc = modeColor(board || R, L.y0, L.y1, x0, x1, i => !mask[i]);
  const b = { id: out.length + 1, x0, y0: ls[0].y0, x1, y1: ls[ls.length - 1].y1, w: bw,
    inkH, size, lh: pitch ? Math.round(pitch / size * 100) / 100 : 0, lines: ls.length, color, bg: bgc,
    kind: ls.length > 1 && !L.lead ? 'para' : 'point', rows: ls };
  if (L.lead) { b.lead = L.lead; b.nameW = L.lead.nameRight - x0 + 1; b.priceW = x1 - L.lead.priceLeft + 1; }
  out.push(b);
});
/* 同一栏的价格是右对齐的：把 x0 相同的行归一组，组内统一到最右那一端，短价格自然往里缩 */
{ const grp = new Map();
  out.filter(b => b.lead).forEach(b => {
    const k = Math.round(b.x0 / 6) + ':' + Math.round((b.x1 - b.x0) / 120);
    (grp.get(k) || grp.set(k, []).get(k)).push(b); });
  grp.forEach(list => { const right = Math.max(...list.map(b => b.x1));
    if (right - Math.min(...list.map(b => b.x1)) <= list[0].size * 2)
      list.forEach(b => { b.x1 = right; b.w = right - b.x0 + 1; }); });
}
if (!out.length) die('没有需要新增的文字或线段：背景图保持原样；若参考图确有新增内容，请检查 --ref、--board 和 --T ' + T);

/* ---------- 裁图（按块堆叠成 sheet，读字用） ---------- */
fs.mkdirSync(OUT, { recursive: true });
const sheets = [];
const tb = out.filter(b => b.kind !== 'line');      // 线段没有字要认，不进裁图
/* 裁图按"一张能装多少块"堆，而不是固定每 8 块一张：读图每出一张就来回一次，14 张就是 14 轮。
   但也不能拼成一张巨图（打开会被缩小到看不清字），所以按高度预算切，明说了 --sheet N 才按块数切。 */
const MAXPX = +get('maxpx', 4200), SHEET_GIVEN = A.indexOf('--sheet') >= 0;
const stripH = bs => bs.reduce((a, b) => a + (b.y1 - b.y0 + 1) + 16, 0);
const scaleOf = bs => Math.max(1, Math.min(3, Math.floor(30 / Math.max(6, Math.min(...bs.map(b => b.inkH))))));
const packs = []; let pk = [];
try { fs.readdirSync(OUT).filter(f => /^sheet\d+\.png$/.test(f)).forEach(f => fs.unlinkSync(path.join(OUT, f))); } catch (e) { }
tb.forEach(b => { const next = pk.concat([b]);
  const over = !pk.length ? false : (SHEET_GIVEN ? next.length > SHEET : stripH(next) * scaleOf(next) > MAXPX);
  if (over) { packs.push(pk); pk = [b]; } else pk = next; });
if (pk.length) packs.push(pk);
packs.forEach((sh, si) => {
  const pad = 8, mx = Math.max(...sh.map(b => b.w + 2 * pad));
  const hh = stripH(sh);
  const sc = scaleOf(sh);
  const px = Buffer.alloc(mx * sc * hh * sc * 3);
  let oy = 0;
  sh.forEach((b, bi) => {
    const bh = (b.y1 - b.y0 + 1) + 2 * pad;
    for (let y = 0; y < bh * sc; y++) for (let x = 0; x < mx * sc; x++) {
      const j = ((oy * sc + y) * mx * sc + x) * 3;
      const sy = b.y0 - pad + Math.floor(y / sc), sx = b.x0 - pad + Math.floor(x / sc);
      let c = [255, 255, 255];
      if (sy >= 0 && sy < H && sx >= 0 && sx < W) { const k = (sy * W + sx) * 3; c = [R.px[k], R.px[k + 1], R.px[k + 2]]; }
      px[j] = c[0]; px[j + 1] = c[1]; px[j + 2] = c[2];
    }
    /* 块之间画一条分隔线，顺序即 blocks.json 顺序 */
    if (bi) for (let x = 0; x < mx * sc; x++) for (let y = 0; y < 2; y++) { const j = ((oy * sc + y) * mx * sc + x) * 3; px[j] = 0; px[j + 1] = 200; px[j + 2] = 0; }
    oy += bh;
  });
  const f = path.join(OUT, `sheet${String(si + 1).padStart(2, '0')}.png`);
  writePng(f, mx * sc, hh * sc, px);
  sheets[si] = { file: path.basename(f), ids: sh.map(b => b.id), w: mx * sc, h: hh * sc };
});

/* ---------- 样式聚类（--cluster）----------
   一份稿子里其实只有几套字号/颜色/线宽，逐块各量各的会把"同一套"量出几十个错值（抗锯齿、字数少、边缘糊）。
   这里把同类量按间隙切簇：排序后相邻两值差在 tol 以内算一簇，簇代表取**按墨迹面积加权的众数**（不是均值，
   众数才贴"设计师当时填的那个整数"，均值会被少数离群值拖走）。容差内一律吸附；
   簇内离散度（CV）超过阈值就认定"这是真差异不是噪声"，整簇不吸，只报出来让人看一眼。 */
const CLUSTER = flag('cluster'), NOSNAP = flag('nosnap');
/* --unify 才并字号。实测（4032 菜单稿，210 个文字层拿交付件真值对比）：
   AI 画的参考图里"同一档"字号本身就带 ±5% 抖动（105 个菜名的真值散在 51~61），
   逐层量出来的中位误差 0.9%，并成组内一个值就涨到 3.5% —— 并字号省的是"要复核的条目数"，
   赔的是和参考图的对位还原度，而还原度是这套东西的第一判据，所以默认不并。
   颜色/底色/线宽/点距不一样：那些本来就该是一套，并了只有好处（点线点距 16/17 混着排，进 PS 一眼看得出不齐）。 */
const UNIFY = flag('unify');
const TOL = +get('tol', 0.06);            // 切簇与吸附的相对容差
function cluster1d(items, tol) {          // items=[{v,w}] → [{rep,n,cv,idx}]
  const a = items.map((x, i) => ({ v: x.v, w: x.w, i })).filter(x => x.v > 0).sort((p, q) => p.v - q.v);
  const gs = [];
  a.forEach(x => { const g = gs[gs.length - 1];
    if (g && (x.v - g.last) <= tol * x.v) { g.it.push(x); g.last = x.v; } else gs.push({ it: [x], last: x.v }); });
  return gs.map(g => {
    const sw = g.it.reduce((s, x) => s + x.w, 0) || g.it.length;
    const mean = g.it.reduce((s, x) => s + x.v * x.w, 0) / sw;
    const cnt = new Map(); g.it.forEach(x => { const k = Math.round(x.v * 10) / 10; cnt.set(k, (cnt.get(k) || 0) + x.w); });
    let rep = mean, rw = -1; cnt.forEach((v, k) => { if (v > rw || (v === rw && Math.abs(k - mean) < Math.abs(rep - mean))) { rw = v; rep = k; } });
    const sd = Math.sqrt(g.it.reduce((s, x) => s + x.w * (x.v - mean) * (x.v - mean), 0) / sw);
    return { rep, n: g.it.length, cv: mean ? sd / mean : 0, idx: g.it.map(x => x.i) }; });
}
/* 颜色也走同一套：按亮度排序后贪心并簇，三通道都差不到 tolDist 就算一簇，代表色取面积加权均值 */
function clusterColor(items, tolDist) {
  const hx = c => [1, 3, 5].map(i => parseInt(String(c || '#000000').slice(i, i + 2), 16));
  const toHex = a => '#' + a.map(v => ('0' + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2)).join('');
  const a = items.map((x, i) => ({ c: hx(x.v), w: x.w, i })).sort((p, q) =>
    (p.c[0] + p.c[1] + p.c[2]) - (q.c[0] + q.c[1] + q.c[2]));
  const gs = [];
  a.forEach(x => { const g = gs[gs.length - 1];
    if (g && x.c.every((v, k) => Math.abs(v - g.rep[k]) <= tolDist)) { g.it.push(x);
      g.rep = g.rep.map((v, k) => (v * (g.it.length - 1) + x.c[k]) / g.it.length); }
    else gs.push({ it: [x], rep: x.c.slice() }); });
  return gs.map(g => { const sw = g.it.reduce((s, x) => s + x.w, 0) || g.it.length;
    const rep = g.it.reduce((s, x) => s.map((v, k) => v + x.c[k] * x.w, [0, 0, 0]), [0, 0, 0]).map(v => v / sw);
    return { rep: toHex(rep), n: g.it.length, idx: g.it.map(x => x.i) }; });
}
const area2 = b => Math.max(1, b.w * (b.y1 - b.y0 + 1));
const CL = [];                             // 聚类台账：{unit,rep,n,cv,loose}，最后打成一张表
if (CLUSTER) {
  const ti = tb.map(b => b.id), tx = out.filter(b => b.kind === 'line').map(b => b.id);
  const idOf = arr => arr.map(id => out.findIndex(b => b.id === id));
  const snap = (oi, pick, put, unit, tol, hard) => {
    const items = oi.map(i => ({ v: pick(out[i]), w: area2(out[i]) }));
    const gs = cluster1d(items, tol || TOL); let n = 0;
    gs.forEach(g => { const loose = g.n < 2 || g.cv > 0.15;
      if (!loose) g.idx.forEach(k => { const i = oi[k]; if (Math.abs(pick(out[i]) - g.rep) > 1e-9) n++;
        if (!NOSNAP && hard !== false) put(out[i], g.rep); });
      CL.push({ unit, rep: g.rep, n: g.n, cv: g.cv, loose, held: loose || hard === false }); });
    return n; };
  /* 字号、行距、线宽、点距：四个一维量（snap 的第 4 个参数是台账里的名字） */
  snap(idOf(ti), b => b.size, (b, v) => b.size = v, '字号', TOL, UNIFY);
  snap(idOf(ti.filter(b => b.lines > 1)), b => b.lh, (b, v) => b.lh = v, '行距', 0.08, UNIFY);
  snap(idOf(tx), b => b.th, (b, v) => b.th = v, '线宽', 0.12);
  snap(idOf(tx.filter(b => b.dash)).concat(idOf(ti.filter(b => b.lead))),
    b => b.dash ? +String(b.dash).split(/\s+/)[1] : b.lead.dotGap,
    (b, v) => { if (b.dash) { const p = String(b.dash).split(/\s+/); p[1] = v; b.dash = p.join(' '); } else b.lead.dotGap = v; }, '点距', 0.1);
  /* 颜色与底色：按色距并簇（18/255 大约是一个抗锯齿色阶） */
  const gc = clusterColor(tb.map(b => ({ v: b.color, w: area2(b) })), 18);
  gc.forEach(g => { CL.push({ unit: '字色', rep: g.rep, n: g.n, cv: 0, loose: g.n < 2 });
    if (g.n < 2 || NOSNAP) return; g.idx.forEach(k => tb[k].color = g.rep); });
  const gb = clusterColor(out.filter(b => b.bg).map(b => ({ v: b.bg, w: area2(b) })), 14);
  const bgIdx = []; out.forEach((b, i) => { if (b.bg) bgIdx.push(i); });
  gb.forEach(g => { CL.push({ unit: '底色', rep: g.rep, n: g.n, cv: 0, loose: g.n < 2 });
    if (g.n < 2 || NOSNAP) return; g.idx.forEach(k => out[bgIdx[k]].bg = g.rep); });
  /* 角色名：字号档位 + 是不是引导行的菜名/价格 + 多行段落，够用来给图层起名和按角色批量调 */
  const sorted = tb.map(b => b.size).sort((x, y) => x - y);
  const medS = sorted.length ? sorted[sorted.length >> 1] : 40;
  tb.forEach(b => { const big = b.size >= medS * 1.45;
    b.role = b.kind === 'para' ? '段落' : big ? (b.lines > 1 ? '大标题' : '标题') : b.lines > 1 ? '多行' : '文字'; });
  tx.forEach(id => { out[id].role = '线段'; });
  /* 文字层级：按字号从大到小切档（一档＝一个层级），写进图层 lv。
     容差故意放大到 18%：AI 稿同一档字号本身带 ±5% 抖动，切太细会把"同一个设计意图"拆成十几档，
     选字体就又变成逐层比选。层级是给"一次定一套"用的，不是给还原度用的（字号该不该并是另一件事）。 */
  { const gs = cluster1d(tb.map(b => ({ v: b.size, w: area2(b) })), Math.max(TOL, 0.18)).sort((a, b) => b.rep - a.rep);
    gs.forEach((g, k) => g.idx.forEach(j => { tb[j].lv = k + 1; }));
    console.log(`文字层级 ${gs.length} 档：` + gs.map((g, k) => `L${k + 1} 字号≈${g.rep}（${g.n} 块）`).join('　')); }
}

/* ---------- 图层骨架 ---------- */
const tally = (list, pick, wt) => { const m = new Map();
  list.forEach(b => { const k = pick(b), n = wt(b); m.set(k, (m.get(k) || 0) + n); });
  let best = '#000000', bn = -1; m.forEach((v, k) => { if (v > bn) { bn = v; best = k; } }); return best; };
const med = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 40; };
const area = b => b.w * (b.y1 - b.y0 + 1);
/* 一个块落成几层：纯文字 1 层；「菜名 ……… 价格」3 层（菜名 + 点线 + 价格）；线段 1 层。
   fits 记下每块里「哪个层用哪段墨迹宽校字号」，--fit 靠它对上号（层序和块序已经不一致了）。
   开了 --cluster 就顺手把角色名写进 name：214 个"?"层一眼分不清谁是谁，按角色名才能整批调。 */
const layers = [], fits = [];
out.forEach(b => {
  const li = [], nm = CLUSTER ? b.role : undefined, lv = b.lv;
  if (b.kind === 'line') {
    layers.push({ kind: 'line', name: nm, x: b.lx0, y: b.ly0, x2: b.lx1, y2: b.ly1, width: b.th, style: b.style,
      dash: b.dash || undefined, color: b.color });
  } else if (b.lead) {
    const d = b.lead, cy = Math.round((d.dotY0 + d.dotY1) / 2);
    layers.push({ kind: 'point', name: nm, lv, x: b.x0, y: b.y0, size: b.size, color: b.color, text: '?' });
    li.push([layers.length - 1, b.nameW, 1]);
    layers.push({ kind: 'line', name: CLUSTER ? '引导点线' : undefined, x: d.dotX0 + d.dotTh / 2, y: cy,
      x2: d.dotX1 - d.dotTh / 2 + 1, y2: cy,
      width: d.dotTh, style: 'dotted', dash: '0.1 ' + d.dotGap, color: b.color });
    layers.push({ kind: 'point', name: CLUSTER ? '价格' : undefined, align: 'right', lv, x: b.x1 + 1, y: b.y0, size: b.size, color: b.color, text: '?' });
    /* 价格的墨迹范围用 priceW 还原：b.x1 被"同栏右端对齐"扩过，直接拿它当右边界会吃进下一栏的菜名 */
    li.push([layers.length - 1, b.priceW, 1]);
  } else {
    const L = { kind: b.kind, name: nm, lv, x: b.x0, y: b.y0, size: b.size, color: b.color, text: '?' };
    if (b.kind === 'para') { L.w = b.w; L.lh = b.lh; }
    layers.push(L);
    li.push([layers.length - 1, b.rows.reduce((a, r) => a + (r.x1 - r.x0 + 1), 0), b.rows.length]);
  }
  fits.push(li);
});
const nl = out.length - tb.length;
const sc = { name: RN.replace(/\.[^.]+$/, ''), design: { w: W, h: H }, yink: true,
  paper: tally(out, b => b.bg, area),
  text: { font: 'Microsoft YaHei', weight: 400, size: med(tb.map(b => b.size)), lh: 1, ls: 0,
    color: tally(tb, b => b.color, area), align: 'left' },
  layers: layers };
/* 聚类之后公共值收进 text：和默认值相同的 size/color 从层里删掉。
   一来 scene.json 小一半，二来"改一个字号整类跟着动"是真的（引擎 styleOf() 就是按 text.* 兜底的）。 */
if (CLUSTER && !NOSNAP) {
  const tt = layers.filter(L => L.kind !== 'line');
  const dom = (pick) => tally(tt, pick, L => Math.max(1, (L.w || 200) * (L.size || 1)));
  sc.text.size = dom(L => L.size) || sc.text.size;
  sc.text.color = dom(L => L.color) || sc.text.color;
  let cut = 0;
  tt.forEach(L => { if (L.size === sc.text.size) { delete L.size; cut++; }
    if (L.color === sc.text.color) delete L.color; });
  console.log(`样式聚类：公共字号 ${sc.text.size}、公共色 ${sc.text.color} 收进 text，${cut} 层不再重复写 size`);
}
let fillNote = '', needFit = false; const fillSay = [];
/* ---------- --from 上一版图层稿：同一版式重出图时，字不用再读一遍 ----------
   换底板、重排、改了描边之后重新量图，字其实还是那些字 —— 再读一遍不只是那几秒，是把读错/读空的又捞回来重看一轮。
   所以按锚点把旧稿对到新层上搬过来。
   只搬「量不出来的东西」：内容 text 和字体/字重；坐标和字号仍以这次量的为准（搬旧的反而是退化）。
   旧稿坐标按新旧设计尺寸等比缩放，所以参考图换了像素密度也对得上。 */
if (FROM) {
  if (!fs.existsSync(FROM)) die('--from 找不到文件：' + FROM);
  let old = null;
  try {
    let txt = fs.readFileSync(FROM, 'utf8');
    const a = txt.indexOf('/*<<<SCENE>>>*/'), b = txt.indexOf('/*<<<END SCENE>>>*/');
    if (a < 0 || b < 0) {
      /* 也接受 probe 自己出的 scene.json：填完字再跑一次同一条命令时用它续上，不用重新读图 */
      if (!/^\s*[{[]/.test(txt)) die('--from 要指本工具出的图层稿 .html，或 probe 出的 scene.json');
      old = JSON.parse(txt);
    } else old = JSON.parse(txt.slice(a + 15, b).trim());
  } catch (e) { die('--from 读数据块失败：' + String(e.message || e).split('\n')[0]); }
  const OD = old.design || {}, kx = OD.w ? W / OD.w : 1, ky = OD.h ? H / OD.h : 1;
  const TOL2 = +get('fromtol', 14);                      // 锚点容差（设计像素）：超过就不算同一层
  const pool = (old.layers || []).map((L, i) => ({ L, i, used: false,
    x: (L.x || 0) * kx, y: (L.y || 0) * ky })).filter(o => o.L.kind !== 'line');
  /* 就近一对一：先把所有候选按距离排一遍，再按距离从小到大认领，谁也不会被两层抢走。
     这次新量出来的层照样全部来配 —— 旧稿那份是人核对过的，配上就以它为准。 */
  const cand = [];
  layers.forEach((L, i) => { if (L.kind === 'line') return;
    pool.forEach(o => { const d = Math.hypot(o.x - L.x, o.y - L.y);
      if (d <= TOL2) cand.push({ d, i, j: o.i }); }); });
  cand.sort((a, b) => a.d - b.d);
  const mine = new Map(), done = new Set();
  cand.forEach(c => { if (mine.has(c.i) || done.has(c.j)) return; mine.set(c.i, c.j); done.add(c.j); });
  let txt = 0, fnt = 0;
  mine.forEach((j, i) => { const O = (old.layers || [])[j], L = layers[i];
    if (O.text && O.text !== '?') {
      L.text = O.text; txt++; }
    ['font', 'weight'].forEach(k => { if (O[k] != null) { L[k] = O[k]; fnt++; } }); });
  const miss = layers.filter((L, i) => L.kind !== 'line' && L.text === '?').length;
  const otxt = pool.length;
  fillNote += (fillNote ? '\n' : '') + `沿用旧稿 ${path.basename(FROM)}：旧 ${otxt} 个文字层 / 新 ${layers.filter(L => L.kind !== 'line').length} 个，`
    + `按锚点（容差 ${TOL2}px）配上 ${mine.size} 对、搬进文字 ${txt} 层${fnt ? `、带字体字重 ${fnt} 处` : ''}`
    + (miss ? `；还有 ${miss} 层旧稿没配上，text 仍是 "?"（读 sheet 裁图填）` : '')
    + (mine.size ? '' : '\n   ⚠ 一层都没配上：多半是版式整体挪过、或旧稿不是同一张设计图 —— 那就别带 --from，改走另一条：读 sheet 裁图手工填');
  if (txt) needFit = true;              /* 字有了就得重算字号（--fit 按墨迹宽算，光靠墨迹高估不准） */
}
fs.writeFileSync(path.join(OUT, 'scene.json'), JSON.stringify(sc, null, 1));
fs.writeFileSync(path.join(OUT, 'blocks.json'), JSON.stringify({ ref: RN, board: BN,
  design: { w: W, h: H }, T, blocks: out, fits: fits }, null, 1));
/* 字已经填进骨架了，这一步顺手按墨迹宽重算字号（不跑这步，字号还是按墨迹高估的，差 5% 上下） */
if (needFit) {
  try {
    require('child_process').execFileSync(process.execPath, [__filename, '--fit', path.join(OUT, 'scene.json')]
      .concat(CLUSTER ? ['--cluster'] : []), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
      .split('\n').filter(l => /^(按墨迹宽|⚠)/.test(l)).forEach(l => fillSay.push('  ' + l));
    fillNote += '，并已按墨迹宽重算字号';
  } catch (e) { fillNote += '，但 --fit 没跑成：' + String(e.message || e).split('\n')[0]; }
}
if (fillNote) fillSay.unshift('\n' + fillNote);

console.log(`\n量到 ${tb.length} 块文字${nl ? ` + ${nl} 根线段` : ''}（${sheets.length} 张裁图在 ${path.relative(process.cwd(), OUT) || '.'}/）${skipped ? `，另跳过 ${skipped} 处弱差异（不是字）` : ''}${faint ? `，${faint} 处差异太淡没当线段` : ''}：`);
console.log('#  kind   x..y..尺寸            字号 行距 行 色        底色');
tb.forEach(b => console.log(`${String(b.id).padStart(3)} ${b.kind.padEnd(5)} x=${String(b.x0).padStart(4)}..${String(b.x1).padStart(4)} y=${String(b.y0).padStart(4)}..${String(b.y1).padStart(4)} h=${String(b.inkH).padStart(3)}  ${String(b.size).padStart(5)} ${String(b.lh).padStart(5)} ${String(b.lines).padStart(2)}  ${b.color} ${b.bg}${b.lead ? `  点线${b.lead.dots}个/距${b.lead.dotGap} → 拆成 菜名+线段+价格` : ''}`));
out.filter(b => b.kind === 'line').forEach(b => console.log(`${String(b.id).padStart(3)} line  (${b.lx0},${b.ly0})→(${b.lx1},${b.ly1})  粗${b.th} ${b.style}${b.dash ? ` dash=${b.dash}` : ''}  ${b.color}`));
/* 聚类台账：一屏看完"这份稿子其实只有这几套参数"，以及哪几套没被吸附（要人看的就这几个） */
if (CLUSTER && CL.length) {
  const by = new Map();
  CL.forEach(c => { const k = c.unit; if (!by.has(k)) by.set(k, []); by.get(k).push(c); });
  console.log(`\n样式聚类${NOSNAP ? '（--nosnap：只统计，没改值）' : `（容差 ${(TOL * 100).toFixed(0)}%，已吸附）`}：`);
  by.forEach((gs, unit) => {
    const tight = gs.filter(g => !g.loose && !g.held), held = gs.filter(g => g.held && !g.loose), loose = gs.filter(g => g.loose);
    console.log(`  ${String(unit).padEnd(4)} ${tight.sort((a, b) => b.n - a.n).map(g => `${g.rep}×${g.n}`).join('  ')}` +
      (held.length ? `   ${NOSNAP ? '（只统计）' : '（不并，保对位）'} ${held.sort((a, b) => b.n - a.n).slice(0, 6).map(g => `${g.rep}×${g.n}`).join(' ')}` + (held.length > 6 ? ` …共 ${held.length} 组` : '') : '') +
      (loose.length ? `   ⚠ 太散不吸 ${loose.length} 组：${loose.map(g => `${g.rep}(${g.n}个${g.cv ? ' 散' + (g.cv * 100).toFixed(0) + '%' : ''})`).join(' ')}` : '')); });
  const role = new Map(); tb.forEach(b => role.set(b.role, (role.get(b.role) || 0) + 1));
  console.log(`  角色   ${[...role].map(([k, v]) => `${k}×${v}`).join('  ')}（已写进图层 name，可整批调）`);
}
const rel = path.relative(process.cwd(), OUT) || '.';
fillSay.forEach(l => console.log(l));
/* 文件名带空格时打印出来的命令要能直接粘进 shell 跑 */
const q = s => /\s/.test(s) ? '"' + s + '"' : s;
if (needFit) {
  console.log(`\n下一步：字已填好（${FROM ? `沿用 ${path.basename(FROM)}` : '手工填的'}）、字号也按墨迹宽重算过了 —— 直接`);
  console.log(`        node scripts/build.cjs build --scene ${q(rel)}/scene.json --board ${q(BN || '底板.png')} --ref ${q(RN)} --out 稿.html --fonts auto`);
  console.log(FROM ? `        字体和字重也一并从旧稿搬过来了，通常不用再选字体；要重新选：node scripts/fontpick.cjs --scene ${q(rel)}/scene.json --ref ${q(RN)} --board ${q(BN || '底板.png')} --apply`
    : `        要抽查就读 ${q(rel)}/crops/ 里的小图（一张一层）；字体还是占位，按参考图换成本机字体（node scripts/fonts.cjs --filter 关键词）`);
} else {
console.log(`\n下一步 · 填字两条路（按顺序试）：`);
console.log(`        ① 有上一版就别读字，搬过来：node scripts/probe.cjs --ref ${q(RN)} --board ${q(BN || '底板.png')} --out ${q(rel)} --cluster --from "<上一版.html 或上一份 scene.json>"`);
console.log(`        ② 全新稿：读 ${sheets.map(s => s.file).join(' ')} 把每块的字写进 ${q(rel)}/scene.json 的 text（段落按参考图的换行处写 \\n；线段层没有字要填），`);
console.log(`           写完跑 node scripts/probe.cjs --fit ${q(rel)}/scene.json 按墨迹宽重算字号；`);
console.log(`        然后 node scripts/build.cjs build --scene ${q(rel)}/scene.json --board ${q(BN || '底板.png')} --ref ${q(RN)} --out 稿.html --fonts auto`);
console.log('        骨架里的 font 是占位，按参考图感觉换成本机字体（一条命令比完：node scripts/fontpick.cjs --scene … --ref … --apply）；weight 参考图明显是粗体就写 700。');
}
