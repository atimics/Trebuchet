import assert from 'node:assert/strict';
import { Keypair, PublicKey, SystemInstruction, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, MintLayout, ExtensionType } from '@solana/spl-token';
import { pack } from '@solana/spl-token-metadata';
import { getMetadataAccountDataSerializer, getUpdateV1InstructionDataSerializer, TokenStandard } from '@metaplex-foundation/mpl-token-metadata';
import { none, some } from '@metaplex-foundation/umi';
import { metadataAddress, METADATA_PROGRAM_ID } from '../../src/metadata-update.js';
import { inspectSolanaTransaction } from '../../src/solana.js';
import { solSweepChain, sweepWallet, sweepDestination } from './sol-sweep-chain.mjs';

export { sweepWallet, sweepDestination };
export const metadataMint = Keypair.fromSeed(new Uint8Array(32).fill(36)).publicKey;
export const metadataRevealFields = { name: 'Final Token', symbol: 'FINAL', uri: 'https://example.invalid/' + 'm'.repeat(120), 'trebuchet:sha256': 'b'.repeat(64) };
const tlv = (type, bytes) => {
  const header = Buffer.alloc(4); header.writeUInt16LE(type); header.writeUInt16LE(bytes.length, 2);
  return Buffer.concat([header, bytes]);
};
export function metadataChain({ inline = false } = {}) {
  const ledger = solSweepChain(), { state, connection } = ledger;
  const mint = metadataMint;
  const pda = metadataAddress(mint), account = inline ? mint : pda;
  Object.assign(state, { fee: 20000, authority: sweepWallet.publicKey.toBase58(), name: 'Sealed token', symbol: 'SEALED', uri: 'https://example.invalid/placeholder.json',
    additionalMetadata: [['trebuchet:sha256', 'a'.repeat(64)]], mutable: true, accountSlot: state.slot, accountOwner: METADATA_PROGRAM_ID, metadataMint: mint,
    sellerFeeBasisPoints: 0, creators: some([{ address: sweepWallet.publicKey.toBase58(), verified: true, share: 100 }]),
  });
  const inlineData = () => Buffer.from(pack({ mint: state.metadataMint, updateAuthority: state.authority === SystemProgram.programId.toBase58() ? undefined : new PublicKey(state.authority), name: state.name, symbol: state.symbol, uri: state.uri, additionalMetadata: state.additionalMetadata }));
  const mintData = () => {
    const base = Buffer.alloc(82);
    MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: SystemProgram.programId, supply: 1000000000n, decimals: 9, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: SystemProgram.programId }, base);
    if (!inline) return base;
    const pointer = Buffer.concat([Buffer.alloc(32), mint.toBuffer()]);
    return Buffer.concat([base, Buffer.alloc(165 - 82), Buffer.from([1]), tlv(ExtensionType.MetadataPointer, pointer), tlv(ExtensionType.TokenMetadata, inlineData())]);
  };
  const classicData = () => {
    const bytes = getMetadataAccountDataSerializer().serialize({
      updateAuthority: state.authority, mint: state.metadataMint.toBase58(), name: state.name.padEnd(32, '\0'), symbol: state.symbol.padEnd(10, '\0'), uri: state.uri.padEnd(200, '\0'),
      sellerFeeBasisPoints: state.sellerFeeBasisPoints, creators: state.creators, primarySaleHappened: false, isMutable: state.mutable,
      editionNonce: none(), tokenStandard: some(TokenStandard.Fungible), collection: none(), uses: none(), collectionDetails: none(), programmableConfig: none(),
    });
    const data = Buffer.alloc(679); data.set(bytes); return data;
  };
  state.mintLamports = (128 + mintData().length) * 6960;
  const accountInfo = (key) => {
    const base = { executable: false, rentEpoch: 0 };
    if (key.equals(sweepWallet.publicKey)) return { ...base, owner: SystemProgram.programId, lamports: state.balance, data: Buffer.alloc(0) };
    if (key.equals(mint)) return { ...base, owner: inline ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID, lamports: state.mintLamports, data: mintData() };
    if (!inline && key.equals(pda)) return { ...base, owner: state.accountOwner, lamports: (128 + 679) * 6960, data: classicData() };
    return null;
  };
  connection.getMultipleAccountsInfoAndContext = async (keys) => ({ context: { slot: state.accountSlot }, value: keys.map(accountInfo) });
  connection.getMinimumBalanceForRentExemption = async (size) => (128 + size) * 6960;
  connection.sendRawTransaction = async (bytes) => {
    const inspected = inspectSolanaTransaction(bytes);
    await state.beforeSend?.(inspected);
    state.sends.push(inspected);
    if (!state.receipts.has(inspected.signature)) {
      const tx = Transaction.from(bytes), message = VersionedTransaction.deserialize(bytes).message;
      const keys = message.staticAccountKeys;
      const preBalances = keys.map((key) => accountInfo(key)?.lamports || 0);
      for (const ix of tx.instructions.slice(2)) {
        if (ix.programId.equals(SystemProgram.programId)) {
          const transfer = SystemInstruction.decodeTransfer(ix);
          assert.equal(transfer.toPubkey.toBase58(), mint.toBase58());
          state.balance -= Number(transfer.lamports); state.mintLamports += Number(transfer.lamports);
        } else if (ix.programId.equals(METADATA_PROGRAM_ID)) {
          const [update] = getUpdateV1InstructionDataSerializer().deserialize(ix.data);
          if (update.newUpdateAuthority.__option === 'Some') state.authority = update.newUpdateAuthority.value;
          if (update.data.__option === 'Some') Object.assign(state, update.data.value);
          if (update.isMutable.__option === 'Some') state.mutable = update.isMutable.value;
        } else {
          assert.equal(ix.programId.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
          if (ix.data[0] === 215) state.authority = new PublicKey(ix.data.subarray(8, 40)).toBase58();
          else {
            assert.equal(ix.data[0], 221);
            let cursor = 9;
            const string = () => { const size = ix.data.readUInt32LE(cursor); cursor += 4; const text = ix.data.subarray(cursor, cursor + size).toString(); cursor += size; return text; };
            const field = ix.data[8] === 3 ? string() : ['name', 'symbol', 'uri'][ix.data[8]];
            const value = string();
            if (['name', 'symbol', 'uri'].includes(field)) state[field] = value;
            else {
              const prior = state.additionalMetadata.find((entry) => entry[0] === field);
              if (prior) prior[1] = value; else state.additionalMetadata.push([field, value]);
            }
          }
        }
      }
      state.balance -= state.fee;
      const postBalances = keys.map((key) => accountInfo(key)?.lamports || 0);
      state.receipts.set(inspected.signature, { slot: state.slot, blockTime: 1700000000,
        transaction: { message, signatures: [inspected.signature] }, meta: { err: null, fee: state.fee, preBalances, postBalances } });
    }
    await state.afterSend?.(inspected);
    return inspected.signature;
  };
  return { ...ledger, mint, account, accountInfo };
}
