#!/usr/bin/env node
/* fill.cjs —— 把「哪个位置是什么字」写进 scene.json，顺手补齐管线里原来要人手改的三件事。
   为什么要它：以前量完图停在「还有 77 层没填字」，下游的 agent（或我）每次都要现写一份填字脚本 ——
   实测一次转换光这一段就花掉 8 分钟、还留下 7 个临时 .cjs。填字清单是纯文本，比手改 JSON 不容易错。

   用法：
     node scripts/fill.cjs --scene probe/scene.json --dump-out 填字.txt  把待填的层写成 UTF-8 清单
     node scripts/fill.cjs --scene probe/scene.json --dump              也可只打印清单
     node scripts/fill.cjs --scene probe/scene.json --map 填字.txt     按清单填字（填完自动 --fit 校字号；要顺手钳离群字号再加 --clamp）
          [--tol 8]        位置对多宽算配上（设计像素）
          [--clamp]       顺手把离本档中位数 25% 以上的字号钳回中位数（--fit 离群清单的一键版，默认不动）
          [--nofit]        不接着校字号
          [--noclamp]      不钳离群字号
          [--only 0,3,7]   只填这几层（分批填时用）
   清单每行一条，# 开头是注释，三种写法都行：
     81,601 原味蛋黄溶豆（6M+）      ← 位置锚点（--dump 打出来的就是它）
     12 原味蛋黄溶豆（6M+）           ← 层号锚点
     82,711 大小米饼（8M+）……27 元   ← 值里有 ……/|/··· ＝ 这一行原来粘成了一层，拆成 菜名 + 引导点线 + 价格 三层
   段落文本照原样写，换行用 \n。线段层没有字，不用管。 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const A = process.argv.slice(2);
const get = (k, d) => { const i = A.indexOf('--' + k); return i < 0 ? d : A[i + 1]; };
const off = k => A.indexOf('--' + k) < 0;
const die = m => { console.error('ERR ' + m); process.exit(1); };
const SCENE = get('scene', '');
if (!SCENE || !fs.existsSync(SCENE)) die('缺 --scene probe/scene.json');
const OUT = path.dirname(path.resolve(SCENE));
const TOL = +get('tol', 8);
const ONLY = (get('only', '') || '').split(/[,，]/).filter(x => /^\d+$/.test(x)).map(Number);
const rd = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const q = s => /\s/.test(s) ? '"' + s + '"' : s;
const sc = rd(SCENE);
let jdBlk = null;                   // blocks.json 原样留着，拆行时要改它的 fits
const layers = sc.layers || die('这份 scene.json 里没有 layers');
const DW = (sc.design || {}).w || 0;

/* 每字符宽度（em 计）—— 拆行时用它把「名字多宽、价格贴哪」算出来，和 probe --fit 同一口径 */
function adv(t) { let v = 0;
  for (const ch of String(t)) { const c = ch.codePointAt(0);
    if (ch === ' ') v += 0.3;
    else if (c >= 0x2E80) v += 1;
    else if (/[0-9]/.test(ch)) v += 0.56;
    else if (/[A-Z]/.test(ch)) v += 0.72;
    else if (/[.,:;'"|!()\[\]\/\\\-]/.test(ch)) v += 0.33;
    else v += 0.55; }
  return v; }

/* 墨迹宽：拆粘连行要知道这一层原来那团墨有多宽 —— probe 把它记在同目录 blocks.json 的 fits 里 */
const inkW = new Map(), fitRef = {};
let fitsDirty = false;
const BJ = path.join(OUT, 'blocks.json');
if (fs.existsSync(BJ)) { try { const jd = jdBlk = rd(BJ);
  (jd.fits || []).forEach(ts => (ts || []).forEach(t => { inkW.set(t[0], t[1]); fitRef[t[0]] = t; })); } catch (e) { } }

const blank = i => { const L = layers[i]; return L.kind !== 'line' && (!L.text || L.text === '?'); };
/* --dump-out：直接写 UTF-8，避免 PowerShell 5 的 > 重定向写成 UTF-16。 */
if (A.indexOf('--dump') >= 0 || get('dump-out', '')) {
  const bl = layers.map((L, i) => ({ L, i })).filter(o => blank(o.i) && (!ONLY.length || ONLY.includes(o.i)));
  const body = [
    `# ${SCENE} 还有 ${bl.length} 层没填字。每行改成「位置 文字」，粘成一行的是「菜名……价格」，写完跑：`,
    `#   node scripts/fill.cjs --scene ${q(SCENE)} --map 填字.txt`,
    ...bl.map(o => `${o.L.x},${o.L.y} ?`)
  ].join('\n') + '\n';
  const dumpOut = get('dump-out', '');
  if (dumpOut) {
    fs.writeFileSync(dumpOut, body, 'utf8');
    console.log(`已写出 ${path.resolve(dumpOut)}（${bl.length} 层待填）`);
  } else process.stdout.write(body);
  process.exit(0);
}
const MAP = get('map', '');
if (!MAP || !fs.existsSync(MAP)) die('缺 --map 填字清单（或先用 --dump 打一份骨架）');

/* 1) 读清单 */
const SPLIT = /(…{2,}|\.{3,}|·{2,}|\s\|\s|\|)/;
const ent = [];
fs.readFileSync(MAP, 'utf8').replace(/^﻿/, '').split(/\r?\n/).forEach((ln, no) => {
  const s = ln.trim();
  if (!s || s.startsWith('#')) return;
  let m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\s+(.*)$/.exec(s);
  if (m) { ent.push({ x: +m[1], y: +m[2], val: m[3].replace(/\\n/g, '\n'), no }); return; }
  m = /^(\d+)\s+(.*)$/.exec(s);
  if (m) { ent.push({ li: +m[1], val: m[2].replace(/\\n/g, '\n'), no }); return; }
  die(`清单第 ${no + 1} 行看不懂（要「x,y 文字」或「层号 文字」）：${s}`);
});

/* 2) 认层：层号直接取；位置用「就近 + 一对一」，所有候选按距离排序后从小到大认领，避免两层抢同一行 */
const cand = [];
ent.forEach(e => {
  if (e.li != null) { if (!layers[e.li]) die(`清单第 ${e.no + 1} 行的层号 ${e.li} 超出范围（共 ${layers.length} 层）`);
    cand.push({ d: 0, li: e.li, e }); return; }
  layers.forEach((L, i) => { if (L.kind === 'line') return;
    const d = Math.abs(L.x - e.x) + Math.abs(L.y - e.y) * 2;      // 纵向更值钱：同一列上下相邻行只差 x
    if (d <= TOL * 3) cand.push({ d, i, e }); });
});
cand.sort((a, b) => a.d - b.d);
const taken = new Set(), hit = new Map();
cand.forEach(c => { const li = c.li != null ? c.li : c.i;
  if (taken.has(li) || taken.has(c.e)) return; taken.add(li); taken.add(c.e); hit.set(c.e, li); });
const missed = ent.filter(e => !hit.has(e));

/* 3) 写进去；带分隔符的拆成 菜名 + 引导点线 + 价格 */
const line0 = layers.find(L => L.kind === 'line' && L.style === 'dotted');
let filled = 0, split = 0, added = [];
ent.forEach(e => {
  const li = hit.get(e); if (li == null) return;
  const L = layers[li], parts = String(e.val).split(SPLIT);
  if (parts.length < 2 || !String(parts[1]).trim()) { L.text = e.val; filled++; return; }
  /* 粘行：前段是菜名，后段是价格（价格取最后一段，中间都是引导点） */
  const price = String(parts[parts.length - 1]).trim(), name = parts[0].trim();
  if (L.align === 'right' || !price) { L.text = e.val; filled++; return; }
  const size = L.size || (sc.text || {}).size || 20, w = inkW.get(li) || adv(e.val.replace(SPLIT, '')) * size;
  const right = L.x + w;
  const nx = L.x + adv(name) * size, px = right - adv(price) * size;
  const cy = L.y + Math.round(size * 0.7);
  const gapPx = Math.max(1, Math.round(size * 0.3));
  L.text = name; filled++;
  const ln = { kind: 'line', name: '引导点线', x: Math.round(nx + size * 0.14), y: cy,
    x2: Math.round(Math.max(nx + 2, px - size * 0.14)), y2: cy,
    width: line0 ? line0.width : Math.max(2, Math.round(size * 0.11)), style: 'dotted',
    dash: line0 ? line0.dash : '0.1 ' + gapPx, color: L.color || (line0 && line0.color) || (sc.text || {}).color };
  const pr = { kind: 'point', name: '价格', lv: L.lv, align: 'right', x: Math.round(right) + 1, y: L.y,
    size, color: L.color, text: price };
  if (nx > px - 2) { ln.x2 = ln.x + 2; ln.dash = '0.1 1'; }   // 名字本来就快顶到价格：点线留个记号，别倒着画
  /* --fit 靠 blocks.json 的 fits 认每层的墨迹宽：这层原来是整行粘在一起的一团，
     宽是整行的宽。不改成菜名自己那段，fit 会拿整行宽去除菜名的字数（实测把 55 推成 153）。 */
  if (fitRef[li]) { fitRef[li][1] = Math.round(adv(name) * size); fitsDirty = true; }
  added.push([li, ln, pr]); split++;
});
/* 新层一律追加到末尾 —— 插在中间会把后面所有层的层号挪位，blocks.json 的 fits 就对不上号了，
   --fit 会拿别人的墨迹宽来算这层的字号（实测一次把 107 层算飞）。 */
added.forEach(o => { layers.push(o[1]); layers.push(o[2]); });
if (fitsDirty && fs.existsSync(BJ)) fs.writeFileSync(BJ, JSON.stringify(jdBlk), 'utf8');   // fits 的宽改过了
fs.writeFileSync(SCENE, JSON.stringify(sc, null, 1), 'utf8');   // 先落盘，--fit 读的是文件
/* 4) 校字号 + 钳离群：--fit 按墨迹宽重算，拆出来的三层不在 fits 里、要单独钳一次 */
if (A.indexOf('--nofit') < 0 && filled) {
  try { cp.execFileSync(process.execPath, [path.join(__dirname, 'probe.cjs'), '--fit', path.resolve(SCENE)]
    .concat(off('unify') ? [] : ['--unify']), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { console.log('   --fit 没跑成：' + String(e.message || e).split('\n')[0]); }
}
const sc2 = rd(SCENE);
if (A.indexOf('--clamp') >= 0) {
  const byLv = new Map();
  sc2.layers.forEach((L, i) => { if (L.kind === 'line') return;
    const k = L.lv || 1; (byLv.get(k) || byLv.set(k, []).get(k)).push([i, L.size || (sc2.text || {}).size || 0]); });
  let clamped = 0;
  byLv.forEach((arr, k) => {
    if (arr.length < 4) return;                       // 少于 4 层没资格谈「离群」，标题档常常就两三层
    const vs = arr.map(a => a[1]).sort((a, b) => a - b), rep = vs[vs.length >> 1];
    arr.forEach(([i, v]) => { if (rep && Math.abs(v - rep) / rep > 0.25) { sc2.layers[i].size = rep; clamped++; } });
  });
  if (clamped) { fs.writeFileSync(SCENE, JSON.stringify(sc2, null, 1));
    console.log(`   钳离群字号：${clamped} 层拉回本档中位数（--fit 按整团墨迹反解时，粘行拆出来的三层会偏大）`); }
}

/* 5) 报数 */
function blank2(L) { return L.kind !== 'line' && (!L.text || L.text === '?'); }
/* 剩下的没填的层，报层号和位置 */
const rel = path.relative(process.cwd(), path.resolve(SCENE)) || SCENE;
console.log(`填字 ${filled} 层` + (split ? `，其中 ${split} 行拆成 菜名 + 引导点线 + 价格（多出 ${split * 2} 层）` : '')
  + `；清单共 ${ent.length} 条，没配上 ${missed.length} 条`);
if (missed.length) console.log('   没配上的（位置给得不准或那一层不存在）：\n'
  + missed.slice(0, 12).map(e => `     第 ${e.no + 1} 行 ` + (e.li != null ? '层号 ' + e.li : `(${e.x},${e.y})`)).join('\n'));
const un = sc2.layers.filter((L, i) => blank2(L));
console.log(un.length ? `还剩 ${un.length} 层没字：${un.slice(0, 24).map((L, i) => `${sc2.layers.indexOf(L)} (${L.x},${L.y})`).join(' ')}${un.length > 24 ? ' …' : ''}`
  : `字填齐了（共 ${sc2.layers.length} 层）`);
console.log(`下一步：node scripts/run.cjs --ref "<参考图>" --board "<底板>" --out ${q(path.dirname(rel))} --name "<稿名>" --from ${q(rel)} —— 它会跳过量图、接着认字体、建稿、比还原度`);
