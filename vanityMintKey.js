import { Keypair, PublicKey } from '@solana/web3.js';
import { scalarPublicKey } from '@trebuchet/core/split-key';

function invalidKey(message) {
  return Object.assign(new Error(message), { code: 'INVALID_VANITY_KEY' });
}

function keyBytes(value, length, label) {
  if (!(Array.isArray(value) || value instanceof Uint8Array)) {
    throw invalidKey(`${label} must be a ${length}-byte array.`);
  }
  if (value.length !== length) {
    throw invalidKey(`${label} requires ${length} bytes; received ${value.length}. Import the complete mint key with its key type.`);
  }
  if (!Array.from(value).every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    throw invalidKey(`${label} must contain whole numbers from 0 to 255.`);
  }
  return Uint8Array.from(value);
}

// Accept a Solana keypair array or a typed import record. Split scalars keep
// their own signer because treating a scalar as a seed changes its address.
export function readVanityMintKey(value, { publicKey: expectedPublicKey } = {}) {
  let record = value;
  if (typeof record === 'string') {
    try { record = JSON.parse(record); }
    catch { throw invalidKey('Import the mint key as a JSON byte array or a key record.'); }
  }
  if (Array.isArray(record) || record instanceof Uint8Array) record = { secretKey: record };
  if (!record || typeof record !== 'object') {
    throw invalidKey('Import the mint key as a JSON byte array or a key record.');
  }
  if (record.keyType && !['seed', 'scalar'].includes(record.keyType)) {
    throw invalidKey('The mint key type must be seed or scalar.');
  }
  if (record.scalar != null && record.secretKey != null) {
    throw invalidKey('Import one mint key: a secretKey array or a scalar array.');
  }
  const keyType = record.keyType || (record.scalar != null ? 'scalar' : 'seed');
  if (keyType === 'seed' && record.scalar != null) {
    throw invalidKey('A scalar mint key requires the scalar key type.');
  }
  const bytes = keyBytes(
    keyType === 'scalar' ? (record.scalar ?? record.secretKey) : record.secretKey,
    keyType === 'scalar' ? 32 : 64,
    keyType === 'scalar' ? 'Vanity mint scalar' : 'Vanity mint secret key',
  );
  let publicKey;
  try {
    publicKey = keyType === 'scalar'
      ? new PublicKey(scalarPublicKey(bytes)).toBase58()
      : Keypair.fromSecretKey(bytes).publicKey.toBase58();
  } catch {
    throw invalidKey('The vanity mint key failed its Ed25519 key check. Import the original mint key.');
  }
  for (const expected of [expectedPublicKey, record.publicKey]) {
    if (expected && String(expected) !== publicKey) {
      throw invalidKey('The imported mint key must match the selected vanity address.');
    }
  }
  return {
    publicKey,
    keyType,
    ...(keyType === 'scalar' ? { scalar: Array.from(bytes) } : { secretKey: Array.from(bytes) }),
  };
}
