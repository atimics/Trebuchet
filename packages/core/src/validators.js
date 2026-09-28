const TOKEN_DECIMALS = 9;
const U64_MAX = (1n << 64n) - 1n;
const TOKEN_RAW_MULTIPLIER = 10n ** BigInt(TOKEN_DECIMALS);
const BASE58_CHARS = new Set('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz');
const JPEG_SOF_MARKERS = new Set([
  0xc0,
  0xc1,
  0xc2,
  0xc3,
  0xc5,
  0xc6,
  0xc7,
  0xc9,
  0xca,
  0xcb,
  0xcd,
  0xce,
  0xcf,
]);

function byteLength(s) {
  // Browser-safe: TextEncoder counts UTF-8 bytes without a Node Buffer.
  return new TextEncoder().encode(String(s)).length;
}

export function normalizeTokenName(value) {
  const name = String(value ?? '').trim();
  if (!name) throw new Error('Token name is required');
  if (byteLength(name) > 32) {
    throw new Error('Token name must be 32 UTF-8 bytes or fewer');
  }
  return name;
}

export function normalizeTokenSymbol(value) {
  const symbol = String(value ?? '').trim();
  if (!symbol) throw new Error('Token symbol is required');
  if (byteLength(symbol) > 10) {
    throw new Error('Token symbol must be 10 UTF-8 bytes or fewer');
  }
  return symbol;
}

export function normalizeTokenDescription(value) {
  const description = String(value ?? '').trim();
  if (byteLength(description) > 1000) {
    throw new Error('Token description must be 1000 UTF-8 bytes or fewer');
  }
  return description;
}

export function normalizeWholeTokenSupply(value, decimals = TOKEN_DECIMALS) {
  const raw = String(value ?? '').trim().replace(/,/g, '');
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error('Total supply must be a positive whole number');
  }

  const whole = BigInt(raw);
  const multiplier = 10n ** BigInt(decimals);
  const rawSupply = whole * multiplier;
  if (rawSupply > U64_MAX) {
    const maxWhole = U64_MAX / multiplier;
    throw new Error(
      `Total supply is too large for an SPL mint with ${decimals} decimals; ` +
        `maximum whole-token supply is ${maxWhole.toString()}`,
    );
  }

  return raw;
}

// Placeholder destinations used in examples, fixtures, and practice flows (the
// all-ones system-program family). Sweeping there is unrecoverable: nobody can
// sign for those addresses, so swept SOL, tokens, and Fee Key NFTs are lost and
// trading fees can never be claimed. Exposed as a predicate so hosts can warn
// or refuse without changing plan output.
const PLACEHOLDER_SWEEP_RE = /^1{20,}[1-9A-HJ-NP-Za-km-z]*$/;

export function isPlaceholderSweepDestination(value) {
  const destination = String(value ?? '').trim();
  return Boolean(destination) && PLACEHOLDER_SWEEP_RE.test(destination);
}

// The Solana incinerator: tokens and NFTs sent here are burned.
export const INCINERATOR_ADDRESS = '1nc1nerator11111111111111111111111111111111';

/**
 * Why a sweep must not go to this address, or null when it is safe.
 * Covers the placeholder family, the incinerator, and the launch wallet
 * itself (sweeping to yourself moves nothing and looks like success).
 */
export function unsafeSweepDestinationReason(value, { launchWallet = null } = {}) {
  const destination = String(value ?? '').trim();
  if (!destination) return null;
  if (isPlaceholderSweepDestination(destination)) {
    return `${destination} is a placeholder address. Nobody can sign for it, so swept SOL, tokens, and Fee Keys would be lost.`;
  }
  if (destination === INCINERATOR_ADDRESS) {
    return 'The destination is the Solana incinerator. Swept tokens and Fee Keys would be burned.';
  }
  if (launchWallet && destination === String(launchWallet).trim()) {
    return 'The destination is the launch wallet itself, so nothing would move.';
  }
  return null;
}

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const KEY_SPACE = 2n ** 256n;
// Keys below 2^248 have a zero first byte and encode with a leading '1'.
const NO_ZERO_BYTE_FLOOR = 2n ** 248n;

function caseVariants(text, caseInsensitive) {
  let variants = [''];
  for (const ch of text) {
    const options = caseInsensitive
      ? [...new Set([ch, ch.toLowerCase(), ch.toUpperCase()])].filter((c) => BASE58_CHARS.has(c))
      : [ch];
    variants = variants.flatMap((head) => options.map((option) => head + option));
  }
  return variants;
}

function overlap(lo, hi) {
  const from = lo > NO_ZERO_BYTE_FLOOR ? lo : NO_ZERO_BYTE_FLOOR;
  const to = hi < KEY_SPACE ? hi : KEY_SPACE;
  return to > from ? to - from : 0n;
}

// Keys (out of 2^256) whose address has `length` characters (any length when
// null) and starts with `prefix`. An address is base58 of a 256-bit number,
// so the first character is far from uniform: a 44-character address can
// only start with 1-9, A-H or J, and "R..." needs a 43-character address
// (1 in ~989, not 1 in 58). Addresses starting with '1' (zero first byte)
// are approximated as uniform.
function prefixKeyCount(prefix, length) {
  const lengths = length ? [length] : Array.from({ length: 44 - 31 }, (_, i) => 32 + i);
  if (prefix.startsWith('1')) {
    const perLength = KEY_SPACE / (58n ** BigInt(prefix.length));
    return length ? perLength / 17n : perLength;
  }
  let value = 0n;
  for (const ch of prefix) value = value * 58n + BigInt(B58_ALPHABET.indexOf(ch));
  let count = 0n;
  for (const total of lengths) {
    if (total < prefix.length) continue;
    const scale = 58n ** BigInt(total - prefix.length);
    if (prefix) {
      count += overlap(value * scale, (value + 1n) * scale);
    } else {
      count += overlap(58n ** BigInt(total - 1), 58n ** BigInt(total));
    }
  }
  return count;
}

/**
 * Average attempts to grind a vanity address with the given prefix, suffix,
 * optional exact address length, and case mode. Case-insensitive matching
 * accepts every base58 case variant of each letter.
 */
export function expectedVanityAttempts(prefix = '', suffix = '', { caseInsensitive = false, length = null } = {}) {
  const prefixKeys = !prefix && !length
    ? KEY_SPACE
    : caseVariants(prefix, caseInsensitive).reduce((sum, variant) => sum + prefixKeyCount(variant, length), 0n);
  if (prefixKeys === 0n) return Infinity;
  const suffixVariants = caseVariants(suffix, caseInsensitive).length;
  const suffixOdds = 58 ** suffix.length / suffixVariants;
  const prefixOdds = Number(KEY_SPACE * 1000000n / prefixKeys) / 1e6;
  return Math.round(prefixOdds * suffixOdds);
}

export function invalidBase58Characters(value) {
  return [...new Set([...String(value ?? '')].filter((ch) => !BASE58_CHARS.has(ch)))];
}

export function normalizeVanityTargetBase58(prefixValue = '', suffixValue = '') {
  const prefix = String(prefixValue ?? '').trim();
  const suffix = String(suffixValue ?? '').trim();
  const invalid = invalidBase58Characters(`${prefix}${suffix}`);
  if (invalid.length) {
    throw new Error(
      `Vanity CA target contains invalid Base58 character${invalid.length === 1 ? '' : 's'}: ${invalid.join(', ')}`,
    );
  }
  return { prefix, suffix };
}

function asciiBytes(bytes, start, end) {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function byteView(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function detectLogoImageMime(buffer) {
  const isByteView = buffer instanceof Uint8Array;
  if (!isByteView) return null;

  const isPng =
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a &&
    asciiBytes(buffer, 12, 16) === 'IHDR';
  if (isPng) return 'image/png';

  const isJpeg =
    buffer.length >= 4 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff;
  if (isJpeg) return 'image/jpeg';

  const gifHeader = buffer.length >= 13
    ? asciiBytes(buffer, 0, 6)
    : '';
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') return 'image/gif';

  return null;
}

function pngImageDimensions(buffer) {
  if (detectLogoImageMime(buffer) !== 'image/png') return null;
  const width = byteView(buffer).getUint32(16);
  const height = byteView(buffer).getUint32(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function jpegImageDimensions(buffer) {
  if (detectLogoImageMime(buffer) !== 'image/jpeg') return null;

  let offset = 2;
  while (offset < buffer.length) {
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) return null;

    const marker = buffer[offset];
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) return null;

    const segmentLength = byteView(buffer).getUint16(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return null;

    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 7) return null;
      const height = byteView(buffer).getUint16(offset + 3);
      const width = byteView(buffer).getUint16(offset + 5);
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }

    offset += segmentLength;
  }

  return null;
}

function gifImageDimensions(buffer) {
  if (detectLogoImageMime(buffer) !== 'image/gif') return null;
  const width = byteView(buffer).getUint16(6, true);
  const height = byteView(buffer).getUint16(8, true);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

export function detectLogoImageDimensions(buffer) {
  const mime = detectLogoImageMime(buffer);
  if (mime === 'image/png') return pngImageDimensions(buffer);
  if (mime === 'image/jpeg') return jpegImageDimensions(buffer);
  if (mime === 'image/gif') return gifImageDimensions(buffer);
  return null;
}

export function normalizeLogoImageMime(buffer) {
  const mime = detectLogoImageMime(buffer);
  if (!mime) throw new Error('Logo must be a PNG, JPG, or GIF image');
  return mime;
}

// The logo is embedded in the on-chain metadata JSON and the launch report,
// whose sponsored Arweave upload caps near 95KB. A 200x200 ceiling plus a
// byte cap keeps every copy inside that budget.
export const LOGO_MAX_DIMENSION_PX = 200;
export const LOGO_MAX_BYTES = 100 * 1024;

/** { width, height } of a PNG, JPEG, or GIF; throws when unreadable. */
export function readImageDimensions(buffer) {
  normalizeLogoImageMime(buffer);
  const dimensions = detectLogoImageDimensions(buffer);
  if (!dimensions) throw new Error('Logo image is corrupt (no frame header found)');
  return dimensions;
}

/** Type, byte size, and pixel limits. The server's authoritative check. */
export function assertLogoConstraints(buffer, {
  maxDimension = LOGO_MAX_DIMENSION_PX,
  maxBytes = LOGO_MAX_BYTES,
} = {}) {
  const mime = normalizeLogoImageMime(buffer);
  if (buffer.length > maxBytes) {
    throw new Error(
      `Logo file is ${Math.ceil(buffer.length / 1024)}KB — the maximum is `
      + `${Math.floor(maxBytes / 1024)}KB. Export it at ${maxDimension}×${maxDimension} `
      + 'pixels or smaller and try again.',
    );
  }
  const { width, height } = readImageDimensions(buffer);
  if (!(width > 0) || !(height > 0)) {
    throw new Error('Logo image reports zero size — the file appears corrupt');
  }
  if (width > maxDimension || height > maxDimension) {
    throw new Error(
      `Logo is ${width}×${height} pixels — the maximum is `
      + `${maxDimension}×${maxDimension}. Resize it and try again.`,
    );
  }
  return { mime, width, height };
}


// Token spending uses decimal text and integer base units throughout.
export function normalizeTokenAmountRaw(value, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('Use token decimals between 0 and 255');
  if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) throw new Error('Use decimal text for large token amounts');
  const text = String(value ?? '').trim();
  if (text.length > 400) throw new Error('Use a bounded token amount');
  const match = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) throw new Error('Use a positive decimal token amount');
  const exponent = Number(match[3] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) throw new Error('Use a bounded token exponent');
  let digits = (match[1] + (match[2] || '')).replace(/^0+/, '');
  if (!digits) throw new Error('Use a token amount greater than zero');
  const shift = decimals + exponent - (match[2]?.length || 0);
  if (shift < 0) {
    if (typeof value === 'number') {
      const padded = digits.padStart(-shift + 1, '0'), whole = padded.slice(0, shift);
      digits = (BigInt(whole) + (padded.at(shift) >= '5' ? 1n : 0n)).toString();
      if (digits === '0') throw new Error('Use a token amount of at least one base unit');
    } else {
      if (-shift >= digits.length || !/^0+$/.test(digits.slice(shift))) throw new Error('Use an amount that fits the token decimals');
      digits = digits.slice(0, shift);
    }
  } else {
    if (digits.length + shift > 20) throw new Error('Use a token amount within the unsigned 64-bit limit');
    digits += '0'.repeat(shift);
  }
  if (digits.length > 20 || BigInt(digits) > U64_MAX) throw new Error('Use a token amount within the unsigned 64-bit limit');
  return BigInt(digits).toString();
}

export function formatTokenAmountRaw(value, decimals) {
  const raw = normalizeTokenAmountRaw(value, 0);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('Use token decimals between 0 and 255');
  if (decimals === 0) return raw;
  const padded = raw.padStart(decimals + 1, '0');
  return (padded.slice(0, -decimals) + '.' + padded.slice(-decimals)).replace(/0+$/, '').replace(/\.$/, '');
}
