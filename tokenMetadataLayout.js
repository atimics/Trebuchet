// Pure readers for the fixed-size string fields in a Metaplex Metadata v1
// account. The account stores length-prefixed strings in fixed allocations:
// name: 32 bytes, symbol: 10 bytes, uri: 200 bytes.

export const METAPLEX_NAME_OFFSET = 1 + 32 + 32 + 4;
export const METAPLEX_NAME_MAX_LEN = 32;
export const METAPLEX_SYMBOL_OFFSET = METAPLEX_NAME_OFFSET + METAPLEX_NAME_MAX_LEN + 4;
export const METAPLEX_SYMBOL_MAX_LEN = 10;
export const METAPLEX_URI_OFFSET = METAPLEX_SYMBOL_OFFSET + METAPLEX_SYMBOL_MAX_LEN + 4;
export const METAPLEX_URI_MAX_LEN = 200;
export const METAPLEX_METADATA_MIN_LEN = METAPLEX_URI_OFFSET + METAPLEX_URI_MAX_LEN;

function parseFixedString(data, offset, maxLen) {
  if (!data || data.length < offset + maxLen) return null;
  const raw = data.slice(offset, offset + maxLen);
  const text = Buffer.from(raw).toString('utf8').replace(/\0+$/, '').trim();
  return text || null;
}

export function parseMetaplexName(data) {
  return parseFixedString(data, METAPLEX_NAME_OFFSET, METAPLEX_NAME_MAX_LEN);
}

export function parseMetaplexSymbol(data) {
  return parseFixedString(data, METAPLEX_SYMBOL_OFFSET, METAPLEX_SYMBOL_MAX_LEN);
}

export function parseMetaplexUri(data) {
  return parseFixedString(data, METAPLEX_URI_OFFSET, METAPLEX_URI_MAX_LEN);
}
