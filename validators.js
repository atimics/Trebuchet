const TOKEN_DECIMALS = 9;
const U64_MAX = (1n << 64n) - 1n;
const TOKEN_RAW_MULTIPLIER = 10n ** BigInt(TOKEN_DECIMALS);

function byteLength(s) {
  return Buffer.byteLength(String(s), 'utf8');
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
  const symbol = String(value ?? '').trim().toUpperCase();
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
