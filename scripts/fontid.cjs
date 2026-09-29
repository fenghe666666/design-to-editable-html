#!/usr/bin/env node
/* fontid.cjs —— 把参考图的各字号档直接归入宋、黑、圆、楷、隶、仿宋六类，
   再用每类固定的本机字体，不逐一渲染整页比选。

   两个信号，从强到弱：
     ① 逐字比字形（要字已经填进 scene）：用系统自带的 GDI+ 把「候选字体 × 已知字符」画成一张表格图，
        每格按墨迹外接框归一到 32×32，再把参考图里同一行字切成单字、同样归一化，比 IoU。
        六类代表字体一次画完，只用于判类别；输出字体由 fontgroups.cjs 的固定映射决定。
     ② 笔画几何（字还没填也能给个方向）：横着扫得到竖画的宽、竖着扫得到横画的宽。
        本机实测：宋体/新宋体/华文中宋 56px 上比值 0.4~0.67（横细竖粗），黑体/微软雅黑 0.8~1.0（等粗）；
        仿宋、楷体、以及 30px 以下的任何字体，比值都贴着 1.0 —— 几何只分得出「是不是宋体那一类」，
        分不出细的三家，所以它只在字还没填时用来缩方向，不当结论。

   用法：
     node scripts/fontid.cjs --scene probe/scene.json [--blocks blocks.json] [--ref 参考图.png]
          [--max 18]        单次字形表的字体上限（六类始终优先各占一席）
          [--pool 宋体,黑体]  自己指定候选（跳过自动列表）
          [--chars 30]      比字形最多用多少个字
          [--lv 1,2]        只认这几档字号（层级）
          [--noglyph]       不比字形，只出笔画几何
          [--nopool] [--pct]  标定/排障用（--nopool 连字体表都不枚举）
   输出：每档字号的类别、映射字体和把握度 + fontid.json。--apply 直接写入 scene。 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');
const fontgroups = require('./fontgroups.cjs');
const A = process.argv.slice(2);
const get = (k, d) => { const i = A.indexOf('--' + k); return i < 0 ? d : A[i + 1]; };
const die = m => { console.error('ERR ' + m); process.exit(1); };
const SCENE = get('scene', path.join('probe', 'scene.json'));
if (!fs.existsSync(SCENE)) die('找不到 --scene ' + SCENE);
const OUT = path.dirname(path.resolve(SCENE));
const BJ = get('blocks', path.join(OUT, 'blocks.json'));
const MAX = +get('max', 18), MAXCH = +get('chars', 30);
const QUIET = A.indexOf('--quiet') >= 0;
const say = m => { if (!QUIET) console.log(m); };
const LVW = (get('lv', '') || '').split(',').filter(x => /^\d+$/.test(x)).map(Number);
const rd = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const node = (s, args) => cp.execFileSync(process.execPath, [path.join(__dirname, s)].concat(args),
  { encoding: 'utf8', maxBuffer: 1 << 28 });
const med = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

const sc = rd(SCENE);
if (!fs.existsSync(BJ)) die('要同一次 probe 的 blocks.json 才量得到每段墨迹框：' + BJ);
const jd = rd(BJ);
/* blocks.json 里的 ref 常常只剩个文件名，所以在 scene/blocks 的上下层目录里找同名（扩展名可换）的一份 */
function findRef(p) {
  if (!p) return '';
  if (fs.existsSync(p)) return p;
  const b = path.basename(p), stem = b.replace(/\.[^.]+$/, '');
  for (const d of [OUT, path.dirname(OUT), process.cwd(), path.join(process.cwd(), 'probe')]) {
    for (const f of [b, stem, stem + '.png', stem + '.jpg', stem + '.jpeg', stem + '.webp', stem + '.bmp']) {
      const j = path.join(d, f); if (fs.existsSync(j)) return j;
    }
  }
  return '';
}
const REF = findRef(get('ref', '') || jd.ref);
if (!REF) die('参考图找不到（blocks.json 记的是 ' + jd.ref + '），用 --ref 指一份');

/* 1) 参考图 → 灰度（flat.cjs 带缓存，webp/jpg 也吃得下） */
let img;
try { img = require('./png.cjs').decodePng(fs.readFileSync(require('./flat.cjs')(REF, { need: 'png' }))); }
catch (e) { die('解不开参考图：' + String(e.message || e).split('\n')[0]); }
const W = img.width, H = img.height, D = img.data;
const lum = new Uint8ClampedArray(W * H);
for (let i = 0, o = 0; i < W * H; i++, o += 4) lum[i] = (D[o] * 77 + D[o + 1] * 150 + D[o + 2] * 29) >> 8;
const hx = s => { const m = /^#?([0-9a-f]{6})$/i.exec(String(s || '')); return m ? parseInt(m[1], 16) : 0x101010; };
const L_ = c => { const v = hx(c); return (v >> 16 & 255) * 77 + (v >> 8 & 255) * 150 + (v & 255) * 29 >> 8; };

/* 2) 每层要量的段：lead 块分「菜名段 / 价格段」，多行的按行分开量（跨行统计会把行距算进笔画） */
const segs = [];
(jd.fits || []).forEach((ts, bi) => {
  const b = jd.blocks[bi];
  if (!b || b.kind === 'line' || !ts) return;
  ts.forEach(t => {
    const L = sc.layers[t[0]];
    if (!L || L.kind === 'line' || (LVW.length && !LVW.includes(L.lv || 1))) return;
    const w = t[1], part = b.lead ? (L.align === 'right' ? b.lead.priceLeft : b.x0) : b.x0;
    const rows = b.lead ? [b] : (b.rows || [b]);
    /* 段落按行分开量，文字也要按行配对 —— 把整段配给每一行，切出来的单字数永远对不上，
       这一层就直接被丢掉（实测多行段落全判不出）。行数配不上时宁可整层不比对，也不错配。 */
    const ln = String(L.text || '').split('\n');
    const rowTxt = rows.length === ln.length ? ln : rows.length === 1 ? [String(L.text || '')] : null;
    rows.forEach((r, ri) => {
      segs.push({ li: t[0], text: rowTxt ? rowTxt[ri] : '', lv: L.lv || 1, size: b.size, bg: b.bg,
        x0: part, x1: part + Math.max(4, w) - 1, y0: r.y0 != null ? r.y0 : b.y0, y1: r.y1 != null ? r.y1 : b.y1 });
    });
  });
});
if (!segs.length) die('一个墨迹段都没配上（scene 和 blocks.json 不是同一次 probe 的产物？）');
const inkOf = s => {                                    // 该段的墨迹判定：离它自己的底色足够远
  const base = L_(s.bg), th = Math.max(22, Math.min(80, Math.round(s.size * 0.55)));
  return (x, y) => Math.abs(lum[y * W + x] - base) > th;
};

/* 3) 信号②：笔画几何 */
function strokes(s) {
  const size = s.size;
  if (!(size > 6)) return null;
  const cap = Math.max(3, Math.round(size * 0.32));      // 比这还长的段不是笔画（连笔、字间粘连、装饰线）
  const X0 = Math.max(0, s.x0), X1 = Math.min(W - 1, s.x1), Y0 = Math.max(0, s.y0), Y1 = Math.min(H - 1, s.y1);
  if (X1 <= X0 || Y1 <= Y0) return null;
  const ink = inkOf(s), hv = [], vv = [];
  let inkPx = 0, all = 0;
  for (let y = Y0; y <= Y1; y++) { let r = 0;
    for (let x = X0; x <= X1; x++) { if (ink(x, y)) { r++; inkPx++; } else if (r) { if (r <= cap) hv.push(r); r = 0; } all++; }
    if (r && r <= cap) hv.push(r); }
  for (let x = X0; x <= X1; x++) { let r = 0;
    for (let y = Y0; y <= Y1; y++) { if (ink(x, y)) r++; else if (r) { if (r <= cap) vv.push(r); r = 0; } }
    if (r && r <= cap) vv.push(r); }
  const dens = all ? inkPx / all : 0;
  if (hv.length < 12 || vv.length < 12 || dens < 0.04 || dens > 0.62) return null;
  return { vh: avg(hv), hh: avg(vv), n: Math.min(hv.length, vv.length), dens, size: s.size };
}

/* 4) 信号①：单字切格 + 归一化到 32×32 二值 */
const N = 32;
function normAt(box, ink) {                               // 墨迹外接框 → 32×32 覆盖率，再 0.5 二值化
  let bx0 = 1e9, bx1 = -1, by0 = 1e9, by1 = -1;
  for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) if (ink(x, y)) {
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
  if (bx1 <= bx0 || by1 <= by0) return null;
  const g = new Uint8Array(N * N), w = bx1 - bx0 + 1, h = by1 - by0 + 1;
  const cnt = new Uint16Array(N * N), tot = new Uint16Array(N * N);
  for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
    const i = Math.min(N - 1, Math.floor((x - bx0) * N / w)), j = Math.min(N - 1, Math.floor((y - by0) * N / h));
    tot[j * N + i]++; if (ink(x, y)) cnt[j * N + i]++; }
  for (let i = 0; i < N * N; i++) g[i] = tot[i] && cnt[i] / tot[i] > 0.5 ? 1 : 0;
  let n = 0; for (let i = 0; i < N * N; i++) n += g[i];
  return n < 20 ? null : g;
}
function splitGlyphs(s) {                                 // 一段横向墨迹切成单字（按列空白断开）
  const X0 = Math.max(0, s.x0), X1 = Math.min(W - 1, s.x1), Y0 = Math.max(0, s.y0), Y1 = Math.min(H - 1, s.y1);
  if (X1 <= X0 || Y1 <= Y0) return [];
  const ink = inkOf(s), col = new Uint16Array(X1 - X0 + 1);
  for (let x = X0; x <= X1; x++) { let n = 0;
    for (let y = Y0; y <= Y1; y++) if (ink(x, y)) n++; col[x - X0] = n; }
  const gap = Math.max(1, Math.round(s.size * 0.05)), runs = [];
  for (let x = 0; x <= X1 - X0; x++) {
    if (!col[x]) continue;
    let x1 = x;
    while (x1 + 1 <= X1 - X0) { if (col[x1 + 1]) { x1++; continue; }
      let k = x1 + 1; while (k <= X1 - X0 && !col[k]) k++;
      if (k <= X1 - X0 && k - x1 <= gap) x1 = k; else break; }
    let y0 = 1e9, y1 = -1;
    for (let x2 = x; x2 <= x1; x2++) for (let y = Y0; y <= Y1; y++) if (ink(X0 + x2, y)) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 - x + 1 >= s.size * 0.28 && y1 - y0 + 1 >= s.size * 0.34) runs.push({ x0: X0 + x, x1: X0 + x1, y0, y1 });
    x = x1 + 1;
  }
  return runs;
}

/* 5) 候选字体表 */
const NOPOOL = A.indexOf('--nopool') >= 0;
const DECO = /[★【】]|\(c\)|草书|行书|手写|艺术|花|签名|长体|扁体/i;   // 隶书／魏碑是系统里的正经类别（用户会点名要），不当装饰体排掉
const CJKNAME = /(黑|宋|明|圆|楷|仿宋|隶|魏碑|等线|雅黑|苹方|冬青|Hei|Song|Ming|SimSun|Kai|Fang|LiSu|DengXian|YaHei|PingFang|Source Han|Noto|思源|霞鹜|寒蝉|Yu Gothic|Meiryo|Mincho)/i;   // 名字里带「隶／魏碑／等线」的也是系统正经类别，别被这张表挡在池外
let faces = null;
function faceList() {
  if (get('pool', '')) return get('pool').split(/[,，]/).map(s => s.trim()).filter(Boolean);
  if (NOPOOL) return [];
  if (!faces) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fontfaces-'));
    const list = path.join(tmp, 'families.txt');
    try {
      cp.execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(__dirname, 'fontfaces.ps1'), '-Out', list], { stdio: 'ignore' });
      faces = fs.readFileSync(list, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } catch (e) {
      say('GDI 字体列表读取失败，改用字体文件扫描：' + String(e.message || e).split('\n')[0]);
      try { faces = Object.keys(JSON.parse(node('fonts.cjs', ['--json'])).faceWeights || {}); }
      catch (e2) { faces = []; }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    /* GDI 把同一家族的字重也列成独立名称。常规稿排除粗/细变体，
       以免把「字重更接近」误报成「家族更接近」；粗体稿保留 Bold 变体。 */
    const weights = (sc.layers || []).filter(L => L.kind !== 'line' && L.text && L.text !== '?')
      .map(L => +((L.weight != null ? L.weight : (sc.text || {}).weight) || 400));
    const bold = med(weights) >= 600;
    const styled = bold
      ? /(?:\s|^)(?:Thin|ExtraLight|UltraLight|DemiLight|Light|Medium|Black|Heavy)$/i
      : /(?:\s|^)(?:Thin|ExtraLight|UltraLight|DemiLight|Light|Medium|SemiBold|DemiBold|Bold|ExtraBold|Black|Heavy)$/i;
    faces = faces.filter(f => !f.startsWith('.') && !/[?\uFFFD]/.test(f) && !DECO.test(f)
      && CJKNAME.test(f) && !styled.test(f));
  }
  return fontgroups.sampleFaces(faces, MAX);
}

/* 6) 几何按层级汇总；只在字形样本不足时充当粗略类别。 */
const geo = new Map();
segs.forEach(s => { const r = strokes(s); if (!r) return;
  const g = geo.get(s.lv) || { lv: s.lv, rows: [] }; g.rows.push(r); geo.set(s.lv, g); });
const levels = [...new Set((sc.layers || []).filter(L => L.kind !== 'line' && (!LVW.length || LVW.includes(L.lv || 1)))
  .map(L => L.lv || 1))].sort((a, b) => a - b);
if (!levels.length) die('scene 中没有需要识别的文字层');
const G = levels.map(lv => {
  const rows = (geo.get(lv) || { rows: [] }).rows, rr = rows.map(r => r.hh / r.vh);
  const ratio = med(rr);
  const vote = { 均匀: 0, 有对比: 0 };
  rr.forEach(v => { if (v >= 0.86) vote.均匀++; else if (v <= 0.72) vote.有对比++; });
  const hard = vote.均匀 + vote.有对比, margin = hard ? (vote.均匀 - vote.有对比) / hard : 0;
  const first = ratio <= 0.72 ? '有对比' : ratio >= 0.86 ? '均匀'
    : Math.abs(margin) >= 0.4 ? (margin > 0 ? '均匀' : '有对比') : '?';
  return { lv, n: rows.length, ratio: rows.length ? +ratio.toFixed(2) : null,
    hh: +med(rows.map(r => r.hh).sort((a, b) => a - b)).toFixed(1),
    vh: +med(rows.map(r => r.vh).sort((a, b) => a - b)).toFixed(1),
    size: +med(rows.map(r => r.size || 0)).toFixed(1),
    vote, first: rows.length ? first : '?', glyph: null, category: '', categoryRank: [], sure: false };
});
if (A.indexOf('--pct') >= 0) {
  G.forEach(r => say(`L${r.lv} ${r.n} 段 size=${r.size} 横画均宽 ${r.hh} 竖画均宽 ${r.vh} 比值 ${r.ratio} 投票 ${r.vote.均匀}/${r.vote.有对比}`));
  process.exit(0);
}

/* 7) 比字形：候选字体 × 已知字符画一张表，再和参考图切出来的单字比 IoU */
let pairs = 0, dropped = 0;
if (A.indexOf('--noglyph') < 0 && !NOPOOL) {
  const pool = faceList();
  const known = segs.filter(s => String(s.text).replace(/\s/g, '').length >= 3);
  if (!pool.length) say('候选字体表是空的，跳过比字形（--pool 宋体,黑体 可以手动给）');
  else if (!known.length) say('scene 里还没有已知的字，跳过比字形 —— 认字体要拿同一个字的形状比，先把字填进 scene 再跑');
  else {
    const freq = new Map();
    known.forEach(s => [...new Set(String(s.text).replace(/\s/g, ''))].forEach(c => freq.set(c, (freq.get(c) || 0) + 1)));
    const chars = Array.from(freq.keys()).sort((a, b) => freq.get(b) - freq.get(a)).slice(0, MAXCH);
    const pick = new Set(chars), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fontid-'));
    const wl = (f, arr) => fs.writeFileSync(path.join(tmp, f), '\ufeff' + arr.join('\n') + '\n', 'utf8');
    try {
      wl('chars.txt', chars); wl('fams.txt', pool);
      const sheet = path.join(tmp, 'sheet.png'), mmap = path.join(tmp, 'map.txt');
      cp.execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(__dirname, 'glyphsheet.ps1'), '-Chars', path.join(tmp, 'chars.txt'),
        '-Fams', path.join(tmp, 'fams.txt'), '-Out', sheet, '-Map', mmap], { encoding: 'utf8' });
      const rowsMap = [], meta = {};
      fs.readFileSync(mmap, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim()).forEach(l => {
        const p = l.split('\t');
        if (p[0] === 'cell') { meta.Cell = +p[1]; return; }
        if (p.length >= 3) rowsMap.push({ row: +p[0], family: p[1], actual: p[2] });
      });
      if (!rowsMap.length) throw new Error('表格图没画出任何一行（字体表没读进来？）');
      const S = require('./png.cjs').decodePng(fs.readFileSync(sheet));
      const SL = new Uint8ClampedArray(S.width * S.height);
      for (let i = 0, o = 0; i < SL.length; i++, o += 4) SL[i] = (S.data[o] * 77 + S.data[o + 1] * 150 + S.data[o + 2] * 29) >> 8;
      const Cell = meta.Cell, inkS = (x, y) => SL[y * S.width + x] < 160;
      const cell = new Map();                              // '族||字' → 32×32 二值
      rowsMap.forEach(rm => {
        if (rm.row < 0) return;                            // 这个名字 GDI+ 开不出来

        chars.forEach((ch, c) => {
          const g = normAt({ x0: c * Cell, x1: (c + 1) * Cell - 1, y0: rm.row * Cell, y1: (rm.row + 1) * Cell - 1 }, inkS);
          if (g) cell.set(rm.family + '||' + ch, g); });
      });
      if (!cell.size) throw new Error('表格图里一个格子都没量到墨迹（字画到格子外面了，或墨迹阈值不对）');
      const acc = new Map();                               // lv → 族 → [IoU 合计, 字数]
      known.forEach(s => {
        const cs = [...String(s.text).replace(/\s/g, '')];
        const runs = splitGlyphs(s);
        if (!runs.length || runs.length !== cs.length) { dropped++; return; }   // 切不开就丢掉这段，不猜
        const m = acc.get(s.lv) || new Map(); acc.set(s.lv, m);
        cs.forEach((ch, i) => {
          if (!pick.has(ch)) return;
          const g = normAt(runs[i], inkOf(s)); if (!g) return; pairs++;
          pool.forEach(fam => { const cg = cell.get(fam + '||' + ch); if (!cg) return;
            let i = 0, u = 0;
            for (let p = 0; p < N * N; p++) { if (g[p] && cg[p]) i++; if (g[p] || cg[p]) u++; }
            if (!u) return; const e = m.get(fam) || [0, 0]; e[0] += i / u; e[1]++; m.set(fam, e); });
        });
      });
      acc.forEach((m, lv) => {
        const r = G.find(x => x.lv === lv); if (!r) return;
        const rank = Array.from(m.entries()).map(e => [e[0], +(e[1][0] / e[1][1]).toFixed(3), e[1][1]])
          .filter(x => x[2] >= 6).sort((a, b) => b[1] - a[1]);
        if (!rank.length) return;
        r.glyph = { best: rank[0][0], score: rank[0][1], pairs: rank[0][2],
          margin: rank[1] ? +(rank[0][1] - rank[1][1]).toFixed(3) : 1, second: rank[1] ? rank[1][0] : '',
          top: rank.slice(0, 5).map(x => x[0] + ' ' + x[1]) };
        const groups = new Map();
        rank.forEach(([face, score, count]) => {
          const type = fontgroups.groupOf(face);
          if (!type) return;
          const old = groups.get(type);
          if (!old || score > old.score) groups.set(type, { type, score, pairs: count, sample: face });
        });
        r.categoryRank = [...groups.values()].sort((a, b) => b.score - a.score);
        if (!r.categoryRank.length) return;
        r.category = r.categoryRank[0].type;
        r.categoryScore = r.categoryRank[0].score;
        r.categoryMargin = r.categoryRank[1]
          ? +(r.categoryScore - r.categoryRank[1].score).toFixed(3) : 1;
        r.sure = r.categoryScore >= 0.6 && r.categoryMargin >= 0.08;
      });
    } catch (e) { say('比字形没跑成（跳过，只剩笔画几何这个方向）：' + String(e.message || e).split('\n')[0]); }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
  }
}
/* 未切出足够字形的档继承最近字号档；完全没有字形时才按笔画几何猜大类。 */
G.forEach(r => {
  if (r.category) return;
  const known = G.filter(x => x.category && x.lv !== r.lv)
    .sort((a, b) => Math.abs(a.size - r.size) - Math.abs(b.size - r.size))[0];
  if (known) { r.category = known.category; r.reason = `沿用 L${known.lv} 类别`; }
  else { r.category = r.first === '有对比' ? '宋体' : '黑体'; r.reason = '笔画几何粗判'; }
});
const installed = faces || fontgroups.installedFaces();
G.forEach(r => {
  const mapped = fontgroups.resolveFont(r.category, installed);
  r.font = mapped.font;
  r.fontInstalled = mapped.installed;
});

/* 8) 说结论 */
say('参考图：' + REF);
say(`笔画几何 ${G.reduce((a, r) => a + r.n, 0)} 段（按字号分 ${G.length} 档）`
  + (pairs ? `；字形比对用了 ${pairs} 个字，切不开丢掉 ${dropped} 段` : ''));
G.forEach(r => {
  say(`  L${r.lv} 字号≈${r.size}px ${r.n} 段：${r.category} → ${r.font}`
    + (r.sure ? `（字形 IoU ${r.categoryScore}，领先下一类 ${r.categoryMargin}）`
      : `（类别待核对${r.reason ? '；' + r.reason : r.categoryScore != null ? '；IoU ' + r.categoryScore : ''}）`));
  if (r.glyph) say(`      六类样本：${r.categoryRank.map(x => x.type + ' ' + x.score).join(' / ')}`);
});
if (G.some(r => !r.sure)) say('  低置信度类别请对照 sheet 裁图确认；需要修正时用 run --font-groups "L1:楷体,L2:仿宋"。');

const dest = get('json', path.join(OUT, 'fontid.json'));
if (A.indexOf('--nojson') < 0) {
  fs.writeFileSync(dest, JSON.stringify({ by: 'fontid.cjs', ref: REF, lv: G }, null, 1));
  say('已写 ' + dest);
}
/* --apply：每档直接套六类固定字体。低置信度留警示，不再逐家渲染整页。 */
const APPLY = A.indexOf('--apply') >= 0;
if (APPLY) {
  let set = 0;
  G.forEach(r => {
    sc.layers.forEach(L => { if (L.kind !== 'line' && (L.lv || 1) === r.lv) { L.font = r.font; set++; } });
    sc.text ||= {};
    if (r.lv === 1 || !sc.text.font) sc.text.font = r.font;
  });
  fs.writeFileSync(SCENE, JSON.stringify(sc, null, 1), 'utf8');
  say(`已按字体类别写入 ${SCENE}：${set} 层`);
}
