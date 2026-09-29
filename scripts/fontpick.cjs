#!/usr/bin/env node
/* fontpick.cjs —— 对候选字体逐一渲染，按参考图差值排名。默认只比较当前字号档的文字区域，
   由 blocks.json 的探测结果定位；无 blocks.json 时退回整页差值。一次命令完成多轮比选。

   用法：
     node scripts/fontpick.cjs --scene probe/scene.json --ref 参考图.png [--board 底板.png] [--html 工作稿.html]
          [--cands 宋体,寒蝉端黑宋]        不给就自动挑（本机含中文、且有稿件所需字重的家族）
          [--filter "宋|黑|楷"]            自动挑时的关键词
          [--width 4032] [--max 6] [--levels 2] [--apply] [--full-page]
   --apply 把冠军写回 scene.json 的对应字号档。

   层级：probe --cluster 会给每个文字层写 lv（1＝字号最大那档）。
   加 --levels 2 只重测第 2 档，其余层保持已定的字体。 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');
const A = process.argv.slice(2);
const get = (k, d) => { const i = A.indexOf('--' + k); return i < 0 ? d : A[i + 1]; };
const flag = k => A.indexOf('--' + k) >= 0;
const die = m => { console.error('ERR ' + m); process.exit(1); };
const SCENE = get('scene', ''), REF = get('ref', '');
if (!SCENE || !fs.existsSync(SCENE)) die('缺 --scene probe/scene.json');
if (!REF || !fs.existsSync(REF)) die('缺 --ref 参考图（要拿它比差值）');
const SK = __dirname, MAX = +get('max', 6), APPLY = flag('apply');
/* 字体评分直接解 PNG；JPG/WebP 输入先摊成 PNG。 */
const REFF = (() => { try { return require('./flat.cjs')(REF, { need: 'png' }); } catch (e) { die(e.message); } })();
const WIDTH = get('width', '4032'), W = +WIDTH;
if (!Number.isInteger(W) || W < 1) die('--width 要写像素整数，如 1024');
const LEVELS = (get('levels', '') || '').split(',').filter(x => /^\d+$/.test(x)).map(Number);
const rd = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const score = require('./fontscore.cjs');
const node = (s, args) => cp.execFileSync(process.execPath, [path.join(SK, s)].concat(args),
  { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fontpick-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { } });

/* 1) 候选字体：显式给的优先；否则从本机字体里挑——要含 CJK、要有稿件用的那个字重、优先静态 TrueType */
function fontidData() {
  if (flag('nofontid')) return null;
  const p = get('fontid', path.join(path.dirname(path.resolve(SCENE)), 'fontid.json'));
  if (!fs.existsSync(p)) return null;
  try { const j = rd(p); return (j && j.lv && j.lv.length) ? j : null; } catch (e) { return null; }
}
function pick() {
  if (get('cands', '')) return get('cands').split(/[,，]/).map(s => s.trim()).filter(Boolean);
  /* fontid.cjs 认出来的那几家优先：候选圈缩到认出的族，不再拿全库三十多家去比整页差值 */
  const fid = fontidData();
  if (fid) {
    const lvs = LEVELS.length ? LEVELS : fid.lv.map(x => x.lv);
    const pool = [];
    lvs.forEach(l => { const e = fid.lv.find(x => x.lv === l) || fid.lv[0];
      ((e && e.pool) || []).concat(e && (!e.sure || !e.glyph) ? (e.fallback || []) : [])
        .forEach(f => { if (f && !pool.includes(f)) pool.push(f); }); });
    if (pool.length) {
      console.log(`候选由 fontid.json 提供 ${Math.min(pool.length, MAX)} 家（低把握时补宋/楷/仿宋；认出：`
        + fid.lv.map(x => `L${x.lv}→${(x.glyph && x.glyph.best) || x.first || '?'}`).join(' ') + `）：${pool.slice(0, MAX).join(' / ')}`);
      return pool.slice(0, MAX);
    }
    console.log('fontid.json 没给出候选，退回全库自动挑');
  }
  const meta = JSON.parse(node('fonts.cjs', ['--json']));
  const sc = rd(SCENE), want = +((sc.text || {}).weight || 400);
  const cff = meta.faceCff || {};
  const list = Object.keys(meta.faceWeights || {}).filter(f => !f.startsWith('.') && !/[?\uFFFD]/.test(f));
  const scored = list.map(f => {
    const wt = meta.faceWeights[f] || [];
    const has = wt.some(v => Math.abs(v - want) <= 1) || wt.length === 0;
    const near = wt.length ? Math.min(...wt.map(v => Math.abs(v - want))) : 999;
    return { f, has, near, cff: !!cff[f], n: (wt || []).length };
  }).filter(x => x.has);
  /* 只当"正文候选"：名字里带 ★/【】、草书/行书/手写/艺术这类装饰体先排掉——它们能写出好看的海报，
     但拿去做菜单正文，比出来的数字没有参考价值。要试装饰体就自己 --cands 显式给。 */
  const body = get('filter', '') ? new RegExp(get('filter'))
    : /(黑|宋|明|圆|楷体|雅黑|书宋|仿宋|Hei|Song|Ming|Yuan|YaHei|PingFang|Source Han|Noto|思源|霞鹜|寒蝉|SimSun|SimHei|KaiTi|FangSong)/i;
  const deco = /[★【】]|\(c\)|草书|行书|手写|艺术|花|签名|长体|扁体|隶书|魏碑/i;
  const std = /^(宋体|黑体|微软雅黑|楷体|仿宋|新宋体|思源黑体|思源宋体|Noto Sans SC|Noto Serif SC|Source Han|Microsoft YaHei|SimSun|SimHei|KaiTi|FangSong)/i;
  const cjk = scored.filter(x => body.test(x.f) && !deco.test(x.f));
  /* 系统自带的常规家族排最前；"034-上首…"这种编号花体包往后放（能用，但不该自动顶上来） */
  cjk.sort((a, b) => (std.test(b.f) - std.test(a.f)) || (a.cff - b.cff) || (/^\d+-/.test(a.f) - /^\d+-/.test(b.f))
    || (a.near - b.near) || a.f.localeCompare(b.f));
  const out = cjk.slice(0, MAX).map(x => x.f);
  if (sc.text && sc.text.font && !out.includes(sc.text.font)) out.unshift(sc.text.font);
  return out.slice(0, MAX + 1);
}

/* 2) 一个候选换字体后出图；有 blocks.json 时只在目标字号档的文字区域算差值。 */
const baseScene = rd(SCENE), design = baseScene.design || {};
const H = Math.round(W * design.h / design.w);
const blocksPath = get('blocks', path.join(path.dirname(path.resolve(SCENE)), 'blocks.json'));
let maskInfo = null;
if (!flag('full-page') && fs.existsSync(blocksPath)) {
  try { maskInfo = score.textMask(baseScene, rd(blocksPath), LEVELS, W, H); }
  catch (e) { console.log('文字区域生成失败，退回整页比对：' + e.message); }
}
const reference = maskInfo ? score.resize(score.readPng(REFF), W, H) : null;
function measure(cand, html) {
  const sc = rd(SCENE);
  const setAll = L => { if (L.kind === 'line') return;
    if (!LEVELS.length || LEVELS.includes(L.lv || 1)) L.font = cand; };
  if (!LEVELS.length) sc.text.font = cand;
  (sc.layers || []).forEach(setAll);
  const sj = path.join(tmp, 'scene.json');
  fs.writeFileSync(sj, JSON.stringify(sc, null, 1));
  node('build.cjs', ['set', '--html', html, '--scene', sj]);
  const o = node('export.cjs', [html, '--width', WIDTH, '--format', 'png', '--out', path.join(tmp, 'r')]);
  const png = path.join(tmp, 'r-' + WIDTH + 'px.png');
  if (!fs.existsSync(png)) die('export 没出图：' + o.split('\n').slice(-2).join(' '));
  if (maskInfo) return score.compare(score.readPng(png), reference, maskInfo.mask);
  const r = cp.execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(SK, 'overlay.ps1'), '-Render', png, '-Ref', REFF,
    '-DiffOut', path.join(tmp, 'diff.png')], { encoding: 'utf8' });
  const mean = +(String(r).match(/平均通道差\s*([\d.]+)/) || [])[1];
  const pct = +(String(r).match(/明显差异像素\s*([\d.]+)%/) || [])[1];
  if (!(pct >= 0)) die('overlay 输出读不到数字：' + String(r).split('\n').slice(-3).join(' '));
  return { mean, pct };
}

const cands = pick();
if (flag('list')) { console.log('自动候选：' + cands.join(' / ')); process.exit(0); }
if (!cands.length) die('一个候选字体都没有：用 --cands 家族1,家族2 显式给');
let html = get('html', '');
if (html) { const source = path.resolve(html); html = path.join(tmp, 'work.html'); fs.copyFileSync(source, html); }
else { html = path.join(tmp, 'work.html');
  if (!fs.existsSync(get('board', '') || '')) die('第一次建工作稿要 --board 底板.png（或 --html 指一个已有稿）');
  node('build.cjs', ['build', '--scene', SCENE, '--board', get('board'), '--ref', REF, '--out', html,
    '--dpi', '300', '--fonts', 'auto']);
}
console.log(`候选 ${cands.length} 套，各渲染一遍 ${WIDTH}px 并与参考图比差值（`
  + (LEVELS.length ? `只换第 ${LEVELS.join('/')} 档` : '整页共用一套字体')
  + (maskInfo ? `；只评 ${maskInfo.regions} 个文字区域、${(maskInfo.pixels / (W * H) * 100).toFixed(1)}% 画面` : '；整页评分') + '）：');
const rows = [];
cands.forEach(c => {
  const m = measure(c, html);
  rows.push({ cand: c, ...m });
  console.log(`   ${(m.pct).toFixed(2)}% 明显差异 · 平均差 ${m.mean.toFixed(2)} · ${c}`);
});
rows.sort(maskInfo ? (a, b) => a.mean - b.mean || a.pct - b.pct : (a, b) => a.pct - b.pct);
const win = rows[0];
console.log(`\n排名：` + rows.map((r, i) => `${i + 1}) ${r.cand} ${maskInfo ? r.mean.toFixed(2) + ' 均差' : r.pct.toFixed(2) + '%'}`).join('　'));
console.log(`冠军 ${win.cand}（比第二名 ${rows[1]
  ? rows[1].cand + (maskInfo ? ' 均差低 ' + (rows[1].mean - win.mean).toFixed(2) : ' 明显差异低 ' + (rows[1].pct - win.pct).toFixed(2) + ' 个点')
  : '—'}）`);
if (APPLY) {
  const sc = rd(SCENE);
  if (!LEVELS.length || LEVELS.includes(1)) sc.text.font = win.cand;
  sc.layers.forEach(L => { if (L.kind !== 'line' && (!LEVELS.length || LEVELS.includes(L.lv || 1))) L.font = win.cand; });
  fs.writeFileSync(SCENE, JSON.stringify(sc, null, 1));
  console.log(`已把 ${win.cand} 写进 ${SCENE}` + (LEVELS.length ? `（只第 ${LEVELS.join('/')} 档）` : '（整页默认）')
    + '；工作稿记得重新 build：node scripts/build.cjs build --scene ' + SCENE + ' --board 底板.png --ref 参考图 --out 稿.html --fonts auto');
} else console.log('（没加 --apply，只报数不改文件）');
