import { createPublicKey, verify } from 'node:crypto';
import { PACKET_DATA_SIZE, SendTransactionError, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

// Read from the public Solana cluster RPCs with getGenesisHash.
export const SOLANA_GENESIS_HASHES = Object.freeze({
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
});

const invalid = (message) => Object.assign(new Error(message), { code: 'TRANSACTION_INVALID' });
const unavailable = () => Object.assign(new Error('A complete chain response is required for recovery'), { code: 'CHAIN_STATE_UNAVAILABLE' });
const ed25519Prefix = Buffer.from('302a300506032b6570032100', 'hex');

// The status read that sets minContextSlot reports the newest slot, while this asks at 'finalized',
// which trails it by ~32 slots: asking at once is refused with "Minimum context slot has not been
// reached" (-32016). That is a wait, not a failure, so wait for finality to catch up and ask again.
async function finalizedBlockhashValidity(connection, blockhash, minContextSlot, { attempts = 60, delayMs = 1000 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await connection.isBlockhashValid(blockhash, { commitment: 'finalized', minContextSlot });
    } catch (error) {
      const notYet = error?.code === -32016 || /minimum context slot has not been reached/i.test(String(error?.message || ''));
      if (!notYet || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export function inspectSolanaTransaction(input) {
  let bytes;
  if (typeof input === 'string') {
    if (input.length > Math.ceil(PACKET_DATA_SIZE / 3) * 4) throw invalid('Transaction size exceeds the chain packet limit');
    bytes = Buffer.from(input, 'base64');
    if (bytes.toString('base64') !== input) throw invalid('Use canonical base64 transaction bytes');
  } else if (input instanceof Uint8Array) bytes = Buffer.from(input);
  else throw invalid('Provide signed transaction bytes');
  if (!bytes.length || bytes.length > PACKET_DATA_SIZE) throw invalid('Transaction size exceeds the chain packet limit');
  let transaction;
  try { transaction = VersionedTransaction.deserialize(bytes); }
  catch { throw invalid('The signed transaction must decode completely'); }
  if (!Buffer.from(transaction.serialize()).equals(bytes)) throw invalid('The signed transaction must use canonical wire bytes');
  const { message, signatures } = transaction;
  if (!signatures.length || signatures.length !== message.header.numRequiredSignatures) throw invalid('Every required signer must sign the transaction');
  const messageBytes = message.serialize();
  for (let index = 0; index < signatures.length; index++) {
    if (!message.staticAccountKeys[index]) throw invalid('Every signer must have an account key');
    const key = createPublicKey({ key: Buffer.concat([ed25519Prefix, message.staticAccountKeys[index].toBuffer()]), format: 'der', type: 'spki' });
    if (!verify(null, messageBytes, key, signatures[index])) throw invalid('Every transaction signature must verify');
  }
  const first = message.compiledInstructions[0];
  if (first && message.staticAccountKeys[first.programIdIndex]?.toBase58() === '11111111111111111111111111111111'
      && first.data.length >= 4 && Buffer.from(first.data).readUInt32LE() === 4) {
    throw invalid('Use a recent blockhash transaction for this execution engine');
  }
  return {
    signature: bs58.encode(signatures[0]), wire: bytes.toString('base64'),
    blockhash: message.recentBlockhash, walletPublicKey: message.staticAccountKeys[0].toBase58(),
  };
}

// A host can replace this adapter with a hardware or remote signer. The key
// backend supplies the wallet and any account signers for the prepared intent.
export function createSolanaSigner({ getSigners }) {
  if (typeof getSigners !== 'function') throw new TypeError('Supply a signer key backend');
  return {
    async signTransaction(context) {
      const input = context.transaction;
      const bytes = input.serialize({ requireAllSignatures: false, verifySignatures: false });
      const transaction = VersionedTransaction.deserialize(bytes);
      transaction.sign(await getSigners(context));
      return transaction.serialize();
    },
  };
}

function validateSaved(transaction) {
  const inspected = inspectSolanaTransaction(transaction.wire);
  if (inspected.signature !== transaction.signature || inspected.blockhash !== transaction.blockhash
    || !Number.isSafeInteger(transaction.lastValidBlockHeight) || transaction.lastValidBlockHeight < 0) throw invalid('Saved transaction identity requires recovery');
  return inspected;
}

export async function readSolanaTransactionStatus(connection, transaction) {
  const readStatus = async (signature, minSlot = 0) => {
    const response = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    if (!Number.isSafeInteger(response?.context?.slot) || response.context.slot < minSlot || !Array.isArray(response.value) || response.value.length !== 1) throw unavailable();
    const status = response.value[0];
    if (status === null) return { slot: response.context.slot, status: null };
    if (!status || !Number.isSafeInteger(status.slot) || !Object.hasOwn(status, 'err') || !['processed', 'confirmed', 'finalized'].includes(status.confirmationStatus)) throw unavailable();
    return { slot: response.context.slot, status };
  };
  const knownStatus = ({ status }) => ({
    state: status.confirmationStatus === 'finalized' ? (status.err === null ? 'confirmed' : 'failed') : 'pending',
    evidence: { slot: status.slot, commitment: status.confirmationStatus, error: status.err },
  });
  validateSaved(transaction);
  const first = await readStatus(transaction.signature);
  if (first.status) return knownStatus(first);
  const height = await connection.getBlockHeight('finalized');
  if (!Number.isSafeInteger(height) || height < 0) throw unavailable();
  if (height <= transaction.lastValidBlockHeight) return { state: 'rebroadcast', evidence: { slot: first.slot, finalizedBlockHeight: height } };
  const validity = await finalizedBlockhashValidity(connection, transaction.blockhash, first.slot);
  if (typeof validity?.value !== 'boolean' || !Number.isSafeInteger(validity?.context?.slot) || validity.context.slot < first.slot) throw unavailable();
  // Re-read after expiry checks so a transaction that landed at the end of
  // its valid window is adopted before a replacement can be built.
  const afterExpiry = await readStatus(transaction.signature, validity.context.slot);
  if (afterExpiry.status) return knownStatus(afterExpiry);
  if (validity.value) return { state: 'rebroadcast', evidence: { slot: afterExpiry.slot, finalizedBlockHeight: height } };
  return { state: 'expired', evidence: { slot: afterExpiry.slot, finalizedBlockHeight: height, blockhashValid: false } };
}

export function createSolanaChain({ connection, network, expectedGenesisHash, beforeSend }) {
  if (!connection || !['devnet', 'mainnet', 'localnet'].includes(network) || typeof expectedGenesisHash !== 'string' || !expectedGenesisHash) {
    throw new TypeError('Supply a Solana connection, network, and expected genesis hash');
  }
  const checkNetwork = async () => {
    if (await connection.getGenesisHash() !== expectedGenesisHash) {
      throw Object.assign(new Error('The RPC is on a different network from the app. Match them on the Mode bar or in Settings, then try again'), { code: 'NETWORK_MISMATCH' });
    }
  };
  return {
    network,
    inspectTransaction: inspectSolanaTransaction,
    async readTransaction(transaction) {
      validateSaved(transaction);
      await checkNetwork();
      return readSolanaTransactionStatus(connection, transaction);
    },
    async sendTransaction(transaction, context) {
      validateSaved(transaction);
      await checkNetwork();
      if (beforeSend) await beforeSend(transaction, context);
      try {
        return await connection.sendRawTransaction(Buffer.from(transaction.wire, 'base64'), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 });
      } catch (error) {
        // A duplicate preflight reply resumes status checks for these exact
        // saved bytes. The engine still requires finality and result evidence.
        if (error instanceof SendTransactionError
            && error.transactionError.message === 'Transaction simulation failed: This transaction has already been processed') return transaction.signature;
        throw error;
      }
    },
  };
}
