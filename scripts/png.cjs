#!/usr/bin/env node
/*
  png.cjs —— 极小 PNG 解码器，给 psd.cjs 用（Node 没有 canvas，读不了位图）
  只覆盖本 skill 会遇到的情况：8 bit 深、非隔行、颜色类型 0/2/3/4/6（灰度、RGB、调色板、灰度+α、RGBA）
  调色板之外都不管，遇到就明确报错，别悄悄出错的图。

    const { decodePng } = require('./png.cjs');
    const { width, height, data } = decodePng(fs.readFileSync('a.png'));  // data: RGBA Uint8ClampedArray
*/
const zlib = require('zlib');

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function decodePng(buf) {
  if (buf.length < 8 || buf.compare(SIG, 0, 8, 0, 8) !== 0) throw new Error('不是 PNG 文件');
  let p = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const ids = [], plte = [], trns = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const body = buf.slice(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === 'IHDR') {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4);
      depth = body[8]; ctype = body[9]; interlace = body[12];
      if (depth !== 8) throw new Error(`只支持 8 bit 深，当前 ${depth} bit`);
      if (interlace !== 0) throw new Error('不支持隔行（interlaced）PNG');
      if (CHANNELS[ctype] == null) throw new Error(`不支持的颜色类型 ${ctype}`);
    } else if (type === 'IDAT') ids.push(body);
    else if (type === 'PLTE') for (let i = 0; i + 2 < body.length; i += 3) plte.push([body[i], body[i + 1], body[i + 2]]);
    else if (type === 'tRNS') for (let i = 0; i < body.length; i++) trns[i] = body[i];
    else if (type === 'IEND') break;
  }
  if (!w || !h) throw new Error('PNG 缺少 IHDR');
  const ch = CHANNELS[ctype], bpp = ch;                 // 8 bit 深 → 每像素字节数就是通道数
  const stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(ids));
  if (raw.length < (stride + 1) * h) throw new Error('PNG 数据不完整');

  const out = Buffer.allocUnsafe(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {                            // Paeth
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (filter !== 0) throw new Error(`未知过滤方式 ${filter}`);
      cur[x] = v & 255;
    }
  }

  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, o = 0; i < w * h; i++, o += 4) {
    if (ctype === 6) { data[o] = out[i * 4]; data[o + 1] = out[i * 4 + 1]; data[o + 2] = out[i * 4 + 2]; data[o + 3] = out[i * 4 + 3]; }
    else if (ctype === 2) { data[o] = out[i * 3]; data[o + 1] = out[i * 3 + 1]; data[o + 2] = out[i * 3 + 2]; data[o + 3] = 255; }
    else if (ctype === 0) { const g = out[i]; data[o] = data[o + 1] = data[o + 2] = g; data[o + 3] = 255; }
    else if (ctype === 4) { const g = out[i * 2]; data[o] = data[o + 1] = data[o + 2] = g; data[o + 3] = out[i * 2 + 1]; }
    else {                                                // 3 = 调色板
      const k = out[i], c = plte[k] || [0, 0, 0];
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2];
      data[o + 3] = trns.length ? (trns[k] == null ? 255 : trns[k]) : 255;
    }
  }
  return { width: w, height: h, data };
}

/* 页面里内联的底板是 data URI，直接解比再截一次屏快得多，也正好是设计分辨率 */
function fromDataUri(src) {
  const m = /^data:image\/png;base64,([\s\S]+)$/.exec(String(src || '').trim());
  return m ? decodePng(Buffer.from(m[1], 'base64')) : null;
}

module.exports = { decodePng, fromDataUri };
