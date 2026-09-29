#!/usr/bin/env node
/* Six visual font classes. Glyph recognition may compare representative faces
   once; output always uses the class's fixed preferred family. */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');

const GROUPS = [
  { type: '宋体', samples: [/^(思源宋体|Source Han Serif CN)$/i, /^(宋体|SimSun)$/i],
    choices: [[/^(思源宋体|Source Han Serif CN)$/i, f => /^Source Han/i.test(f) ? 'Source Han Serif CN' : f],
      [/^(宋体|SimSun)$/i, f => f]] },
  { type: '黑体', samples: [/^(思源黑体|Source Han Sans CN)(?: Regular)?$/i, /^(黑体|SimHei)$/i],
    choices: [[/^(思源黑体|Source Han Sans CN)(?: Regular)?$/i, f => /^Source Han/i.test(f) ? 'Source Han Sans CN' : f],
      [/^(黑体|SimHei)$/i, f => f]] },
  { type: '圆体', samples: [/^(幼圆|YouYuan)$/i],
    choices: [[/^(幼圆|YouYuan)$/i, f => f]] },
  { type: '楷体', samples: [/^(楷体|KaiTi)$/i, /^(华文楷体|STKaiti)$/i],
    choices: [[/^(楷体|KaiTi)$/i, f => f]] },
  { type: '隶书', samples: [/^(隶书|LiSu)$/i],
    choices: [[/^(隶书|LiSu)$/i, f => f]] },
  { type: '仿宋', samples: [/^(仿宋|FangSong)$/i, /^(华文仿宋|STFangsong)$/i],
    choices: [[/^(仿宋|FangSong)$/i, f => f]] }
];
const FALLBACK = { 宋体: 'SimSun', 黑体: 'SimHei', 圆体: 'YouYuan',
  楷体: 'KaiTi', 隶书: 'LiSu', 仿宋: 'FangSong' };

function groupOf(face) {
  const f = String(face || '');
  if (/仿宋|FangSong|STFangsong/i.test(f)) return '仿宋';
  if (/隶书|LiSu/i.test(f)) return '隶书';
  if (/楷|KaiTi|STKaiti/i.test(f)) return '楷体';
  if (/圆|Yuan/i.test(f)) return '圆体';
  if (/思源宋|Source Han Serif|Noto Serif|宋|Song|Ming|SimSun|Mincho/i.test(f)) return '宋体';
  if (/思源黑|Source Han Sans|Noto Sans|黑|Hei|YaHei|DengXian|等线|PingFang|苹方|Gothic/i.test(f)) return '黑体';
  return '';
}

function sampleFaces(faces, max = 18) {
  const selected = [], extras = [];
  for (const g of GROUPS) {
    g.samples.forEach((re, i) => {
      const f = faces.find(name => re.test(name));
      if (f && !selected.includes(f) && !extras.includes(f)) (i ? extras : selected).push(f);
    });
  }
  return selected.concat(extras).slice(0, Math.max(6, max));
}

function resolveFont(type, faces) {
  const g = GROUPS.find(x => x.type === type);
  if (!g) throw new Error('字体类别只支持：' + GROUPS.map(x => x.type).join('、'));
  for (const [re, output] of g.choices) {
    const found = faces.find(f => re.test(f));
    if (found) return { type, font: output(found), installed: true, matchedFace: found };
  }
  return { type, font: FALLBACK[type], installed: false, matchedFace: '' };
}

function installedFaces() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fontgroups-'));
  const output = path.join(tmp, 'faces.txt');
  try {
    cp.execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'fontfaces.ps1'), '-Out', output], { stdio: 'ignore' });
    return fs.readFileSync(output, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch (e) {
    return []; // 字体枚举不可用时仍可写入 CSS 通用家族名，渲染时再检查。
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function parseGroups(spec) {
  const out = new Map();
  String(spec || '').split(/[,，;；]/).map(s => s.trim()).filter(Boolean).forEach(item => {
    const m = /^L?(\d+)\s*[:=：]\s*(.+)$/i.exec(item);
    if (!m || !GROUPS.some(g => g.type === m[2].trim()))
      throw new Error('字体类别写成 L1:楷体,L2:仿宋；可用：' + GROUPS.map(g => g.type).join('、'));
    out.set(+m[1], m[2].trim());
  });
  return out;
}

module.exports = { GROUPS, groupOf, sampleFaces, resolveFont, installedFaces, parseGroups };

if (require.main === module) {
  const a = process.argv.slice(2);
  const get = k => { const i = a.indexOf('--' + k); return i < 0 ? '' : a[i + 1]; };
  try {
    const scene = get('scene'), selected = parseGroups(get('groups'));
    if (!scene || !fs.existsSync(scene) || !selected.size) throw new Error('用法：fontgroups.cjs --scene scene.json --groups L1:楷体,L2:仿宋');
    const sc = JSON.parse(fs.readFileSync(scene, 'utf8')), faces = installedFaces();
    sc.text ||= {};
    const levels = [...new Set((sc.layers || []).filter(L => L.kind !== 'line').map(L => L.lv || 1))];
    const missing = levels.filter(lv => !selected.has(lv));
    if (missing.length) throw new Error('缺少字号档：' + missing.map(x => 'L' + x).join('、'));
    const rows = levels.map(lv => ({ lv, ...resolveFont(selected.get(lv), faces) }));
    rows.forEach(r => {
      sc.layers.forEach(L => { if (L.kind !== 'line' && (L.lv || 1) === r.lv) L.font = r.font; });
      if (r.lv === 1 || !sc.text.font) sc.text.font = r.font;
      console.log(`L${r.lv} ${r.type} → ${r.font}${r.installed ? '' : '（本机未确认安装，请检查渲染）'}`);
    });
    fs.writeFileSync(scene, JSON.stringify(sc, null, 1), 'utf8');
    fs.writeFileSync(path.join(path.dirname(path.resolve(scene)), 'fontid.json'),
      JSON.stringify({ by: 'visual font groups', lv: rows }, null, 1), 'utf8');
  } catch (e) { console.error('ERR ' + e.message); process.exit(1); }
}
