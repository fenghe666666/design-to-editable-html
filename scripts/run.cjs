#!/usr/bin/env node
/* run.cjs —— 一条命令跑完整条转换：量图 →（填字）→ 校字号 → 定字体类别 → 建稿 → 出图 → 比还原度。
   为什么要它：挂钟几乎等于「工具调用次数 × 每次 30~60 秒的模型延迟」，实测两次转换分别是 85 次和 102 次
   调用，而脚本本身只占 5%。把六步搬进一次调用，省的是那几十次来回。

   用法：
     node scripts/run.cjs --ref 参考图.png --board 底板.png [--out probe] [--name 稿名]
          [--dpi 300] [--width 4032] [--fonts auto]
          [--from 上一版.html｜scene.json]  同一版式重出图：文字和字体从旧稿按位置搬过来，不再读字也不再选字体
          [--map 填字.txt]  直接吃 fill.cjs 的填字清单（一次跑完，不用先停一次）
          [--clamp]  填字时顺手把离本档中位数 25% 以上的字号钳回来
          [--font-groups L1:楷体,L2:仿宋]  裁图判出每档类别后直接套固定字体；省去自动字形识别
          [--reclassify-fonts]  带 --from 时重新按六类识别并映射
          [--no-fonts]  保留 scene 里现有字体
          [--exports jpg,pdf,text,psd,svg]  **默认不出**：成品图/文字层/PDF/PSD/SVG 由使用者在页面「导出…」里自己点，
                                 只有他明确要命令行版产物时才加这个参数（五样合计约 24 s、49 MB）
   默认不自动读字，所以分两段跑：第一次量完发现还有 "?" 层就停下来，只出骨架 + 裁图；
   用 fill.cjs --dump-out 生成清单，核对文字后重跑同一条命令并加 --map 填字.txt。
   参考图/底板给 webp、jpg 也行（先让系统自带的 WIC 摊成 PNG，见 flat.cjs）。
   结束时打印一份「绝对路径 + 这是什么 + 关键数字」的清单——交付就是要说这些。 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const A = process.argv.slice(2);
const get = (k, d) => { const i = A.indexOf('--' + k); return i < 0 ? d : A[i + 1]; };
const flag = k => A.indexOf('--' + k) >= 0;
const die = m => { console.error('ERR ' + m); process.exit(1); };
const REF = get('ref', ''), BOARD = get('board', '');
if (!REF || !fs.existsSync(REF)) die('缺 --ref 参考图');
if (!BOARD || !fs.existsSync(BOARD)) die('缺 --board 背景图（已有文字保持原样）');
const SK = __dirname, OUT = path.resolve(get('out', 'probe'));
const NAME = get('name', '稿'), DPI = +get('dpi', 300), WIDTH = get('width', '');
const EXPS = (get('exports', '') || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
const t0 = Date.now();
const say = m => console.log(m);
const step = (label, fn) => { const s = Date.now();
  say(`\n── ${label}`); const r = fn();
  say(`   ⏱ ${((Date.now() - s) / 1000).toFixed(1)}s`); return r; };
function node(script, args, opt) {
  try { return cp.execFileSync(process.execPath, [path.join(SK, script)].concat(args),
    Object.assign({ encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'inherit'] }, opt || {})); }
  catch (e) { die(script + ' 失败：' + String(e.message || e).split('\n')[0]); }
}
const q = s => /\s/.test(s) ? '"' + s + '"' : s;
const mb = p => (fs.statSync(p).size / 1048576).toFixed(2) + 'MB';
/* overlay.ps1 用的是 GDI+，webp/heic 它解不动 —— 比还原度前先摊成 PNG（flat.cjs 有缓存，不重复转） */
const toflat = require('./flat.cjs');
const REFF = (() => { try { return toflat(REF); } catch (e) { die(e.message); } })();

/* 1) 量图（默认不自动读字：读裁图填字是原来的办法，也是现在的默认） */
const scene = path.join(OUT, 'scene.json');
step('量图' + (get('from', '') ? ' + 沿用旧稿' : '') + ' + 校字号', () => {
  const args = ['--ref', path.resolve(REF), '--board', path.resolve(BOARD), '--out', OUT, '--cluster'];
  if (get('from', '')) args.push('--from', path.resolve(get('from')))
  /* 阈值原样转给 probe：参考图是有损 jpg 时要加 --T 45，不然量不到东西 */
  if (get('T', '')) args.push('--T', get('T'));;
  return node('probe.cjs', args);
});
let sc = JSON.parse(fs.readFileSync(scene, 'utf8'));
const blanks = s => (s.layers || []).map((L, i) => ({ L, i })).filter(o => o.L.kind !== 'line' && (!o.L.text || o.L.text === '?'));
let blank = blanks(sc);
const MAP = get('map', '');
if (blank.length && MAP) {
  if (!fs.existsSync(MAP)) die('缺 --map 填字清单');
  step('填字（按清单写进 scene，粘行顺手拆三层）', () => node('fill.cjs',
    ['--scene', scene, '--map', path.resolve(MAP)].concat(flag('clamp') ? ['--clamp'] : [])));
  sc = JSON.parse(fs.readFileSync(scene, 'utf8'));
  blank = blanks(sc);
}
if (blank.length) {
  /* 第一段到此为止：字还没填，先输出可直接执行的下一步。 */
  const sheets = fs.readdirSync(OUT).filter(f => /^sheet\d+\.png$/.test(f)).map(f => path.join(OUT, f));
  const mapFile = path.join(OUT, '填字.txt');
  say(`\n── 停在这里：还有 ${blank.length} 层没填字（层号 ${blank.slice(0, 20).map(o => o.i).join(' ')}${blank.length > 20 ? ' …' : ''}）`);
  say(`   查看裁图：${sheets.join(' ')}`);
  say(`   生成 UTF-8 清单：node ${q(path.join(SK, 'fill.cjs'))} --scene ${q(scene)} --dump-out ${q(mapFile)}`);
  say(`   填好真实文案后重跑本命令，追加 --map ${q(mapFile)}；同版式旧稿也可用 --from <上一版.html 或 scene.json>。`);
  process.exit(0);
}
const DW = (sc.design || {}).w || 0, nT = (sc.layers || []).filter(L => L.kind !== 'line').length;
const nP = (sc.layers || []).filter(L => L.kind === 'para').length, nL = (sc.layers || []).length - nT - nP;
say(`   ${sc.layers.length} 层（${nT} 点文本 · ${nP} 段落 · ${nL} 线段）· 设计 ${DW}×${(sc.design || {}).h}px`);

/* 2) 先读裁图判六类。显式给类别时直接映射；未给时做一次字形表自动粗判。
      --from 默认沿用已核对的旧稿字体。完整转换不再调用 fontpick。 */
if (flag('force-pick') || get('cands', '')) die('默认流程已改为六类直映射；请用 --font-groups "L1:楷体,L2:仿宋" 指定类别');
const groups = get('font-groups', '');
const SKIPFONT = flag('no-fonts') || flag('no-fontpick') || (get('from', '') && !groups && !flag('reclassify-fonts'));
if (SKIPFONT) say(`\n── 沿用 scene 现有字体`);
else if (groups) step('按裁图类别直接套固定字体', () => say(node('fontgroups.cjs',
  ['--scene', scene, '--groups', groups]).trim()));
else step('自动判断六类字体并直接映射（低置信度需看裁图）', () => say(node('fontid.cjs',
  ['--scene', scene, '--ref', path.resolve(REF), '--apply']).trim()));

/* 3) 建单文件稿 */
const html = path.join(OUT, NAME + '.html');
step('建稿（内联底板与参考图）', () => node('build.cjs',
  ['build', '--scene', scene, '--board', path.resolve(BOARD), '--ref', path.resolve(REF),
    '--out', html, '--dpi', String(DPI), '--fonts', get('fonts', 'auto')]));
say(`   ${html} · ${mb(html)}`);

/* 4) 出图 + 还原度（出图宽度默认＝参考图/设计宽度，别用缩放过的参考去比）
   比对用的渲染单独占一个前缀：export 出 jpg 时会把同名的中间 PNG 删掉，共用前缀会把这张吃掉。 */
const W = WIDTH || DW || 4032;
const cmpBase = path.join(OUT, NAME + '-还原度比对');
const png = cmpBase + '-' + W + 'px.png';
step('出图并和参考图比还原度', () => {
  node('export.cjs', [html, '--width', String(W), '--format', 'png', '--out', cmpBase]);
  if (!fs.existsSync(png)) die('export 没产出 ' + png);
  const r = cp.execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(SK, 'overlay.ps1'), '-Render', png, '-Ref', REFF,
    '-DiffOut', path.join(OUT, NAME + '-还原度差异热图.png')], { encoding: 'utf8' });
  say(String(r).trim().split('\n').slice(-3).join('\n'));
});

/* 5) 额外产物 */
const extra = [];
EXPS.forEach(k => step('出 ' + k, () => {
  if (k === 'jpg') { node('export.cjs', [html, '--width', String(W), '--format', 'jpg',
    '--out', path.join(OUT, NAME)]); extra.push(path.join(OUT, NAME + '-' + W + 'px.jpg')); }
  else if (k === 'text') { node('export.cjs', [html, '--width', String(W), '--layer', 'text',
    '--out', path.join(OUT, NAME + '-文字层')]); extra.push(path.join(OUT, NAME + '-文字层-' + W + 'px.png')); }
  else if (k === 'pdf') { node('export.cjs', [html, '--format', 'pdf', '--out', path.join(OUT, NAME + '-印刷')]);
    extra.push(path.join(OUT, NAME + '-印刷.pdf')); }
  else if (k === 'psd') { node('psd.cjs', [html, '--out', path.join(OUT, NAME + '-可改字.psd')]);
    extra.push(path.join(OUT, NAME + '-可改字.psd'), path.join(OUT, NAME + '-可改字-通用.psd')); }
  else if (k === 'svg') { node('svg.cjs', [html, '--out', path.join(OUT, NAME + '-分层.svg')]);
    extra.push(path.join(OUT, NAME + '-分层.svg')); }
  else say('   不认识的产品：' + k + '（可用 jpg|text|pdf|psd|svg）');
}));

/* 6) 交付清单：路径 + 是什么 + 关键数字 */
say('\n════ 产物（挂钟 ' + ((Date.now() - t0) / 1000).toFixed(0) + 's）');
[[html, `图层稿（双击打开点「编辑」改字），${sc.layers.length} 层`],
 [scene, '可改的源数据'],
 [png, `还原度比对用的 ${W}px 渲染`],
 [path.join(OUT, NAME + '-还原度差异热图.png'), '差异热图'],
].concat(extra.map(p => [p, path.extname(p) === '.psd' ? 'PSD 可改字文字层' :
  path.extname(p) === '.pdf' ? '印刷 PDF' : path.extname(p) === '.svg' ? '分层活字 SVG' : '成品图']))
  .forEach(([p, what]) => { if (!fs.existsSync(p)) return;
    say('  ' + path.resolve(p) + '   ← ' + what + ' · ' + mb(p)); });
say('  下一步：把上面这份清单原样贴给使用者。成品图 / 透明文字层 / 印刷 PDF / PSD 可改字 / 分层 SVG 都在'
  + '页面「导出…」里点（默认不替他用命令行出）；要改字体版式直接在页面里改，或改 scene.json 后重跑本命令。');
