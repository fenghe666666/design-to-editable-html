#!/usr/bin/env node
/*
  fonts.cjs —— 枚举本机已安装字体，输出家族名与真正可用的字重

    node fonts.cjs                 每行 "家族名<TAB>可用字重"
    node fonts.cjs --filter 正则   只留匹配的家族
    node fonts.cjs --json          {"fonts":[...],"faceWeights":{"家族":[400,700]},"facePs":{"家族":{"400":"Family-Regular"}},"faceFiles":{"家族":{"400":"C:\\...ttf[#序号]"}},"faceCff":{"家族":"cff|mixed"}}
    node fonts.cjs --dir 目录      追加一个字体目录
    node fonts.cjs --json --cache 路径  复用目录未变化时的完整 JSON

  为什么需要它：家族里若只有 400，写 font-weight:700 时浏览器会「合成假粗」，
  大字画成两份错位直接出重影。选字体前先查真实字重。
  做法：解析字体文件的 name 表（家族名）与 OS/2 表（usWeightClass），
  得到的家族名与 Chrome/DirectWrite 可解析的名字一致。
  facePs 是**每个字重的 PostScript 名**（name 表 nameID 6）：浏览器按家族+字重找字，Photoshop 的文字层只认
  PostScript 名，写家族名就会被替换成别的字体（版面跟着变），所以出 PSD 必须用它。
*/
const fs = require('fs'), path = require('path'), crypto = require('crypto');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--json') a.json = true;
    else if (t === '--filter') a.filter = argv[++i];
    else if (t.startsWith('--filter=')) a.filter = t.slice(9);
    else if (t === '--dir') a.dir = argv[++i];
    else if (t === '--cache') a.cache = argv[++i];
  }
  return a;
}
const A = parseArgs(process.argv.slice(2));
const WNAME = {
  thin: 100, hairline: 100, ultralight: 200, extralight: 200, light: 300,
  regular: 400, normal: 400, book: 400, medium: 500,
  semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800,
  black: 900, heavy: 900, hvy: 900, blk: 900
};
function weightFromStyle(s) {
  const t = String(s || '').toLowerCase().replace(/italic|oblique/g, ' ').trim();
  for (const k of Object.keys(WNAME)) if (new RegExp('\\b' + k + '\\b').test(t)) return WNAME[k];
  const n = parseInt(t, 10);
  return n >= 100 && n <= 900 ? n : 400;
}
function fontDirs() {
  const list = [];
  if (A.dir) list.push(A.dir);
  list.push(path.join(process.env.SystemRoot || 'C:\\Windows', 'Fonts'));
  if (process.env.LOCALAPPDATA) list.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
  return list.filter(d => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } });
}
/* --json 的完整字体目录只需解析一次；文件增删、大小或修改时间变化就失效。 */
function fontFingerprint() {
  const rows = [];
  for (const d of fontDirs()) {
    rows.push('DIR ' + d);
    for (const f of fs.readdirSync(d).sort()) {
      if (!/\.(ttf|otf|ttc|otc)$/i.test(f)) continue;
      const p = path.join(d, f);
      try { const st = fs.statSync(p); rows.push(p + '\t' + st.size + '\t' + st.mtimeMs); }
      catch (e) { rows.push(p + '\tmissing'); }
    }
  }
  return crypto.createHash('sha256').update(rows.join('\n')).digest('hex');
}
let cacheKey = '';
if (A.json && A.cache && !A.filter) {
  try {
    cacheKey = fontFingerprint();
    const saved = JSON.parse(fs.readFileSync(A.cache, 'utf8'));
    if (saved.version === 1 && saved.key === cacheKey && typeof saved.output === 'string') {
      process.stdout.write(saved.output);
      process.exit(0);
    }
  } catch (e) { /* 无缓存、目录不可读时照常扫描 */ }
}
const u16 = (b, o) => b.readUInt16BE(o);
const u32 = (b, o) => b.readUInt32BE(o);
const TAG = (b, o) => b.toString('latin1', o, o + 4);
const decBE = (b, pos, len) => {          /* name 表里的 UTF-16BE 字符串 */
  let s = '';
  for (let i = 0; i + 1 < len; i += 2) s += String.fromCharCode(b.readUInt16BE(pos + i));
  return s;
};

/* 解析一个 sfnt 字体；off 是该字体 sfnt 头的位置（TTC 内每个字体各不相同） */
function parseFont(buf, off) {
  if (off + 12 > buf.length) return null;
  const numTables = u16(buf, off + 4);
  if (!numTables || numTables > 500) return null;
  let nameOff = -1, nameLen = 0, os2Off = -1, cff = false;
  for (let i = 0; i < numTables; i++) {
    const r = off + 12 + i * 16;
    if (r + 16 > buf.length) return null;
    const tag = TAG(buf, r);
    if (tag === 'name') { nameOff = u32(buf, r + 8); nameLen = u32(buf, r + 12); }
    else if (tag === 'OS/2') os2Off = u32(buf, r + 8);
    else if (tag === 'CFF ') cff = true;        /* 轮廓类型决定 Chrome 出 PDF 时能不能嵌成真活字 */
  }
  if (nameOff < 0 || nameOff + 6 > buf.length || nameOff + nameLen > buf.length) return null;
  const count = u16(buf, nameOff + 2), storage = nameOff + u16(buf, nameOff + 4);
  const names = new Set();
  let sub = '', ps = '', psAny = '';
  for (let i = 0; i < count; i++) {
    const r = nameOff + 6 + i * 12;
    if (r + 12 > buf.length) break;
    const plat = u16(buf, r), lang = u16(buf, r + 2), id = u16(buf, r + 6);
    const len = u16(buf, r + 8), pos = storage + u16(buf, r + 10);
    if ((plat !== 3 && plat !== 0) || pos + len > buf.length) continue;
    /* 家族名有中英两份（宋体 / SimSun），浏览器两份都认，所以全部收下 */
    if (id === 1 || id === 16) names.add(decBE(buf, pos, len));
    else if (id === 2 && !sub) sub = decBE(buf, pos, len);
    /* PostScript 名是 nameID **6**（18 是 Compatible Full，长得像但不是：Arial 的 6=ArialMT、18=Arial-Regular）。
       它也有本地化副本（微软雅黑在中文记录里写成 MicrosoftYaHeiRegular），PS 按英文那条找字体，所以优先 0x0409。 */
    else if (id === 6) { const v = decBE(buf, pos, len); if (!psAny) psAny = v; if (lang === 0x409 && !ps) ps = v; }
  }
  if (!names.size) return null;
  let w = (os2Off >= 0 && os2Off + 6 <= buf.length) ? u16(buf, os2Off + 4) : 0;
  if (!w) w = weightFromStyle(sub);
  ps = ps || psAny;
  /* 没有 nameID 18 的老字体按 OpenType 惯例拼一个：家族-子家族（去掉空格） */
  if (!ps) { const fam = [...names][0] || ''; ps = fam.replace(/\s+/g, '') + (sub ? '-' + sub.replace(/\s+/g, '') : ''); }
  return [...names].map(n => ({ name: n, weight: w, ps: ps, cff: cff }));
}

function collect() {
  const map = new Map();
  /* 每个「家族＋字重」记住它来自哪个文件（内嵌子集要按这个路径去读原始字体）；TTC 记上第几个字体 */
  const add = (name, w, ps, file, idx, cff) => {
    name = String(name).replace(/^@+/, '').trim();
    if (!name) return;
    if (!map.has(name)) map.set(name, new Map());
    const m = map.get(name);
    if (!m.has(w)) m.set(w, { ps: String(ps || ''), file, idx, cff: !!cff });
  };
  let files = 0, bad = 0;
  const seen = new Set();
  for (const d of fontDirs()) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      const ext = path.extname(f).toLowerCase();
      if (!['.ttf', '.otf', '.ttc', '.otc'].includes(ext)) continue;
      const key = f.toLowerCase();
      if (seen.has(key)) continue;          /* 用户目录与系统目录同名文件只认系统 */
      seen.add(key);
      let buf;
      try { buf = fs.readFileSync(p); files++; } catch (e) { continue; }
      try {
        const t0 = buf.length >= 4 ? u32(buf, 0) : 0;
        const offs = [];
        if (TAG(buf, 0) === 'ttcf') {                       /* 字体合集 */
          const n = u32(buf, 8);
          for (let i = 0; i < n && 12 + i * 4 + 4 <= buf.length; i++) offs.push(u32(buf, 12 + i * 4));
        } else if ([0x00010000, 0x4f54544f, 0x74727565].includes(t0)) {  /* TTF / OTTO / true */
          offs.push(0);
        }
        for (let oi = 0; oi < offs.length; oi++) {
          const r = parseFont(buf, offs[oi]);
          if (r) r.forEach(x => add(x.name, x.weight, x.ps, p, oi, x.cff));
        }
      } catch (e) { bad++; }
    }
  }
  return { map, files, bad };
}

const { map, files, bad } = collect();
let names = [...map.keys()].sort((a, b) => a.localeCompare(b, 'en'));
if (A.filter) {
  let re; try { re = new RegExp(A.filter, 'i'); } catch (e) { re = new RegExp(A.filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  names = names.filter(n => re.test(n));
}
const fw = {}, fp = {}, ff = {}, fc = {};
for (const n of names) {
  const m = map.get(n);
  fw[n] = [...m.keys()].sort((a, b) => a - b);
  const o = {}, g = {}; let c = 0, t = 0;
  for (const w of fw[n]) {
    const v = m.get(w) || {};
    if (v.ps) o[w] = v.ps;
    if (v.file) g[w] = v.file + (v.idx ? '#' + v.idx : '');
    if (v.cff) c++; else t++;
  }
  if (Object.keys(o).length) fp[n] = o;
  if (Object.keys(g).length) ff[n] = g;
  if (c && !t) fc[n] = 'cff'; else if (c) fc[n] = 'mixed';
}

if (A.json) {
  const output = JSON.stringify({ fonts: names, faceWeights: fw, facePs: fp, faceFiles: ff, faceCff: fc });
  if (A.cache && cacheKey && !A.filter) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(A.cache)), { recursive: true });
      fs.writeFileSync(A.cache, JSON.stringify({ version: 1, key: cacheKey, output }), 'utf8');
    } catch (e) { /* 缓存目录不可写时不影响字体表输出 */ }
  }
  process.stdout.write(output);
} else {
  console.log(`# ${names.length} 个家族（扫描 ${files} 个字体文件${bad ? `，${bad} 个解析失败` : ''}）`);
  for (const n of names) console.log(n + '\t' + fw[n].join(','));
}
