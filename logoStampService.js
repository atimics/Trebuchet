// logoStampService.js
//
// Stamps a token's mint address (CA) onto its logo before upload.
//
// Copy launchers reuse an official launch's metadata URI and image verbatim.
// A logo that carries its own CA turns every such copy into an advert for the
// real mint: explorers, wallets and DEX pages all show the stamped image.
//
// Pure JS on purpose (pngjs, jpeg-js, gifuct-js, gifenc and a built-in pixel
// font) so the packaged Electron app needs no native image stack. Stamping is
// best effort: when the logo is too small to hold a legible CA, or the stamped
// file would pass the upload cap, the caller gets the original logo back with
// a reason, and the launch continues.

import { createRequire } from 'node:module';
import zlib from 'node:zlib';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { parseGIF, decompressFrames } from 'gifuct-js';
import { LOGO_MAX_BYTES, detectLogoImageMime } from './validators.js';

const require = createRequire(import.meta.url);
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

// 5x9 glyphs: rows 0-6 are the cap height, rows 7-8 hold descenders. Only the
// characters a stamp needs: "CA", separators, and the base58 alphabet.
const GLYPHS = {
  ' ': [],
  ':': ['.....', '..#..', '..#..', '.....', '..#..', '..#..'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['###..', '#..#.', '#...#', '#...#', '#...#', '#..#.', '###..'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  a: ['.....', '.....', '.###.', '....#', '.####', '#...#', '.####'],
  b: ['#....', '#....', '#.##.', '##..#', '#...#', '#...#', '####.'],
  c: ['.....', '.....', '.###.', '#....', '#....', '#...#', '.###.'],
  d: ['....#', '....#', '.##.#', '#..##', '#...#', '#...#', '.####'],
  e: ['.....', '.....', '.###.', '#...#', '#####', '#....', '.###.'],
  f: ['..##.', '.#..#', '.#...', '###..', '.#...', '.#...', '.#...'],
  g: ['.....', '.....', '.####', '#...#', '#...#', '#...#', '.####', '....#', '.###.'],
  h: ['#....', '#....', '#.##.', '##..#', '#...#', '#...#', '#...#'],
  i: ['..#..', '.....', '.##..', '..#..', '..#..', '..#..', '.###.'],
  j: ['...#.', '.....', '..##.', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  k: ['#....', '#....', '#..#.', '#.#..', '##...', '#.#..', '#..#.'],
  m: ['.....', '.....', '##.#.', '#.#.#', '#.#.#', '#...#', '#...#'],
  n: ['.....', '.....', '#.##.', '##..#', '#...#', '#...#', '#...#'],
  o: ['.....', '.....', '.###.', '#...#', '#...#', '#...#', '.###.'],
  p: ['.....', '.....', '####.', '#...#', '#...#', '#...#', '####.', '#....', '#....'],
  q: ['.....', '.....', '.####', '#...#', '#...#', '#...#', '.####', '....#', '....#'],
  r: ['.....', '.....', '#.##.', '##..#', '#....', '#....', '#....'],
  s: ['.....', '.....', '.####', '#....', '.###.', '....#', '####.'],
  t: ['.#...', '.#...', '###..', '.#...', '.#...', '.#..#', '..##.'],
  u: ['.....', '.....', '#...#', '#...#', '#...#', '#..##', '.##.#'],
  v: ['.....', '.....', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  w: ['.....', '.....', '#...#', '#...#', '#.#.#', '#.#.#', '.#.#.'],
  x: ['.....', '.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  y: ['.....', '.....', '#...#', '#...#', '#...#', '#..##', '.##.#', '....#', '.###.'],
  z: ['.....', '.....', '#####', '...#.', '..#..', '.#...', '#####'],
};

const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 9;
const CELL_WIDTH = GLYPH_WIDTH + 1;
const LINE_HEIGHT = GLYPH_HEIGHT + 1;
// The band may cover at most this share of the logo's height.
const MAX_BAND_SHARE = 0.16;
const MAX_TEXT_SHARE = 0.8;
// Small logos are upscaled (nearest neighbour, whole factors) until the CA
// fits, within the launch's logo dimension limit.
const MAX_UPSCALE = 4;
const MAX_DIMENSION = 1024;
const BAND_ALPHA = 0.78;
const JPEG_QUALITIES = [92, 85, 75, 65];

function assertStampable(text) {
  for (const char of text) {
    if (!(char in GLYPHS)) throw new Error(`The logo stamp font has no glyph for "${char}".`);
  }
}

// Pick the layout with the largest legible scale: one line when the logo is
// wide enough, otherwise the CA split across two lines.
export function planStamp(width, height, mint) {
  const address = String(mint || '').trim();
  assertStampable(address);
  const half = Math.ceil(address.length / 2);
  const layouts = [
    [`CA ${address}`],
    [`CA ${address.slice(0, half)}`, `   ${address.slice(half)}`],
  ];
  let best = null;
  for (const lines of layouts) {
    const columns = Math.max(...lines.map((line) => line.length));
    const scale = Math.min(
      Math.floor((width * MAX_TEXT_SHARE) / (columns * CELL_WIDTH)),
      Math.floor((height * MAX_BAND_SHARE) / (lines.length * LINE_HEIGHT + 2)),
    );
    if (scale >= 1 && (!best || scale > best.scale)) best = { lines, columns, scale };
  }
  if (!best) return null;
  const { lines, columns, scale } = best;
  const pad = scale;
  const bandHeight = lines.length * LINE_HEIGHT * scale + pad * 2;
  const textWidth = columns * CELL_WIDTH * scale - scale;
  return {
    lines,
    scale,
    bandTop: height - bandHeight,
    textLeft: Math.floor((width - textWidth) / 2),
    textTop: height - bandHeight + pad + scale,
  };
}

export function fitStamp(width, height, mint) {
  for (let factor = 1; factor <= MAX_UPSCALE; factor += 1) {
    if (width * factor > MAX_DIMENSION || height * factor > MAX_DIMENSION) break;
    const plan = planStamp(width * factor, height * factor, mint);
    if (plan) return { plan, factor, width: width * factor, height: height * factor };
  }
  return null;
}

function upscale(rgba, width, height, factor) {
  if (factor === 1) return rgba;
  const out = new Uint8Array(width * factor * height * factor * 4);
  for (let y = 0; y < height * factor; y += 1) {
    for (let x = 0; x < width * factor; x += 1) {
      const src = (Math.floor(y / factor) * width + Math.floor(x / factor)) * 4;
      out.set(rgba.subarray(src, src + 4), (y * width * factor + x) * 4);
    }
  }
  return out;
}

function blend(rgba, offset, r, g, b, alpha) {
  const dstAlpha = rgba[offset + 3] / 255;
  const outAlpha = alpha + dstAlpha * (1 - alpha);
  if (outAlpha <= 0) return;
  rgba[offset] = Math.round((r * alpha + rgba[offset] * dstAlpha * (1 - alpha)) / outAlpha);
  rgba[offset + 1] = Math.round((g * alpha + rgba[offset + 1] * dstAlpha * (1 - alpha)) / outAlpha);
  rgba[offset + 2] = Math.round((b * alpha + rgba[offset + 2] * dstAlpha * (1 - alpha)) / outAlpha);
  rgba[offset + 3] = Math.round(outAlpha * 255);
}

// Draw a planned stamp into an RGBA buffer in place.
export function drawStamp(rgba, width, height, plan) {
  for (let y = Math.max(0, plan.bandTop); y < height; y += 1) {
    for (let x = 0; x < width; x += 1) blend(rgba, (y * width + x) * 4, 0, 0, 0, BAND_ALPHA);
  }
  plan.lines.forEach((line, lineIndex) => {
    [...line].forEach((char, column) => {
      const rows = GLYPHS[char];
      rows.forEach((row, rowIndex) => {
        for (let bit = 0; bit < GLYPH_WIDTH; bit += 1) {
          if (row[bit] !== '#') continue;
          const left = plan.textLeft + (column * CELL_WIDTH + bit) * plan.scale;
          const top = plan.textTop + (lineIndex * LINE_HEIGHT + rowIndex) * plan.scale;
          for (let dy = 0; dy < plan.scale; dy += 1) {
            for (let dx = 0; dx < plan.scale; dx += 1) {
              const x = left + dx;
              const y = top + dy;
              if (x < 0 || y < 0 || x >= width || y >= height) continue;
              const offset = (y * width + x) * 4;
              rgba[offset] = 255;
              rgba[offset + 1] = 255;
              rgba[offset + 2] = 255;
              rgba[offset + 3] = 255;
            }
          }
        }
      });
    });
  });
}

function isOpaque(rgba) {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return false;
  return true;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// pngjs only writes truecolour. A 256-colour palette PNG is the fallback that
// keeps stamped logos (often palette PNGs to begin with) under the cap.
function encodeIndexedPng(rgba, width, height) {
  const palette = quantize(rgba, 256, { format: 'rgba4444' });
  const indexed = applyPalette(rgba, palette, 'rgba4444');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 3, 0, 0, 0], 8);
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw.set(indexed.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const chunks = [
    pngChunk('IHDR', header),
    pngChunk('PLTE', Buffer.from(palette.flatMap(([r, g, b]) => [r, g, b]))),
  ];
  if (palette.some((color) => color[3] !== 255)) {
    chunks.push(pngChunk('tRNS', Buffer.from(palette.map((color) => color[3] ?? 255))));
  }
  chunks.push(pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

// Encodings to try, best quality first. The first one under the cap wins.
function* stillEncodings(rgba, width, height, sourceMime) {
  const opaque = isOpaque(rgba);
  if (sourceMime === 'image/png') {
    const png = new PNG({ width, height });
    png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length);
    yield { mimeType: 'image/png', buffer: PNG.sync.write(png, { colorType: opaque ? 2 : 6, deflateLevel: 9 }) };
    yield { mimeType: 'image/png', buffer: encodeIndexedPng(rgba, width, height) };
    if (!opaque) return;
  }
  for (const quality of JPEG_QUALITIES) {
    yield { mimeType: 'image/jpeg', buffer: Buffer.from(jpeg.encode({ data: rgba, width, height }, quality).data) };
  }
}

function stampStill(buffer, mint, sourceMime, maxBytes) {
  const image = sourceMime === 'image/png'
    ? PNG.sync.read(buffer)
    : jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 256 });
  const fit = fitStamp(image.width, image.height, mint);
  if (!fit) return { reason: 'logo-too-small' };
  const rgba = upscale(image.data, image.width, image.height, fit.factor);
  drawStamp(rgba, fit.width, fit.height, fit.plan);
  let smallest = null;
  for (const encoded of stillEncodings(rgba, fit.width, fit.height, sourceMime)) {
    if (encoded.buffer.length <= maxBytes) return encoded;
    if (!smallest || encoded.buffer.length < smallest.buffer.length) smallest = encoded;
  }
  return smallest;
}

// Animated GIFs.
//
// Every source frame is composited onto the full canvas (honouring its
// disposal) and stamped. Re-encoding each of those frames whole made a typical
// delta-optimised GIF 5-6x larger and pushed it over the upload cap, so the
// stamp was silently skipped. Instead each frame stores only the rectangle that
// changed from the previous one (the static stamp band never changes, so it is
// stored once). If the result is still over the cap the encoder trades colours,
// then frame rate, for size, keeping the loop's total duration.
const GIF_ATTEMPTS = [
  { colors: 256, step: 1 },
  { colors: 128, step: 1 },
  { colors: 64, step: 1 },
  { colors: 64, step: 2 },
  { colors: 32, step: 2 },
  { colors: 32, step: 3 },
  { colors: 16, step: 4 },
];
const GIF_OPAQUE_ALPHA = 128;

// Stamped full-canvas RGBA for each source frame, one at a time.
function* stampedGifFrames(frames, width, height, fit) {
  const canvas = new Uint8ClampedArray(width * height * 4);
  let previous = null;
  for (const frame of frames) {
    if (previous?.disposalType === 2) {
      const { left, top, width: w, height: h } = previous.dims;
      for (let y = top; y < Math.min(height, top + h); y += 1) {
        canvas.fill(0, (y * width + left) * 4, (y * width + Math.min(width, left + w)) * 4);
      }
    } else if (previous?.disposalType === 3 && previous.saved) {
      canvas.set(previous.saved);
    }
    const saved = frame.disposalType === 3 ? canvas.slice() : null;
    const { left, top, width: w, height: h } = frame.dims;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const cx = left + x;
        const cy = top + y;
        if (cx >= width || cy >= height) continue;
        const src = (y * w + x) * 4;
        if (frame.patch[src + 3] === 0) continue;
        canvas.set(frame.patch.subarray(src, src + 4), (cy * width + cx) * 4);
      }
    }
    const out = fit.factor === 1 ? canvas.slice() : upscale(canvas, width, height, fit.factor);
    drawStamp(out, fit.width, fit.height, fit.plan);
    yield { out, delay: frame.delay || 0 };
    previous = { disposalType: frame.disposalType, dims: frame.dims, saved };
  }
}

function samePixel(a, b, offset) {
  const aClear = a[offset + 3] < GIF_OPAQUE_ALPHA;
  const bClear = b[offset + 3] < GIF_OPAQUE_ALPHA;
  if (aClear || bClear) return aClear && bClear;
  return a[offset] === b[offset] && a[offset + 1] === b[offset + 1] && a[offset + 2] === b[offset + 2];
}

// Bounding box of the pixels that differ, or null when the frames match.
function changedBox(out, previous, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (samePixel(out, previous, (y * width + x) * 4)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// True when showing `next` on top of `current` needs no pixel to go from
// visible back to transparent, i.e. a transparent "unchanged" pixel is enough.
function canLayerOver(current, next) {
  for (let i = 3; i < current.length; i += 4) {
    if (current[i] >= GIF_OPAQUE_ALPHA && next[i] < GIF_OPAQUE_ALPHA) return false;
  }
  return true;
}

// gifenc always writes a frame at (0, 0). Move the frame it just wrote by
// rewriting the left/top of its image descriptor (0x2C, left, top, width, height).
function placeLastFrame(encoder, startOffset, left, top) {
  if (!left && !top) return;
  const bytes = encoder.bytesView();
  for (let i = startOffset; i < bytes.length - 12; i += 1) {
    // Graphic control extension: 21 F9 04 <flags> <delay x2> <transparent> 00 (8 bytes), then 2C.
    if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04 && bytes[i + 7] === 0x00 && bytes[i + 8] === 0x2c) {
      const at = i + 9;
      bytes[at] = left & 0xff;
      bytes[at + 1] = (left >> 8) & 0xff;
      bytes[at + 2] = top & 0xff;
      bytes[at + 3] = (top >> 8) & 0xff;
      return;
    }
  }
  throw new Error('gif frame descriptor not found');
}

function encodeStampedGif(frames, width, height, fit, { colors, step }) {
  const encoder = GIFEncoder();
  let pending = null; // the frame waiting for its disposal to be decided

  const write = (frame, dispose, box = frame.box) => {
    const { out, delta, delay } = frame;
    const region = new Uint8ClampedArray(box.width * box.height * 4);
    let hasClear = false;
    for (let y = 0; y < box.height; y += 1) {
      for (let x = 0; x < box.width; x += 1) {
        const from = ((box.top + y) * fit.width + box.left + x) * 4;
        const to = (y * box.width + x) * 4;
        if (delta && samePixel(out, delta, from)) { hasClear = true; continue; }
        if (out[from + 3] < GIF_OPAQUE_ALPHA) { hasClear = true; continue; }
        region[to] = out[from];
        region[to + 1] = out[from + 1];
        region[to + 2] = out[from + 2];
        region[to + 3] = 255;
      }
    }
    const format = hasClear ? 'rgba4444' : 'rgb565';
    const palette = quantize(region, colors, hasClear ? { format, oneBitAlpha: true } : { format });
    const indexed = applyPalette(region, palette, format);
    const clearIndex = hasClear ? palette.findIndex((color) => color[3] === 0) : -1;
    const startOffset = encoder.bytesView().length;
    encoder.writeFrame(indexed, box.width, box.height, {
      palette,
      delay: frame.delay,
      repeat: frame.first ? 0 : undefined,
      transparent: clearIndex >= 0,
      transparentIndex: Math.max(0, clearIndex),
      dispose,
    });
    placeLastFrame(encoder, startOffset, box.left, box.top);
  };

  // `step` > 1 drops frames to save bytes; the delays of the dropped ones are
  // added to the frame that stays so the loop keeps its length.
  let kept = null;
  let index = 0;
  const flush = (next) => {
    if (!kept) return;
    if (!pending) {
      pending = { out: kept.out, box: { left: 0, top: 0, width: fit.width, height: fit.height }, delta: null, delay: kept.delay, first: true };
      kept = null;
      return;
    }
    if (canLayerOver(pending.out, kept.out)) {
      const box = changedBox(kept.out, pending.out, fit.width, fit.height);
      if (!box) {
        pending.delay += kept.delay;
        kept = null;
        return;
      }
      write(pending, 1);
      pending = { out: kept.out, box, delta: pending.out, delay: kept.delay, first: false };
    } else {
      // Disposal clears the whole image descriptor. The frame may only draw a
      // cropped delta, while older pixels elsewhere also need to become clear.
      // Expand the descriptor to cover every pixel that changes before the
      // next full-canvas frame, then let that next frame redraw its scene.
      const clearBox = changedBox(kept.out, pending.out, fit.width, fit.height);
      const left = Math.min(clearBox.left, pending.box.left);
      const top = Math.min(clearBox.top, pending.box.top);
      const right = Math.max(clearBox.left + clearBox.width, pending.box.left + pending.box.width);
      const bottom = Math.max(clearBox.top + clearBox.height, pending.box.top + pending.box.height);
      write(pending, 2, { left, top, width: right - left, height: bottom - top });
      pending = { out: kept.out, box: { left: 0, top: 0, width: fit.width, height: fit.height }, delta: null, delay: kept.delay, first: false };
    }
    kept = null;
    void next;
  };
  for (const frame of stampedGifFrames(frames, width, height, fit)) {
    if (index % step === 0) {
      flush();
      kept = { out: frame.out, delay: frame.delay };
    } else if (kept) {
      kept.delay += frame.delay;
    }
    index += 1;
  }
  flush();
  if (pending) write(pending, 1);
  encoder.finish();
  return Buffer.from(encoder.bytes());
}

function stampGif(buffer, mint, maxBytes) {
  const gif = parseGIF(Uint8Array.from(buffer));
  const frames = decompressFrames(gif, true);
  const width = gif.lsd.width;
  const height = gif.lsd.height;
  const fit = fitStamp(width, height, mint);
  if (!fit) return { reason: 'logo-too-small' };
  if (!frames.length) return { reason: 'logo-unreadable' };

  let smallest = null;
  for (const attempt of GIF_ATTEMPTS) {
    if (attempt.step > 1 && frames.length < 4) break;
    const encoded = encodeStampedGif(frames, width, height, fit, attempt);
    if (!smallest || encoded.length < smallest.length) smallest = encoded;
    if (encoded.length <= maxBytes) break;
  }
  return { buffer: smallest, mimeType: 'image/gif' };
}

// Stamp `mint` onto a logo data URL. Always resolves; `stamped: false` comes
// with a `reason` and the original data URL.
export function stampLogoDataUrl(logoDataUrl, mint, { maxBytes = LOGO_MAX_BYTES } = {}) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(logoDataUrl || ''));
  if (!match) return { stamped: false, reason: 'logo-not-data-url', dataUrl: logoDataUrl };
  const input = Buffer.from(match[2], 'base64');
  // Trust the bytes, not the label: browsers name the type after the file
  // extension, and a renamed JPEG is common.
  const mimeType = detectLogoImageMime(input);
  let result;
  try {
    if (mimeType === 'image/png' || mimeType === 'image/jpeg') result = stampStill(input, mint, mimeType, maxBytes);
    else if (mimeType === 'image/gif') result = stampGif(input, mint, maxBytes);
    else result = { reason: 'logo-format-unsupported' };
  } catch (error) {
    result = { reason: 'logo-unreadable', error: error?.message || String(error) };
  }
  if (!result.buffer) {
    return { stamped: false, reason: result.reason, error: result.error, dataUrl: logoDataUrl };
  }
  if (result.buffer.length > maxBytes) {
    return {
      stamped: false,
      reason: 'stamped-logo-too-large',
      stampedBytes: result.buffer.length,
      dataUrl: logoDataUrl,
    };
  }
  return {
    stamped: true,
    mimeType: result.mimeType,
    bytes: result.buffer.length,
    dataUrl: `data:${result.mimeType};base64,${result.buffer.toString('base64')}`,
  };
}
