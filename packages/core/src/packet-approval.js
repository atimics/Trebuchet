import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { secretKeyToEd25519Material, CONFIRMATION_NETWORKS } from './confirmation.js';

export const PACKET_APPROVAL_SCHEMA = 'trebuchet-packet-approval/v1';
const HEX = /^[0-9a-f]{64}$/;
const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const U64_MAX = 18_446_744_073_709_551_615n;
const FIELDS = ['manifestDigest', 'planDigest', 'operatorKey', 'walletPublicKey', 'network', 'maxSpendLamports', 'expiresAt'];
const fail = (message) => { throw new TypeError(message); };

function lamports(value, { positive = false } = {}) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) fail('Use a decimal integer string for lamports.');
  const amount = BigInt(value);
  if (amount > U64_MAX || (positive && amount === 0n)) fail('The spending ceiling must be a positive uint64 lamport amount.');
  return value;
}

export function solToLamports(value) {
  const match = String(value).match(/^(0|[1-9][0-9]{0,10})(?:\.([0-9]{1,9}))?$/);
  if (!match) fail('Use a SOL amount with up to nine decimal places.');
  return lamports((BigInt(match[1]) * 1_000_000_000n + BigInt((match[2] || '').padEnd(9, '0'))).toString());
}

function normalizePayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Packet approval requires an object payload.');
  if (Object.keys(input).some((key) => !FIELDS.includes(key))) fail('Packet approval contains an unknown payload field.');
  const payload = Object.fromEntries(FIELDS.map((key) => [key, input[key]]));
  for (const field of ['manifestDigest', 'planDigest', 'operatorKey']) {
    if (typeof payload[field] !== 'string' || !HEX.test(payload[field])) fail(`Packet approval requires a lowercase 64-character hex ${field}.`);
  }
  if (typeof payload.walletPublicKey !== 'string' || !WALLET.test(payload.walletPublicKey)) fail('Packet approval requires a launch wallet public key.');
  if (!CONFIRMATION_NETWORKS.has(payload.network)) fail('Packet approval requires a supported network.');
  lamports(payload.maxSpendLamports, { positive: true });
  const date = new Date(payload.expiresAt);
  if (typeof payload.expiresAt !== 'string' || !Number.isFinite(date.getTime()) || date.toISOString() !== payload.expiresAt) fail('Packet approval expiry must be a canonical ISO timestamp.');
  return payload;
}

function signedBytes(payload) {
  return Buffer.from(`${PACKET_APPROVAL_SCHEMA}\n${JSON.stringify(payload)}`, 'utf8');
}

export function signPacketApproval(input, secretKey) {
  const { privateKey, rawPublicKey } = secretKeyToEd25519Material(secretKey);
  const operatorKey = Buffer.from(rawPublicKey).toString('hex');
  if (input.operatorKey !== undefined && input.operatorKey !== operatorKey) fail('The signing key must match the expected operator key.');
  const payload = normalizePayload({ ...input, operatorKey });
  return {
    schema: PACKET_APPROVAL_SCHEMA,
    signatureAlgorithm: 'ed25519',
    payload,
    signature: sign(null, signedBytes(payload), privateKey).toString('base64'),
  };
}

// Every binding comes from the verified packet and the host configuration.
// Callers must supply all five; accepting the envelope's own identity would
// turn an operator check into a self-signature check.
export function verifyPacketApproval(approval, { expected, spendLamports = '0', now = new Date() } = {}) {
  const errors = [];
  const error = (code, message) => errors.push({ code, message });
  if (approval?.schema !== PACKET_APPROVAL_SCHEMA || approval?.signatureAlgorithm !== 'ed25519') {
    return { valid: false, errors: [{ code: 'SCHEMA', message: `Expected ${PACKET_APPROVAL_SCHEMA} with an Ed25519 signature.` }], payload: null, approvalId: null };
  }
  let payload;
  try { payload = normalizePayload(approval.payload); }
  catch (cause) { return { valid: false, errors: [{ code: 'PAYLOAD', message: cause.message }], payload: null, approvalId: null }; }
  let signatureValid = false;
  try {
    const bytes = Buffer.from(approval.signature, 'base64');
    if (bytes.length === 64 && bytes.toString('base64') === approval.signature) {
      const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(payload.operatorKey, 'hex')]), format: 'der', type: 'spki' });
      signatureValid = verify(null, signedBytes(payload), key, bytes);
    }
  } catch { /* reported below */ }
  if (!signatureValid) error('SIGNATURE', 'Packet approval signature is invalid.');
  for (const field of ['manifestDigest', 'planDigest', 'operatorKey', 'walletPublicKey', 'network']) {
    if (!expected || typeof expected[field] !== 'string' || !expected[field]) error('EXPECTED_BINDING', `Supply the trusted ${field}.`);
    else if (payload[field] !== expected[field]) error('BINDING', `Packet approval ${field} differs from the expected value.`);
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) error('CLOCK', 'Supply a valid verification time.');
  else if (now.getTime() >= Date.parse(payload.expiresAt)) error('EXPIRED', 'Packet approval has expired.');
  try {
    if (BigInt(lamports(spendLamports)) > BigInt(payload.maxSpendLamports)) error('SPEND_CEILING', 'The required spend exceeds the signed ceiling.');
  } catch (cause) { error('SPEND', cause.message); }
  const approvalId = signatureValid ? createHash('sha256').update(signedBytes(payload)).update(approval.signature).digest('hex') : null;
  return { valid: errors.length === 0, errors, payload, approvalId };
}
