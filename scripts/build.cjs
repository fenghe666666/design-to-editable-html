#!/usr/bin/env node
/*
  build.cjs —— 生成/更新单文件图层稿

    node build.cjs build --scene scene.json --board board.png --out 稿.html
          [--template assets/stage.html] [--ref reference.png] [--maxref 1600]
          [--fonts fonts.json|auto] [--page 420x297] [--dpi 300]

    node build.cjs set --html 稿.html --scene scene.json
          （只替换数据块，已内联的底图/参考图保持不变）

  约定：scene.json 里不要写 board/ref 字段，图片由本脚本内联进去。
*/
const fs = require('fs'), path = require('path'), cp = require('child_process');
const HERE = __dirname;
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

function args(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
    else a._.push(argv[i]);
  }
  return a;
}
function die(m) { console.error('ERR ' + m); process.exit(1); }
function readScene(p) {
  let t = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  t = t.replace(/\/\*<<<SCENE>>>\*\/\s*/g, '').replace(/\s*\/\*<<<END SCENE>>>\*\//g, '');
  try { return JSON.parse(t); } catch (e) { die('scene JSON 解析失败：' + e.message); }
}
function dataUri(p) {
  const ext = path.extname(p).toLowerCase();
  if (!MIME[ext]) die('不支持的底图格式：' + ext);
  return 'data:' + MIME[ext] + ';base64,' + fs.readFileSync(p).toString('base64');
}
/* webp / heic 这类 GDI+ 解不动的格式，先让系统自带的 WIC 转成 PNG（flat.cjs，和 probe 共用一份缓存），
   这样 AI 工具发下来的 webp 底板/参考图不用人先手工转一道。 */
const toflat = require('./flat.cjs');
function flat(p) { try { return toflat(p, { log: m => console.log('   转格式 ' + m) }); } catch (e) { die(e.message); } }
function ps(script, params) {
  const full = path.join(HERE, script);
  const r = cp.spawnSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', full].concat(params),
    { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) die(script + ' 失败：\n' + (r.stderr || r.stdout || r.error || ''));
  return (r.stdout || '').trim();
}
function node(script, params) {
  const r = cp.spawnSync(process.execPath, [path.join(HERE, script)].concat(params),
    { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) die(script + ' 失败：\n' + (r.stderr || r.error || ''));
  return (r.stdout || '').trim();
}
/* 每个图层单独一行，方便人和 AI 做单行修改 */
function sceneText(sc) {
  /* 值为 undefined 的键必须跳过：JSON.stringify(undefined) 返回的是 undefined 本身，
     拼进字符串就变成 "cff": undefined —— 数据块直接不是合法 JSON（export/psd 全都读不出来） */
  const keys = Object.keys(sc).filter(k => k !== 'layers' && sc[k] !== undefined);
  const out = ['{'];
  keys.forEach(k => out.push('  ' + JSON.stringify(k) + ': ' + JSON.stringify(sc[k]) + ','));
  const ls = sc.layers || [];
  out.push('  "layers": [');
  ls.forEach((L, i) => out.push('    ' + JSON.stringify(L) + (i < ls.length - 1 ? ',' : '')));
  out.push('  ]');
  out.push('}');
  return out.join('\n');
}
/* 用标记锚定数据块，避免误匹配文档里出现的同名标签文本 */
const BLOCK = /<script id="scene" type="application\/json">\s*\/\*<<<SCENE>>>\*\/([\s\S]*?)\/\*<<<END SCENE>>>\*\/\s*<\/script>/;
function inject(html, sc) {
  const hits = html.match(new RegExp(BLOCK.source, 'g')) || [];
  if (!hits.length) die('模板里找不到数据块（<script id="scene">…/*<<<SCENE>>>*/），请确认 --template 没被改坏');
  if (hits.length > 1) die('发现多个数据块，HTML 被改坏了，请用模板重新 build');
  const body = '<script id="scene" type="application/json">\n/*<<<SCENE>>>*/\n' + sceneText(sc) + '\n/*<<<END SCENE>>>*/\n</script>';
  return html.replace(BLOCK, () => body);   // 用函数替换，避免 $& 之类被当成捕获组
}
function mb(n) { return (n / 1048576).toFixed(2) + 'MB'; }
/* 图层构成 + 线段字段体检，写错的坐标会让线画到屏幕外 */
function tally(sc) {
  const n = { point: 0, para: 0, line: 0, row: 0, other: 0, stroke: 0 };
  const bad = [];
  const OPT = { ostyle: ['solid', 'dashed', 'dotted', 'dashdot', 'longdash'],
                opos: ['center', 'outside', 'inside'], ocap: ['butt', 'round', 'square'],
                ojoin: ['miter', 'round', 'bevel'] };
  (sc.layers || []).forEach((L, i) => {
    const k = L.kind === 'para' || L.kind === 'line' || L.kind === 'row' ? L.kind
      : !L.kind || L.kind === 'point' ? 'point' : 'other';
    n[k]++;
    if (L.kind === 'line') {
      if (!isFinite(+L.x) || !isFinite(+L.y)) bad.push(`#${i + 1} 线段缺 x/y`);
      if (!isFinite(+L.x2) && !isFinite(+L.len)) bad.push(`#${i + 1} 线段没有 x2 也没有 len，不知道画到哪`);
      if (L.width != null && !(+L.width > 0)) bad.push(`#${i + 1} 线段 width=${L.width}`);
      const STYLES = ['solid', 'dashed', 'dotted', 'dashdot', 'longdash'];
      if (L.style && !STYLES.includes(L.style)) bad.push(`#${i + 1} 线段 style=${L.style}（可用 ${STYLES.join('/')}）`);
      if (L.cap && !['butt', 'round', 'square'].includes(L.cap)) bad.push(`#${i + 1} 线段 cap=${L.cap}（可用 butt/round/square）`);
    } else if (+L.ow > 0) {
      n.stroke++;
      /* 描边字段写错不会报错，只会安静地按默认值画，所以在这里拦一下 */
      Object.keys(OPT).forEach(p => { if (L[p] && !OPT[p].includes(L[p])) bad.push(`#${i + 1} 描边 ${p}=${L[p]}（可用 ${OPT[p].join('/')}）`); });
    }
    if (L.kind === 'para' && !isFinite(+L.w)) bad.push(`#${i + 1} 段落缺 w`);
    if (L.kind !== 'line' && L.direction && !['horizontal', 'vertical'].includes(L.direction))
      bad.push(`#${i + 1} 文本方向 direction=${L.direction}（可用 horizontal/vertical）`);
  });
  if (bad.length) console.log('WARN ' + bad.slice(0, 8).join('\n   ') + (bad.length > 8 ? `\n   …共 ${bad.length} 处` : ''));
  return `${n.point} 点文本 · ${n.para} 段落 · ${n.line} 线段` +
    (n.stroke ? `（${n.stroke} 层带轮廓描边）` : '') +
    (n.row ? ` · ${n.row} 旧价格行（打开时自动拆成 点文本+线段+点文本）` : '') +
    (n.other ? ` · ${n.other} 未知类型` : '');
}

const A = args(process.argv.slice(2));
const cmd = A._[0];

if (cmd === 'build') {
  if (!A.scene || !A.board || !A.out) die('用法: build --scene s.json --board b.png --out o.html');
  const tpl = path.resolve(A.template || path.join(HERE, '..', 'assets', 'stage.html'));
  if (!fs.existsSync(tpl)) die('模板不存在：' + tpl);
  const sc = readScene(path.resolve(A.scene));

  sc.design = sc.design || {};
  const board = flat(A.board), refImg = A.ref ? flat(A.ref) : '';
  const dim = ps('shrink.ps1', [board]).split('x');
  if (!sc.design.w || !sc.design.h) { sc.design.w = +dim[0]; sc.design.h = +dim[1]; }
  sc.board = dataUri(board);

  if (refImg) {
    const maxw = +(A.maxref || 1600);
    const tmp = path.resolve(A.out) + '.ref.tmp.jpg';
    ps('shrink.ps1', [refImg, tmp, String(maxw)]);
    sc.ref = dataUri(tmp);
    fs.unlinkSync(tmp);
  }
  if (A.page) { const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/i.exec(A.page); if (!m) die('--page 写成 420x297'); sc.page = { wmm: +m[1], hmm: +m[2] }; }
  else if (A.dpi) sc.page = { wmm: +(sc.design.w / +A.dpi * 25.4).toFixed(1), hmm: +(sc.design.h / +A.dpi * 25.4).toFixed(1) };

  let meta = null;                                  /* 轮廓体检在下面还要用，提到外层 */
  if (A.fonts) {
    const j = A.fonts === 'auto' ? node('fonts.cjs', ['--json', '--cache',
      path.join(process.cwd(), '.codex-skill-runtime', 'font-catalog.json')]) : fs.readFileSync(path.resolve(A.fonts), 'utf8');
    try { meta = JSON.parse(j); } catch (e) { die('--fonts 内容不是 fonts.cjs --json 的输出'); }
    if (Array.isArray(meta)) sc.fonts = meta;
    else { sc.fonts = meta.fonts || []; if (meta.faceWeights) sc.faceWeights = meta.faceWeights; }
    /* 以 . 开头的隐藏族、名字里带 ? 的残缺别名在浏览器里根本选不中，别内联进交付文件（白占几十 KB） */
    const junk = f => !f || f.length < 2 || f[0] === '.' || /[?\uFFFD]/.test(f);
    const n0 = sc.fonts.length;
    sc.fonts = sc.fonts.filter(f => !junk(f));
    if (sc.faceWeights) Object.keys(sc.faceWeights).forEach(f => { if (junk(f)) delete sc.faceWeights[f]; });
    /* PSD 的文字层只认 **PostScript 名**（写家族名会被 PS 换成别的字体，版面跟着跑偏；
       写中文家族名更糟 —— PS 直接报"无法读取这些文字图层"并把它们栅格化）。
       以前只存稿件用到的那几个，但用户在页面里换字体是常事，换到一个没登记的家庭就踩这个坑，
       所以整张表都存进来（约 209KB，占 6.4MB 稿子的 3%）：换任何本机字体，PSD 里都是真 PS 名。 */
    if (meta.facePs) {
      const fp = {};
      sc.fonts.forEach(f => { if (meta.facePs[f]) fp[f] = meta.facePs[f]; });
      (sc.layers || []).forEach(L => { if (L.font && meta.facePs[L.font]) fp[L.font] = meta.facePs[L.font]; });
      if (Object.keys(fp).length) sc.facePs = fp;
    }
    console.log(`   字体表 ${sc.fonts.length} 个可用家族（剔除 ${n0 - sc.fonts.length} 个选不中的隐藏/残缺别名）`);
  }

  /* 字重体检：单字重字体写 700 会被浏览器合成假粗，大字直接出重影 */
  if (sc.faceWeights) {
    const near = (list, w) => list.reduce((a, b) => Math.abs(b - w) < Math.abs(a - w) ? b : a, list[0]);
    const bad = new Map();
    (sc.layers || []).forEach((L, i) => {
      if (L.kind === 'line') return;                       // 线段没有字体字重，不参与字重体检
      const fam = L.font || (sc.text || {}).font, wt = L.weight != null ? L.weight : (sc.text || {}).weight;
      const have = sc.faceWeights[fam];
      if (have && wt != null && !have.includes(+wt)) {
        const k = fam + '|' + wt;
        if (!bad.has(k)) bad.set(k, { fam, wt: +wt, have, n: 0, first: i + 1 });
        bad.get(k).n++;
      }
    });
    const top = (sc.text || {}).weight;
    if (sc.faceWeights[(sc.text || {}).font] && top != null && !sc.faceWeights[sc.text.font].includes(+top))
      bad.set(sc.text.font + '|' + top, { fam: sc.text.font, wt: +top, have: sc.faceWeights[sc.text.font], n: '默认', first: 0 });
    if (bad.size) {
      const msg = [...bad.values()].map(b =>
        `${b.fam} 没有 ${b.wt} 字重（只有 ${b.have.join('/')}）：${b.n === '默认' ? '全局默认' : `#${b.first} 起 ${b.n} 处`}，浏览器会合成假粗出重影 → 改 ${near(b.have, b.wt)} 或换有 ${b.wt} 的字体`);
      console.log('WARN 字重不可用：\n   ' + msg.join('\n   '));
    }
  }

  /* 轮廓类型体检：Chrome 打印 PDF 只把**静态 TrueType**（glyf）嵌成 CIDFontType2 活字；
     CFF(.otf)、可变字体、以及内联的 @font-face 子集一律写成 Type3 —— 显示/印刷/搜索都正常，
     但 Illustrator 打开多半转成轮廓。这里只做提醒，改不改字体由用户定（分层 SVG 不受影响）。 */
  if (meta.faceCff) {
    const used = new Set([((sc.text || {}).font)]);
    (sc.layers || []).forEach(L => { if (L.font && L.kind !== 'line') used.add(L.font); });
    const cff = [...used].filter(f => f && meta.faceCff[f]);
    if (cff.length) {
      sc.cff = cff;
      console.log(`WARN 这些家族是 CFF/可变轮廓：${cff.join('、')} —— 印刷 PDF 里文字会被写成 Type3（显示、印刷、搜索都正常，Illustrator 打开多半转轮廓）。` +
        '\n   要在别的软件里逐层改字就用「SVG（分层·活字）」；要让 PDF 里也是可改的活字，就换成**静态 TrueType** 字体（本机如 黑体 SimHei、微软雅黑）。');
    }
  }

  const html = inject(fs.readFileSync(tpl, 'utf8'), sc);
  fs.writeFileSync(path.resolve(A.out), html);
  const kinds = tally(sc);
  console.log(`OK ${path.resolve(A.out)}\n   设计 ${sc.design.w}×${sc.design.h} · ${kinds} · ${mb(Buffer.byteLength(html))}`);
  if (sc.page) console.log(`   印刷 ${sc.page.wmm}×${sc.page.hmm}mm`);
  if (!sc.ref) console.log('   提示：没给 --ref，页面里的「叠影/差值」按钮无用');
} else if (cmd === 'set') {
  if (!A.html || !A.scene) die('用法: set --html 稿.html --scene s.json');
  const p = path.resolve(A.html);
  const html = fs.readFileSync(p, 'utf8');
  const m = BLOCK.exec(html);
  if (!m) die('找不到数据块');
  const old = JSON.parse(m[1]);
  const sc = readScene(path.resolve(A.scene));
  sc.board = old.board; sc.ref = old.ref; sc.fonts = old.fonts || sc.fonts;
  sc.faceWeights = sc.faceWeights || old.faceWeights; sc.facePs = sc.facePs || old.facePs;
  if (old.cff) sc.cff = old.cff; else delete sc.cff;   /* 轮廓体检结果跟着字体表走，别在 set 时丢掉 */
  sc.design = sc.design || old.design; sc.page = sc.page || old.page;
  fs.writeFileSync(p, inject(html, sc));
  console.log(`OK 数据块已更新：${tally(sc)} · ${path.basename(p)}`);
} else {
  console.log('用法: node build.cjs build --scene s.json --board b.png --out o.html [--ref r.png] [--fonts auto] [--dpi 300]');
  console.log('      node build.cjs set --html o.html --scene s.json');
  if (!cmd) process.exit(0); else die('未知子命令：' + cmd);
}
