function logoSummary(logo = state.tokenLogo) {
  if (!logo) return 'No logo selected';
  const kb = Math.max(1, Math.ceil(Number(logo.sizeBytes || 0) / 1024));
  const animated = logo.animated ? ' · animated' : '';
  return `${logo.name || 'Logo'} · ${kb} KB${animated}`;
}

function loadLogoImage(file) {
  return new Promise((resolve, reject) => {
    if (typeof URL === 'undefined' || typeof Image === 'undefined') {
      reject(new Error('Logo image processing is unavailable in this runtime'));
      return;
    }
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      resolve({
        image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        release: () => URL.revokeObjectURL(url),
      });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode image - file may be corrupt'));
    };
    image.src = url;
  });
}

function launchIdentityRgbHex(rgb = []) {
  return `#${rgb.slice(0, 3).map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')}`;
}

function launchIdentityRelativeLuminance(rgb = []) {
  const channels = rgb.slice(0, 3).map((value) => {
    const channel = Math.max(0, Math.min(255, Number(value) || 0)) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function launchIdentityMixRgb(from = [], to = [], amount = 0.5) {
  return from.slice(0, 3).map((value, index) => Math.round(
    Number(value || 0) + ((Number(to[index]) || 0) - Number(value || 0)) * amount,
  ));
}

function launchIdentityRgbToHsl(rgb = []) {
  const [r, g, b] = rgb.slice(0, 3).map((value) => Math.max(0, Math.min(255, Number(value) || 0)) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue;
  if (max === r) hue = ((g - b) / delta) + (g < b ? 6 : 0);
  else if (max === g) hue = ((b - r) / delta) + 2;
  else hue = ((r - g) / delta) + 4;
  return [hue / 6, saturation, lightness];
}

function launchIdentityHslToRgb(hsl = []) {
  let [hue, saturation, lightness] = hsl;
  hue = ((Number(hue) || 0) % 1 + 1) % 1;
  saturation = Math.max(0, Math.min(1, Number(saturation) || 0));
  lightness = Math.max(0, Math.min(1, Number(lightness) || 0));
  if (saturation === 0) {
    const gray = Math.round(lightness * 255);
    return [gray, gray, gray];
  }
  const hueToRgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = lightness < 0.5
    ? lightness * (1 + saturation)
    : lightness + saturation - (lightness * saturation);
  const p = 2 * lightness - q;
  return [
    Math.round(hueToRgb(p, q, hue + 1 / 3) * 255),
    Math.round(hueToRgb(p, q, hue) * 255),
    Math.round(hueToRgb(p, q, hue - 1 / 3) * 255),
  ];
}

function defaultLaunchIdentityArt() {
  const primary = [116, 247, 169];
  const accent = [104, 207, 255];
  return {
    palette: {
      primary,
      accent,
      primaryHex: launchIdentityRgbHex(primary),
      accentHex: launchIdentityRgbHex(accent),
      contrast: '#03100a',
    },
    posterDataUrl: null,
  };
}

function tuneLaunchIdentityColor(rgb = []) {
  const luminance = launchIdentityRelativeLuminance(rgb);
  if (luminance < 0.08) {
    // Lift dark colors in HSL so they keep their hue instead of greying out.
    const [hue, saturation, lightness] = launchIdentityRgbToHsl(rgb);
    return launchIdentityHslToRgb([hue, saturation, Math.max(lightness, 0.46)]).map((value) => Math.round(value));
  }
  if (luminance > 0.88) return launchIdentityMixRgb(rgb, [0, 0, 0], 0.22);
  return rgb.map((value) => Math.round(value));
}

function extractLaunchIdentityArt(image, { includePoster = false } = {}) {
  const fallback = defaultLaunchIdentityArt();
  try {
    const sample = document.createElement('canvas');
    sample.width = 40;
    sample.height = 40;
    const context = sample.getContext('2d', { willReadFrequently: true });
    if (!context || typeof context.getImageData !== 'function') return fallback;
    context.drawImage(image, 0, 0, sample.width, sample.height);
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
    const buckets = new Map();
    for (let index = 0; index < pixels.length; index += 4) {
      const alpha = pixels[index + 3];
      if (alpha < 96) continue;
      const r = pixels[index];
      const g = pixels[index + 1];
      const b = pixels[index + 2];
      const key = `${Math.round(r / 24)}:${Math.round(g / 24)}:${Math.round(b / 24)}`;
      const bucket = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 };
      bucket.count += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      buckets.set(key, bucket);
    }
    const scored = [...buckets.values()].map((bucket) => {
      const rgb = [bucket.r, bucket.g, bucket.b].map((sum) => sum / bucket.count);
      const [, saturation, lightness] = launchIdentityRgbToHsl(rgb);
      const middleBias = 1 - Math.min(0.72, Math.abs(lightness - 0.52));
      return {
        rgb,
        count: bucket.count,
        chromatic: saturation >= 0.28 && lightness >= 0.12 && lightness <= 0.9,
        score: (bucket.count ** 0.72) * (0.42 + saturation * 1.8) * middleBias,
      };
    });
    // Dark or white backgrounds would win on pixel count alone; use the
    // logo's colors whenever it has enough of them.
    const total = scored.reduce((sum, candidate) => sum + candidate.count, 0);
    const chromatic = scored.filter((candidate) => candidate.chromatic);
    const chromaticCount = chromatic.reduce((sum, candidate) => sum + candidate.count, 0);
    const candidates = (chromaticCount >= total * 0.04 ? chromatic : scored)
      .sort((a, b) => b.score - a.score);
    if (!candidates.length) return fallback;

    const primary = tuneLaunchIdentityColor(candidates[0].rgb);
    const distance = (a, b) => Math.sqrt(a.reduce((sum, value, index) => sum + ((value - b[index]) ** 2), 0));
    const accentCandidate = candidates.slice(1)
      .map((candidate) => ({ ...candidate, rgb: tuneLaunchIdentityColor(candidate.rgb) }))
      .filter((candidate) => distance(candidate.rgb, primary) >= 72)
      .sort((a, b) => (b.score * distance(b.rgb, primary)) - (a.score * distance(a.rgb, primary)))[0];
    const primaryHsl = launchIdentityRgbToHsl(primary);
    const accent = tuneLaunchIdentityColor(accentCandidate?.rgb || launchIdentityHslToRgb([
      primaryHsl[0] + 0.12,
      Math.max(0.55, primaryHsl[1]),
      Math.max(0.44, Math.min(0.68, primaryHsl[2])),
    ]));
    const contrast = launchIdentityRelativeLuminance(primary) > 0.44 ? '#03100a' : '#f7fbf9';
    let posterDataUrl = null;
    if (includePoster) {
      const poster = document.createElement('canvas');
      const size = 192;
      poster.width = size;
      poster.height = size;
      const posterContext = poster.getContext('2d');
      const sourceWidth = Number(image.naturalWidth || image.width || 1);
      const sourceHeight = Number(image.naturalHeight || image.height || 1);
      const scale = Math.max(size / sourceWidth, size / sourceHeight);
      const width = sourceWidth * scale;
      const height = sourceHeight * scale;
      posterContext?.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
      if (typeof poster.toDataURL === 'function') posterDataUrl = poster.toDataURL('image/png');
    }
    return {
      palette: {
        primary,
        accent,
        primaryHex: launchIdentityRgbHex(primary),
        accentHex: launchIdentityRgbHex(accent),
        contrast,
      },
      posterDataUrl,
    };
  } catch (_) {
    return fallback;
  }
}

function logoCanvasBlob(image, width, height, mimeType, quality) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: mimeType === 'image/png' });
    if (!context) {
      reject(new Error('Logo compression is unavailable in this runtime'));
      return;
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Logo compression failed'));
        return;
      }
      resolve(blob);
    }, mimeType, quality);
  });
}

function nextLogoScale(scale, encodedBytes) {
  const estimated = Math.sqrt(CLASSIC_LOGO_MAX_BYTES / Math.max(1, encodedBytes)) * 0.94;
  return scale * Math.max(0.55, Math.min(0.86, estimated));
}

async function compressLogoFile(file, source) {
  const sourceScale = Math.min(1, CLASSIC_LOGO_MAX_DIMENSION / Math.max(source.width, source.height));
  const minimumScale = CLASSIC_LOGO_MIN_DIMENSION / Math.min(source.width, source.height);
  let scale = sourceScale;
  let lastAttemptScale = null;

  while (scale >= minimumScale) {
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const qualities = file.type === 'image/jpeg' ? LOGO_JPEG_QUALITY_STEPS : [undefined];
    let smallestBlob = null;

    for (const quality of qualities) {
      const blob = await logoCanvasBlob(source.image, width, height, file.type, quality);
      if (!smallestBlob || blob.size < smallestBlob.size) smallestBlob = blob;
      if (blob.size <= CLASSIC_LOGO_MAX_BYTES) {
        const optimizedFile = new File([blob], file.name || 'token-logo', {
          type: file.type,
          lastModified: Number(file.lastModified) || Date.now(),
        });
        return {
          file: optimizedFile,
          width,
          height,
          compressed: true,
          originalSizeBytes: file.size,
        };
      }
    }

    lastAttemptScale = scale;
    const reducedScale = nextLogoScale(scale, smallestBlob?.size || file.size);
    if (reducedScale < minimumScale && lastAttemptScale !== minimumScale) {
      scale = minimumScale;
    } else if (Math.abs(reducedScale - scale) < 0.0001) {
      break;
    } else {
      scale = reducedScale;
    }
  }

  throw new Error('Logo could not be compressed below 100KB without becoming too small');
}

async function validateLogoFile(file) {
  if (!file) return null;
  const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/gif']);
  if (!allowedTypes.has(file.type)) {
    throw new Error('Logo must be a PNG, JPG, or GIF image');
  }
  if (file.size <= 0 || file.size > LOGO_SOURCE_MAX_BYTES) {
    const mb = Math.max(1, Math.ceil(Number(file.size || 0) / (1024 * 1024)));
    throw new Error(`Logo is ${mb}MB; source max is 10MB`);
  }

  const source = await loadLogoImage(file);
  try {
    const identity = extractLaunchIdentityArt(source.image, { includePoster: file.type === 'image/gif' });
    if (source.width > LOGO_SOURCE_MAX_DIMENSION || source.height > LOGO_SOURCE_MAX_DIMENSION) {
      throw new Error(`Logo dimensions must be ${LOGO_SOURCE_MAX_DIMENSION}x${LOGO_SOURCE_MAX_DIMENSION}px or smaller before compression`);
    }
    if (source.width < CLASSIC_LOGO_MIN_DIMENSION || source.height < CLASSIC_LOGO_MIN_DIMENSION) {
      throw new Error(`Logo is ${source.width}x${source.height}px; minimum is ${CLASSIC_LOGO_MIN_DIMENSION}x${CLASSIC_LOGO_MIN_DIMENSION}px`);
    }
    const requiresCompression = file.size > CLASSIC_LOGO_MAX_BYTES
      || source.width > CLASSIC_LOGO_MAX_DIMENSION
      || source.height > CLASSIC_LOGO_MAX_DIMENSION;
    if (!requiresCompression) {
      return {
        file,
        width: source.width,
        height: source.height,
        compressed: false,
        originalSizeBytes: file.size,
        identity,
      };
    }
    if (file.type === 'image/gif') {
      const optimizer = globalThis.TrebuchetGifOptimizer?.optimizeAnimatedGif;
      if (typeof optimizer !== 'function') {
        throw new Error('Animated GIF compression is unavailable; reload Trebuchet and try again');
      }
      return {
        ...await optimizer(file, {
          maxBytes: CLASSIC_LOGO_MAX_BYTES,
          maxDimension: CLASSIC_LOGO_MAX_DIMENSION,
          minDimension: CLASSIC_LOGO_MIN_DIMENSION,
        }),
        identity,
      };
    }
    return {
      ...await compressLogoFile(file, source),
      identity,
    };
  } finally {
    source.release();
  }
}

function validateProofFile(file) {
  if (!file) return null;
  const name = String(file.name || '');
  const type = String(file.type || '');
  const jsonLike = type === 'application/json'
    || type === 'text/json'
    || (!type && /\.json$/i.test(name))
    || /\.json$/i.test(name);
  const htmlLike = type === 'text/html'
    || (!type && /\.html?$/i.test(name))
    || /\.html?$/i.test(name);
  if (!jsonLike && !htmlLike) {
    throw new Error('Proof import must be a Trebuchet JSON proof or HTML launch record');
  }
  if (file.size <= 0 || file.size > LAUNCH_PROOF_IMPORT_LIMIT) {
    throw new Error('Proof import must be 2MB or smaller');
  }
  return file;
}

function validateClassicArtifactFile(file) {
  if (!file) return null;
  const name = String(file.name || '');
  const type = String(file.type || '');
  const artifactLike = type === 'application/json'
    || type === 'text/json'
    || type === 'text/html'
    || type === 'text/plain'
    || (!type && /\.(json|html?|txt)$/i.test(name))
    || /\.(json|html?|txt)$/i.test(name);
  if (!artifactLike) {
    throw new Error('Classic artifact must be JSON, HTML, or text');
  }
  if (file.size <= 0 || file.size > CLASSIC_ARTIFACT_IMPORT_LIMIT) {
    throw new Error('Classic artifact must be 1MB or smaller');
  }
  return file;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (typeof FileReader !== 'function') {
      reject(new Error('Logo picker is unavailable in this runtime'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Logo read failed'));
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file, label = 'File') {
  return new Promise((resolve, reject) => {
    if (typeof FileReader !== 'function') {
      reject(new Error(`${label} picker is unavailable in this runtime`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(`${label} read failed`));
    reader.readAsText(file);
  });
}

async function selectTokenLogo(file) {
  try {
    if (file?.type === 'image/gif' && file.size > CLASSIC_LOGO_MAX_BYTES) {
      notify('Optimizing animated GIF locally…');
    }
    const prepared = await validateLogoFile(file);
    if (!prepared) return;
    const safeFile = prepared.file;
    const dataUrl = await readFileAsDataUrl(safeFile);
    state.tokenLogo = {
      name: safeFile.name || 'token-logo',
      mimeType: safeFile.type,
      sizeBytes: safeFile.size,
      width: prepared.width,
      height: prepared.height,
      compressed: prepared.compressed,
      originalSizeBytes: prepared.originalSizeBytes,
      frameCount: prepared.frameCount,
      originalFrameCount: prepared.originalFrameCount,
      animated: safeFile.type === 'image/gif',
      dataUrl,
    };
    state.launchIdentity = prepared.identity || defaultLaunchIdentityArt();
    state.tokenLogoError = null;
    invalidateClassicOutputs();
    refreshClassicPreview({ includePoolEditor: true });
    if (prepared.compressed && safeFile.type === 'image/gif') {
      const beforeMb = (Number(prepared.originalSizeBytes || 0) / (1024 * 1024)).toFixed(1);
      const afterKb = Math.max(1, Math.ceil(safeFile.size / 1024));
      notify(`Animated GIF compressed from ${beforeMb}MB to ${afterKb}KB and attached`);
    } else {
      notify(prepared.compressed ? 'Token logo auto-compressed and attached' : 'Token logo attached');
    }
  } catch (error) {
    state.tokenLogo = null;
    state.launchIdentity = { palette: null, posterDataUrl: null };
    state.tokenLogoError = error.message || 'Token logo failed validation';
    const input = document.getElementById('tokenLogoFile');
    if (input) input.value = '';
    invalidateClassicOutputs();
    refreshClassicPreview({ includePoolEditor: true });
    notify(state.tokenLogoError);
  }
}

function clearTokenLogo() {
  state.tokenLogo = null;
  state.launchIdentity = { palette: null, posterDataUrl: null };
  state.tokenLogoError = null;
  const input = document.getElementById('tokenLogoFile');
  if (input) input.value = '';
  invalidateClassicOutputs();
  refreshClassicPreview({ includePoolEditor: true });
  notify('Token logo cleared');
}

function numberStepperLabel(input) {
  const label = input.closest('label');
  const labelText = label?.querySelector(':scope > span')?.textContent?.trim();
  return labelText || input.getAttribute('aria-label') || input.name || input.id || 'value';
}

function enhanceNumberSteppers(root = document) {
  root.querySelectorAll('input[type="number"]:not([data-number-stepper])').forEach((input) => {
    input.dataset.numberStepper = 'ready';
    const label = numberStepperLabel(input);
    const shell = document.createElement('span');
    shell.className = 'number-stepper';

    const decrement = document.createElement('button');
    decrement.type = 'button';
    decrement.className = 'number-stepper-button';
    decrement.dataset.action = 'step-number';
    decrement.dataset.direction = '-1';
    decrement.setAttribute('aria-label', `Decrease ${label}`);
    decrement.textContent = '−';

    const increment = document.createElement('button');
    increment.type = 'button';
    increment.className = 'number-stepper-button';
    increment.dataset.action = 'step-number';
    increment.dataset.direction = '1';
    increment.setAttribute('aria-label', `Increase ${label}`);
    increment.textContent = '+';

    input.parentNode.insertBefore(shell, input);
    shell.append(decrement, input, increment);
  });
}

function stepNumberInput(input, direction) {
  if (!input || input.disabled || input.readOnly) return false;
  const previousValue = input.value;
  try {
    if (direction > 0) input.stepUp();
    else input.stepDown();
  } catch (_) {
    return false;
  }
  if (input.value === previousValue) return false;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus({ preventScroll: true });
  return true;
}

async function copyText(value, label = 'Value') {
  const text = String(value || '');
  if (!text) {
    notify('Nothing to copy');
    return;
  }
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(text);
    notify(`${label} copied`);
  } catch {
    await openOperatorPrompt({
      eyebrow: 'Clipboard fallback',
      title: `Copy ${label}`,
      detail: 'Automatic clipboard access is unavailable. Select the value below and copy it manually.',
      label,
      value: text,
      multiline: true,
      readOnly: true,
      required: false,
      confirmLabel: 'Done',
      message: 'Select and copy the value manually.',
    });
  }
}
