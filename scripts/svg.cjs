#!/usr/bin/env node
/*
  svg.cjs —— 把图层稿导出成**分层 SVG**：一个图层一个 <g>，文字仍是活字

    node svg.cjs 稿.html [--out 名.svg] [--no-xml]

    例：node svg.cjs 稿.html            -> 稿.svg（底板内联，自包含单文件）

  Illustrator / Inkscape / Figma / Affinity 都能打开并逐层改。比 PSD 更稳的落点：
  SVG 的 font-size 就是用户单位，不存在"按不按文档分辨率换算 pt"这一说，各家渲染的都是同一个数字。

  排版仍由页面自己算：#svg 模式把整份 SVG 源码 base64 塞进 <pre>，--dump-dom 读走，
  所以屏幕 / 画布导出 / PSD / SVG 用的是同一套坐标（layout()/lineOf()/strokeOf()）。
*/
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');

function args(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else a._.push(argv[i]);
  }
  return a;
}
function die(m) { console.error('ERR ' + m); process.exit(1); }

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

const A = args(process.argv.slice(2));
const html = A._[0] ? path.resolve(A._[0]) : null;
if (!html || !fs.existsSync(html)) die('用法: node svg.cjs 稿.html [--out 名.svg]');

const chrome = findChrome();
function restrictedCodexProcess() {
  if (!process.env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY || !process.env.USERPROFILE) return false;
  try { fs.realpathSync(process.env.USERPROFILE); return false; }
  catch (e) { return e.code === 'EPERM'; }
}
const chromeSandbox = restrictedCodexProcess() ? ['--no-sandbox'] : [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd2svg-'));
const url = 'file:///' + html.replace(/\\/g, '/') + '#svg';
const base = head => [head, '--disable-gpu', ...chromeSandbox, '--hide-scrollbars', '--force-device-scale-factor=1',
  '--virtual-time-budget=20000', '--user-data-dir=' + tmp, '--window-size=1600,1200', '--dump-dom', url];
let out = '';
try {
  for (const head of ['--headless=new', '--headless']) {
    const r = cp.spawnSync(chrome, base(head), { encoding: 'utf8', maxBuffer: 1 << 28 });
    out = r.stdout || '';
    if (/\[\[\[SVG\]\]\]/.test(out)) break;
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

const m = /\[\[\[SVG\]\]\]([A-Za-z0-9+\/=]+)\[\[\[\/SVG\]\]\]/.exec(out);
if (!m) die('读不到 SVG：页面没能跑起来（检查 HTML 是否为本 skill 生成、有无脚本报错）');
let svg = Buffer.from(m[1], 'base64').toString('utf8');
if (A['no-xml']) svg = svg.replace(/^<\?xml[^>]*\?>\s*/, '');   /* 有的编辑器只吃纯 <svg> 片段 */

const bin = A.out ? path.resolve(String(A.out)) : html.replace(/\.html?$/i, '') + '.svg';
fs.writeFileSync(bin, svg, 'utf8');

/* 自检：组数应与数据块里的图层数一致（空文本层会被跳过，所以只报不平，不报错） */
const sm = /\/\*<<<SCENE>>>\*\/([\s\S]*?)\/\*<<<END SCENE>>>\*\//.exec(fs.readFileSync(html, 'utf8'));
let want = '?', texts = 0, groups = 0;
try { want = (JSON.parse(sm[1]).layers || []).length; } catch (e) { /* 数据块读不了就算了 */ }
groups = (svg.match(/<g id="L/g) || []).length;
texts = (svg.match(/<text /g) || []).length;
const sz = fs.statSync(bin).size;
console.log(`OK ${bin}\n   SVG · ${groups}/${want} 组 · ${texts} 段活字 · ${(sz / 1048576).toFixed(2)}MB` +
  (groups < want ? ` · 空文本层 ${want - groups} 个未出` : ''));
