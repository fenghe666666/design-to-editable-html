#!/usr/bin/env node
/* 从参考图里量文字行的真实位置：按矩形区域做水平投影，找出每一行文字的 y、行高、左右边界。
   用法：node rows.cjs --image 参考图.png --rect x,y,w,h [--rect ...] [--dark 120] [--gap 6] [--minInk 20]
   多个 --rect 只解码一次图像，可一次量完全部分栏。 */
'use strict';
const fs = require('fs'), zlib = require('zlib');

function die(m) { console.error(m); process.exit(1); }
const A = process.argv.slice(2);
function get(k, d) { const i = A.indexOf('--' + k); return i < 0 ? d : A[i + 1]; }
const img = get('image', '');
if (!img || !fs.existsSync(img)) die('找不到 --image 指定的文件：' + img);
const rects = A.map((v, i) => (v === '--rect' ? A[i + 1] : null)).filter(Boolean);
if (!rects.length) die('至少要一个 --rect x,y,w,h');
const DARK = +get('dark', 120);        // max(r,g,b) 小于此值算墨迹（红牌匾 max>120，不会误判）
const GAP = +get('gap', 6);            // 相邻行之间允许的最大空白行数
const MININK = +get('minInk', 20);     // 一行的墨迹像素少于此数就不算一行（压掉杂点/细线）
const MINH = +get('minH', 6);

/* ---------- PNG 解码（8bit、非隔行、colorType 0/2/4/6） ---------- */
function decode(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) die('不是 PNG 文件（本脚本只支持 PNG，JPG 请先转 PNG）');
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
  if (ihdr.depth !== 8 || ihdr.inter !== 0) die(`只支持 8bit 非隔行 PNG（当前 depth=${ihdr.depth} interlace=${ihdr.inter}）`);
  const ch = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[ihdr.color];
  if (!ch) die('不支持的 colorType ' + ihdr.color);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const W = ihdr.w, H = ihdr.h, stride = W * ch;
  const out = Buffer.alloc(H * stride);
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
  return { w: W, h: H, ch: ch, px: out };
}
/* 统一成灰度 max(r,g,b)：彩色文字里挑最亮的通道，红色牌匾因此不会被当成黑字 */
function gray(d) {
  const g = Buffer.alloc(d.w * d.h);
  for (let i = 0, j = 0; i < d.w * d.h; i++, j += d.ch) {
    if (d.ch === 1 || d.ch === 2) g[i] = d.px[j];
    else if (d.ch === 4) g[i] = Math.max(d.px[j], d.px[j + 1], d.px[j + 2]);
    else { const k = (d.px[j] << 16 | d.px[j + 1] << 8 | d.px[j + 2]) & 0xffffff; g[i] = Math.max((k >> 16) & 255, (k >> 8) & 255, k & 255); }
  }
  return g;
}

function rowsIn(g, d, r) {
  let [x0, y0, w, h] = r.split(',').map(Number);
  x0 = Math.max(0, x0 | 0); y0 = Math.max(0, y0 | 0);
  w = Math.min(d.w - x0, w | 0); h = Math.min(d.h - y0, h | 0);
  const hit = new Uint8Array(h);
  for (let y = 0; y < h; y++) { let n = 0; const base = (y0 + y) * d.w + x0;
    for (let x = 0; x < w; x++) if (g[base + x] < DARK) n++;
    hit[y] = n; }
  const bands = [];
  let y = 0;
  while (y < h) {
    if (hit[y] < MININK) { y++; continue; }
    let y1 = y;
    while (y1 + 1 < h) { if (hit[y1 + 1] >= MININK) { y1++; continue; }
      let k = y1 + 1; while (k + 1 < h && hit[k] < MININK) k++;
      if (k < h && k - y1 <= GAP) y1 = k; else break; }
    let l = w, rr = -1, sum = 0;
    for (let yy = y; yy <= y1; yy++) { const base = (y0 + yy) * d.w + x0;
      for (let x = 0; x < w; x++) if (g[base + x] < DARK) { if (x < l) l = x; if (x > rr) rr = x; sum++; } }
    if (y1 - y + 1 >= MINH) bands.push({ top: y0 + y, bottom: y0 + y1, h: y1 - y + 1, x0: x0 + l, x1: x0 + rr, ink: sum });
    y = y1 + 1;
  }
  return bands;
}

const d = decode(fs.readFileSync(img)), g = gray(d);
/* 行内分段：把一行里的墨迹按列空白切成段（菜名 / 引导点 / 价格），用于精确量菜名的宽度。
   每段带「最高一列的墨迹行数」：引导点只有几个像素高，汉子和数字接近整行高，据此区分点和字。 */
function bandRuns(g, d, bx, y0, y1, tol) {
  const w = d.w;
  const hit = new Uint16Array(w);
  for (let x = 0; x < w; x++) { let n = 0;
    for (let y = y0; y <= y1; y++) if (g[y * d.w + x] < DARK) n++;
    hit[x] = n > 1 ? n : 0; }
  const runs = [];
  for (let x = bx.x0; x <= bx.x1; x++) {
    if (!hit[x]) continue;
    let x1 = x, th = hit[x];
    while (x1 + 1 <= bx.x1) { if (hit[x1 + 1]) { th = Math.max(th, hit[++x1]); continue; }
      let k = x1 + 1; while (k <= bx.x1 && !hit[k]) k++;
      if (k <= bx.x1 && k - x1 <= tol) { for (let j = x1 + 1; j <= k; j++) th = Math.max(th, hit[j]); x1 = k; }
      else break; }
    runs.push([x, x1, th]); x = x1 + 1;
  }
  return runs;
}
if (A.includes('--runs')) {
  const tol = +get('tol', 10);
  const out = rects.map(r => ({ rect: r, bands: rowsIn(g, d, r).map(b => ({
    y: b.top, h: b.h, runs: bandRuns(g, d, b, b.top, b.bottom, tol) })) }));
  if (A.includes('--json')) console.log(JSON.stringify(out));
  else out.forEach(o => { console.log('# rect ' + o.rect);
    o.bands.forEach(b => console.log(`  y=${String(b.y).padStart(4)} h=${String(b.h).padStart(2)}  ` +
      b.runs.map(x => `${x[0]}..${x[1]}(${x[1] - x[0] + 1}|${x[2]})`).join('  '))); });
  process.exit(0);
}

/* 分栏边界：把矩形按列做垂直投影，输出有墨迹的列段（段间空白 > colgap 就断开） */
function colsIn(r) {
  let [x0, y0, w, h] = r.split(',').map(Number);
  x0 = Math.max(0, x0 | 0); y0 = Math.max(0, y0 | 0);
  w = Math.min(d.w - x0, w | 0); h = Math.min(d.h - y0, h | 0);
  const hit = new Uint8Array(w);
  for (let x = 0; x < w; x++) { let n = 0;
    for (let y = 0; y < h; y++) if (g[(y0 + y) * d.w + x0 + x] < DARK) n++;
    hit[x] = n > 2 ? 1 : 0; }
  const runs = []; const CG = +get('colgap', 12);
  for (let x = 0; x < w; x++) {
    if (!hit[x]) continue;
    let x1 = x;
    while (x1 + 1 < w) { if (hit[x1 + 1]) { x1++; continue; }
      let k = x1 + 1; while (k + 1 < w && !hit[k]) k++;
      if (k < w && k - x1 <= CG) x1 = k; else break; }
    runs.push({ x0: x0 + x, x1: x0 + x1, w: x1 - x + 1 });
    x = x1 + 1;
  }
  return runs;
}
if (A.includes('--cols')) {
  rects.forEach(r => { console.log('# rect ' + r);
    colsIn(r).forEach(c => console.log(`  x=${String(c.x0).padStart(4)}..${String(c.x1).padStart(4)}  w=${c.w}`)); });
  process.exit(0);
}
const res = rects.map(r => ({ rect: r, bands: rowsIn(g, d, r) }));
if (rects.length === 1 && res[0].bands.length && !process.argv.includes('--json')) {
  const b = res[0].bands;
  const pitch = b.length > 1 ? Math.round((b[b.length - 1].top - b[0].top) / (b.length - 1) * 10) / 10 : b[0].h;
  console.log(`# ${b.length} 行  y=${b[0].top}..${b[b.length - 1].bottom}  行距≈${pitch}`);
  b.forEach((x, i) => console.log(`${String(i).padStart(2)}  y=${String(x.top).padStart(4)} h=${String(x.h).padStart(3)}  x=${String(x.x0).padStart(4)}..${String(x.x1).padStart(4)}  w=${String(x.x1 - x.x0 + 1).padStart(4)}  ink=${x.ink}`));
} else {
  console.log(JSON.stringify(res.map(o => ({ rect: o.rect, n: o.bands.length,
    pitch: o.bands.length > 1 ? Math.round((o.bands[o.bands.length - 1].top - o.bands[0].top) / (o.bands.length - 1) * 10) / 10 : null,
    bands: o.bands.map(b => ({ y: b.top, h: b.h, x0: b.x0, x1: b.x1 })) })), null, 1));
}
