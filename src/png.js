'use strict';

// Just enough PNG to show a picture in the terminal: decode() reads 8-bit
// greyscale, RGB, RGBA and palette images (not interlaced) with zlib, and
// thumbnail() draws one in coloured half blocks (▀: the top pixel in the
// text colour, the bottom one behind it), two pixels a cell, in true colour
// where the terminal has it and the 256-colour palette otherwise. A
// picture's own colours are its content, so they don't come from the theme.

const fs = require('fs');
const zlib = require('zlib');
const ansi = require('./ansi');

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// { width, height, rgb: Uint8Array of width*height*3 } or throws.
function decode(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let pos = 8;
  let head = null;
  let palette = null;
  const data = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      head = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] };
    } else if (type === 'PLTE') palette = body;
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!head) throw new Error('no header');
  if (head.depth !== 8 || head.interlace || !(head.color in CHANNELS)) throw new Error('an unusual PNG');
  const ch = CHANNELS[head.color];
  const { width, height } = head;
  const stride = width * ch;
  const raw = zlib.inflateSync(Buffer.concat(data));
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride);
    const prev = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = v & 255;
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    let r;
    let g;
    let b;
    if (head.color === 3) [r, g, b] = [palette[px[i] * 3], palette[px[i] * 3 + 1], palette[px[i] * 3 + 2]];
    else if (ch <= 2) r = g = b = px[i * ch];
    else [r, g, b] = [px[i * ch], px[i * ch + 1], px[i * ch + 2]];
    rgb.set([r, g, b], i * 3);
  }
  return { width, height, rgb };
}

// The average colour of a box of pixels.
function average(img, x0, y0, x1, y1) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = Math.floor(y0); y < Math.max(Math.floor(y0) + 1, Math.floor(y1)); y++) {
    for (let x = Math.floor(x0); x < Math.max(Math.floor(x0) + 1, Math.floor(x1)); x++) {
      const i = (Math.min(y, img.height - 1) * img.width + Math.min(x, img.width - 1)) * 3;
      r += img.rgb[i];
      g += img.rgb[i + 1];
      b += img.rgb[i + 2];
      n++;
    }
  }
  return [r / n, g / n, b / n].map(Math.round);
}

// The nearest of xterm's 256 colours: the 6×6×6 cube or the grey ramp.
function to256([r, g, b]) {
  const level = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
  const steps = [0, 95, 135, 175, 215, 255];
  const [cr, cg, cb] = [level(r), level(g), level(b)];
  const cube = [steps[cr], steps[cg], steps[cb]];
  const grey = Math.min(23, Math.max(0, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gv = 8 + grey * 10;
  const dist = (p) => (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2;
  return dist([gv, gv, gv]) < dist(cube) ? 232 + grey : 16 + 36 * cr + 6 * cg + cb;
}

const trueColor = () => /truecolor|24bit/i.test(process.env.COLORTERM || '');

// The picture as `cols` columns of half blocks: an array of lines.
function thumbnail(img, cols, { truecolor = trueColor() } = {}) {
  if (!ansi.isEnabled()) return [];
  const rows = Math.max(1, Math.round((cols * img.height) / img.width / 2));
  const sx = img.width / cols;
  const sy = img.height / (rows * 2);
  const fg = (c) => (truecolor ? `\x1b[38;2;${c[0]};${c[1]};${c[2]}m` : `\x1b[38;5;${to256(c)}m`);
  const bg = (c) => (truecolor ? `\x1b[48;2;${c[0]};${c[1]};${c[2]}m` : `\x1b[48;5;${to256(c)}m`);
  const lines = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const top = average(img, c * sx, 2 * r * sy, (c + 1) * sx, (2 * r + 1) * sy);
      const bottom = average(img, c * sx, (2 * r + 1) * sy, (c + 1) * sx, (2 * r + 2) * sy);
      line += `${fg(top)}${bg(bottom)}▀`;
    }
    lines.push(line + ansi.reset());
  }
  return lines;
}

function thumbnailFile(file, cols, opts) {
  try { return thumbnail(decode(fs.readFileSync(file)), cols, opts); } catch { return []; }
}

module.exports = { decode, thumbnail, thumbnailFile, to256 };
