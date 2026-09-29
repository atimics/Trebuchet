import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram, SystemInstruction, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { assertSwapInstruction, SWAP_PROGRAMS } from './swap-instruction.js';
import { publicJson } from './store.js';

const rejected = (message) => Object.assign(new Error(message), { code: 'SWAP_INTENT_MISMATCH' });
const address = (value) => new PublicKey(value).toBase58();
const same = (left, right) => address(left) === address(right);
const whole = (value) => Number.isSafeInteger(value) && value >= 0;
const supportedToken = (value) => [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(address(value));

// This checks the complete message sequence before the host saves or signs it.
// The execution adapter also checks finalized mint/account data, rent, fees,
// approval, and final receipt balances. Lookup tables come from that host read.
export async function reviewSwapBundle({ transactions, lookupTables = [], intent }) {
  if (!Array.isArray(transactions) || !transactions.length || transactions.length > 8 || !Array.isArray(lookupTables)) throw rejected('Use a bounded swap transaction bundle');
  if (new Set(lookupTables.map((table) => address(table.key))).size !== lookupTables.length) throw rejected('Use one resolved lookup table per address');
  const wallet = new PublicKey(intent.walletPublicKey), source = address(intent.sourceTokenAccount), outputMint = address(intent.outputMint);
  const outputProgram = address(intent.outputProgramId), destination = address(intent.destinationTokenAccount);
  if (!supportedToken(outputProgram) || outputMint === NATIVE_MINT.toBase58() || source === destination
      || !same(getAssociatedTokenAddressSync(new PublicKey(outputMint), wallet, false, new PublicKey(outputProgram)), destination)
      || !/^[1-9][0-9]*$/.test(String(intent.inputAmountRaw)) || !whole(Number(intent.inputAmountRaw)) || !whole(intent.rentCeilingLamports) || !whole(Number(intent.inputAmountRaw) + intent.rentCeilingLamports)
      || !Number.isInteger(intent.maxSlippageBps) || intent.maxSlippageBps < 0 || intent.maxSlippageBps > 10000) throw rejected('Use the approved output account and exact swap funding bounds');
  const accounts = new Map([[NATIVE_MINT.toBase58(), TOKEN_PROGRAM_ID.toBase58()], [outputMint, outputProgram]]);
  if (!Array.isArray(intent.intermediateMints || []) || (intent.intermediateMints || []).length > 32) throw rejected('Use bounded intermediate swap mints');
  for (const mint of intent.intermediateMints || []) {
    const key = address(mint.mint), program = address(mint.programId);
    if (!supportedToken(program) || accounts.has(key) && accounts.get(key) !== program) throw rejected('Use one token program for each route mint');
    accounts.set(key, program);
  }
  let trade, tradeOrdinal = -1, ordinal = 0, explicitLamports = 0, transferLamports = 0, closeOrdinal = -1, lastSetupOrdinal = -1;
  const steps = [], created = new Map(), initialized = new Set();
  const createdAccount = (record) => {
    const existing = created.get(record.address);
    if (existing && publicJson(existing) !== publicJson(record)) throw rejected('Use one creation plan for each swap account');
    created.set(record.address, record);
  };
  const setup = () => { lastSetupOrdinal = ordinal; };
  for (const [index, transaction] of transactions.entries()) {
    if (!(transaction instanceof VersionedTransaction) || transaction.serialize().length > 1232 || transaction.message.header.numRequiredSignatures !== 1
        || !same(transaction.message.staticAccountKeys[0], wallet)) throw rejected('Use bounded transactions signed and paid by the approved wallet');
    let decoded;
    try { decoded = TransactionMessage.decompile(transaction.message, { addressLookupTableAccounts: lookupTables }); }
    catch { throw rejected('Resolve every swap address lookup table before signing'); }
    const resolved = transaction.message.getAccountKeys({ addressLookupTableAccounts: lookupTables });
    const accountKeys = Array.from({ length: resolved.length }, (_, at) => address(resolved.get(at)));
    const step = { index, accountKeys, trade: false, closesSource: false, explicitLamports: 0, creates: [] }, compute = new Set();
    let effects = 0;
    for (const instruction of decoded.instructions) {
      ordinal++;
      const program = instruction.programId.toBase58(), data = Buffer.from(instruction.data), keys = instruction.keys;
      const key = (at) => { if (!keys[at]) throw rejected('Read every setup account'); return keys[at].pubkey; };
      if (keys.some((value) => value.isSigner && !same(value.pubkey, wallet))) throw rejected('Keep all signing authority with the approved wallet');
      if (program === ComputeBudgetProgram.programId.toBase58()) {
        const code = data[0];
        if (![1, 2, 3, 4].includes(code) || compute.has(code) || data.length !== (code === 3 ? 9 : 5) || keys.length) throw rejected('Use one complete instruction per compute limit');
        const value = code === 3 ? data.readBigUInt64LE(1) : data.readUInt32LE(1);
        if (code === 1 && (value < 32768 || value > 262144 || value % 1024)
            || code === 2 && (!value || value > 1400000) || code === 4 && (!value || value > 67108864)) throw rejected('Use valid swap compute and memory limits');
        compute.add(code); continue;
      }
      effects++;
      if (Object.values(SWAP_PROGRAMS).includes(program)) {
        if (trade) throw rejected('Use one approved trade in each purchase bundle');
        trade = assertSwapInstruction(instruction, intent); tradeOrdinal = ordinal; step.trade = true;
      } else if (program === SystemProgram.programId.toBase58()) {
        let type;
        try { type = SystemInstruction.decodeInstructionType(instruction); } catch { throw rejected('Read the complete SOL setup instruction'); }
        if (type === 'Transfer') {
          const transfer = SystemInstruction.decodeTransfer(instruction), lamports = Number(transfer.lamports);
          if (data.length !== 12 || keys.length !== 2 || !same(transfer.fromPubkey, wallet) || !same(transfer.toPubkey, source)
              || !whole(lamports) || lamports > Number(intent.inputAmountRaw)) throw rejected('Fund only the saved wrapped-SOL input amount');
          transferLamports += lamports;
          if (!whole(transferLamports) || transferLamports > Number(intent.inputAmountRaw)) throw rejected('Keep total wrapped-SOL transfers within the approved input');
          step.explicitLamports += lamports;
        } else if (type === 'CreateWithSeed') {
          const value = SystemInstruction.decodeCreateWithSeed(instruction), derived = await PublicKey.createWithSeed(wallet, value.seed, TOKEN_PROGRAM_ID);
          if (!same(value.fromPubkey, wallet) || !same(value.basePubkey, wallet) || !same(value.newAccountPubkey, source) || !same(derived, source)
              || !same(value.programId, TOKEN_PROGRAM_ID) || value.space !== 165 || !whole(value.lamports)
              || !SystemProgram.createAccountWithSeed(value).data.equals(data)) throw rejected('Create the saved wallet-owned wrapped-SOL account');
          const record = { address: source, mint: NATIVE_MINT.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), kind: 'seed', seed: value.seed, lamports: value.lamports };
          createdAccount(record); step.creates.push(record); step.explicitLamports += value.lamports;
        } else throw rejected('Use reviewed SOL funding instructions for this swap');
        setup();
      } else if (program === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()) {
        if (data.length > 1 || data.length && ![0, 1].includes(data[0]) || ![6, 7].includes(keys.length)) throw rejected('Use a complete token account creation instruction');
        const mint = address(key(3)), tokenProgram = accounts.get(mint);
        if (!tokenProgram || !same(key(0), wallet) || !same(key(2), wallet) || !same(key(4), SystemProgram.programId) || !same(key(5), tokenProgram)
            || keys.length === 7 && !same(key(6), SYSVAR_RENT_PUBKEY)) throw rejected('Create token accounts only for the saved route and wallet');
        const target = getAssociatedTokenAddressSync(new PublicKey(mint), wallet, false, new PublicKey(tokenProgram));
        if (!same(key(1), target) || mint === NATIVE_MINT.toBase58() && !same(target, source)) throw rejected('Use the derived token account for this swap');
        const record = { address: target.toBase58(), mint, programId: tokenProgram, kind: 'associated', idempotent: data[0] === 1 };
        createdAccount(record); step.creates.push(record); setup();
      } else if (program === TOKEN_PROGRAM_ID.toBase58()) {
        if ([1, 16, 18].includes(data[0])) {
          const code = data[0], expectedKeys = code === 1 ? 4 : code === 16 ? 3 : 2;
          if (data.length !== (code === 1 ? 1 : 33) || keys.length !== expectedKeys || !same(key(0), source) || !same(key(1), NATIVE_MINT)
              || !same(code === 1 ? key(2) : new PublicKey(data.subarray(1)), wallet)
              || code !== 18 && !same(key(expectedKeys - 1), SYSVAR_RENT_PUBKEY)
              || created.get(source)?.kind !== 'seed' || initialized.has(source)) throw rejected('Initialize the saved wrapped-SOL account for its wallet');
          initialized.add(source); setup();
        } else if (data[0] === 17) {
          if (data.length !== 1 || keys.length !== 1 || !same(key(0), source)) throw rejected('Sync only the saved wrapped-SOL account');
          setup();
        } else if (data[0] === 9) {
          if (data.length !== 1 || keys.length !== 3 || !same(key(0), source) || !same(key(1), wallet) || !same(key(2), wallet) || closeOrdinal >= 0) throw rejected('Return wrapped-SOL rent only to its wallet');
          closeOrdinal = ordinal; step.closesSource = true;
        } else throw rejected('Use reviewed wrapped-SOL setup and cleanup instructions');
      } else throw rejected('Review the extra swap instruction before signing');
    }
    if (!effects) throw rejected('Keep each swap transaction tied to a saved action');
    explicitLamports += step.explicitLamports;
    if (!whole(explicitLamports) || explicitLamports > Number(intent.inputAmountRaw) + intent.rentCeilingLamports) throw rejected('Keep the complete bundle within its SOL funding and rent ceiling');
    const normalized = new VersionedTransaction(VersionedTransaction.deserialize(transaction.serialize()).message);
    normalized.message.recentBlockhash = PublicKey.default.toBase58();
    step.template = Buffer.from(normalized.serialize()).toString('base64');
    steps.push(step);
  }
  if (!trade || lastSetupOrdinal >= tradeOrdinal || closeOrdinal >= 0 && closeOrdinal <= tradeOrdinal) throw rejected('Prepare the saved accounts before the trade and return rent afterward');
  if ([...created.values()].some((record) => record.kind === 'seed' && !initialized.has(record.address))) throw rejected('Initialize every saved wrapped-SOL account before spending');
  const tradeIndex = steps.findIndex((step) => step.trade);
  for (const step of steps) step.kind = step.index === tradeIndex ? 'swap' : step.index < tradeIndex ? 'setup' : 'cleanup';
  const reviewedIntent = { network: intent.network, walletPublicKey: wallet.toBase58(), sourceTokenAccount: source,
    destinationTokenAccount: destination, outputMint, outputProgramId: outputProgram, inputAmountRaw: String(intent.inputAmountRaw),
    minimumOutputRaw: String(intent.minimumOutputRaw), maxSlippageBps: intent.maxSlippageBps, rentCeilingLamports: intent.rentCeilingLamports,
    intermediateMints: [...accounts].filter(([mint]) => mint !== NATIVE_MINT.toBase58() && mint !== outputMint).map(([mint, programId]) => ({ mint, programId })).sort((a, b) => a.mint.localeCompare(b.mint)) };
  const plan = { intent: reviewedIntent, trade, explicitLamports, creations: [...created.values()], steps };
  return { ...plan, digest: createHash('sha256').update(publicJson(plan)).digest('hex') };
}
