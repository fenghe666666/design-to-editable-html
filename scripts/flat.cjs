#!/usr/bin/env node
/* flat.cjs —— 把 GDI+ / probe 自带解码器认不下的图（webp、heic、avif…）先摊成 PNG。
   用的是系统自带的 WIC（同目录 img2png.ps1，走 WinRT 的 BitmapDecoder/Encoder），
   实测本机能直接解 webp（1067×1600 一次成功），所以 AI 出图工具发的 webp 不用人先手工转一道 ——
   手工转一次就是一轮对话，约一分钟挂钟。
     const flat = require('./flat.cjs');
     const png = flat('菜单.webp', { log: console.log });   // GDI+ 能读的就原样返回
     const lossless = flat('参考图.jpg', { need: 'png' });  // probe 用这个：不是 PNG 就摊
   抛错自己 die()；缓存：源图旁边的 _src/<名>-<字节数>-<mtime>.png —— 同名换图不会用到旧的，几个脚本共用同一份。 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const KNOWN = ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tif', '.tiff', '.ico'];  /* 这些不用转 */

module.exports = function flat(file, opt) {
  const o = opt || {}, abs = path.resolve(file), ext = path.extname(abs).toLowerCase();
  /* 默认只摊 GDI+ 认不下的格式；probe 的解码器只吃 PNG（而且必须无损），就传 { need:'png' } */
  if (o.off) return abs;
  if (o.need === 'png' ? ext === '.png' : KNOWN.indexOf(ext) >= 0) return abs;
  if (!fs.existsSync(abs)) throw new Error('找不到图片：' + abs);
  const st = fs.statSync(abs), dir = o.cache || path.join(path.dirname(abs), '_src');
  const dst = path.join(dir, path.basename(abs, ext) + '-' + st.size + '-' + Math.round(st.mtimeMs) + '.png');
  if (fs.existsSync(dst) && fs.statSync(dst).size > 64) { if (o.log) o.log('复用已转好的 ' + dst); return dst; }
  fs.mkdirSync(dir, { recursive: true });
  const tmp = dst + '.tmp', stp = tmp + '.status';
  fs.writeFileSync(tmp, Buffer.alloc(0));        /* WinRT 的 StorageFile 只开已存在的文件 */
  cp.spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'img2png.ps1'), '-In', abs, '-Out', tmp, '-Status', stp],
    { encoding: 'utf8', timeout: 300000 });
  /* 状态从 UTF-8 文件读，不从 stdout 读：PowerShell 控制台是 GBK，中文报错过来全是乱码 */
  let msg = '';
  try { msg = fs.readFileSync(stp, 'utf8').trim(); } catch (e) { }
  try { fs.unlinkSync(stp); } catch (e) { }
  if (!/^OK\s+\d+x\d+/.test(msg) || !fs.existsSync(tmp) || fs.statSync(tmp).size <= 64) {
    try { fs.unlinkSync(tmp); } catch (e) { }
    throw new Error(path.basename(abs) + ' 转 PNG 失败：' + (msg || '没产出文件') +
      '（这个格式本机 WIC 也解不了，先让出图方导一份 PNG/JPG）');
  }
  fs.renameSync(tmp, dst);
  if (o.log) o.log(path.basename(abs) + ' → ' + msg.slice(3) + ' 的 PNG（存 ' + dst + '）');
  return dst;
};
