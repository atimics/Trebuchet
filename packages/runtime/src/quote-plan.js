import { PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackMint, unpackAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { createQuoteProvider } from './quote-provider.js';
import { reviewSwapBundle } from './swap-bundle.js';
import { readSwapState, projectSwapStep } from './swap-state.js';

const native = NATIVE_MINT.toBase58(), maxU64 = 18446744073709551615n;
const whole = (value) => Number.isSafeInteger(value) && value >= 0;
const fail = (code, message) => Object.assign(new Error(message), { code });
const raw = (value) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > maxU64) throw new TypeError('Use exact unsigned token amounts');
  return BigInt(value);
};
const address = (value) => {
  if (typeof value !== 'string' || new PublicKey(value).toBase58() !== value) throw new TypeError('Use a complete token or wallet address');
  return value;
};
export function normalizeQuoteRequest(autoSwapPlan) {
  if (!Array.isArray(autoSwapPlan) || autoSwapPlan.length > 64) throw new TypeError('Use up to 64 quote allocation rows');
  const grouped = new Map();
  for (const item of autoSwapPlan) {
    const mint = address(item.quoteMint), target = raw(item.targetRaw), minimum = raw(item.minRaw ?? item.targetRaw);
    const cap = item.maxInputLamports === undefined ? Math.ceil(item.estSolSpend * 1e9) : Number(raw(item.maxInputLamports));
    if (mint === native || !whole(item.allocationIndex) || item.allocationIndex > 63 || !whole(item.quoteDecimals) || item.quoteDecimals > 19
        || minimum <= 0n || target < minimum || !whole(cap) || cap < 50000
        || item.maxInputLamports === undefined && (typeof item.estSolSpend !== 'number' || !Number.isFinite(item.estSolSpend))
        || item.routeProvider !== undefined && !['raydium', 'jupiter'].includes(item.routeProvider)
        || typeof item.quoteSymbol !== 'string' || item.quoteSymbol.length > 32) throw new TypeError('Use complete quote targets, decimals, and SOL input limits');
    const previous = grouped.get(mint);
    if (previous) {
      if (previous.quoteDecimals !== item.quoteDecimals || previous.allocationIndices.includes(item.allocationIndex)) throw new TypeError('Use distinct allocations with matching mint decimals');
      previous.targetRaw = (BigInt(previous.targetRaw) + target).toString(); previous.minRaw = (BigInt(previous.minRaw) + minimum).toString();
      previous.maxInputLamports += cap; previous.allocationIndices.push(item.allocationIndex);
      if (!whole(previous.maxInputLamports) || raw(previous.targetRaw) > maxU64 || raw(previous.minRaw) > maxU64) throw new TypeError('Keep combined quote amounts exact');
    } else grouped.set(mint, { quoteMint: mint, quoteSymbol: item.quoteSymbol, quoteDecimals: item.quoteDecimals, targetRaw: target.toString(), minRaw: minimum.toString(),
      maxInputLamports: cap, routeProvider: item.routeProvider || 'raydium', allocationIndices: [item.allocationIndex] });
  }
  if (grouped.size > 16) throw new TypeError('Use up to 16 distinct quote mints');
  return [...grouped.values()].map((item) => ({ ...item, allocationIndices: item.allocationIndices.sort((a, b) => a - b) })).sort((a, b) => a.quoteMint.localeCompare(b.quoteMint));
}

export function createQuotePlanBuilder({ connection, network, expectedGenesisHash, provider = createQuoteProvider(),
  priorityFeeMicroLamports = 50000, slippageBps = 100, feePadLamports = 5000 }) {
  if (!['mainnet', 'devnet', 'localnet'].includes(network) || !expectedGenesisHash || !whole(priorityFeeMicroLamports)
      || !whole(slippageBps) || slippageBps > 1000 || !whole(feePadLamports)) throw new TypeError('Use a complete quote network and fee policy');
  const read = async (keys, minContextSlot = 0) => {
    const response = await connection.getMultipleAccountsInfoAndContext(keys.map((value) => new PublicKey(value)), { commitment: 'finalized', minContextSlot });
    if (!whole(response?.context?.slot) || response.context.slot < minContextSlot || !Array.isArray(response.value) || response.value.length !== keys.length) {
      throw fail('CHAIN_STATE_UNAVAILABLE', 'Read every finalized quote account');
    }
    return response;
  };
  const mint = async (key, minSlot = 0) => {
    const response = await read([key], minSlot), info = response.value[0];
    if (!info || info.executable || ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(info.owner.toBase58())) throw fail('CHAIN_STATE_UNAVAILABLE', 'Verify the quote mint token program');
    const value = unpackMint(new PublicKey(key), info, info.owner);
    if (!value.isInitialized) throw fail('CHAIN_STATE_UNAVAILABLE', 'Use an initialized quote mint');
    return { programId: info.owner.toBase58(), decimals: value.decimals, slot: response.context.slot };
  };
  return {
    async build({ walletPublicKey, autoSwapPlan }) {
      address(walletPublicKey);
      const rows = normalizeQuoteRequest(autoSwapPlan), purchases = [], preparedRows = [];
      if (await connection.getGenesisHash() !== expectedGenesisHash) throw fail('NETWORK_MISMATCH', 'The RPC is on a different network from the app. Match them on the Mode bar or in Settings, then try again');
      for (const row of rows) {
        const output = await mint(row.quoteMint);
        if (row.quoteDecimals !== output.decimals) throw fail('QUOTE_DECIMALS_MISMATCH', 'Refresh the estimate with the quote mint decimals');
        const wallet = new PublicKey(walletPublicKey), destination = getAssociatedTokenAddressSync(new PublicKey(row.quoteMint), wallet, false, new PublicKey(output.programId));
        const snapshot = await read([destination.toBase58()], output.slot), info = snapshot.value[0];
        let balance = 0n;
        if (info && !(info.owner.equals(SystemProgram.programId) && info.data.length === 0)) {
          const token = unpackAccount(destination, info, new PublicKey(output.programId));
          if (!token.isInitialized || token.isFrozen || token.isNative || !token.owner.equals(wallet) || token.mint.toBase58() !== row.quoteMint
              || token.delegate || token.closeAuthority && !token.closeAuthority.equals(wallet)) throw fail('CHAIN_STATE_UNAVAILABLE', 'Verify ownership and authority of the quote account');
          balance = token.amount;
        }
        if (info && (info.executable || !whole(info.lamports))) throw fail('CHAIN_STATE_UNAVAILABLE', 'Read the complete quote account balance');
        const context = { ...row, programId: output.programId, observedSlot: snapshot.context.slot, alreadyHadRaw: balance.toString() };
        if (balance >= BigInt(row.minRaw)) { preparedRows.push({ ...context, state: 'held' }); continue; }
        const needed = BigInt(row.minRaw) - balance, target = BigInt(row.targetRaw);
        const input = Number((BigInt(row.maxInputLamports) * (target - balance) + target - 1n) / target);
        if (!whole(input) || input < 50000 || input > row.maxInputLamports) throw fail('QUOTE_INPUT_TOO_SMALL', 'Refresh the quote with a complete SOL input amount');
        let purchase, routeProvider, lastError;
        for (const name of [row.routeProvider, row.routeProvider === 'raydium' ? 'jupiter' : 'raydium']) {
          try {
            const quote = await provider.quote({ provider: name, inputMint: native, outputMint: row.quoteMint, inputAmountRaw: String(input), slippageBps });
            const data = name === 'raydium' ? quote?.data : quote, hops = data?.routePlan;
            const minimum = raw(data?.otherAmountThreshold), outputRaw = raw(name === 'raydium' ? data?.outputAmount : data?.outAmount);
            const quotedInput = name === 'raydium' ? data?.inputAmount : data?.inAmount;
            if (data?.inputMint !== native || data?.outputMint !== row.quoteMint || quotedInput !== String(input) || minimum < needed || minimum > outputRaw
                || data.slippageBps !== slippageBps || !Array.isArray(hops) || !hops.length || hops.length > 16) throw fail('QUOTE_INTENT_MISMATCH', 'Use a quote for the exact SOL input and required token output');
            const routeMints = [...new Set(hops.flatMap((hop) => { const value = name === 'raydium' ? hop : hop.swapInfo; return [address(value.inputMint), address(value.outputMint)]; }))]
              .filter((key) => key !== native && key !== row.quoteMint);
            if (routeMints.length > 8) throw fail('QUOTE_INTENT_MISMATCH', 'Use a bounded token route');
            const intermediateMints = [];
            for (const key of routeMints) intermediateMints.push({ mint: key, programId: (await mint(key, snapshot.context.slot)).programId });
            const wires = await provider.transactions({ provider: name, quote, walletPublicKey, priorityFeeMicroLamports });
            if (!Array.isArray(wires) || !wires.length || wires.length > 8) throw fail('QUOTE_INTENT_MISMATCH', 'Use a complete unsigned provider bundle');
            const transactions = wires.map((wire) => VersionedTransaction.deserialize(Buffer.from(wire, 'base64'))), tables = new Map();
            for (const tx of transactions) for (const lookup of tx.message.addressTableLookups || []) {
              if (tables.has(lookup.accountKey.toBase58())) continue;
              const result = await connection.getAddressLookupTable(lookup.accountKey, { commitment: 'finalized' });
              if (!result?.value || !whole(result.context?.slot)) throw fail('CHAIN_STATE_UNAVAILABLE', 'Read every quote lookup table');
              tables.set(lookup.accountKey.toBase58(), result.value);
            }
            const intent = { network, walletPublicKey, sourceTokenAccount: getAssociatedTokenAddressSync(NATIVE_MINT, wallet).toBase58(),
              destinationTokenAccount: destination.toBase58(), outputMint: row.quoteMint, outputProgramId: output.programId, inputAmountRaw: String(input),
              minimumOutputRaw: minimum.toString(), maxSlippageBps: slippageBps, intermediateMints, rentCeilingLamports: 1000000000 };
            const review = await reviewSwapBundle({ transactions, lookupTables: [...tables.values()], intent });
            if (review.trade.provider !== name) throw fail('QUOTE_INTENT_MISMATCH', 'Use the reviewed transaction provider named by the quote');
            let state = await readSwapState(connection, review, snapshot.context.slot), rent = 0, feeCeilingLamports = 0;
            const expiry = await connection.getLatestBlockhash('finalized');
            for (const step of review.steps) {
              const transaction = VersionedTransaction.deserialize(Buffer.from(step.template, 'base64')); transaction.message.recentBlockhash = expiry.blockhash;
              const fee = await connection.getFeeForMessage(transaction.message, 'finalized');
              if (!whole(fee?.context?.slot) || fee.context.slot < state.slot || !whole(fee.value) || !whole(fee.value + feePadLamports)) throw fail('CHAIN_STATE_UNAVAILABLE', 'Read the complete quote transaction fee');
              feeCeilingLamports = Math.max(feeCeilingLamports, fee.value + feePadLamports);
              const projection = projectSwapStep(review, step, state); rent += projection.createdRentLamports;
              state = { ...state, accounts: projection.accounts, walletLamports: state.walletLamports - projection.grossDebitLamports - fee.value + projection.returnedLamports };
            }
            if (!whole(rent)) throw fail('QUOTE_INTENT_MISMATCH', 'Use an exact quote rent ceiling');
            intent.rentCeilingLamports = rent;
            await reviewSwapBundle({ transactions, lookupTables: [...tables.values()], intent });
            purchase = { transactions, intent, feeCeilingLamports }; routeProvider = name; break;
          } catch (error) {
            // A failed account read must keep its uncertainty visible. A
            // provider failure can use another unsigned quote before approval.
            if (!['QUOTE_UNAVAILABLE', 'QUOTE_INTENT_MISMATCH', 'SWAP_INTENT_MISMATCH'].includes(error.code)) throw error;
            lastError = error;
          }
        }
        if (!purchase) throw lastError || fail('QUOTE_UNAVAILABLE', 'Refresh the quote before approving this purchase');
        purchases.push(purchase); preparedRows.push({ ...context, state: 'purchase', routeProvider, inputAmountRaw: purchase.intent.inputAmountRaw,
          minimumOutputRaw: purchase.intent.minimumOutputRaw, feeCeilingLamports: purchase.feeCeilingLamports * purchase.transactions.length,
          rentCeilingLamports: purchase.intent.rentCeilingLamports });
      }
      return { purchases, rows: preparedRows };
    },
  };
}
