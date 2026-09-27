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
  const gif = parseGIF(Uint8Array.from(decode(result.dataUrl)));
  const frames = decompressFrames(gif, true);
  assert.equal(frames.length, 3);
  const plan = planStamp(240, 240, MINT);
  for (const frame of frames) {
    assert.equal(frame.delay, 120);
    assert.ok(whitePixels(frame.patch, 240, plan.bandTop, 240) > 100);
  }
  assert.deepEqual([...frames[1].patch.subarray(0, 3)], [0, 0, 255], 'frame colours survive');
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
