import assert from 'node:assert/strict';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ClmmInstrument, PoolInfoLayout, PositionInfoLayout, LockClPositionLayoutV2, CLMM_PROGRAM_ID, CLMM_LOCK_PROGRAM_ID, CLMM_LOCK_AUTH_ID, getPdaPersonalPositionAddress } from '@raydium-io/raydium-sdk-v2';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, MintLayout, AccountLayout } from '@solana/spl-token';
import BN from 'bn.js';
import bs58 from 'bs58';
import { inspectSolanaTransaction, SOLANA_GENESIS_HASHES } from '../../packages/runtime/src/solana.js';
import { solSweepChain, sweepWallet } from '../../packages/runtime/test/fixtures/sol-sweep-chain.mjs';

export { sweepWallet };
const key = (n) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;
const mints = [key(60), key(61)].sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
export const poolTokens = mints.map((mint) => ({ address: mint.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), decimals: 6 }));
const config = key(62);
const poolInstructions = await ClmmInstrument.createPoolInstructions({ programId: CLMM_PROGRAM_ID, owner: sweepWallet.publicKey,
  mintA: poolTokens[0], mintB: poolTokens[1], ammConfigId: config, initialPriceX64: new BN(2).pow(new BN(64)), extendMintAccount: [] });
export const poolId = poolInstructions.address.poolId.toBase58();
export const poolInfo = { id: poolId, programId: CLMM_PROGRAM_ID.toBase58(), mintA: poolTokens[0], mintB: poolTokens[1], config: { id: config.toBase58(), tickSpacing: 10 } };
const poolKeys = { vault: { A: poolInstructions.address.mintAVault.toBase58(), B: poolInstructions.address.mintBVault.toBase58() } };
export const plan = { tokenMint: poolTokens[0].address, tokenDecimals: 6, tokenTotalSupply: '1000', targetMarketCapUsd: 1000,
  allocations: [{ quoteToken: 'SOL', supplyPercent: 100 }], lockPositions: true };
export const actionFor = (mode) => mode === 'pool' ? { type: 'pool', event: { stage: 'pool_create_done', allocationIndex: 0 } }
  : mode === 'lock' ? { type: 'lock', poolId, positionNftMint: key(63).toBase58(), event: { stage: 'main_lock_done', allocationIndex: 0, sliceIndex: 0 } }
    : { type: 'position', poolId, tickLower: 100, tickUpper: 200, event: { stage: 'main_open_done', allocationIndex: 0, sliceIndex: 0, baseAmountRaw: '1000' } };
export const actionKey = (mode) => mode === 'pool' ? 'pool/0' : mode === 'lock' ? `lock/${key(63)}` : 'position/0/main/0';
const encode = (layout, fields) => { const data = Buffer.alloc(layout.span); layout.encode({ ...layout.decode(data), ...fields }, data); return data; };
const info = (owner, data) => ({ owner, data, lamports: 2_000_000, executable: false, rentEpoch: 0 });
const poolData = () => info(CLMM_PROGRAM_ID, encode(PoolInfoLayout, { ammConfig: config, creator: sweepWallet.publicKey, mintA: mints[0], mintB: mints[1],
  vaultA: poolInstructions.address.mintAVault, vaultB: poolInstructions.address.mintBVault, observationId: poolInstructions.address.observationId, tickSpacing: 10, sqrtPriceX64: new BN(2).pow(new BN(64)) }));
const nft = (mint, owner, program) => ({
  mint: info(program, encode(MintLayout, { mintAuthorityOption: 0, mintAuthority: SystemProgram.programId, supply: 1n, decimals: 0, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: SystemProgram.programId })),
  holding: info(program, encode(AccountLayout, { mint, owner, amount: 1n, state: 1 })),
});

export async function buildLiquiditySdk(mode, connection, signerOptions = {}, builderArgs = {}) {
  let instructions = poolInstructions;
  if (mode === 'position' || mode === 'position22') instructions = await ClmmInstrument.openPositionFromBaseInstructions({ poolInfo, poolKeys,
    ownerInfo: { feePayer: sweepWallet.publicKey, wallet: sweepWallet.publicKey, tokenAccountA: key(65), tokenAccountB: key(66) },
    tickLower: builderArgs.tickLower ?? 100, tickUpper: builderArgs.tickUpper ?? 200, base: builderArgs.base || 'MintA', baseAmount: builderArgs.baseAmount || new BN(1000), otherAmountMax: builderArgs.otherAmountMax || new BN(0), withMetadata: 'create', nft2022: mode === 'position22', ...signerOptions });
  if (mode === 'lock') instructions = await ClmmInstrument.makeLockPositions({ programId: CLMM_LOCK_PROGRAM_ID, authProgramId: CLMM_LOCK_AUTH_ID, poolProgramId: CLMM_PROGRAM_ID,
    wallet: sweepWallet.publicKey, payer: sweepWallet.publicKey, nftMint: builderArgs.ownerPosition?.nftMint || key(63), nft2022: false, ...signerOptions });
  const message = new TransactionMessage({ payerKey: sweepWallet.publicKey, recentBlockhash: (await connection.getLatestBlockhash()).blockhash, instructions: instructions.instructions }).compileToV0Message();
  return { transaction: new VersionedTransaction(message), signers: [sweepWallet], extInfo: mode === 'pool'
    ? { address: { id: poolId, mintA: poolTokens[0], mintB: poolTokens[1], config: poolInfo.config, vault: poolKeys.vault } }
    : instructions.address };
}

export function liquidityChain({ mode = 'position' } = {}) {
  const { state, connection } = solSweepChain();
  Object.assign(state, { balance: 1_000_000_000, fee: 10000, genesisHash: SOLANA_GENESIS_HASHES.mainnet, accounts: new Map(), accountSlot: 200,
    accountTransform: (value) => value, drop: false, blockhash: key(64).toBase58(), height: 200, valid: true, builds: 0 });
  if (mode !== 'pool') state.accounts.set(poolId, poolData());
  const getAccount = (pubkey) => state.accountTransform(state.accounts.get(pubkey.toBase58()) || null, pubkey);
  connection.getLatestBlockhash = async () => ({ blockhash: state.blockhash, lastValidBlockHeight: 400 });
  connection.getBlockHeight = async () => state.height;
  connection.isBlockhashValid = async () => ({ context: { slot: state.slot }, value: state.valid });
  connection.getAccountInfo = async (pubkey) => getAccount(pubkey);
  connection.getMultipleAccountsInfoAndContext = async (keys) => ({ context: { slot: state.accountSlot }, value: keys.map(getAccount) });
  connection.sendRawTransaction = async (bytes) => {
    const inspected = inspectSolanaTransaction(bytes);
    await state.beforeSend?.(inspected);
    state.sends.push(inspected);
    if (state.drop) return inspected.signature;
    if (!state.receipts.has(inspected.signature)) {
      const transaction = VersionedTransaction.deserialize(bytes), message = transaction.message;
      const instruction = message.compiledInstructions[0], keys = instruction.accountKeyIndexes.map((index) => message.staticAccountKeys[index]);
      const data = Buffer.from(instruction.data), program = message.staticAccountKeys[instruction.programIdIndex];
      let resultMint;
      if (data[0] === 233) {
        assert.equal(keys[2].toBase58(), poolId); assert.ok(program.equals(CLMM_PROGRAM_ID));
        assert.equal(state.accounts.has(poolId), false, 'one pool creation'); state.accounts.set(poolId, poolData());
      } else if (data[0] === 77) {
        const token22 = data[1] === 255, mint = keys[2], position = keys[token22 ? 8 : 9];
        assert.ok(program.equals(CLMM_PROGRAM_ID)); assert.equal(state.accounts.has(position.toBase58()), false, 'one position creation');
        const tokenProgram = token22 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
        state.accounts.set(position.toBase58(), info(CLMM_PROGRAM_ID, encode(PositionInfoLayout, {
          nftMint: mint, poolId: new PublicKey(poolId), tickLower: data.readInt32LE(8), tickUpper: data.readInt32LE(12), liquidity: new BN(1000) })));
        const tokens = nft(mint, sweepWallet.publicKey, tokenProgram);
        state.accounts.set(mint.toBase58(), tokens.mint); state.accounts.set(keys[3].toBase58(), tokens.holding); resultMint = mint;
      } else {
        assert.ok(program.equals(CLMM_LOCK_PROGRAM_ID)); assert.equal(data[0], 188);
        const mint = keys[9], position = keys[8];
        assert.equal(state.accounts.has(position.toBase58()), false, 'one lock creation');
        state.accounts.set(position.toBase58(), info(CLMM_LOCK_PROGRAM_ID, encode(LockClPositionLayoutV2, { lockOwner: sweepWallet.publicKey,
          poolId: new PublicKey(poolId), positionId: keys[5], nftAccount: keys[7], lockNftMint: mint })));
        assert.ok(keys[5].equals(getPdaPersonalPositionAddress(CLMM_PROGRAM_ID, keys[6]).publicKey));
        const tokens = nft(mint, sweepWallet.publicKey, TOKEN_PROGRAM_ID);
        state.accounts.set(mint.toBase58(), tokens.mint); state.accounts.set(keys[10].toBase58(), tokens.holding); resultMint = mint;
      }
      const preBalances = message.staticAccountKeys.map((_, index) => index === 0 ? state.balance : 0);
      const postBalances = [...preBalances]; postBalances[0] -= 10_000_000 + state.fee; state.balance = postBalances[0];
      state.receipts.set(inspected.signature, { version: 0, slot: state.slot, blockTime: 1700000000,
        meta: { err: null, fee: state.fee, preBalances, postBalances, loadedAddresses: { writable: [], readonly: [] } },
        transaction: { message, signatures: transaction.signatures.map((signature) => bs58.encode(signature)) }, resultMint: resultMint?.toBase58() });
    }
    await state.afterSend?.(inspected);
    return inspected.signature;
  };
  const rpcReceipt = (signature) => {
    const receipt = state.receipts.get(signature); if (!receipt) return null;
    const message = receipt.transaction.message;
    return { ...receipt, transaction: { signatures: receipt.transaction.signatures, message: {
      header: message.header, accountKeys: message.staticAccountKeys.map((key) => key.toBase58()), recentBlockhash: message.recentBlockhash,
      addressTableLookups: [], instructions: message.compiledInstructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accounts: ix.accountKeyIndexes, data: bs58.encode(ix.data) })),
    } } };
  };
  return { state, connection, rpcReceipt, build: (signers) => { state.builds++; return buildLiquiditySdk(mode, connection, signers); } };
}
