import { createHash } from 'node:crypto';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { swapBaseInAutoAccount, ALL_PROGRAM_ID, DEVNET_PROGRAM_ID } from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import { SWAP_PROGRAMS } from '../../src/swap-instruction.js';

export const key = (seed) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey;
const wallet = key(43), mint = key(44), source = getAssociatedTokenAddressSync(NATIVE_MINT, wallet), destination = getAssociatedTokenAddressSync(mint, wallet);
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
export const intent = { network: 'mainnet', walletPublicKey: wallet.toBase58(), sourceTokenAccount: source.toBase58(), destinationTokenAccount: destination.toBase58(),
  outputMint: mint.toBase58(), outputProgramId: TOKEN_PROGRAM_ID.toBase58(), rentCeilingLamports: 5000000, inputAmountRaw: '50000', minimumOutputRaw: '1234', maxSlippageBps: 100 };

export function raydium(network = 'mainnet', { outputProgram = TOKEN_PROGRAM_ID, outputAccount = destination } = {}) {
  const programs = network === 'devnet' ? DEVNET_PROGRAM_ID : ALL_PROGRAM_ID;
  const pool = { id: key(45).toBase58(), programId: ALL_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM.toBase58(),
    mintA: { address: NATIVE_MINT.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58() },
    mintB: { address: mint.toBase58(), programId: outputProgram.toBase58() },
    authority: key(46).toBase58(), config: { id: key(47).toBase58() }, vault: { A: key(48).toBase58(), B: key(49).toBase58() }, observationId: key(50).toBase58() };
  const routeInfo = { success: true, data: { inputMint: pool.mintA.address, outputMint: pool.mintB.address, otherAmountThreshold: '1234',
    routePlan: [{ poolId: pool.id, inputMint: pool.mintA.address, outputMint: pool.mintB.address }] } };
  return swapBaseInAutoAccount({ programId: programs.Router, wallet, amount: new BN(50000), inputAccount: source, outputAccount, routeInfo, poolKeys: [pool] });
}

export function jupiter({ shared = false, steps = [Buffer.from([7, 100, 0, 1])], amount = 50000n, output = 1250n, slippage = 100, fee = 0 } = {}) {
  const program = new PublicKey(SWAP_PROGRAMS.jupiter);
  const prefix = createHash('sha256').update(`global:${shared ? 'shared_accounts_route' : 'route'}`).digest().subarray(0, 8);
  const count = Buffer.alloc(4); count.writeUInt32LE(steps.length);
  const amounts = Buffer.alloc(19); amounts.writeBigUInt64LE(amount); amounts.writeBigUInt64LE(output, 8); amounts.writeUInt16LE(slippage, 16); amounts[18] = fee;
  return new TransactionInstruction({ programId: program, data: Buffer.concat([prefix, ...(shared ? [Buffer.from([0])] : []), count, ...steps, amounts]), keys: shared
    ? [meta(TOKEN_PROGRAM_ID), meta(key(60)), meta(wallet, false, true), meta(source, true), meta(key(61), true), meta(key(62), true), meta(destination, true), meta(NATIVE_MINT), meta(mint), meta(program), meta(program), meta(new PublicKey('D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf')), meta(program)]
    : [meta(TOKEN_PROGRAM_ID), meta(wallet, false, true), meta(source, true), meta(destination, true), meta(program), meta(mint), meta(program), meta(new PublicKey('D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf')), meta(program)] });
}


export { wallet, mint, source, destination, meta };


export function raydiumAccount(kind, lamports = 50000n) {
  const data = kind === 'wrap' ? Buffer.alloc(9) : Buffer.from([6]);
  if (kind === 'wrap') { data[0] = 5; data.writeBigUInt64LE(lamports, 1); }
  return new TransactionInstruction({ programId: new PublicKey(SWAP_PROGRAMS.raydium), data,
    keys: [meta(wallet, true, true), meta(source, true), kind === 'wrap' ? meta(NATIVE_MINT) : meta(wallet, true, true),
      meta(TOKEN_PROGRAM_ID), meta(ASSOCIATED_TOKEN_PROGRAM_ID), meta(SystemProgram.programId)] });
}
