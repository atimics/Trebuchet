import { createHash } from 'node:crypto';
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, MINT_SIZE, AuthorityType, ExtensionType,
  getMintLen, getAccountLen, getAssociatedTokenAddressSync, getMetadataPointerState, getExtensionData, getExtensionTypes,
  getNewAccountLenForExtensionLen, unpackMint, unpackAccount, createInitializeMint2Instruction,
  createInitializeMetadataPointerInstruction, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, createSetAuthorityInstruction,
} from '@solana/spl-token';
import { createInitializeInstruction, createUpdateFieldInstruction, pack, unpack } from '@solana/spl-token-metadata';
import { createMetadataAccountV3, getMetadataAccountDataSerializer, Key, TokenStandard } from '@metaplex-foundation/mpl-token-metadata';
import { createNoopSigner, publicKey as umiPublicKey, some, none } from '@metaplex-foundation/umi';
import { createPreparedTransactionService } from './prepared-transaction.js';
import { metadataAddress, METADATA_PROGRAM_ID } from './metadata-update.js';
import { publicJson } from './store.js';

export const TOKEN_CREATION_KIND = 'token-creation';
const failure = (code, message) => Object.assign(new Error(message), { code });
const paused = (message) => failure('CHAIN_STATE_UNAVAILABLE', message);
const hash = (value) => createHash('sha256').update(publicJson(value)).digest('hex');
const key = (value) => new PublicKey(value);
const whole = (value) => Number.isSafeInteger(value) && value >= 0;
const raw = (value) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 20 || BigInt(value) > (1n << 64n) - 1n) throw paused('Use exact unsigned 64-bit token amounts');
  return BigInt(value);
};
const trim = (value) => value.replace(/\0+$/, '');
// This is a rent ceiling, expressed as account bytes, for classic metadata.
const classicMetadataRentLimit = 1024;

export function normalizeTokenCreationPlan(input) {
  const mint = key(input.mint).toBase58(), programId = key(input.programId).toBase58();
  if (![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(programId)
      || !Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > 255 || raw(input.supplyRaw) === 0n) throw paused('Use the saved mint program, decimals, and supply');
  const metadata = {};
  for (const [field, limit] of Object.entries({ name: 32, symbol: 10, uri: 200, hash: 64 })) {
    const value = input.metadata?.[field];
    if (typeof value !== 'string' || !value.length || value.includes('\0') || Buffer.byteLength(value) > limit) throw paused('Use the complete saved token metadata');
    metadata[field] = value;
  }
  if (!/^[a-f0-9]{64}$/.test(metadata.hash)) throw paused('Use the saved metadata content hash');
  return { mint, programId, decimals: input.decimals, supplyRaw: input.supplyRaw, metadata };
}

async function snapshot(connection, plan, walletPublicKey, minContextSlot = 0) {
  const mint = key(plan.mint), program = key(plan.programId), wallet = key(walletPublicKey);
  const ata = getAssociatedTokenAddressSync(mint, wallet, false, program), pda = metadataAddress(mint);
  const response = await connection.getMultipleAccountsInfoAndContext([wallet, mint, ata, pda], { commitment: 'finalized', minContextSlot });
  if (!whole(response?.context?.slot) || response.context.slot < minContextSlot || !Array.isArray(response.value) || response.value.length !== 4) throw paused('Read complete finalized token creation accounts');
  const [payer, mintInfo, holdingInfo, classicInfo] = response.value;
  if (!payer || payer.executable || !payer.owner.equals(SystemProgram.programId) || !whole(payer.lamports)) throw paused('Verify the token creation payer');
  let mintState = null, holding = null, metadata = null;
  try {
    if (mintInfo) {
      if (mintInfo.executable || !whole(mintInfo.lamports)) throw new Error('Verify the mint account');
      mintState = unpackMint(mint, mintInfo, program);
      if (!mintState.isInitialized || mintState.decimals !== plan.decimals || mintState.freezeAuthority) throw new Error('Verify the mint decimals and disabled freeze authority');
      if (program.equals(TOKEN_2022_PROGRAM_ID)) {
        const pointer = getMetadataPointerState(mintState);
        if (!pointer || pointer.authority || !pointer.metadataAddress?.equals(mint)
            || getExtensionTypes(mintState.tlvData).some((type) => ![ExtensionType.MetadataPointer, ExtensionType.TokenMetadata].includes(type))) throw new Error('Verify the permanent metadata pointer and mint extensions');
        const data = getExtensionData(ExtensionType.TokenMetadata, mintState.tlvData);
        if (data) {
          const value = unpack(data);
          if (!value.mint.equals(mint)) throw new Error('Verify the inline metadata mint');
          metadata = { name: value.name, symbol: value.symbol, uri: value.uri, hash: value.additionalMetadata.find(([field]) => field === 'trebuchet:sha256')?.[1],
            authority: value.updateAuthority?.toBase58() || null, mutable: !!value.updateAuthority };
        }
      } else if (classicInfo) {
        if (classicInfo.executable || !classicInfo.owner.equals(METADATA_PROGRAM_ID) || classicInfo.data.length > classicMetadataRentLimit) throw new Error('Verify the classic metadata account');
        const [value] = getMetadataAccountDataSerializer().deserialize(classicInfo.data);
        if (value.key !== Key.MetadataV1 || value.mint !== plan.mint || (value.tokenStandard.__option === 'Some' && ![TokenStandard.Fungible, TokenStandard.FungibleAsset].includes(value.tokenStandard.value))) throw new Error('Verify the fungible metadata mint');
        metadata = { name: trim(value.name), symbol: trim(value.symbol), uri: trim(value.uri), authority: value.updateAuthority, mutable: value.isMutable,
          creators: value.creators, sellerFeeBasisPoints: value.sellerFeeBasisPoints };
      }
    }
    if (holdingInfo) {
      if (!mintState || holdingInfo.executable || !whole(holdingInfo.lamports)) throw new Error('Verify the mint and supply account');
      holding = unpackAccount(ata, holdingInfo, program);
      if (!holding.isInitialized || holding.isFrozen || !holding.owner.equals(wallet) || !holding.mint.equals(mint)) throw new Error('Verify the launch wallet supply account');
    }
  } catch (cause) { throw paused(cause.message); }
  return { slot: response.context.slot, payer, mintInfo, mintState, holdingInfo, holding, metadata, classicInfo, ata, pda };
}

function verifyReceipt(receipt, result, plan, walletPublicKey) {
  if (!receipt) return {};
  const keys = receipt.transaction.message.staticAccountKeys.map((value) => value.toBase58()), meta = receipt.meta;
  const fundedIndex = keys.indexOf(result.fundedAccount);
  if (fundedIndex < 1) throw paused('Verify the funded account in the creation receipt');
  let rent = 0;
  for (let index = 1; index < keys.length; index++) {
    const difference = meta.postBalances[index] - meta.preBalances[index];
    if (index === fundedIndex) {
      if (difference < 0 || difference > result.rentCeilingLamports) throw paused('Verify the created account rent against the saved ceiling');
      rent = difference;
    } else if (difference !== 0) throw paused('Verify each token creation account balance');
  }
  if (result.exactRentLamports !== undefined && rent !== result.exactRentLamports) throw paused('Verify the exact saved account funding');
  if (meta.preBalances[0] - meta.postBalances[0] !== meta.fee + rent) throw paused('Verify the exact token creation rent and fee');
  if (result.type !== 'supply-finalize') return { rentLamports: rent };
  const balance = (rows, optional = false) => {
    if (!Array.isArray(rows)) throw paused('Read complete supply receipt balances');
    const matches = rows.filter((entry) => entry.accountIndex === fundedIndex);
    if (optional && matches.length === 0) return 0n;
    const value = matches[0];
    if (matches.length !== 1 || value.mint !== plan.mint || value.uiTokenAmount?.decimals !== plan.decimals
        || (value.owner !== undefined && value.owner !== walletPublicKey) || (value.programId !== undefined && value.programId !== plan.programId)) throw paused('Verify the supply receipt mint and account owner');
    return raw(value.uiTokenAmount.amount);
  };
  const before = balance(meta.preTokenBalances, meta.preBalances[fundedIndex] === 0), after = balance(meta.postTokenBalances);
  if (before !== raw(result.balanceBeforeRaw) || after !== raw(result.balanceAfterRaw) || after - before !== raw(result.issuedRaw)) throw paused('Verify the exact issued supply and saved account balances in its receipt');
  return { rentLamports: rent, issuedRaw: result.issuedRaw };
}

export async function checkTokenCreationResult(connection, { operation, launch, minContextSlot, receipt }) {
  const plan = launch.config.plan, result = operation.payload.result, walletPublicKey = launch.walletPublicKey;
  const current = await snapshot(connection, plan, walletPublicKey, minContextSlot);
  const evidence = verifyReceipt(receipt, result, plan, walletPublicKey);
  const present = (extra = {}) => ({ state: 'present', slot: current.slot, evidence: { ...evidence, ...extra } });
  const absent = () => {
    if (current.payer.lamports < operation.payload.maxSpendLamports) throw failure('INSUFFICIENT_FUNDS', 'Fund the saved fee and account rent before creation');
    return { state: 'absent', slot: current.slot };
  };
  if (result.type === 'mint-create') {
    if (!current.mintState) return absent();
    if (current.mintState.supply !== 0n || current.mintState.mintAuthority?.toBase58() !== walletPublicKey) throw paused('Verify the new mint supply and authority');
    return present();
  }
  if (!current.mintState) throw paused('Recover the saved mint before the next creation step');
  if (result.type === 'metadata-create') {
    const value = current.metadata;
    if (!value) {
      if (current.mintState.mintAuthority?.toBase58() !== walletPublicKey) throw paused('Recover mint authority before creating metadata');
      return absent();
    }
    if (['name', 'symbol', 'uri'].some((field) => value[field] !== plan.metadata[field]) || value.authority !== walletPublicKey || !value.mutable
        || (plan.programId === TOKEN_2022_PROGRAM_ID.toBase58() && value.hash !== plan.metadata.hash)) throw paused('Verify the exact saved metadata fields and authority');
    if (plan.programId === TOKEN_PROGRAM_ID.toBase58() && (value.sellerFeeBasisPoints !== 0 || value.creators.__option !== 'Some'
        || value.creators.value.length !== 1 || value.creators.value[0].address !== walletPublicKey || !value.creators.value[0].verified || value.creators.value[0].share !== 100)) throw paused('Verify the original metadata creator');
    return present();
  }
  if (result.type !== 'supply-finalize') throw paused('Use the saved token creation step');
  const mint = current.mintState;
  if (mint.supply === raw(plan.supplyRaw) && mint.mintAuthority === null) {
    if (receipt && (!current.holding || current.holding.amount !== raw(result.balanceAfterRaw))) throw paused('Verify the finalized launch wallet supply');
    return present({ supplyRaw: plan.supplyRaw, mintAuthorityRenounced: true, freezeAuthorityDisabled: true });
  }
  if (mint.mintAuthority?.toBase58() !== walletPublicKey || mint.supply !== raw(result.supplyBeforeRaw)
      || (current.holding?.amount || 0n) !== raw(result.balanceBeforeRaw)) throw paused('Recover the exact supply and authority before minting');
  return absent();
}

export function createTokenCreationService({ owner, store, connection, signer, network, expectedGenesisHash, authorize, feePolicy, now = Date.now, timeoutMs = 60_000, pollIntervalMs = 500 }) {
  if (typeof feePolicy !== 'function' || typeof authorize !== 'function') throw new TypeError('Supply token creation fee and approval policies');
  // Each phase has its own operation. Compare its complete plan with the
  // other saved phases of this launch before approval and submission.
  const checkSavedPlan = (scopeId, walletPublicKey, plan) => {
    owner.assertActive();
    const digest = hash(plan);
    for (const operation of store.listWalletOperations(walletPublicKey)) {
      if (operation.kind !== TOKEN_CREATION_KIND) continue;
      const launch = store.getLaunch(operation.launchId);
      if (launch.network !== network || launch.config.scopeId !== scopeId) continue;
      if (launch.config.genesisHash !== expectedGenesisHash || launch.planDigest !== digest || publicJson(launch.config.plan) !== publicJson(plan)) {
        throw failure('OPERATION_CONFLICT', 'Use the complete saved token plan for every creation step');
      }
    }
  };
  const service = createPreparedTransactionService({ owner, store, connection, signer, kind: TOKEN_CREATION_KIND, network, expectedGenesisHash, now, timeoutMs, pollIntervalMs,
    authorize: async (context) => {
      checkSavedPlan(context.launch.config.scopeId, context.launch.walletPublicKey, context.launch.config.plan);
      const approved = await authorize(context);
      checkSavedPlan(context.launch.config.scopeId, context.launch.walletPublicKey, context.launch.config.plan);
      return approved;
    },
    checkResult: (context) => checkTokenCreationResult(connection, context) });
  return {
    async execute({ scopeId, walletPublicKey, plan: inputPlan, type, approval }) {
      const plan = normalizeTokenCreationPlan(inputPlan), wallet = key(walletPublicKey), mint = key(plan.mint), program = key(plan.programId);
      checkSavedPlan(scopeId, walletPublicKey, plan);
      if (!['mint-create', 'metadata-create', 'supply-finalize'].includes(type)) throw paused('Choose a supported token creation step');
      return service.execute({ scopeId, walletPublicKey, key: `${plan.mint}/${type}`, plan, approval,
        build: async () => {
          const current = await snapshot(connection, plan, walletPublicKey), policy = await feePolicy({ connection, walletPublicKey, type });
          if (![policy.computeUnitLimit, policy.microLamports, policy.feeCeilingLamports].every(whole) || !policy.computeUnitLimit || policy.computeUnitLimit > 1_400_000) throw paused('Use bounded token creation fees');
          const tx = new Transaction({ feePayer: wallet, recentBlockhash: PublicKey.default.toBase58() }).add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: policy.computeUnitLimit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: policy.microLamports }));
          const result = { type, mint: plan.mint, programId: plan.programId, decimals: plan.decimals };
          let rentCeilingLamports = 0, fundedAccount;
          const rentFor = async (size) => {
            const value = await connection.getMinimumBalanceForRentExemption(size, 'finalized');
            if (!whole(value)) throw paused('Read complete account rent before creation');
            return value;
          };
          if (type === 'mint-create') {
            if (current.mintInfo) throw paused('Recover the saved mint transaction before creating this account');
            const inline = program.equals(TOKEN_2022_PROGRAM_ID), space = inline ? getMintLen([ExtensionType.MetadataPointer]) : MINT_SIZE;
            rentCeilingLamports = await rentFor(space); fundedAccount = plan.mint;
            result.exactRentLamports = rentCeilingLamports;
            tx.add(SystemProgram.createAccount({ fromPubkey: wallet, newAccountPubkey: mint, lamports: rentCeilingLamports, space, programId: program }));
            if (inline) tx.add(createInitializeMetadataPointerInstruction(mint, null, mint, program));
            tx.add(createInitializeMint2Instruction(mint, plan.decimals, wallet, null, program));
          } else if (type === 'metadata-create') {
            if (!current.mintState) throw paused('Create the saved mint before its metadata');
            if (program.equals(TOKEN_2022_PROGRAM_ID)) {
              fundedAccount = plan.mint;
              const metadata = { mint, updateAuthority: wallet, name: plan.metadata.name, symbol: plan.metadata.symbol, uri: plan.metadata.uri, additionalMetadata: [['trebuchet:sha256', plan.metadata.hash]] };
              const size = getNewAccountLenForExtensionLen(current.mintInfo, mint, ExtensionType.TokenMetadata, pack(metadata).length, program);
              rentCeilingLamports = Math.max(0, await rentFor(size) - current.mintInfo.lamports);
              result.exactRentLamports = rentCeilingLamports;
              if (rentCeilingLamports) tx.add(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: mint, lamports: rentCeilingLamports }));
              tx.add(createInitializeInstruction({ programId: program, metadata: mint, updateAuthority: wallet, mint, mintAuthority: wallet,
                name: plan.metadata.name, symbol: plan.metadata.symbol, uri: plan.metadata.uri }));
              tx.add(createUpdateFieldInstruction({ programId: program, metadata: mint, updateAuthority: wallet, field: 'trebuchet:sha256', value: plan.metadata.hash }));
            } else {
              fundedAccount = current.pda.toBase58(); rentCeilingLamports = await rentFor(classicMetadataRentLimit);
              const identity = createNoopSigner(umiPublicKey(walletPublicKey));
              const builder = createMetadataAccountV3({ identity, payer: identity, programs: { getPublicKey: (_name, fallback) => umiPublicKey(fallback) } }, {
                metadata: umiPublicKey(fundedAccount), mint: umiPublicKey(plan.mint), mintAuthority: identity, updateAuthority: identity,
                data: { name: plan.metadata.name, symbol: plan.metadata.symbol, uri: plan.metadata.uri, sellerFeeBasisPoints: 0,
                  creators: some([{ address: identity.publicKey, verified: true, share: 100 }]), collection: none(), uses: none() }, isMutable: true, collectionDetails: none(),
              });
              for (const instruction of builder.getInstructions()) tx.add(new TransactionInstruction({ programId: key(instruction.programId), data: Buffer.from(instruction.data),
                keys: instruction.keys.map(({ pubkey, ...flags }) => ({ ...flags, pubkey: key(pubkey) })) }));
            }
          } else {
            if (!current.mintState) throw paused('Create the saved mint before issuing its supply');
            const supply = current.mintState.supply;
            if (![0n, raw(plan.supplyRaw)].includes(supply)) throw paused('Verify the exact existing token supply');
            const issued = raw(plan.supplyRaw) - supply, balance = current.holding?.amount || 0n;
            if (balance + issued > (1n << 64n) - 1n) throw paused('Keep the supply account within its token amount limit');
            Object.assign(result, { supplyBeforeRaw: supply.toString(), balanceBeforeRaw: balance.toString(), balanceAfterRaw: (balance + issued).toString(), issuedRaw: issued.toString() });
            fundedAccount = current.ata.toBase58();
            if (!current.holding) rentCeilingLamports = await rentFor(getAccountLen(program.equals(TOKEN_2022_PROGRAM_ID) ? [ExtensionType.ImmutableOwner] : []));
            tx.add(createAssociatedTokenAccountIdempotentInstruction(wallet, current.ata, wallet, mint, program));
            if (issued) tx.add(createMintToInstruction(mint, current.ata, wallet, issued, [], program));
            tx.add(createSetAuthorityInstruction(mint, wallet, AuthorityType.MintTokens, null, [], program));
          }
          const maxSpendLamports = policy.feeCeilingLamports + rentCeilingLamports;
          if (!whole(maxSpendLamports)) throw paused('Use a bounded token creation spending ceiling');
          Object.assign(result, { rentCeilingLamports, fundedAccount });
          return { transaction: VersionedTransaction.deserialize(tx.serialize({ requireAllSignatures: false, verifySignatures: false })), result,
            allowExisting: type !== 'mint-create', feeCeilingLamports: policy.feeCeilingLamports, maxSpendLamports };
        } });
    },
    recover: (input) => service.recover(input),
    planDigest: (input) => hash(normalizeTokenCreationPlan(input)),
  };
}
