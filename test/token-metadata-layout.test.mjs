import test from 'node:test';
import assert from 'node:assert/strict';

import {
  METAPLEX_METADATA_MIN_LEN,
  METAPLEX_NAME_MAX_LEN,
  METAPLEX_NAME_OFFSET,
  METAPLEX_SYMBOL_MAX_LEN,
  METAPLEX_SYMBOL_OFFSET,
  METAPLEX_URI_MAX_LEN,
  METAPLEX_URI_OFFSET,
  parseMetaplexName,
  parseMetaplexSymbol,
  parseMetaplexUri,
} from '../tokenMetadataLayout.js';

function writeFixedString(buffer, offset, maxLen, value) {
  const bytes = Buffer.from(value, 'utf8');
  bytes.copy(buffer, offset, 0, Math.min(bytes.length, maxLen));
}

function metadataAccount({ name = '', symbol = '', uri = '' } = {}) {
  const buffer = Buffer.alloc(METAPLEX_METADATA_MIN_LEN);
  writeFixedString(buffer, METAPLEX_NAME_OFFSET, METAPLEX_NAME_MAX_LEN, name);
  writeFixedString(buffer, METAPLEX_SYMBOL_OFFSET, METAPLEX_SYMBOL_MAX_LEN, symbol);
  writeFixedString(buffer, METAPLEX_URI_OFFSET, METAPLEX_URI_MAX_LEN, uri);
  return buffer;
}

test('parses fixed-size Metaplex metadata string fields', () => {
  const data = metadataAccount({
    name: 'Trebuchet Token',
    symbol: 'TRBU',
    uri: 'https://example.test/token.json',
  });

  assert.equal(parseMetaplexName(data), 'Trebuchet Token');
  assert.equal(parseMetaplexSymbol(data), 'TRBU');
  assert.equal(parseMetaplexUri(data), 'https://example.test/token.json');
});

test('trims whitespace and trailing null padding from metadata fields', () => {
  const data = metadataAccount({
    name: '  Padded Name  ',
    symbol: '  PAD  ',
    uri: '  https://example.test/padded.json  ',
  });

  assert.equal(parseMetaplexName(data), 'Padded Name');
  assert.equal(parseMetaplexSymbol(data), 'PAD');
  assert.equal(parseMetaplexUri(data), 'https://example.test/padded.json');
});

test('returns null for empty or truncated metadata fields', () => {
  const empty = metadataAccount();

  assert.equal(parseMetaplexName(empty), null);
  assert.equal(parseMetaplexSymbol(empty), null);
  assert.equal(parseMetaplexUri(empty), null);

  assert.equal(parseMetaplexName(Buffer.alloc(METAPLEX_NAME_OFFSET + METAPLEX_NAME_MAX_LEN - 1)), null);
  assert.equal(parseMetaplexSymbol(Buffer.alloc(METAPLEX_SYMBOL_OFFSET + METAPLEX_SYMBOL_MAX_LEN - 1)), null);
  assert.equal(parseMetaplexUri(Buffer.alloc(METAPLEX_URI_OFFSET + METAPLEX_URI_MAX_LEN - 1)), null);
});

test('reads only the fixed allocation for overlong metadata strings', () => {
  const data = metadataAccount({
    name: 'x'.repeat(METAPLEX_NAME_MAX_LEN + 10),
    symbol: 'S'.repeat(METAPLEX_SYMBOL_MAX_LEN + 10),
    uri: 'u'.repeat(METAPLEX_URI_MAX_LEN + 10),
  });

  assert.equal(parseMetaplexName(data), 'x'.repeat(METAPLEX_NAME_MAX_LEN));
  assert.equal(parseMetaplexSymbol(data), 'S'.repeat(METAPLEX_SYMBOL_MAX_LEN));
  assert.equal(parseMetaplexUri(data), 'u'.repeat(METAPLEX_URI_MAX_LEN));
});
