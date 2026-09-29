#!/usr/bin/env node
/*
  export.cjs —— 用无头 Chrome 出图，渲染引擎与预览完全一致（比浏览器内 canvas 导出更准，印刷用这个）

    node export.cjs 稿.html [--out 前缀] [--width 4k|8k|16k|3840] [--format jpg|png|pdf]
                            [--layer full|text] [--quality 92]

    例：node export.cjs 稿.html --width 4k                 -> 稿-3840px.jpg
        node export.cjs 稿.html --width 8k --format png
        node export.cjs 稿.html --layer text --format png  -> 透明底文字层
        node export.cjs 稿.html --format pdf               -> 按 scene.page 的纸张出矢量 PDF
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
const PRESET = { '2k': 2048, '4k': 3840, '8k': 7680, '16k': 15360 };

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
function designOf(htmlPath) {
  const t = fs.readFileSync(htmlPath, 'utf8');
  const m = /\/\*<<<SCENE>>>\*\/([\s\S]*?)\/\*<<<END SCENE>>>\*\//.exec(t);
  if (!m) die('读不到数据块（HTML 不是本 skill 生成的，或被改坏了）');
  let sc;
  try { sc = JSON.parse(m[1]); } catch (e) { die('数据块 JSON 解析失败：' + e.message); }
  if (!sc.design || !sc.design.w || !sc.design.h) die('数据块缺少 design.w / design.h');
  return sc.design;
}

const A = args(process.argv.slice(2));
const html = A._[0] ? path.resolve(A._[0]) : null;
if (!html || !fs.existsSync(html)) die('用法: node export.cjs 稿.html [--width 4k] [--format jpg|png|pdf] [--layer full|text]');

const fmt = (A.format || 'jpg').toLowerCase();
const layer = (A.layer || 'full').toLowerCase();
const design = designOf(html);
const chrome = findChrome();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd2eh-'));
const base = A.out ? path.resolve(A.out) : html.replace(/\.html?$/i, '');
/* In the restricted Codex Windows process, Node cannot traverse USERPROFILE
   and Chrome's GPU subprocess fails. Escalated processes retain the Codex env
   marker but can traverse USERPROFILE, so keep Chrome's own sandbox there. */
function restrictedCodexProcess() {
  if (!process.env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY || !process.env.USERPROFILE) return false;
  try { fs.realpathSync(process.env.USERPROFILE); return false; }
  catch (e) { return e.code === 'EPERM'; }
}
const chromeSandbox = restrictedCodexProcess() ? ['--no-sandbox'] : [];

let bin;
if (fmt === 'pdf') {
  bin = base + '.pdf';
  const a = ['--headless=new', '--disable-gpu', ...chromeSandbox, '--no-pdf-header-footer', '--virtual-time-budget=20000',
    '--user-data-dir=' + tmp, '--print-to-pdf=' + bin, 'file:///' + html.replace(/\\/g, '/') + '#export'];
  const r = cp.spawnSync(chrome, a, { encoding: 'utf8' });
  if (!fs.existsSync(bin)) {
    fs.rmSync(bin, { force: true });
    a[0] = '--headless';
    cp.spawnSync(chrome, a, { encoding: 'utf8' });
  }
} else {
  const W = PRESET[String(A.width || '4k').toLowerCase()] || parseInt(A.width, 10) || 3840;
  const H = Math.round(W * design.h / design.w);
  if (W * H > 400e6) die(`目标 ${W}x${H} 超过无头渲染上限，请降尺寸`);
  const png = base + `-${W}px${layer === 'text' ? '-文字层' : ''}.png`;
  const url = 'file:///' + html.replace(/\\/g, '/') + '#export' + (layer === 'text' ? '&text' : '');
  const run = headless => {
    const a = [headless, '--disable-gpu', ...chromeSandbox, '--hide-scrollbars', '--force-device-scale-factor=1',
      '--virtual-time-budget=20000', '--user-data-dir=' + tmp,
      '--window-size=' + W + ',' + H, '--screenshot=' + png, url];
    if (layer === 'text') a.push('--default-background-color=00000000');
    return cp.spawnSync(chrome, a, { encoding: 'utf8' });
  };
  let r = run('--headless=new');
  if (!fs.existsSync(png)) { fs.rmSync(png, { force: true }); r = run('--headless'); }
  if (!fs.existsSync(png)) die('截图失败：' + ((r.stderr || r.stdout || '').split('\n').slice(-4).join(' ') || '无输出'));
  if (fmt === 'jpg') {
    bin = png.replace(/\.png$/, '.jpg');
    const ps = ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'tojpg.ps1'), '-Png', png, '-Jpg', bin, '-Quality', String(A.quality || 92)];
    if (layer === 'text') ps.push('-Background', String(A.bg || '#ffffff'));
    const jr = cp.spawnSync(ps[0], ps.slice(1), { encoding: 'utf8' });
    if (!fs.existsSync(bin)) die('JPG 转换失败：' + (jr.stderr || jr.stdout));
    fs.rmSync(png, { force: true });
  } else bin = png;
}
fs.rmSync(tmp, { recursive: true, force: true });
if (!fs.existsSync(bin)) die('导出失败，未生成文件');
const sz = fs.statSync(bin).size;
console.log(`OK ${bin}\n   ${fmt.toUpperCase()}${layer === 'text' ? ' · 仅文字层' : ''} · ${(sz / 1048576).toFixed(2)}MB`);
