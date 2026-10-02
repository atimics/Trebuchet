import { createHash } from 'node:crypto';
import BN from 'bn.js';
import { PublicKey, SystemProgram, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, ACCOUNT_SIZE, unpackMint, unpackAccount,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createInitializeAccount3Instruction, createCloseAccountInstruction,
  getExtensionTypes, getAccountTypeOfMintType, getAccountLen, ExtensionType, getTransferFeeConfig, calculateEpochFee, getMintCloseAuthority } from '@solana/spl-token';
import { CLMM_PROGRAM_ID, DEVNET_PROGRAM_ID, PoolInfoLayout, PositionInfoLayout, LiquidityMath, SqrtPriceMath,
  ClmmInstrument, getPdaPersonalPositionAddress } from '@raydium-io/raydium-sdk-v2';

const pk = (value) => new PublicKey(value);
const whole = (value) => Number.isSafeInteger(value) && value >= 0;
const fail = (message, code = 'CHAIN_STATE_UNAVAILABLE') => Object.assign(new Error(message), { code });
const tokenPrograms = [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()];
const native = NATIVE_MINT.toBase58();
const discriminator = (name) => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
const programFor = (network) => {
  if (!['mainnet', 'devnet', 'localnet'].includes(network)) throw new TypeError('Choose the withdrawal network');
  return network === 'devnet' ? DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID : CLMM_PROGRAM_ID;
};
const raw = (value, bits = 64) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 39 || BigInt(value) >= 1n << BigInt(bits)) throw new TypeError('Use exact unsigned withdrawal amounts');
  return BigInt(value);
};
const key = (value) => {
  if (typeof value !== 'string' || pk(value).toBase58() !== value) throw new TypeError('Use a complete withdrawal account address');
  return value;
};
const validAccount = (account) => account && !account.executable && whole(account.lamports) && Buffer.isBuffer(account.data);
const decode = (account, layout, program, name) => {
  if (!validAccount(account) || !account.owner.equals(program) || account.data.length !== layout.span || !account.data.subarray(0, 8).equals(discriminator(name))) {
    throw fail(`Verify the ${name} owner and complete layout`);
  }
  try { return layout.decode(account.data); } catch { throw fail(`Decode the ${name} account`); }
};
const read = async (connection, keys, minContextSlot = 0) => {
  const response = await connection.getMultipleAccountsInfoAndContext(keys.map(pk), { commitment: 'finalized', minContextSlot });
  if (!whole(response?.context?.slot) || response.context.slot < minContextSlot || !Array.isArray(response.value) || response.value.length !== keys.length) {
    throw fail('Read every finalized withdrawal account');
  }
  return response;
};

// The caller binds this public snapshot and the complete unsigned message to
// approval. Existing position identity and all output destinations are fixed.
export async function buildPositionWithdrawalPlan({ connection, network, expectedGenesisHash, walletPublicKey, poolId, nftMint,
  expectedLiquidity, requestId, lookupTables = [], slippageBps = 100, priorityFeeMicroLamports = 50000, feePadLamports = 5000 }) {
  [walletPublicKey, poolId, nftMint].forEach(key); raw(expectedLiquidity, 128);
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(requestId) || !expectedGenesisHash
      || !whole(slippageBps) || slippageBps > 1000 || !whole(priorityFeeMicroLamports) || !whole(feePadLamports)
      || !Array.isArray(lookupTables) || lookupTables.length > 8) throw new TypeError('Use a complete withdrawal identity and bounded fee policy');
  const program = programFor(network), wallet = pk(walletPublicKey), nft = pk(nftMint);
  if (await connection.getGenesisHash() !== expectedGenesisHash) throw fail('Prepare the withdrawal on its saved chain', 'NETWORK_MISMATCH');
  const positionAddress = getPdaPersonalPositionAddress(program, nft).publicKey.toBase58();
  const base = await read(connection, [walletPublicKey, poolId, positionAddress, nftMint]);
  const [payer, poolAccount, positionAccount, mintAccount] = base.value;
  if (!validAccount(payer) || !payer.owner.equals(SystemProgram.programId) || payer.data.length) throw fail('Verify the withdrawal wallet system account');
  const pool = decode(poolAccount, PoolInfoLayout, program, 'PoolState');
  if (!positionAccount) throw fail('Refresh the position and its saved recovery status', 'POSITION_NOT_FOUND');
  const position = decode(positionAccount, PositionInfoLayout, program, 'PersonalPositionState');
  if (position.poolId.toBase58() !== poolId || position.nftMint.toBase58() !== nftMint || position.liquidity.toString() !== expectedLiquidity) {
    throw fail('Review the saved position pool, mint, and liquidity again', 'POSITION_CHANGED');
  }
  if (!whole(pool.tickSpacing) || pool.tickSpacing < 1 || !Number.isInteger(position.tickLower) || !Number.isInteger(position.tickUpper)
      || position.tickLower < -443636 || position.tickUpper > 443636 || position.tickLower >= position.tickUpper
      || position.tickLower % pool.tickSpacing || position.tickUpper % pool.tickSpacing || pool.sqrtPriceX64.isZero()) throw fail('Verify the position tick range and pool price');
  if (!validAccount(mintAccount) || !tokenPrograms.includes(mintAccount.owner.toBase58())) throw fail('Verify the position NFT mint program');
  const nftData = unpackMint(nft, mintAccount, mintAccount.owner);
  if (!nftData.isInitialized || nftData.decimals !== 0 || nftData.supply !== 1n || nftData.mintAuthority
      || nftData.freezeAuthority && nftData.freezeAuthority.toBase58() !== poolId) throw fail('Verify the unique position NFT and its authorities');
  if (mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID) && getMintCloseAuthority(nftData)?.closeAuthority?.toBase58() !== positionAddress) throw fail('Verify the position NFT mint close authority');
  const nftAccount = getAssociatedTokenAddressSync(nft, wallet, false, mintAccount.owner).toBase58();
  const rewards = pool.rewardInfos.filter((reward) => !reward.tokenMint.equals(PublicKey.default));
  const sources = [{ mint: pool.mintA.toBase58(), vault: pool.vaultA.toBase58(), side: 'A' }, { mint: pool.mintB.toBase58(), vault: pool.vaultB.toBase58(), side: 'B' },
    ...rewards.map((reward, index) => ({ mint: reward.tokenMint.toBase58(), vault: reward.tokenVault.toBase58(), rewardIndex: index }))];
  const mints = [...new Set(sources.map((row) => row.mint))], vaults = [...new Set(sources.map((row) => row.vault))];
  const assets = await read(connection, [nftAccount, ...mints, ...vaults], base.context.slot);
  const holding = assets.value[0];
  if (!validAccount(holding)) throw fail('Read the position NFT holding');
  const held = unpackAccount(pk(nftAccount), holding, mintAccount.owner);
  if (!held.isInitialized || held.isNative || held.mint.toBase58() !== nftMint || held.owner.toBase58() !== walletPublicKey || held.amount !== 1n
      || held.delegate || held.closeAuthority && !held.closeAuthority.equals(wallet)
      || held.isFrozen && nftData.freezeAuthority?.toBase58() !== poolId) throw fail('Verify the withdrawal wallet owns the position NFT');
  const epoch = await connection.getEpochInfo('finalized');
  if (!whole(epoch?.epoch)) throw fail('Read the withdrawal transfer-fee epoch');
  const { amountA, amountB } = LiquidityMath.getAmountsFromLiquidity(pool.sqrtPriceX64,
    SqrtPriceMath.getSqrtPriceX64FromTick(position.tickLower), SqrtPriceMath.getSqrtPriceX64FromTick(position.tickUpper), position.liquidity, false);
  const principal = { A: raw(amountA.toString()), B: raw(amountB.toString()) }, tokens = [];
  for (const [index, mint] of mints.entries()) {
    const info = assets.value[1 + index];
    if (!validAccount(info) || !tokenPrograms.includes(info.owner.toBase58())) throw fail('Verify every withdrawal token mint');
    const data = unpackMint(pk(mint), info, info.owner), extensions = getExtensionTypes(data.tlvData);
    if (!data.isInitialized || data.decimals > 19) throw fail('Read initialized withdrawal mints and their exact decimals');
    if ([ExtensionType.TransferHook, ExtensionType.NonTransferable, ExtensionType.ConfidentialTransferMint].some((type) => extensions.includes(type))) {
      throw fail('Review the token extension before withdrawing', 'TOKEN_EXTENSION_REQUIRES_REVIEW');
    }
    const accountExtensions = info.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? [...new Set([ExtensionType.ImmutableOwner, ...extensions.map(getAccountTypeOfMintType).filter((type) => type !== ExtensionType.Uninitialized)])] : [];
    const size = mint === native ? ACCOUNT_SIZE : getAccountLen(accountExtensions);
    const rentLamports = await connection.getMinimumBalanceForRentExemption(size, 'finalized');
    if (!whole(rentLamports)) throw fail('Read complete withdrawal account rent');
    const transferFee = getTransferFeeConfig(data), sides = sources.filter((row) => row.mint === mint && row.side);
    let minimumRaw = 0n;
    for (const { side } of sides) {
      const net = principal[side] - (transferFee ? calculateEpochFee(transferFee, BigInt(epoch.epoch), principal[side]) : 0n);
      minimumRaw += net * BigInt(10000 - slippageBps) / 10000n;
    }
    raw(minimumRaw.toString());
    const seed = createHash('sha256').update(JSON.stringify(['trebuchet/withdraw-sol/v1', walletPublicKey, nftMint, requestId])).digest('hex').slice(0, 32);
    const destination = mint === native ? await PublicKey.createWithSeed(wallet, seed, TOKEN_PROGRAM_ID) : getAssociatedTokenAddressSync(pk(mint), wallet, false, info.owner);
    tokens.push({ mint, programId: info.owner.toBase58(), decimals: data.decimals, minimumRaw: minimumRaw.toString(), destination: destination.toBase58(),
      native: mint === native, rentLamports, size, ...(mint === native ? { seed } : {}), vaults: [...new Set(sources.filter((row) => row.mint === mint).map((row) => row.vault))] });
  }
  for (const [index, vault] of vaults.entries()) {
    const info = assets.value[1 + mints.length + index], expected = sources.find((row) => row.vault === vault), token = tokens.find((row) => row.mint === expected.mint);
    if (!validAccount(info)) throw fail('Read each withdrawal vault');
    const data = unpackAccount(pk(vault), info, pk(token.programId));
    if (!data.isInitialized || data.isFrozen || data.mint.toBase58() !== expected.mint || data.owner.toBase58() !== poolId) throw fail('Verify the pool owns each withdrawal vault');
  }
  const outputs = await read(connection, tokens.map((row) => row.destination), assets.context.slot);
  let rentCeilingLamports = 0;
  const setup = [], cleanup = [];
  for (const [index, token] of tokens.entries()) {
    const destination = pk(token.destination), info = outputs.value[index];
    if (token.native) {
      if (info) throw fail('Refresh the withdrawal with a fresh temporary SOL account', 'POSITION_CHANGED');
      setup.push(SystemProgram.createAccountWithSeed({ fromPubkey: wallet, basePubkey: wallet, seed: token.seed, newAccountPubkey: destination,
        lamports: token.rentLamports, space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID }), createInitializeAccount3Instruction(destination, NATIVE_MINT, wallet));
      cleanup.push(createCloseAccountInstruction(destination, wallet, wallet));
      token.created = true; token.alreadyHadRaw = '0'; rentCeilingLamports += token.rentLamports;
    } else if (!info || validAccount(info) && info.owner.equals(SystemProgram.programId) && info.data.length === 0) {
      token.created = true; token.alreadyHadRaw = '0'; rentCeilingLamports += Math.max(0, token.rentLamports - (info?.lamports || 0));
      setup.push(createAssociatedTokenAccountIdempotentInstruction(wallet, destination, wallet, pk(token.mint), pk(token.programId)));
    } else {
      if (!validAccount(info)) throw fail('Read the complete withdrawal destination');
      const data = unpackAccount(destination, info, pk(token.programId));
      if (!data.isInitialized || data.isFrozen || data.isNative || data.mint.toBase58() !== token.mint || data.owner.toBase58() !== walletPublicKey
          || data.delegate || data.closeAuthority && !data.closeAuthority.equals(wallet)) throw fail('Verify the wallet owns every withdrawal destination');
      token.created = false; token.alreadyHadRaw = data.amount.toString();
    }
  }
  const forMint = (mint) => tokens.find((row) => row.mint === mint.toBase58());
  const poolInfo = { id: poolId, programId: program.toBase58(), config: { tickSpacing: pool.tickSpacing },
    mintA: { address: pool.mintA.toBase58() }, mintB: { address: pool.mintB.toBase58() }, rewardDefaultInfos: rewards.map((reward) => ({ mint: { address: reward.tokenMint.toBase58() } })) };
  const poolKeys = { vault: { A: pool.vaultA.toBase58(), B: pool.vaultB.toBase58() }, rewardInfos: rewards.map((reward) => ({ vault: reward.tokenVault.toBase58() })) };
  const nft2022 = mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID);
  const decrease = await ClmmInstrument.decreaseLiquidityInstructions({ poolInfo, poolKeys, ownerPosition: position, ownerInfo: { wallet,
    tokenAccountA: pk(forMint(pool.mintA).destination), tokenAccountB: pk(forMint(pool.mintB).destination), rewardAccounts: rewards.map((reward) => pk(forMint(reward.tokenMint).destination)) },
    liquidity: position.liquidity, amountMinA: new BN(forMint(pool.mintA).minimumRaw), amountMinB: new BN(forMint(pool.mintB).minimumRaw), nft2022 });
  const close = ClmmInstrument.closePositionInstructions({ poolInfo, poolKeys, ownerPosition: position, ownerInfo: { wallet }, nft2022 });
  if (held.isFrozen) close.instructions[0].keys.push({ pubkey: pk(poolId), isSigner: false, isWritable: false });
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }),
    ...setup, ...decrease.instructions, ...close.instructions, ...cleanup];
  const tables = [];
  for (const table of lookupTables) {
    key(table); const found = await connection.getAddressLookupTable(pk(table), { commitment: 'finalized', minContextSlot: outputs.context.slot });
    if (!found?.value || !whole(found.context?.slot) || found.context.slot < outputs.context.slot) throw fail('Read every finalized withdrawal lookup table');
    tables.push(found.value);
  }
  const expiry = await connection.getLatestBlockhash('finalized');
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: expiry.blockhash, instructions }).compileToV0Message(tables));
  let wire;
  try { wire = transaction.serialize(); } catch { throw fail('Use complete lookup tables for the withdrawal bundle', 'TRANSACTION_TOO_LARGE'); }
  if (wire.length > 1232 || transaction.message.header.numRequiredSignatures !== 1) throw fail('Use a complete single-wallet withdrawal transaction', 'TRANSACTION_TOO_LARGE');
  const fee = await connection.getFeeForMessage(transaction.message, 'finalized');
  if (!whole(fee?.context?.slot) || fee.context.slot < outputs.context.slot || !whole(fee.value) || !whole(fee.value + feePadLamports) || !whole(rentCeilingLamports)) throw fail('Read the complete withdrawal fee and rent ceilings');
  const feeCeilingLamports = fee.value + feePadLamports, maxSpendLamports = feeCeilingLamports + rentCeilingLamports;
  if (!whole(maxSpendLamports)) throw fail('Keep the withdrawal spending ceiling exact');
  const accountKeys = transaction.message.getAccountKeys({ addressLookupTableAccounts: tables });
  const plan = { version: 1, network, genesisHash: expectedGenesisHash, walletPublicKey, poolId, nftMint, nftProgramId: mintAccount.owner.toBase58(),
    nftAccount, positionAddress, programId: program.toBase58(), liquidity: expectedLiquidity, tickLower: position.tickLower, tickUpper: position.tickUpper,
    requestId, observedSlot: outputs.context.slot, transferFeeEpoch: epoch.epoch, slippageBps, tokens, sources, feeCeilingLamports, rentCeilingLamports, maxSpendLamports,
    refundAccounts: [...new Set([positionAddress, nftAccount, ...(nft2022 ? [nftMint] : []), ...tokens.filter((row) => row.native).flatMap((row) => row.vaults)])],
    lookupTables: lookupTables.slice(), accountKeys: Array.from({ length: accountKeys.length }, (_, index) => accountKeys.get(index).toBase58()) };
  return { plan, transaction };
}
