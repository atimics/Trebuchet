import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { parseGIF, decompressFrames } from 'gifuct-js';

import { planStamp, stampLogoDataUrl } from '../logoStampService.js';
import { uploadTokenMetadata } from '../metadataUploadService.js';

const require = createRequire(import.meta.url);
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const MINT = 'RUGx1zSD7LCVqFgTYQWNiJKSkDcfN3yRR5XoFoAXRUG';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function solidRgba(width, height, [r, g, b, a]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([r, g, b, a], i);
  return data;
}

function pngDataUrl(width, height, color) {
  const png = new PNG({ width, height });
  png.data = Buffer.from(solidRgba(width, height, color));
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
}

function decode(dataUrl) {
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

function whitePixels(rgba, width, fromRow, toRow) {
  let count = 0;
  for (let y = fromRow; y < toRow; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      if (rgba[o] > 240 && rgba[o + 1] > 240 && rgba[o + 2] > 240 && rgba[o + 3] > 240) count += 1;
    }
  }
  return count;
}

test('the stamp font covers every base58 character', () => {
  assert.ok(planStamp(1024, 1024, BASE58.slice(0, 44)));
  assert.ok(planStamp(1024, 1024, BASE58.slice(14)));
  assert.throws(() => planStamp(1024, 1024, 'O0Il'), /no glyph/);
});

test('stamp layout picks the largest legible scale and stays in the bottom band', () => {
  const wide = planStamp(512, 512, MINT);
  assert.equal(wide.lines.length, 2);
  assert.equal(wide.scale, 2);
  assert.ok(512 - wide.bandTop <= 512 * 0.16);
  assert.equal(planStamp(100, 100, MINT), null, 'too small to hold a legible CA');
});

test('PNG logos get a CA band at the bottom and keep the rest of the image', () => {
  const result = stampLogoDataUrl(pngDataUrl(512, 512, [200, 40, 40, 255]), MINT);
  assert.equal(result.stamped, true);
  assert.equal(result.mimeType, 'image/png');
  const png = PNG.sync.read(decode(result.dataUrl));
  const plan = planStamp(512, 512, MINT);
  assert.deepEqual([...png.data.subarray(0, 4)], [200, 40, 40, 255], 'top of the logo untouched');
  assert.equal(whitePixels(png.data, 512, 0, plan.bandTop), 0);
  assert.ok(whitePixels(png.data, 512, plan.bandTop, 512) > 500, 'CA text drawn in the band');
});

test('small logos are upscaled until the CA is legible', () => {
  const result = stampLogoDataUrl(pngDataUrl(128, 128, [10, 200, 90, 255]), MINT);
  assert.equal(result.stamped, true);
  const png = PNG.sync.read(decode(result.dataUrl));
  assert.deepEqual([png.width, png.height], [256, 256]);
  assert.deepEqual([...png.data.subarray(0, 4)], [10, 200, 90, 255]);
});

test('transparent PNG logos stay transparent outside the band', () => {
  const result = stampLogoDataUrl(pngDataUrl(300, 300, [0, 0, 0, 0]), MINT);
  assert.equal(result.stamped, true);
  const png = PNG.sync.read(decode(result.dataUrl));
  assert.equal(png.data[3], 0);
  assert.ok(png.data[(299 * 300) * 4 + 3] > 150, 'band is opaque enough to read on any wallet');
});

test('JPEG logos are stamped and re-encoded as JPEG', () => {
  const encoded = jpeg.encode({ data: solidRgba(400, 400, [20, 120, 220, 255]), width: 400, height: 400 }, 90);
  const result = stampLogoDataUrl(`data:image/jpeg;base64,${Buffer.from(encoded.data).toString('base64')}`, MINT);
  assert.equal(result.stamped, true);
  assert.equal(result.mimeType, 'image/jpeg');
  const image = jpeg.decode(decode(result.dataUrl), { useTArray: true, formatAsRGBA: true });
  const plan = planStamp(400, 400, MINT);
  assert.ok(whitePixels(image.data, 400, plan.bandTop, 400) > 200);
});

test('animated GIF logos keep every frame and its timing, each stamped', () => {
  const encoder = GIFEncoder();
  for (const color of [[255, 0, 0, 255], [0, 0, 255, 255], [0, 255, 0, 255]]) {
    const rgba = solidRgba(240, 240, color);
    const palette = quantize(rgba, 256);
    encoder.writeFrame(applyPalette(rgba, palette), 240, 240, { palette, delay: 120 });
  }
  encoder.finish();
  const source = `data:image/gif;base64,${Buffer.from(encoder.bytes()).toString('base64')}`;

  const result = stampLogoDataUrl(source, MINT);
  assert.equal(result.stamped, true);
  assert.equal(result.mimeType, 'image/gif');
  // Frames store only what changed, so judge what a viewer sees after each one.
  const { shown } = playGif(decode(result.dataUrl));
  assert.equal(shown.length, 3);
  const plan = planStamp(240, 240, MINT);
  for (const frame of shown) {
    assert.equal(frame.delay, 120);
    assert.ok(whitePixels(frame.rgba, 240, plan.bandTop, 240) > 100);
  }
  assert.deepEqual([...shown[1].rgba.subarray(0, 3)], [0, 0, 255], 'frame colours survive');
});

test('logos that cannot carry a stamp come back unchanged with a reason', () => {
  const tiny = pngDataUrl(20, 20, [1, 2, 3, 255]);
  assert.deepEqual(stampLogoDataUrl(tiny, MINT), { stamped: false, reason: 'logo-too-small', error: undefined, dataUrl: tiny });

  const big = pngDataUrl(512, 512, [9, 9, 9, 255]);
  const overCap = stampLogoDataUrl(big, MINT, { maxBytes: 100 });
  assert.equal(overCap.stamped, false);
  assert.equal(overCap.reason, 'stamped-logo-too-large');
  assert.equal(overCap.dataUrl, big);

  assert.equal(stampLogoDataUrl('data:image/png;base64,bm90IGEgcG5n', MINT).reason, 'logo-format-unsupported');
  assert.equal(stampLogoDataUrl('data:image/webp;base64,AAAA', MINT).reason, 'logo-format-unsupported');
});

test('metadata upload sends the stamped logo when it knows the mint', async () => {
  const uploaded = [];
  const progress = [];
  const umi = {
    uploader: {
      async upload(files) {
        uploaded.push(files[0]);
        return ['https://arweave.net/logo'];
      },
      async uploadJson() {
        return 'https://arweave.net/metadata';
      },
    },
  };
  const logo = pngDataUrl(512, 512, [200, 40, 40, 255]);
  const result = await uploadTokenMetadata({
    umi,
    logoBase64: logo,
    name: 'RUGOWEEN',
    symbol: 'RUG',
    description: 'desc',
    mint: MINT,
    onProgress: (event) => progress.push(event.stage),
    logger: { log() {}, warn() {}, error() {} },
  });
  assert.equal(result.logoStamped, true);
  assert.equal(result.metadata.mint, MINT);
  assert.notDeepEqual(uploaded[0].buffer, decode(logo), 'the uploaded bytes are the stamped logo');
  assert.deepEqual(progress.slice(0, 2), ['logo_stamped', 'logo_uploaded']);

  const unstamped = await uploadTokenMetadata({
    umi,
    logoBase64: logo,
    name: 'RUGOWEEN',
    symbol: 'RUG',
    description: 'desc',
    mint: MINT,
    stampLogo: false,
    logger: { log() {}, warn() {}, error() {} },
  });
  assert.equal(unstamped.logoStamped, false);
  assert.deepEqual(uploaded[1].buffer, decode(logo));
});

// ---- Animated GIFs that look like real logos ------------------------------------------------
// A static background with a moving subject, stored the way GIF optimisers do it: the first frame
// whole, every later frame only the rectangle that changed (transparent elsewhere).

const SIZE = 256;

function gifBackground() {
  const bg = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) bg.set([30 + (x * 100) / SIZE, 20 + (y * 120) / SIZE, 90, 255], (y * SIZE + x) * 4);
  }
  return bg;
}

function gifScene(frame, frames) {
  const img = gifBackground();
  const cx = SIZE / 2 + Math.cos((frame / frames) * 6.283) * SIZE * 0.25;
  const cy = SIZE / 2 + Math.sin((frame / frames) * 6.283) * SIZE * 0.25;
  const r = SIZE * 0.14;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) img.set([250, Math.max(0, 200 - frame), 40, 255], (y * SIZE + x) * 4);
    }
  }
  return img;
}

// Encode full scenes as delta frames: unchanged pixels transparent, frame left in place.
function encodeDeltaGif(scenes, delay = 60) {
  const enc = GIFEncoder();
  scenes.forEach((img, i) => {
    let out = img;
    if (i > 0) {
      out = new Uint8ClampedArray(img.length);
      for (let p = 0; p < img.length; p += 4) {
        const prev = scenes[i - 1];
        if (img[p] !== prev[p] || img[p + 1] !== prev[p + 1] || img[p + 2] !== prev[p + 2]) out.set(img.subarray(p, p + 4), p);
      }
    }
    const palette = quantize(out, 256, { format: 'rgba4444', oneBitAlpha: true });
    const clear = palette.findIndex((color) => color[3] === 0);
    enc.writeFrame(applyPalette(out, palette, 'rgba4444'), SIZE, SIZE, {
      palette, delay, repeat: i === 0 ? 0 : undefined, transparent: clear >= 0, transparentIndex: Math.max(0, clear), dispose: 1,
    });
  });
  enc.finish();
  return Buffer.from(enc.bytes());
}

// What a viewer shows after each frame, honouring placement, transparency and disposal.
function playGif(buffer) {
  const gif = parseGIF(Uint8Array.from(buffer));
  const { width, height } = gif.lsd;
  const canvas = new Uint8ClampedArray(width * height * 4);
  const shown = [];
  let previous = null;
  for (const frame of decompressFrames(gif, true)) {
    if (previous?.disposalType === 2) {
      const { left, top, width: w, height: h } = previous.dims;
      for (let y = top; y < top + h; y += 1) canvas.fill(0, (y * width + left) * 4, (y * width + left + w) * 4);
    }
    const { left, top, width: w, height: h } = frame.dims;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const from = (y * w + x) * 4;
        if (frame.patch[from + 3] === 0) continue;
        canvas.set(frame.patch.subarray(from, from + 4), ((top + y) * width + left + x) * 4);
      }
    }
    shown.push({ rgba: canvas.slice(), delay: frame.delay, dims: frame.dims });
    previous = frame;
  }
  return { width, height, shown };
}

function meanError(a, b, fromRow, toRow, width) {
  let total = 0;
  let count = 0;
  for (let y = fromRow; y < toRow; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      total += Math.abs(a[o] - b[o]) + Math.abs(a[o + 1] - b[o + 1]) + Math.abs(a[o + 2] - b[o + 2]);
      count += 3;
    }
  }
  return total / count;
}

test('a delta-optimised animated GIF is stamped and stays under the logo cap', () => {
  const frames = 24;
  const scenes = Array.from({ length: frames }, (_, i) => gifScene(i, frames));
  const source = encodeDeltaGif(scenes);
  const result = stampLogoDataUrl(`data:image/gif;base64,${source.toString('base64')}`, MINT);

  // Before the fix every frame was re-encoded whole: ~5x larger, over the cap, stamp skipped.
  assert.equal(result.stamped, true, result.reason);
  assert.ok(result.bytes <= 100 * 1024, `stamped GIF is ${result.bytes} bytes`);

  const { width, height, shown } = playGif(decode(result.dataUrl));
  assert.equal(width, SIZE);
  assert.equal(height, SIZE);
  assert.equal(shown.length, frames, 'every frame is kept');
  assert.ok(shown.every((frame) => frame.delay === 60), 'timing is kept');

  const plan = planStamp(SIZE, SIZE, MINT);
  shown.forEach((frame, i) => {
    assert.ok(whitePixels(frame.rgba, SIZE, plan.bandTop, SIZE) > 100, `frame ${i} carries the stamp`);
    // Above the band the picture is the original scene, within colour-quantisation error.
    const error = meanError(frame.rgba, scenes[i], 0, plan.bandTop, SIZE);
    assert.ok(error < 6, `frame ${i} drifted ${error.toFixed(1)} from the source`);
  });
});

test('a GIF whose frames clear pixels is stamped without ghosting', () => {
  const scenes = [];
  for (let i = 0; i < 6; i += 1) {
    const img = new Uint8ClampedArray(SIZE * SIZE * 4); // fully transparent
    const x0 = 20 + i * 30;
    for (let y = 40; y < 140; y += 1) for (let x = x0; x < x0 + 60; x += 1) img.set([220, 40, 60, 255], (y * SIZE + x) * 4);
    scenes.push(img);
  }
  const enc = GIFEncoder();
  scenes.forEach((img, i) => {
    const palette = quantize(img, 256, { format: 'rgba4444', oneBitAlpha: true });
    const clear = palette.findIndex((color) => color[3] === 0);
    enc.writeFrame(applyPalette(img, palette, 'rgba4444'), SIZE, SIZE, {
      palette, delay: 80, repeat: i === 0 ? 0 : undefined, transparent: true, transparentIndex: Math.max(0, clear), dispose: 2,
    });
  });
  enc.finish();
  const result = stampLogoDataUrl(`data:image/gif;base64,${Buffer.from(enc.bytes()).toString('base64')}`, MINT);
  assert.equal(result.stamped, true, result.reason);
  const { shown } = playGif(decode(result.dataUrl));
  assert.equal(shown.length, 6);
  shown.forEach((frame, i) => {
    const x0 = 20 + i * 30;
    const at = (x, y) => frame.rgba[(y * SIZE + x) * 4 + 3];
    assert.equal(at(x0 + 30, 90), 255, `frame ${i}: the square is there`);
    if (i > 0) assert.ok(at(20 + (i - 1) * 30 + 5, 90) < 128 || x0 <= 20 + (i - 1) * 30 + 65, `frame ${i}: the previous square is gone`);
  });
  assert.ok(shown[5].rgba[(90 * SIZE + 25) * 4 + 3] < 128, 'the first square does not ghost into the last frame');
});

test('a cropped delta with disposal 2 clears older pixels outside its bounds', () => {
  const scenes = [];
  const scene = (rectangles) => {
    const img = new Uint8ClampedArray(SIZE * SIZE * 4);
    for (const { left, top, color } of rectangles) {
      for (let y = top; y < top + 20; y += 1) {
        for (let x = left; x < left + 20; x += 1) img.set([...color, 255], (y * SIZE + x) * 4);
      }
    }
    return img;
  };
  scenes.push(scene([{ left: 20, top: 30, color: [240, 20, 20] }]));
  scenes.push(scene([
    { left: 20, top: 30, color: [240, 20, 20] },
    { left: 110, top: 30, color: [20, 20, 240] },
  ]));
  scenes.push(scene([{ left: 190, top: 30, color: [20, 220, 20] }]));

  const encoder = GIFEncoder();
  scenes.forEach((img, index) => {
    const palette = quantize(img, 256, { format: 'rgba4444', oneBitAlpha: true });
    const clear = palette.findIndex((color) => color[3] === 0);
    encoder.writeFrame(applyPalette(img, palette, 'rgba4444'), SIZE, SIZE, {
      palette,
      delay: 80,
      repeat: index === 0 ? 0 : undefined,
      transparent: true,
      transparentIndex: Math.max(0, clear),
      dispose: index === 1 ? 2 : 1,
    });
  });
  encoder.finish();

  const result = stampLogoDataUrl(`data:image/gif;base64,${Buffer.from(encoder.bytes()).toString('base64')}`, MINT);
  assert.equal(result.stamped, true, result.reason);
  const { shown } = playGif(decode(result.dataUrl));
  assert.equal(shown.length, 3);
  const alphaAt = (frame, x) => frame.rgba[(40 * SIZE + x) * 4 + 3];
  assert.equal(alphaAt(shown[0], 25), 255, 'the first red square appears');
  assert.equal(alphaAt(shown[1], 25), 255, 'the red square remains in the second scene');
  assert.equal(alphaAt(shown[1], 115), 255, 'the blue square appears in the second scene');
  assert.ok(alphaAt(shown[2], 25) < 128, 'the red square is cleared from the last scene');
  assert.ok(alphaAt(shown[2], 115) < 128, 'the blue square is cleared from the last scene');
  assert.equal(alphaAt(shown[2], 195), 255, 'the green square appears in the last scene');
});

test('an animated GIF that cannot fit at full quality trades colours and frame rate, keeping the loop length', () => {
  // Noisy frames defeat delta coding, so this needs the size fallbacks.
  const frames = 30;
  const scenes = Array.from({ length: frames }, (_, f) => {
    const img = gifScene(f, frames);
    for (let p = 0; p < img.length; p += 4) {
      const n = ((p * 2654435761 + f * 40503) >>> 8) & 15;
      img[p] = Math.min(255, img[p] + n);
      img[p + 1] = Math.min(255, img[p + 1] + n);
    }
    return img;
  });
  const source = encodeDeltaGif(scenes, 50);
  const result = stampLogoDataUrl(`data:image/gif;base64,${source.toString('base64')}`, MINT);
  if (!result.stamped) {
    assert.equal(result.reason, 'stamped-logo-too-large', 'if it cannot fit, the reason says so');
    return;
  }
  assert.ok(result.bytes <= 100 * 1024);
  const { shown } = playGif(decode(result.dataUrl));
  const total = shown.reduce((sum, frame) => sum + frame.delay, 0);
  assert.ok(Math.abs(total - frames * 50) <= shown.length * 10, `loop is ${total}ms, expected about ${frames * 50}ms`);
});
