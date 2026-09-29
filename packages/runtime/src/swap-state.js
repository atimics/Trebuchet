import { PublicKey, SystemProgram } from '@solana/web3.js';
import { publicJson } from './store.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, unpackMint, unpackAccount,
  getExtensionTypes, getAccountTypeOfMintType, getAccountLen, ExtensionType } from '@solana/spl-token';

const fail = (message) => Object.assign(new Error(message), { code: 'CHAIN_STATE_UNAVAILABLE' });
const whole = (n) => Number.isSafeInteger(n) && n >= 0;
const pk = (value) => new PublicKey(value);
const amount = (value) => {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value)) || String(value).length > 20 || BigInt(value) > 18446744073709551615n) throw fail('Read exact unsigned token balances');
  return BigInt(value);
};
const native = NATIVE_MINT.toBase58();

export function swapAccountDefinitions(review) {
  const { intent } = review;
  const definitions = new Map(review.creations.map(({ address, mint, programId }) => [address, { address, mint, programId }]));
  definitions.set(intent.sourceTokenAccount, { address: intent.sourceTokenAccount, mint: native, programId: TOKEN_PROGRAM_ID.toBase58() });
  definitions.set(intent.destinationTokenAccount, { address: intent.destinationTokenAccount, mint: intent.outputMint, programId: intent.outputProgramId });
  return [...definitions.values()];
}

export async function readSwapState(connection, review, minContextSlot = 0) {
  const definitions = swapAccountDefinitions(review), wallet = review.intent.walletPublicKey;
  const mints = [...new Map(definitions.map((item) => [item.mint, item.programId]))];
  const keys = [wallet, ...mints.map(([mint]) => mint), ...definitions.map((item) => item.address)].map(pk);
  const response = await connection.getMultipleAccountsInfoAndContext(keys, { commitment: 'finalized', minContextSlot });
  if (!whole(response?.context?.slot) || response.context.slot < minContextSlot || !Array.isArray(response.value) || response.value.length !== keys.length) throw fail('Read complete finalized swap accounts');
  const payer = response.value[0];
  if (!payer || !payer.owner.equals(SystemProgram.programId) || payer.executable || payer.data.length || !whole(payer.lamports)) throw fail('Verify the swap wallet system account');
  const mintState = {};
  for (const [index, [mint, programId]] of mints.entries()) {
    let parsed;
    try { parsed = unpackMint(pk(mint), response.value[1 + index], pk(programId)); }
    catch { throw fail('Verify each route mint and its token program'); }
    if (!parsed.isInitialized) throw fail('Use initialized swap mints');
    const extensions = getExtensionTypes(parsed.tlvData);
    if ([ExtensionType.TransferHook, ExtensionType.NonTransferable, ExtensionType.ConfidentialTransferMint].some((type) => extensions.includes(type))) {
      throw Object.assign(new Error('Review the token extension before this swap'), { code: 'TOKEN_EXTENSION_REQUIRES_REVIEW' });
    }
    const accountExtensions = programId === TOKEN_2022_PROGRAM_ID.toBase58()
      ? [ExtensionType.ImmutableOwner, ...extensions.map(getAccountTypeOfMintType).filter((type) => type !== ExtensionType.Uninitialized)] : [];
    const size = getAccountLen(accountExtensions), rentLamports = await connection.getMinimumBalanceForRentExemption(size, 'finalized');
    if (!whole(rentLamports)) throw fail('Read the complete swap account rent');
    mintState[mint] = { decimals: parsed.decimals, programId, size, rentLamports };
  }
  const accounts = {};
  for (const [index, def] of definitions.entries()) {
    const info = response.value[1 + mints.length + index], base = { ...def, decimals: mintState[def.mint].decimals };
    if (info && (info.executable || !whole(info.lamports))) throw fail('Read valid swap token account balances');
    if (!info || info.owner.equals(SystemProgram.programId) && info.data.length === 0) {
      accounts[def.address] = { ...base, exists: false, lamports: info?.lamports || 0, amountRaw: '0', nativeReserveLamports: 0 };
      continue;
    }
    let token;
    try { token = unpackAccount(pk(def.address), info, pk(def.programId)); }
    catch { throw fail('Verify every saved swap token account'); }
    if (!token.isInitialized || token.isFrozen || token.owner.toBase58() !== wallet || token.mint.toBase58() !== def.mint
        || token.delegate || token.closeAuthority && token.closeAuthority.toBase58() !== wallet || token.isNative !== (def.mint === native)) throw fail('Verify wallet ownership and authority for the swap accounts');
    if (token.isNative && (BigInt(info.lamports) < token.amount + token.rentExemptReserve || token.rentExemptReserve > BigInt(Number.MAX_SAFE_INTEGER))) throw fail('Verify the wrapped-SOL amount and rent reserve');
    accounts[def.address] = { ...base, exists: true, lamports: info.lamports, amountRaw: token.amount.toString(), nativeReserveLamports: token.isNative ? Number(token.rentExemptReserve) : 0 };
  }
  return { slot: response.context.slot, walletLamports: payer.lamports, mints: mintState, accounts };
}

// Balance changes can arrive between reads. An idempotent ATA creation may
// also find the approved account already initialized. Keep owner, mint, program,
// and native reserve fixed while checking effects and the spending ceiling.
const canAdoptCreatedAccount = (step, address) => step.creates.some((item) => item.address === address && item.kind === 'associated' && item.idempotent);
const adoptCreatedAccount = (account, before) => ({ ...account, exists: true, nativeReserveLamports: account.mint === native ? before.mints[native].rentLamports : 0 });

export function assertSwapAccountIdentity(before, current, step) {
  const identities = (accounts) => Object.fromEntries(Object.entries(accounts).map(([address, account]) => {
    const { lamports, amountRaw, ...identity } = account;
    return [address, identity];
  }));
  const expected = Object.fromEntries(Object.entries(before.accounts).map(([address, account]) => [address,
    !account.exists && current.accounts[address]?.exists && canAdoptCreatedAccount(step, address) ? adoptCreatedAccount(account, before) : account]));
  if (publicJson(identities(expected)) !== publicJson(identities(current.accounts)) || publicJson(before.mints) !== publicJson(current.mints)) {
    throw fail('Review changed swap account identities or mint rules before submission');
  }
}

// Project wallet-owned accounts through the reviewed setup and cleanup. The
// trade's output is a lower bound; its wrapped-SOL input is exact.
export function projectSwapStep(review, step, before) {
  const accounts = structuredClone(before.accounts), { intent } = review;
  let grossDebitLamports = 0, createdRent = 0, returnedLamports = 0;
  const temporary = new Set();
  const source = accounts[intent.sourceTokenAccount], destination = accounts[intent.destinationTokenAccount];
  const requireSource = () => {
    if (!source.exists || source.initialized === false) throw fail('Initialize the saved wrapped-SOL source before spending');
  };
  for (const action of step.actions) {
    if (action.kind === 'create') {
      const creation = step.creates.find((item) => item.address === action.address), account = accounts[action.address];
      const mint = before.mints[creation.mint];
      if (account.exists) {
        if (creation.kind !== 'associated' || !creation.idempotent) throw fail('Recover the existing swap account before creation');
        continue;
      }
      if (creation.kind === 'seed') {
        if (account.lamports || creation.lamports < mint.rentLamports) throw fail('Create the seeded wrapped-SOL account with its complete rent');
        account.lamports = creation.lamports; account.initialized = false;
        grossDebitLamports += creation.lamports; createdRent += mint.rentLamports;
      } else {
        const added = Math.max(0, mint.rentLamports - account.lamports);
        grossDebitLamports += added; createdRent += added; account.lamports += added;
        account.amountRaw = creation.mint === native ? String(account.lamports - mint.rentLamports) : '0';
      }
      account.nativeReserveLamports = creation.mint === native ? mint.rentLamports : 0;
      account.exists = true;
      if (action.temporary) temporary.add(action.address);
    } else if (action.kind === 'fund') {
      source.lamports += action.lamports; grossDebitLamports += action.lamports;
    } else if (action.kind === 'initialize' || action.kind === 'sync') {
      if (action.kind === 'sync') requireSource();
      else if (!source.exists || source.initialized !== false) throw fail('Initialize the new seeded swap source');
      source.amountRaw = String(source.lamports - source.nativeReserveLamports);
      delete source.initialized;
    } else if (action.kind === 'trade') {
      requireSource();
      if (!destination.exists || amount(source.amountRaw) < amount(intent.inputAmountRaw)) throw fail('Prepare the full swap input and destination before trading');
      source.amountRaw = (amount(source.amountRaw) - amount(intent.inputAmountRaw)).toString();
      source.lamports -= Number(intent.inputAmountRaw);
      destination.amountRaw = (amount(destination.amountRaw) + amount(intent.minimumOutputRaw)).toString();
    } else if (action.kind === 'close-created') {
      if (!temporary.has(action.address)) continue;
      const account = accounts[action.address];
      if (!account?.exists || amount(account.amountRaw) !== 0n) throw fail('Close only the empty intermediate account created by this trade');
      returnedLamports += account.lamports;
      account.lamports = 0; account.exists = false; account.nativeReserveLamports = 0;
      temporary.delete(action.address);
    } else if (action.kind === 'close') {
      requireSource();
      returnedLamports += source.lamports; source.lamports = 0; source.amountRaw = '0'; source.exists = false; source.nativeReserveLamports = 0;
    } else throw fail('Use the reviewed swap action order');
  }
  if (![createdRent, returnedLamports, grossDebitLamports].every(whole)) throw fail('Use exact swap funding and refund amounts');
  return { accounts, grossDebitLamports, returnedLamports, createdRentLamports: createdRent };
}

export function verifySwapEffects({ review, step, before, receipt, feeCeilingLamports }) {
  const keys = step.accountKeys, meta = receipt.meta;
  if (!whole(receipt.slot) || receipt.slot < before.slot || !whole(meta?.fee) || meta.fee > feeCeilingLamports
      || !Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances) || meta.preBalances.length !== keys.length || meta.postBalances.length !== keys.length
      || [...meta.preBalances, ...meta.postBalances].some((n) => !whole(n)) || !Array.isArray(meta.preTokenBalances) || !Array.isArray(meta.postTokenBalances)) throw fail('Read complete finalized swap balances and fees');
  const tokenAmount = (rows, index, expected) => {
    const found = rows.filter((row) => row.accountIndex === index);
    if (!expected.exists && !found.length) return 0n;
    if (!expected.exists || found.length !== 1 || found[0].mint !== expected.mint || found[0].owner !== review.intent.walletPublicKey
        || found[0].programId !== expected.programId || found[0].uiTokenAmount?.decimals !== expected.decimals) throw fail('Verify the receipt token mint, owner, program, and decimals');
    return amount(found[0].uiTokenAmount.amount);
  };
  const receiptBefore = structuredClone(before);
  receiptBefore.slot = receipt.slot;
  receiptBefore.walletLamports = meta.preBalances[0];
  for (const [address, account] of Object.entries(receiptBefore.accounts)) {
    const index = keys.indexOf(address);
    if (index < 0) continue;
    if (!account.exists && meta.preTokenBalances.some((row) => row.accountIndex === index) && canAdoptCreatedAccount(step, address)) {
      Object.assign(account, adoptCreatedAccount(account, before));
    }
    account.lamports = meta.preBalances[index];
    account.amountRaw = tokenAmount(meta.preTokenBalances, index, account).toString();
    if (account.exists && account.mint === native && BigInt(account.lamports) < amount(account.amountRaw) + BigInt(account.nativeReserveLamports)) {
      throw fail('Verify the native balance and saved reserve at transaction execution');
    }
  }
  const projection = projectSwapStep(review, step, receiptBefore);
  let receivedRaw = '0';
  for (const [address, expected] of Object.entries(projection.accounts)) {
    const index = keys.indexOf(address);
    if (index < 0) continue;
    const prior = receiptBefore.accounts[address];
    if (meta.preBalances[index] !== prior.lamports || meta.postBalances[index] !== expected.lamports
        || tokenAmount(meta.preTokenBalances, index, prior) !== amount(prior.amountRaw)) throw fail('Verify the transaction account balances against its reviewed effects');
    const after = tokenAmount(meta.postTokenBalances, index, expected);
    if (step.trade && address === review.intent.destinationTokenAccount) {
      if (after < amount(expected.amountRaw)) throw fail('Verify the approved minimum swap output');
      receivedRaw = (after - amount(prior.amountRaw)).toString();
    } else if (after !== amount(expected.amountRaw)) throw fail('Verify the exact setup, input, and cleanup token balances');
  }
  const spentLamports = meta.preBalances[0] - meta.postBalances[0];
  if (spentLamports !== projection.grossDebitLamports + meta.fee - projection.returnedLamports) throw fail('Verify the exact swap wallet debit, fee, and returned rent');
  // Retain only balances present in this receipt; other prepared accounts
  // remain context for projection rather than evidence at the receipt slot.
  const observedBefore = { slot: receiptBefore.slot, walletLamports: receiptBefore.walletLamports,
    accounts: Object.fromEntries(Object.entries(receiptBefore.accounts).filter(([address]) => keys.includes(address))) };
  return { receiptBefore: observedBefore, receivedRaw, spentLamports, grossDebitLamports: projection.grossDebitLamports + meta.fee, returnedLamports: projection.returnedLamports,
    rentLamports: projection.createdRentLamports, feeLamports: meta.fee };
}
