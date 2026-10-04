import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

export const FEE_VAULT_HEADER = 366;
export const FEE_VAULT_ENTRY = 56;
export const CORE_PROGRAM_ID = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const pk = (value) => new PublicKey(value);
const meta = (value, isWritable = false, isSigner = false) => ({ pubkey: pk(value), isWritable, isSigner });
const u64 = (value) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
const u16 = (value) => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; };
const addr = (data, at) => new PublicKey(data.subarray(at, at + 32)).toBase58();
const number = (data, at) => data.readBigUInt64LE(at).toString();

export function feeVaultAddress(programId, creator, seed) {
  if (Buffer.from(seed).length !== 32) throw new Error('Vault seed must be 32 bytes');
  return PublicKey.findProgramAddressSync([Buffer.from('fee-vault'), pk(creator).toBuffer(), Buffer.from(seed)], pk(programId))[0];
}
export function feeVaultTokenAccounts(vault, source) {
  return source.mints.map((mint, i) => getAssociatedTokenAddressSync(pk(mint), pk(vault), true, pk(source.tokenPrograms[i])));
}
export function initializeFeeVault({ programId, creator, seed, collection, source, count, totalWeight }) {
  const vault = feeVaultAddress(programId, creator, seed);
  const data = Buffer.concat([Buffer.from([0]), Buffer.from(seed), u16(count), u64(totalWeight), pk(collection).toBuffer(),
    Buffer.from([{ meteora: 0, raydium: 1, 'raydium-devnet': 2 }[source.venue]]),
    ...[source.pool, source.position, source.nativeNftMint, source.tokenPrograms[0], source.mints[0], source.mints[1], source.tokenPrograms[1]].map((v) => pk(v).toBuffer())]);
  return new TransactionInstruction({ programId: pk(programId), keys: [meta(creator, true, true), meta(vault, true), meta(SystemProgram.programId)], data });
}
export function registerFeeShare({ programId, creator, vault, asset, index, weight }) {
  return new TransactionInstruction({ programId: pk(programId), keys: [meta(creator, false, true), meta(vault, true), meta(asset)], data: Buffer.concat([Buffer.from([1]), u16(index), u64(weight)]) });
}
export function activateFeeVault({ programId, creator, vault, source, nativeNftAccount }) {
  return new TransactionInstruction({ programId: pk(programId), keys: [meta(creator, false, true), meta(vault, true),
    ...[source.nativeNftMint, nativeNftAccount, source.position, source.pool, ...source.mints].map((v) => meta(v))], data: Buffer.from([2]) });
}
export function harvestFeeVault({ programId, vault, source, instruction }) {
  const tokens = feeVaultTokenAccounts(vault, source);
  return new TransactionInstruction({ programId: pk(programId), keys: [meta(vault, true), ...tokens.map((v) => meta(v, true)), meta(instruction.programId),
    ...instruction.keys.map((k) => ({ ...k, isSigner: false }))], data: Buffer.from([3]) });
}
export function claimFeeShare({ programId, vault, source, owner, asset, index }) {
  const inputs = feeVaultTokenAccounts(vault, source);
  const outputs = source.mints.map((mint, i) => getAssociatedTokenAddressSync(pk(mint), pk(owner), false, pk(source.tokenPrograms[i])));
  return new TransactionInstruction({ programId: pk(programId), keys: [meta(owner, true, true), meta(vault, true), meta(asset),
    ...inputs.map((v) => meta(v, true)), ...outputs.map((v) => meta(v, true)), ...source.mints.map((v) => meta(v)), ...source.tokenPrograms.map((v) => meta(v))], data: Buffer.concat([Buffer.from([4]), u16(index)]) });
}
export function recoverFeeBacking({ programId, vault, source, creator }) {
  const mint = pk(source.nativeNftMint); const tokenProgram = pk(source.nativeTokenProgram);
  return new TransactionInstruction({ programId: pk(programId), keys: [meta(creator, false, true), meta(vault, true), meta(mint),
    meta(getAssociatedTokenAddressSync(mint, pk(vault), true, tokenProgram), true), meta(getAssociatedTokenAddressSync(mint, pk(creator), false, tokenProgram), true), meta(tokenProgram)], data: Buffer.from([5]) });
}
export function decodeFeeVault(raw) {
  const d = Buffer.from(raw);
  if (d.length < FEE_VAULT_HEADER || d.subarray(0, 8).toString() !== 'TFEEV001') throw new Error('Unknown fee vault account');
  const count = d.readUInt16LE(329);
  if (!count || count > 128 || d.length !== FEE_VAULT_HEADER + count * FEE_VAULT_ENTRY) throw new Error('Invalid fee vault size');
  return {
    creator: addr(d, 8), seed: [...d.subarray(40, 72)], collection: addr(d, 72),
    source: { venue: ['meteora', 'raydium', 'raydium-devnet'][d[104]], pool: addr(d, 105), position: addr(d, 137), nativeNftMint: addr(d, 169), mints: [addr(d, 201), addr(d, 233)], tokenPrograms: [addr(d, 265), addr(d, 297)] },
    count, registered: d.readUInt16LE(331), totalWeight: number(d, 333), registeredWeight: number(d, 341), active: d[349] === 1,
    paid: [number(d, 350), number(d, 358)],
    shares: Array.from({ length: count }, (_, index) => { const at = FEE_VAULT_HEADER + index * FEE_VAULT_ENTRY; return { index, asset: addr(d, at), weight: number(d, at + 32), paid: [number(d, at + 40), number(d, at + 48)] }; }),
  };
}
export function feeEntitlement(received, weight, totalWeight, paid = '0') {
  const [r, w, t, p] = [received, weight, totalWeight, paid].map(BigInt);
  if (r < 0n || w <= 0n || t < w || p < 0n) throw new Error('Invalid fee share');
  const earned = r * w / t;
  if (p > earned) throw new Error('Paid balance exceeds earned fees');
  return (earned - p).toString();
}
