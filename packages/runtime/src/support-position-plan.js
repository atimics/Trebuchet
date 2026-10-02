import { createHash } from 'node:crypto';
import BN from 'bn.js';
import { PublicKey, SystemProgram, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, ACCOUNT_SIZE, MINT_SIZE, ExtensionType,
  unpackMint, unpackAccount, getExtensionTypes, getAccountTypeOfMintType, getAccountLen, getMintLen,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createInitializeAccount3Instruction, createCloseAccountInstruction } from '@solana/spl-token';
import { CLMM_PROGRAM_ID, DEVNET_PROGRAM_ID, PoolInfoLayout, PositionInfoLayout, ProtocolPositionLayout, TickArrayLayout,
  TickUtils, LiquidityMath, SqrtPriceMath, ClmmInstrument, getPdaPersonalPositionAddress, getPdaPoolVaultId, getPdaTickArrayAddress } from '@raydium-io/raydium-sdk-v2';

const pk = (value) => new PublicKey(value);
export const supportError = (message, code = 'CHAIN_STATE_UNAVAILABLE') => Object.assign(new Error(message), { code });
export const supportWhole = (value) => Number.isSafeInteger(value) && value >= 0;
export const supportAccount = (value) => value && !value.executable && supportWhole(value.lamports) && Buffer.isBuffer(value.data);
export const supportRaw = (value, bits = 64) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 39 || BigInt(value) >= 1n << BigInt(bits)) throw supportError('Use exact unsigned support amounts');
  return BigInt(value);
};
export const supportDecode = (account, layout, program, name) => {
  const tag = createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
  if (!supportAccount(account) || !account.owner.equals(pk(program)) || account.data.length !== layout.span || !account.data.subarray(0, 8).equals(tag)) throw supportError(`Verify the complete ${name} account`);
  return layout.decode(account.data);
};
export const readSupportAccounts = async (connection, keys, minContextSlot = 0) => {
  const response = await connection.getMultipleAccountsInfoAndContext(keys.map(pk), { commitment: 'finalized', minContextSlot });
  if (!supportWhole(response?.context?.slot) || response.context.slot < minContextSlot || !Array.isArray(response.value) || response.value.length !== keys.length) throw supportError('Read every finalized support account');
  return response;
};
export function verifySupportRange(pool, { nativeIsA, tickLower, tickUpper }) {
  if (!supportWhole(pool.tickSpacing) || pool.tickSpacing < 1 || !Number.isInteger(tickLower) || !Number.isInteger(tickUpper)
      || tickLower < -443636 || tickUpper > 443636 || tickLower >= tickUpper || tickLower % pool.tickSpacing || tickUpper % pool.tickSpacing) throw supportError('Review the support tick range', 'SUPPORT_PLAN_CHANGED');
  if (pool.status & 1 || pool.sqrtPriceX64.isZero() || (nativeIsA
    ? pool.sqrtPriceX64.gt(SqrtPriceMath.getSqrtPriceX64FromTick(tickLower))
    : pool.sqrtPriceX64.lt(SqrtPriceMath.getSqrtPriceX64FromTick(tickUpper)))) throw supportError('Review a support range that takes only SOL', 'SUPPORT_PLAN_CHANGED');
}

// Hosts supply the public NFT identity from their recoverable signer. This
// builder saves a fixed-liquidity, SOL-only operation for explicit approval.
export async function buildSupportPositionPlan({ connection, network, expectedGenesisHash, walletPublicKey, poolId, nftMint,
  depositLamports, tickLower, tickUpper, requestId, nft2022 = true, lookupTables = [], priorityFeeMicroLamports = 50000, feePadLamports = 5000, minContextSlot = 0 }) {
  for (const value of [walletPublicKey, poolId, nftMint]) if (typeof value !== 'string' || pk(value).toBase58() !== value) throw new TypeError('Use complete support account addresses');
  if (!['mainnet', 'devnet', 'localnet'].includes(network) || !expectedGenesisHash || typeof nft2022 !== 'boolean'
      || typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(requestId) || !supportWhole(priorityFeeMicroLamports) || !supportWhole(feePadLamports)
      || !Array.isArray(lookupTables) || lookupTables.length > 8 || new Set(lookupTables).size !== lookupTables.length
      || supportRaw(depositLamports) <= 0n || !supportWhole(Number(depositLamports))) throw new TypeError('Use a complete support request and exact spending limit');
  if (await connection.getGenesisHash() !== expectedGenesisHash) throw supportError('Prepare support on its saved chain', 'NETWORK_MISMATCH');
  const wallet = pk(walletPublicKey), program = network === 'devnet' ? DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID : CLMM_PROGRAM_ID;
  const nftProgram = nft2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const positionAddress = getPdaPersonalPositionAddress(program, pk(nftMint)).publicKey.toBase58(), nftAccount = getAssociatedTokenAddressSync(pk(nftMint), wallet, false, nftProgram).toBase58();
  const base = await readSupportAccounts(connection, [walletPublicKey, poolId, nftMint, nftAccount, positionAddress], minContextSlot);
  const [payer, poolAccount, ...identities] = base.value;
  if (!supportAccount(payer) || !payer.owner.equals(SystemProgram.programId) || payer.data.length) throw supportError('Verify the support wallet system account');
  if (identities.some(Boolean)) throw supportError('Use a fresh saved position identity', 'SUPPORT_POSITION_EXISTS');
  const pool = supportDecode(poolAccount, PoolInfoLayout, program, 'PoolState');
  // Current CLMM pools keep an optional two-byte index after status and fee-on.
  // The legacy layout reserves these same bytes. See Raydium states/pool.rs.
  const poolSeedBytes = poolAccount.data.subarray(PoolInfoLayout.offsetOf('status') + 2, PoolInfoLayout.offsetOf('status') + 4);
  const poolSeedIndex = poolSeedBytes.readUInt16LE();
  const derivedPool = PublicKey.findProgramAddressSync([Buffer.from('pool'), pool.ammConfig.toBuffer(), pool.mintA.toBuffer(), pool.mintB.toBuffer(), ...(poolSeedIndex ? [poolSeedBytes] : [])], program)[0];
  if (!derivedPool.equals(pk(poolId))) throw supportError('Verify the support pool address');
  const nativeIsA = pool.mintA.equals(NATIVE_MINT);
  if (nativeIsA === pool.mintB.equals(NATIVE_MINT)) throw supportError('Choose a token pool paired with native SOL');
  verifySupportRange(pool, { nativeIsA, tickLower, tickUpper });
  const tokenMint = (nativeIsA ? pool.mintB : pool.mintA).toBase58(), nativeVault = (nativeIsA ? pool.vaultA : pool.vaultB).toBase58(), tokenVault = (nativeIsA ? pool.vaultB : pool.vaultA).toBase58();
  for (const [mint, vault] of [[pool.mintA, pool.vaultA], [pool.mintB, pool.vaultB]]) if (!getPdaPoolVaultId(program, pk(poolId), mint).publicKey.equals(vault)) throw supportError('Verify the support pool vault addresses');
  const starts = [...new Set([tickLower, tickUpper].map((tick) => TickUtils.getTickArrayStartIndexByTick(tick, pool.tickSpacing)))];
  const arrays = starts.map((startIndex) => ({ address: getPdaTickArrayAddress(program, pk(poolId), startIndex).publicKey.toBase58(), startIndex }));
  const assets = await readSupportAccounts(connection, [NATIVE_MINT.toBase58(), tokenMint, nativeVault, tokenVault, ...arrays.map((row) => row.address)], base.context.slot);
  const tokenInfo = assets.value[1];
  if (!supportAccount(tokenInfo) || ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(tokenInfo.owner.toBase58())) throw supportError('Read the support token program');
  const token = unpackMint(pk(tokenMint), tokenInfo, tokenInfo.owner), native = unpackMint(NATIVE_MINT, assets.value[0], TOKEN_PROGRAM_ID), extensions = getExtensionTypes(token.tlvData);
  if (!token.isInitialized || token.decimals > 19 || !native.isInitialized || native.decimals !== 9
      || pool.mintDecimalsA !== (nativeIsA ? 9 : token.decimals) || pool.mintDecimalsB !== (nativeIsA ? token.decimals : 9)) throw supportError('Verify the support mint decimals');
  if ([ExtensionType.TransferHook, ExtensionType.NonTransferable, ExtensionType.ConfidentialTransferMint].some((type) => extensions.includes(type))) throw supportError('Review this token extension before adding support', 'TOKEN_EXTENSION_REQUIRES_REVIEW');
  for (const [index, mint, programId] of [[2, NATIVE_MINT, TOKEN_PROGRAM_ID], [3, pk(tokenMint), tokenInfo.owner]]) {
    if (!supportAccount(assets.value[index])) throw supportError('Read each complete support vault');
    const data = unpackAccount(pk(index === 2 ? nativeVault : tokenVault), assets.value[index], programId);
    if (!data.isInitialized || data.isFrozen || !data.mint.equals(mint) || data.owner.toBase58() !== poolId || Boolean(data.isNative) !== (index === 2)) throw supportError('Verify the support vault identities');
  }
  const lower = SqrtPriceMath.getSqrtPriceX64FromTick(tickLower), upper = SqrtPriceMath.getSqrtPriceX64FromTick(tickUpper), amount = new BN(depositLamports);
  const liquidity = nativeIsA ? LiquidityMath.getLiquidityFromTokenAmountA(lower, upper, amount, false) : LiquidityMath.getLiquidityFromTokenAmountB(lower, upper, amount);
  if (liquidity.isZero() || supportRaw(liquidity.toString(), 128) >= 1n << 127n) throw supportError('Choose support that produces a positive bounded liquidity amount');
  const amounts = LiquidityMath.getAmountsFromLiquidity(pool.sqrtPriceX64, lower, upper, liquidity, true);
  const depositedRaw = (nativeIsA ? amounts.amountA : amounts.amountB).toString();
  if (supportRaw(depositedRaw) <= 0n || BigInt(depositedRaw) > BigInt(depositLamports) || !(nativeIsA ? amounts.amountB : amounts.amountA).isZero()) throw supportError('Verify the exact SOL-only support deposit');
  const seed = createHash('sha256').update(JSON.stringify(['trebuchet/support-sol/v1', walletPublicKey, nftMint, requestId])).digest('hex').slice(0, 32);
  const temporary = await PublicKey.createWithSeed(wallet, seed, TOKEN_PROGRAM_ID), tokenAccount = getAssociatedTokenAddressSync(pk(tokenMint), wallet, false, tokenInfo.owner);
  const outputs = await readSupportAccounts(connection, [temporary.toBase58(), tokenAccount.toBase58()], assets.context.slot);
  if (outputs.value[0]) throw supportError('Review a fresh temporary support SOL account', 'SUPPORT_PLAN_CHANGED');
  const tokenTypes = tokenInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? [...new Set([ExtensionType.ImmutableOwner, ...extensions.map(getAccountTypeOfMintType).filter((type) => type !== 0)])] : [];
  const rents = [], rent = async (address, size, current, type, fields = {}) => {
    const minimum = await connection.getMinimumBalanceForRentExemption(size, 'finalized');
    if (!supportWhole(minimum)) throw supportError('Read complete support account rent');
    const system = current && supportAccount(current) && current.owner.equals(SystemProgram.programId) && !current.data.length;
    const created = !current || system, limit = created ? Math.max(0, minimum - (current?.lamports || 0)) : 0;
    rents.push({ address, type, size, created, rentCeilingLamports: limit, ...fields }); return minimum;
  };
  const temporaryRentLamports = await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, 'finalized');
  if (!supportWhole(temporaryRentLamports)) throw supportError('Read the temporary support account rent');
  for (const [index, row] of arrays.entries()) {
    const current = assets.value[4 + index];
    if (current && !(supportAccount(current) && current.owner.equals(SystemProgram.programId) && !current.data.length)) {
      const data = supportDecode(current, TickArrayLayout, program, 'TickArrayState');
      if (data.poolId.toBase58() !== poolId || data.startTickIndex !== row.startIndex) throw supportError('Verify each support tick array');
    }
    await rent(row.address, TickArrayLayout.span, current, 'tick-array', { startIndex: row.startIndex });
  }
  await rent(nftMint, nft2022 ? getMintLen([ExtensionType.MintCloseAuthority]) : MINT_SIZE, null, 'nft-mint');
  await rent(nftAccount, nft2022 ? getAccountLen([ExtensionType.ImmutableOwner]) : ACCOUNT_SIZE, null, 'nft-account');
  await rent(positionAddress, PositionInfoLayout.span, null, 'position');
  const existingToken = outputs.value[1], createdToken = !existingToken || supportAccount(existingToken) && existingToken.owner.equals(SystemProgram.programId) && !existingToken.data.length;
  if (!createdToken) {
    if (!supportAccount(existingToken)) throw supportError('Read the complete support token account');
    const data = unpackAccount(tokenAccount, existingToken, tokenInfo.owner);
    if (!data.isInitialized || data.isFrozen || data.isNative || !data.owner.equals(wallet) || !data.mint.equals(pk(tokenMint)) || data.delegate || data.closeAuthority && !data.closeAuthority.equals(wallet)) throw supportError('Verify the support wallet token account');
  }
  await rent(tokenAccount.toBase58(), getAccountLen(tokenTypes), existingToken, 'token-account');
  const opened = await ClmmInstrument.openPositionFromLiquidityInstructions({ poolInfo: { id: poolId, programId: program.toBase58(), config: { tickSpacing: pool.tickSpacing } },
    poolKeys: { vault: { A: pool.vaultA.toBase58(), B: pool.vaultB.toBase58() }, mintA: { address: pool.mintA.toBase58() }, mintB: { address: pool.mintB.toBase58() } },
    ownerInfo: { wallet, tokenAccountA: nativeIsA ? temporary : tokenAccount, tokenAccountB: nativeIsA ? tokenAccount : temporary }, tickLower, tickUpper, liquidity,
    amountMaxA: nativeIsA ? amount : new BN(0), amountMaxB: nativeIsA ? new BN(0) : amount, nft2022, withMetadata: 'no-create', getEphemeralSigners: async () => [nftMint] });
  // Older CLMM deployments allocate a protocol-position account. Its canonical
  // address and rent ceiling stay explicit when the deployed program uses it.
  const protocolPosition = opened.address.protocolPosition.toBase58(), protocol = await readSupportAccounts(connection, [protocolPosition], outputs.context.slot);
  if (protocol.value[0]) supportDecode(protocol.value[0], ProtocolPositionLayout, program, 'ProtocolPositionState');
  await rent(protocolPosition, ProtocolPositionLayout.span, protocol.value[0], 'protocol-position');
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }),
    SystemProgram.createAccountWithSeed({ fromPubkey: wallet, basePubkey: wallet, seed, newAccountPubkey: temporary, lamports: Number(depositLamports) + temporaryRentLamports, space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeAccount3Instruction(temporary, NATIVE_MINT, wallet), ...(createdToken ? [createAssociatedTokenAccountIdempotentInstruction(wallet, tokenAccount, wallet, pk(tokenMint), tokenInfo.owner)] : []),
    ...opened.instructions, createCloseAccountInstruction(temporary, wallet, wallet)];
  const tables = [];
  for (const table of lookupTables) {
    const result = await connection.getAddressLookupTable(pk(table), { commitment: 'finalized', minContextSlot: protocol.context.slot });
    if (!result?.value || !supportWhole(result.context?.slot) || result.context.slot < protocol.context.slot) throw supportError('Read each finalized support lookup table');
    tables.push(result.value);
  }
  const { blockhash } = await connection.getLatestBlockhash('finalized');
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: blockhash, instructions }).compileToV0Message(tables));
  let wire; try { wire = transaction.serialize(); } catch { throw supportError('Use complete lookup tables for the support transaction', 'TRANSACTION_TOO_LARGE'); }
  if (wire.length > 1232 || transaction.message.header.numRequiredSignatures !== 2 || transaction.message.staticAccountKeys[1].toBase58() !== nftMint) throw supportError('Verify both signers and the complete support transaction', 'TRANSACTION_TOO_LARGE');
  const fee = await connection.getFeeForMessage(transaction.message, 'finalized');
  if (!supportWhole(fee?.context?.slot) || fee.context.slot < protocol.context.slot || !supportWhole(fee.value)) throw supportError('Read the finalized support transaction fee');
  const feeCeilingLamports = fee.value + feePadLamports, rentCeilingLamports = temporaryRentLamports + rents.reduce((sum, row) => sum + row.rentCeilingLamports, 0);
  const maxSpendLamports = Number(depositLamports) + feeCeilingLamports + rentCeilingLamports;
  if (![feeCeilingLamports, rentCeilingLamports, maxSpendLamports].every(supportWhole)) throw supportError('Keep all support spending limits exact');
  const keys = transaction.message.getAccountKeys({ addressLookupTableAccounts: tables });
  return { transaction, plan: { version: 1, network, genesisHash: expectedGenesisHash, walletPublicKey, poolId, nftMint, nftProgramId: nftProgram.toBase58(), nftAccount, positionAddress,
    programId: program.toBase58(), tokenMint, tokenProgramId: tokenInfo.owner.toBase58(), tokenDecimals: token.decimals, tokenAccount: tokenAccount.toBase58(), nativeVault, tokenVault,
    nativeIsA, tickLower, tickUpper, tickSpacing: pool.tickSpacing, poolSeedIndex, ammConfig: pool.ammConfig.toBase58(), liquidity: liquidity.toString(), depositLamports, depositedRaw, requestId,
    observedSlot: protocol.context.slot, temporaryAccount: temporary.toBase58(), temporaryRentLamports, rents, feeCeilingLamports, rentCeilingLamports, maxSpendLamports,
    lookupTables: lookupTables.slice(), accountKeys: Array.from({ length: keys.length }, (_, index) => keys.get(index).toBase58()) } };
}
