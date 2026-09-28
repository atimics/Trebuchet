import { createHash } from 'node:crypto';
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackMint, getExtensionData, getMetadataPointerState, ExtensionType, updateTokenMetadata, getNewAccountLenForExtensionLen } from '@solana/spl-token';
import { createUpdateAuthorityInstruction, createUpdateFieldInstruction, pack, unpack } from '@solana/spl-token-metadata';
import { createNoopSigner, publicKey as umiPublicKey, some, none } from '@metaplex-foundation/umi';
import { updateV1, getMetadataAccountDataSerializer, Key, TokenStandard } from '@metaplex-foundation/mpl-token-metadata';
import { ExecutionEngine } from './engine.js';
import { createSolanaChain } from './solana.js';
import { publicJson } from './store.js';

const kind = 'metadata-update';
export const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
export const metadataAddress = (mint) => PublicKey.findProgramAddressSync([Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), new PublicKey(mint).toBuffer()], METADATA_PROGRAM_ID)[0];
const hash = (value) => createHash('sha256').update(publicJson(value)).digest('hex');
const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const uncertain = (message) => fail('CHAIN_STATE_UNAVAILABLE', message);
const canonicalAddress = (value) => new PublicKey(value).toBase58();
const integer = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw fail('INVALID_INPUT', `${label} requires a nonnegative whole number`);
  return value;
};
const trimPadding = (value) => value.replace(/\0+$/, '');
const normalizeFields = (fields) => {
  if (!fields || Object.getPrototypeOf(fields) !== Object.prototype) throw fail('INVALID_INPUT', 'Use a metadata field object');
  const limits = { name: 32, symbol: 10, uri: 200, 'trebuchet:sha256': 64 };
  for (const [key, value] of Object.entries(fields)) {
    if (!Object.hasOwn(limits, key) || typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > limits[key]
        || (key === 'trebuchet:sha256' && !/^[a-f0-9]{64}$/.test(value))) throw fail('INVALID_INPUT', 'Use valid bounded metadata fields');
  }
  return JSON.parse(publicJson(fields));
};

// Metadata changes are one atomic transaction. Hosts own keys and approvals.
export function createMetadataUpdateService({
  owner, store, connection, signer, network, expectedGenesisHash, authorize, feePolicy,
  now = Date.now, timeoutMs = 60_000, pollIntervalMs = 1000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (typeof authorize !== 'function' || typeof feePolicy !== 'function') throw new TypeError('Metadata updates require approval and fee policy interfaces');
  const checkNetwork = async () => {
    owner.assertActive();
    if (await connection.getGenesisHash() !== expectedGenesisHash) throw fail('NETWORK_MISMATCH', 'Use the approved metadata network');
    owner.assertActive();
  };
  const snapshot = async (mintAddress, walletPublicKey, minContextSlot = 0) => {
    await checkNetwork();
    const mint = new PublicKey(mintAddress), pda = metadataAddress(mint);
    const response = await connection.getMultipleAccountsInfoAndContext([new PublicKey(walletPublicKey), mint, pda], { commitment: 'finalized', minContextSlot });
    if (!Number.isSafeInteger(response?.context?.slot) || response.context.slot < minContextSlot || !Array.isArray(response.value) || response.value.length !== 3) throw uncertain('Read complete finalized metadata accounts');
    const [walletInfo, mintInfo, classicInfo] = response.value;
    if (!walletInfo?.owner.equals(SystemProgram.programId) || !Number.isSafeInteger(walletInfo.lamports) || walletInfo.lamports < 0
        || !mintInfo || mintInfo.executable || ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(mintInfo.owner.toBase58())) throw uncertain('Verify the metadata wallet and mint program');
    let mintState, raw, address, format, metadataInfo;
    try {
      mintState = unpackMint(mint, mintInfo, mintInfo.owner);
      if (!mintState.isInitialized) throw new Error('Initialize the mint before changing metadata');
      if (mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
        const pointer = getMetadataPointerState(mintState);
        if (!pointer?.metadataAddress?.equals(mint) || pointer.authority) throw new Error('Verify the permanent inline metadata pointer');
        const data = getExtensionData(ExtensionType.TokenMetadata, mintState.tlvData);
        if (!data) throw new Error('Read the inline token metadata');
        raw = unpack(data); address = mint; format = 'token-2022-inline'; metadataInfo = mintInfo;
        if (!raw.mint.equals(mint)) throw new Error('The inline metadata must name its mint');
      } else {
        if (!classicInfo?.owner.equals(METADATA_PROGRAM_ID) || classicInfo.executable) throw new Error('Verify the Metaplex metadata owner');
        [raw] = getMetadataAccountDataSerializer().deserialize(classicInfo.data);
        if (raw.key !== Key.MetadataV1 || raw.mint !== mintAddress) throw new Error('The metadata must name its mint');
        if (raw.tokenStandard.__option === 'Some' && ![TokenStandard.Fungible, TokenStandard.FungibleAsset].includes(raw.tokenStandard.value)) throw new Error('Use the fungible token metadata adapter');
        address = pda; format = 'metaplex-pda'; metadataInfo = classicInfo;
      }
    } catch (cause) { throw uncertain(`Verify token metadata: ${cause.message || cause.name}`); }
    const metadata = { name: trimPadding(raw.name), symbol: trimPadding(raw.symbol), uri: trimPadding(raw.uri),
      updateAuthority: format === 'token-2022-inline' ? raw.updateAuthority?.toBase58() || SystemProgram.programId.toBase58() : raw.updateAuthority,
      additionalMetadata: raw.additionalMetadata || [],
      ...(format === 'metaplex-pda' ? { sellerFeeBasisPoints: raw.sellerFeeBasisPoints, creators: raw.creators } : {}), isMutable: format === 'metaplex-pda' ? raw.isMutable : !!raw.updateAuthority };
    return { slot: response.context.slot, walletLamports: walletInfo.lamports, mintInfo, metadataInfo, raw, metadata, format, address: address.toBase58() };
  };
  const reached = (current, payload) => current.metadata.updateAuthority === payload.newAuthority
    && (!payload.makeImmutable || !current.metadata.isMutable)
    && Object.entries(payload.fields).every(([key, value]) => (key === 'trebuchet:sha256' ? current.metadata.additionalMetadata.find(([name]) => name === key)?.[1] : current.metadata[key]) === value);
  const transactionFor = (payload, walletPublicKey, blockhash) => {
    const wallet = new PublicKey(walletPublicKey), mint = new PublicKey(payload.mint);
    const transaction = new Transaction({ feePayer: wallet, recentBlockhash: blockhash }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: payload.computeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: payload.microLamports }),
    );
    if (payload.rentLamports) transaction.add(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: mint, lamports: payload.rentLamports }));
    if (payload.format === 'token-2022-inline') {
      for (const [field, value] of Object.entries(payload.fields)) transaction.add(createUpdateFieldInstruction({ programId: TOKEN_2022_PROGRAM_ID, metadata: mint, updateAuthority: wallet, field, value }));
      transaction.add(createUpdateAuthorityInstruction({ programId: TOKEN_2022_PROGRAM_ID, metadata: mint, oldAuthority: wallet, newAuthority: new PublicKey(payload.newAuthority) }));
    } else {
      const identity = createNoopSigner(umiPublicKey(walletPublicKey));
      const builder = updateV1({ identity, payer: identity, programs: { getPublicKey: (_name, fallback) => umiPublicKey(fallback) } }, {
        mint: umiPublicKey(payload.mint), metadata: umiPublicKey(payload.metadataAddress), authority: identity,
        newUpdateAuthority: some(umiPublicKey(payload.newAuthority)), data: payload.metaplexData ? some(payload.metaplexData) : none(),
        isMutable: payload.makeImmutable ? some(false) : none(),
      });
      for (const instruction of builder.getInstructions()) transaction.add(new TransactionInstruction({
        programId: new PublicKey(instruction.programId), data: Buffer.from(instruction.data),
        keys: instruction.keys.map(({ pubkey, ...flags }) => ({ ...flags, pubkey: new PublicKey(pubkey) })),
      }));
    }
    return transaction;
  };
  const validateWire = (transaction, operation, launch) => {
    const signed = VersionedTransaction.deserialize(Buffer.from(transaction.wire, 'base64'));
    const expected = transactionFor(operation.payload, launch.walletPublicKey, transaction.blockhash).compileMessage();
    if (!Buffer.from(signed.message.serialize()).equals(Buffer.from(expected.serialize()))) throw fail('TRANSACTION_INVALID', 'The signed metadata change must match its saved intent');
    return signed.message;
  };
  const checkFee = async (message, payload) => {
    const quote = await connection.getFeeForMessage(message, 'finalized');
    if (!Number.isSafeInteger(quote?.context?.slot) || quote.context.slot < 0 || !Number.isSafeInteger(quote.value) || quote.value < 0) throw uncertain('Read the metadata transaction fee');
    if (quote.value > payload.feeCeilingLamports) throw fail('SPEND_LIMIT_EXCEEDED', 'The metadata fee exceeds its saved limit');
  };
  const handler = {
    async checkState({ operation, launch, transactions, minContextSlot }) {
      const payload = operation.payload;
      const current = await snapshot(payload.mint, launch.walletPublicKey, minContextSlot);
      if (current.format !== payload.format || current.address !== payload.metadataAddress) throw uncertain('Verify the saved metadata format and address');
      const confirmed = transactions.find((tx) => tx.state === 'confirmed');
      let receipt;
      if (confirmed) {
        const message = validateWire(confirmed, operation, launch);
        receipt = await connection.getTransaction(confirmed.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
        if (!receipt || !Number.isSafeInteger(receipt.slot) || receipt.slot < minContextSlot || receipt.slot > current.slot || receipt.meta?.err !== null
            || receipt.transaction?.signatures?.[0] !== confirmed.signature || typeof receipt.transaction?.message?.serialize !== 'function'
            || !Buffer.from(receipt.transaction.message.serialize()).equals(Buffer.from(message.serialize()))) throw uncertain('Verify the finalized metadata transaction and its message');
        const keys = message.staticAccountKeys, meta = receipt.meta;
        if (!Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances) || meta.preBalances.length !== keys.length || meta.postBalances.length !== keys.length
            || [...meta.preBalances, ...meta.postBalances, meta.fee].some((v) => !Number.isSafeInteger(v) || v < 0) || meta.fee > payload.feeCeilingLamports) throw uncertain('Read complete metadata fee and account balances');
        for (let i = 0; i < keys.length; i++) {
          const expected = i === 0 ? -(meta.fee + payload.rentLamports) : keys[i].toBase58() === payload.metadataAddress ? payload.rentLamports : 0;
          if (meta.postBalances[i] - meta.preBalances[i] !== expected) throw uncertain('Verify the exact metadata rent and transaction fee');
        }
      }
      if (reached(current, payload)) return { state: 'complete', evidence: {
        mint: payload.mint, metadataAddress: payload.metadataAddress, format: payload.format, newAuthority: payload.newAuthority,
        fields: payload.fields, immutable: !current.metadata.isMutable, slot: current.slot,
        signature: confirmed?.signature || null, feeLamports: receipt?.meta.fee || 0, rentLamports: confirmed ? payload.rentLamports : 0,
        adopted: !confirmed,
      } };
      if (confirmed) throw uncertain('Verify the saved metadata fields and authority at the finalized transaction slot');
      if (current.metadata.updateAuthority !== launch.walletPublicKey || hash(current.metadata) !== payload.beforeDigest
          || current.walletLamports < payload.feeCeilingLamports + payload.rentLamports) throw uncertain('Recover the saved metadata authority, content, and fee balance');
      return { state: 'ready', evidence: { slot: current.slot, metadataDigest: payload.beforeDigest } };
    },
    async buildTransaction({ operation, launch }) {
      await checkNetwork();
      const expiry = await connection.getLatestBlockhash('finalized');
      const transaction = transactionFor(operation.payload, launch.walletPublicKey, expiry.blockhash);
      await checkFee(transaction.compileMessage(), operation.payload);
      return { ...expiry, transaction };
    },
  };
  const validateApproval = async (approval, operation, launch) => {
    owner.assertActive();
    const payload = operation.payload;
    if (typeof approval?.id !== 'string' || !approval.id || approval.walletPublicKey !== launch.walletPublicKey || approval.network !== network || approval.genesisHash !== expectedGenesisHash
        || !Number.isSafeInteger(approval.expiresAtMs) || approval.expiresAtMs <= now() || !Number.isSafeInteger(approval.maxSpendLamports)
        || approval.maxSpendLamports < payload.rentLamports + payload.feeCeilingLamports
        || publicJson(approval.metadata || null) !== publicJson({ mint: payload.mint, newAuthority: payload.newAuthority, fields: payload.fields, makeImmutable: payload.makeImmutable })
        || await authorize({ approval, operation, launch }) !== true) throw fail('EXECUTION_APPROVAL_REQUIRED', 'Approve the metadata fields, authority, wallet, network, and spending limit');
    owner.assertActive();
  };
  const recordApproval = (operation, approval) => store.recordOperationApproval(operation.id, { ...approval, requestId: approval.id, id: hash({ operationId: operation.id, requestId: approval.id }) });
  const result = (operation) => ({ ...operation.evidence.chain, operationId: operation.id, txId: operation.evidence.chain.signature });
  const run = async (operation, approval) => {
    const chain = createSolanaChain({ connection, network, expectedGenesisHash, beforeSend: async (_tx, context) => validateApproval(approval, context.operation, context.launch) });
    const engine = new ExecutionEngine({ owner, store, signer, chain, operations: { [kind]: handler }, authorize: async (context) => {
      await validateApproval(approval, context.operation, context.launch);
      recordApproval(context.operation, approval);
      await checkNetwork();
      if (context.transaction) await checkFee(validateWire(context.transaction, context.operation, context.launch), context.operation.payload);
      await validateApproval(approval, context.operation, context.launch);
      return true;
    } });
    const deadline = now() + timeoutMs;
    while (true) {
      let status;
      try { status = await engine.resume(operation.id); } catch (cause) { cause.operationId = operation.id; throw cause; }
      if (status.operation.state === 'confirmed') return result(status.operation);
      if (status.operation.state === 'failed') throw fail('TRANSACTION_FAILED', 'Review the failed metadata transaction before another update', { operationId: operation.id });
      if (now() >= deadline) throw fail('CHAIN_STATE_UNAVAILABLE', 'Resume the metadata update when its finalized receipt is available', { operationId: operation.id });
      await sleep(pollIntervalMs);
    }
  };
  const activeFor = (walletPublicKey, newAuthority) => {
    owner.assertActive();
    const active = store.getActiveOperation(walletPublicKey);
    const launch = active && store.getLaunch(active.launchId);
    if (active && (active.kind !== kind || active.payload.newAuthority !== newAuthority || launch?.network !== network || launch.config.genesisHash !== expectedGenesisHash)) throw fail('OPERATION_IN_FLIGHT', 'Recover the saved wallet operation first', { operationId: active.id });
    return active;
  };
  return {
    async recover({ walletPublicKey, destinationWallet, approval }) {
      const active = activeFor(walletPublicKey, destinationWallet);
      return active ? run(active, approval) : null;
    },
    async update({ scopeId, walletPublicKey, mint, newAuthority, fields = {}, makeImmutable = false, approval }) {
      const wallet = canonicalAddress(walletPublicKey), token = canonicalAddress(mint), authority = canonicalAddress(newAuthority);
      const changes = normalizeFields(fields);
      if (!scopeId || typeof makeImmutable !== 'boolean' || (makeImmutable && authority !== SystemProgram.programId.toBase58())) throw fail('INVALID_INPUT', 'Use a saved launch and retire authority for immutable metadata');
      const intent = { mint: token, newAuthority: authority, fields: changes, makeImmutable };
      const pending = activeFor(wallet, authority);
      if (pending) {
        if (Object.entries(intent).some(([key, value]) => publicJson(pending.payload[key]) !== publicJson(value))) throw fail('OPERATION_IN_FLIGHT', 'Resume the exact saved metadata change', { operationId: pending.id });
        return run(pending, approval);
      }
      const current = await snapshot(token, wallet);
      const complete = reached(current, intent);
      if (!complete && current.metadata.updateAuthority !== wallet) throw uncertain('Use the current metadata authority to approve the update');
      if (current.format === 'metaplex-pda' && Object.hasOwn(changes, 'trebuchet:sha256')) throw fail('INVALID_INPUT', 'Store the document hash in the verified metadata document for this mint');
      if (!complete && current.format === 'metaplex-pda' && !current.metadata.isMutable && Object.keys(changes).length) throw uncertain('Use mutable metadata for content changes');
      const policy = await feePolicy({ connection, walletPublicKey: wallet });
      const computeUnitLimit = integer(policy.computeUnitLimit, 'Compute limit'), microLamports = integer(policy.microLamports, 'Priority fee');
      const feeCeilingLamports = complete ? 0 : integer(policy.feeCeilingLamports, 'Fee limit');
      if (!computeUnitLimit || computeUnitLimit > 1_400_000) throw fail('INVALID_INPUT', 'Use a bounded metadata compute limit');
      let rentLamports = 0;
      if (!complete && current.format === 'token-2022-inline') {
        let updated = current.raw, peakSize = current.mintInfo.data.length;
        for (const [field, value] of Object.entries(changes)) {
          updated = updateTokenMetadata(updated, field, value);
          peakSize = Math.max(peakSize, getNewAccountLenForExtensionLen(current.mintInfo, new PublicKey(token), ExtensionType.TokenMetadata, pack(updated).length));
        }
        if (peakSize > current.mintInfo.data.length) rentLamports = Math.max(0, integer(await connection.getMinimumBalanceForRentExemption(peakSize, 'finalized'), 'Metadata rent') - integer(current.mintInfo.lamports, 'Mint balance'));
      }
      if (!Number.isSafeInteger(rentLamports + feeCeilingLamports)) throw fail('INVALID_INPUT', 'Use a safe metadata spending limit');
      const metaplexData = current.format === 'metaplex-pda' && Object.keys(changes).length ? {
        name: changes.name ?? current.metadata.name, symbol: changes.symbol ?? current.metadata.symbol, uri: changes.uri ?? current.metadata.uri,
        sellerFeeBasisPoints: current.raw.sellerFeeBasisPoints, creators: current.raw.creators,
      } : null;
      const payload = { ...intent, format: current.format, metadataAddress: current.address, metaplexData, beforeDigest: hash(current.metadata), rentLamports, feeCeilingLamports, computeUnitLimit, microLamports };
      if (transactionFor(payload, wallet, SystemProgram.programId.toBase58()).serializeMessage().length + 65 > 1232) throw fail('INVALID_INPUT', 'Use metadata fields that fit in one atomic transaction');
      const config = { scopeId, purpose: kind, walletPublicKey: wallet, network, genesisHash: expectedGenesisHash };
      const planDigest = hash(config), launch = { id: `${kind}-${planDigest}`, walletPublicKey: wallet, network, planDigest, config };
      await validateApproval(approval, { payload }, launch);
      const prior = store.listOperations(launch.id).findLast((operation) => operation.state === 'confirmed' && Object.entries(intent).every(([key, value]) => publicJson(operation.payload[key]) === publicJson(value)));
      if (complete && prior) return result(prior);
      const operation = store.transaction(() => {
        store.saveLaunch(launch);
        const prepared = store.prepareOperation({ launchId: launch.id, kind, index: store.listOperations(launch.id).length, payload });
        recordApproval(prepared, approval);
        return prepared;
      });
      return run(operation, approval);
    },
  };
}
