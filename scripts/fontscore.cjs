/* Compare candidate renders only where the selected text level appears in blocks.json. */
'use strict';
const fs = require('fs');
const { decodePng } = require('./png.cjs');

const readPng = file => decodePng(fs.readFileSync(file));

function resize(img, width, height) {
  if (img.width === width && img.height === height) return img;
  const out = new Uint8ClampedArray(width * height * 4);
  const sx = img.width / width, sy = img.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.max(0, Math.min(img.height - 1, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(img.height - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, Math.min(img.width - 1, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(img.width - 1, x0 + 1), wx = fx - x0;
      const a = (y0 * img.width + x0) * 4, b = (y0 * img.width + x1) * 4;
      const c = (y1 * img.width + x0) * 4, d = (y1 * img.width + x1) * 4;
      const o = (y * width + x) * 4;
      for (let k = 0; k < 4; k++) out[o + k] =
        img.data[a + k] * (1 - wx) * (1 - wy) + img.data[b + k] * wx * (1 - wy)
        + img.data[c + k] * (1 - wx) * wy + img.data[d + k] * wx * wy;
    }
  }
  return { width, height, data: out };
}

function textMask(scene, blocks, levels, width, height) {
  if (!blocks || !Array.isArray(blocks.blocks) || !Array.isArray(blocks.fits)) return null;
  const dw = +(scene.design || {}).w, dh = +(scene.design || {}).h;
  if (!(dw > 0 && dh > 0)) return null;
  const selected = new Set(levels || []), mask = new Uint8Array(width * height);
  let regions = 0;
  blocks.blocks.forEach((b, bi) => {
    if (!b || b.kind === 'line') return;
    (blocks.fits[bi] || []).forEach(t => {
      const layer = (scene.layers || [])[t[0]];
      if (!layer || layer.kind === 'line' || (selected.size && !selected.has(layer.lv || 1))) return;
      const inkW = +t[1];
      if (!(inkW > 0)) return;
      const size = +(layer.size || b.size || (scene.text || {}).size || 20);
      const px = Math.max(4, Math.ceil(size * 0.75)), py = Math.max(3, Math.ceil(size * 0.3));
      const left = b.lead && layer.align === 'right' ? b.lead.priceLeft : b.x0;
      const x0 = Math.max(0, Math.floor((left - px) * width / dw));
      const x1 = Math.min(width, Math.ceil((left + inkW + px) * width / dw));
      const y0 = Math.max(0, Math.floor((b.y0 - py) * height / dh));
      const y1 = Math.min(height, Math.ceil((b.y1 + py + 1) * height / dh));
      if (x1 <= x0 || y1 <= y0) return;
      for (let y = y0; y < y1; y++) mask.fill(1, y * width + x0, y * width + x1);
      regions++;
    });
  });
  if (!regions) return null;
  let pixels = 0;
  for (let i = 0; i < mask.length; i++) pixels += mask[i];
  return { mask, pixels, regions };
}

function compare(render, reference, mask) {
  const ref = resize(reference, render.width, render.height);
  if (mask && mask.length !== render.width * render.height) throw new Error('文字区域掩码尺寸与渲染图不一致');
  let sum = 0, bad = 0, n = 0;
  for (let i = 0, o = 0; i < render.width * render.height; i++, o += 4) {
    if (mask && !mask[i]) continue;
    const d = Math.abs(render.data[o] - ref.data[o])
      + Math.abs(render.data[o + 1] - ref.data[o + 1])
      + Math.abs(render.data[o + 2] - ref.data[o + 2]);
    sum += d; if (d > 40) bad++; n++;
  }
  if (!n) throw new Error('没有可比较的像素');
  return { mean: sum / n / 3, pct: bad / n * 100, pixels: n };
}

module.exports = { readPng, resize, textMask, compare };
