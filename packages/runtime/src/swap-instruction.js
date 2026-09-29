import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';

export const SWAP_PROGRAMS = Object.freeze({
  raydium: 'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS',
  raydiumDevnet: 'BVChZ3XFEwTMUk1o9i3HAf91H6mFxSwa5X2wFAWhYPhU',
  jupiter: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
});
const rejected = (message) => Object.assign(new Error(message), { code: 'SWAP_INTENT_MISMATCH' });
const address = (value) => new PublicKey(value).toBase58();
const discriminator = (name) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const jupiterRoutes = ['route', 'shared_accounts_route'].map((name) => ({ name, prefix: discriminator(name) }));
const uint64 = (value) => {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text) || text.length > 20 || BigInt(text) > 18446744073709551615n) throw rejected('Use an exact unsigned token amount');
  return BigInt(text);
};

// Protocol field layouts from Jupiter's public V6 IDL:
// https://github.com/jup-ag/jupiter-amm-implementation/blob/cc068c9d1df0060c62f9a8a4fc37ea13ea7b9b39/idls/jupiter_aggregator_v6.json
// This pinned schema includes 90 Swap variants. New layouts require review.
// Parse every route step before reading amounts. Reading a fixed tail alone
// could mistake appended bytes for the trade's encoded spending limits.
const flags = new Set([8, 12, 15, 16, 17, 18, 21, 23, 24, 27, 28, 39, 58, 60, 61, 64, 85, 89]);
const widths = new Map([[29, 16], [33, 4], [41, 4], [43, 10], [44, 5], [45, 5], [71, 2], [81, 8], [82, 8]]);
function jupiterAmounts(data, shared) {
  let offset = 8;
  const take = (count) => {
    if (offset + count > data.length) throw rejected('Read a complete Jupiter route instruction');
    const start = offset; offset += count; return start;
  };
  const u8 = () => data.readUInt8(take(1));
  const u32 = () => data.readUInt32LE(take(4));
  const flag = () => { if (u8() > 1) throw rejected('Read a canonical Jupiter route flag'); };
  const remainingAccounts = () => {
    const slices = u32();
    if (slices > 64) throw rejected('Use bounded Jupiter account slices');
    for (let slice = 0; slice < slices; slice++) {
      if (u8() > 8) throw rejected('Use reviewed Jupiter account slice types');
      u8();
    }
  };
  if (shared) u8();
  const count = u32();
  if (!count || count > 64) throw rejected('Use a bounded Jupiter route plan');
  for (let index = 0; index < count; index++) {
    const variant = u8();
    if (variant > 89) throw rejected('Review the new Jupiter route layout before signing');
    if (flags.has(variant)) flag();
    else if (widths.has(variant)) take(widths.get(variant));
    else if (variant === 42) { u8(); flag(); flag(); }
    else if (variant === 47) {
      flag();
      const present = u8();
      if (present > 1) throw rejected('Read a canonical Jupiter account option');
      if (present) remainingAccounts();
    } else if (variant === 75) remainingAccounts();
    else if (variant === 86) { flag(); u8(); }
    else if (variant === 87) { take(8); flag(); }
    const percent = u8(), input = u8(), output = u8();
    if (!percent || percent > 100 || input === output) throw rejected('Read the complete Jupiter route edges');
  }
  const inputAmountRaw = data.readBigUInt64LE(take(8));
  const quotedOutputRaw = data.readBigUInt64LE(take(8));
  const slippageBps = data.readUInt16LE(take(2)), platformFeeBps = u8();
  if (offset !== data.length || slippageBps > 10000 || platformFeeBps) throw rejected('Use the complete fee-free exact-input Jupiter instruction');
  return { inputAmountRaw: inputAmountRaw.toString(), minimumOutputRaw: (quotedOutputRaw * BigInt(10000 - slippageBps) / 10000n).toString(),
    quotedOutputRaw: quotedOutputRaw.toString(), slippageBps };
}

// Decode the trade instruction itself. The host also reviews setup and cleanup
// instructions, mint accounts, token programs, fees, and the whole transaction.
export function readSwapInstruction(instruction, { network }) {
  if (!['mainnet', 'devnet', 'localnet'].includes(network)) throw rejected('Use the saved swap network');
  const program = address(instruction.programId), data = Buffer.from(instruction.data), keys = instruction.keys;
  if (!Array.isArray(keys) || !data.length || data.length > 1232) throw rejected('Read a complete bounded swap instruction');
  const key = (index) => {
    if (!keys[index]) throw rejected('Read every swap account');
    return address(keys[index].pubkey);
  };
  const readonly = (index, expected) => {
    if (key(index) !== expected.toBase58() || keys[index].isSigner || keys[index].isWritable) throw rejected('Use the expected swap program accounts');
  };
  let result;
  const raydium = network === 'devnet' ? SWAP_PROGRAMS.raydiumDevnet : SWAP_PROGRAMS.raydium;
  if (program === raydium) {
    if (data[0] !== 0 || data.length < 17 || (data.length - 17) % 16 || keys.length < 11) throw rejected('Use the complete Raydium exact-input route');
    readonly(0, TOKEN_PROGRAM_ID); readonly(1, TOKEN_2022_PROGRAM_ID); readonly(2, ASSOCIATED_TOKEN_PROGRAM_ID); readonly(3, SystemProgram.programId);
    result = { provider: 'raydium', authority: key(4), sourceTokenAccount: key(5), destinationTokenAccount: key(6), inputMint: key(9),
      inputAmountRaw: data.readBigUInt64LE(1).toString(), minimumOutputRaw: data.readBigUInt64LE(9).toString(), authorityIndex: 4, sourceIndex: 5, destinationIndex: 6 };
  } else if (program === SWAP_PROGRAMS.jupiter && network !== 'devnet') {
    const route = jupiterRoutes.find((value) => value.prefix.equals(data.subarray(0, 8)));
    if (!route) throw rejected('Use a reviewed Jupiter exact-input route');
    readonly(0, TOKEN_PROGRAM_ID);
    const shared = route.name === 'shared_accounts_route';
    if (keys.length < (shared ? 13 : 9)) throw rejected('Read every Jupiter route account');
    readonly(shared ? 11 : 7, new PublicKey('D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf'));
    readonly(shared ? 12 : 8, new PublicKey(program));
    if (key(shared ? 9 : 6) !== program || shared && ![program, TOKEN_2022_PROGRAM_ID.toBase58()].includes(key(10))) throw rejected('Use the reviewed Jupiter fee and token program accounts');
    const authorityIndex = shared ? 2 : 1, sourceIndex = shared ? 3 : 2, destinationIndex = shared ? 6 : 3;
    if (!shared && ![key(destinationIndex), program].includes(key(4))) throw rejected('Keep the approved Jupiter output account');
    result = { provider: 'jupiter', route: route.name, authority: key(authorityIndex), sourceTokenAccount: key(sourceIndex), destinationTokenAccount: key(destinationIndex),
      inputMint: shared ? key(7) : NATIVE_MINT.toBase58(), outputMint: key(shared ? 8 : 5), authorityIndex, sourceIndex, destinationIndex,
      ...jupiterAmounts(data, shared) };
  } else throw rejected('Use the reviewed swap program on its saved network');
  if (!keys[result.authorityIndex].isSigner || !keys[result.sourceIndex].isWritable || !keys[result.destinationIndex].isWritable
      || keys.some((value) => value.isSigner && address(value.pubkey) !== result.authority)
      || !uint64(result.inputAmountRaw) || !uint64(result.minimumOutputRaw)) throw rejected('Verify the swap authority, accounts, and positive trade amounts');
  const { authorityIndex, sourceIndex, destinationIndex, ...decoded } = result;
  return { programId: program, ...decoded };
}

export function assertSwapInstruction(instruction, intent) {
  const value = readSwapInstruction(instruction, intent), outputMint = address(intent.outputMint);
  if (!uint64(intent.inputAmountRaw) || !uint64(intent.minimumOutputRaw)) throw rejected('Approve positive input and minimum output amounts');
  if (value.authority !== address(intent.walletPublicKey) || value.sourceTokenAccount !== address(intent.sourceTokenAccount)
      || value.destinationTokenAccount !== address(intent.destinationTokenAccount) || value.inputMint !== NATIVE_MINT.toBase58()
      || value.outputMint && value.outputMint !== outputMint
      || uint64(value.inputAmountRaw) !== uint64(intent.inputAmountRaw) || uint64(value.minimumOutputRaw) < uint64(intent.minimumOutputRaw)
      || value.slippageBps !== undefined && (!Number.isInteger(intent.maxSlippageBps) || intent.maxSlippageBps < 0 || intent.maxSlippageBps > 10000 || value.slippageBps > intent.maxSlippageBps)) {
    throw rejected('Match the encoded trade to the approved wallet, accounts, amount, and minimum output');
  }
  return value;
}


// Current Trade API helpers. Their exact accounts and data are checked before
// the full bundle translates them into its saved funding and cleanup actions.
export function readRaydiumAccountInstruction(instruction, intent) {
  const program = intent.network === 'devnet' ? SWAP_PROGRAMS.raydiumDevnet : SWAP_PROGRAMS.raydium;
  const data = Buffer.from(instruction.data), keys = instruction.keys;
  if (!['mainnet', 'devnet', 'localnet'].includes(intent.network) || address(instruction.programId) !== program
      || !Array.isArray(keys) || keys.length !== 6 || ![5, 6].includes(data[0]) || data.length !== (data[0] === 5 ? 9 : 1)) {
    throw rejected('Use the complete reviewed Raydium account instruction');
  }
  const key = (index) => address(keys[index].pubkey), wallet = address(intent.walletPublicKey), source = address(intent.sourceTokenAccount);
  const expected = data[0] === 5
    ? [wallet, source, NATIVE_MINT.toBase58(), TOKEN_PROGRAM_ID.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), SystemProgram.programId.toBase58()]
    : [wallet, source, wallet, TOKEN_PROGRAM_ID.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), SystemProgram.programId.toBase58()];
  if (keys.some((value, index) => key(index) !== expected[index] || value.isSigner !== (index === 0 || data[0] === 6 && index === 2))
      || !keys[0].isWritable || !keys[1].isWritable || keys.slice(3).some((value) => value.isWritable)
      || source !== getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(wallet)).toBase58()) {
    throw rejected('Bind Raydium SOL setup and cleanup to the wallet and its native account');
  }
  if (data[0] === 6) return { kind: 'close' };
  const lamports = Number(data.readBigUInt64LE(1));
  if (!Number.isSafeInteger(lamports) || lamports > Number(intent.inputAmountRaw)) throw rejected('Keep Raydium SOL funding within the approved input');
  return { kind: 'wrap', lamports };
}
