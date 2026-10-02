import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { Keypair, PublicKey, SystemProgram, SystemInstruction, Transaction, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, MintLayout, AccountLayout, ExtensionType, getAssociatedTokenAddressSync,
  decodeInitializeMint2Instruction, decodeMintToInstruction, decodeSetAuthorityInstruction } from '@solana/spl-token';
import { pack } from '@solana/spl-token-metadata';
import { getMetadataAccountDataSerializer, getCreateMetadataAccountV3InstructionDataSerializer, TokenStandard } from '@metaplex-foundation/mpl-token-metadata';
import { some, none } from '@metaplex-foundation/umi';
import { solSweepChain, sweepWallet } from './sol-sweep-chain.mjs';
import { inspectSolanaTransaction } from '../../src/solana.js';
import { metadataAddress, METADATA_PROGRAM_ID } from '../../src/metadata-update.js';
export { sweepWallet };
export const mintSigner = Keypair.fromSeed(new Uint8Array(32).fill(77));
const zero = SystemProgram.programId;
const tlv = (type, data) => { const header = Buffer.alloc(4); header.writeUInt16LE(type); header.writeUInt16LE(data.length, 2); return Buffer.concat([header, data]); };

export function tokenCreationChain({ inline = false } = {}) {
  const ledger = solSweepChain(), { state, connection } = ledger;
  const mint = mintSigner.publicKey, wallet = sweepWallet.publicKey, program = inline ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const ata = getAssociatedTokenAddressSync(mint, wallet, false, program), pda = metadataAddress(mint);
  const rent = (size) => (128 + size) * 6960;
  Object.assign(state, { balance: 100000000, fee: 25000, mintExists: false, initialized: false, mintAuthority: wallet, freezeAuthority: null,
    decimals: 9, supply: 0n, holdingExists: false, holdingAmount: 0n, metadata: null, mintLamports: 0, holdingLamports: 0, metadataLamports: 0,
    pointer: false, accountSlot: state.slot, accountTransform: (value) => value });
  const mintData = () => {
    const data = Buffer.alloc(82);
    MintLayout.encode({ mintAuthorityOption: state.mintAuthority ? 1 : 0, mintAuthority: state.mintAuthority || zero, supply: state.supply,
      decimals: state.decimals, isInitialized: state.initialized, freezeAuthorityOption: state.freezeAuthority ? 1 : 0, freezeAuthority: state.freezeAuthority || zero }, data);
    if (!inline) return data;
    const extensions = [];
    if (state.pointer) extensions.push(tlv(ExtensionType.MetadataPointer, Buffer.concat([Buffer.alloc(32), mint.toBuffer()])));
    if (state.metadata) extensions.push(tlv(ExtensionType.TokenMetadata, Buffer.from(pack({ mint, updateAuthority: wallet,
      name: state.metadata.name, symbol: state.metadata.symbol, uri: state.metadata.uri, additionalMetadata: state.metadata.hash ? [['trebuchet:sha256', state.metadata.hash]] : [] }))));
    return Buffer.concat([data, Buffer.alloc(165 - 82), Buffer.from([1]), ...extensions]);
  };
  const holdingData = () => {
    const data = Buffer.alloc(165);
    AccountLayout.encode({ mint, owner: wallet, amount: state.holdingAmount, delegateOption: 0, delegate: zero, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: zero }, data);
    return inline ? Buffer.concat([data, Buffer.from([2]), tlv(ExtensionType.ImmutableOwner, Buffer.alloc(0))]) : data;
  };
  const classicData = () => {
    const data = Buffer.alloc(679);
    const bytes = getMetadataAccountDataSerializer().serialize({ mint: mint.toBase58(), updateAuthority: wallet.toBase58(), ...state.metadata,
      name: state.metadata.name.padEnd(32, '\0'), symbol: state.metadata.symbol.padEnd(10, '\0'), uri: state.metadata.uri.padEnd(200, '\0'),
      sellerFeeBasisPoints: 0, creators: some([{ address: wallet.toBase58(), verified: true, share: 100 }]), primarySaleHappened: false, isMutable: true,
      editionNonce: none(), tokenStandard: some(TokenStandard.Fungible), collection: none(), uses: none(), collectionDetails: none(), programmableConfig: none() });
    data.set(bytes); return data;
  };
  const info = (owner, lamports, data) => ({ owner, lamports, data, executable: false, rentEpoch: 0 });
  const accountInfo = (address) => {
    if (address.equals(wallet)) return info(SystemProgram.programId, state.balance, Buffer.alloc(0));
    if (address.equals(mint)) return state.mintExists ? info(program, state.mintLamports, mintData()) : null;
    if (address.equals(ata)) return state.holdingExists ? info(program, state.holdingLamports, holdingData()) : null;
    if (address.equals(pda)) return !inline && state.metadata ? info(METADATA_PROGRAM_ID, state.metadataLamports, classicData()) : null;
    return null;
  };
  const balances = (keys) => state.holdingExists ? [{ accountIndex: keys.findIndex((value) => value.equals(ata)), mint: mint.toBase58(), owner: wallet.toBase58(), programId: program.toBase58(),
    uiTokenAmount: { amount: state.holdingAmount.toString(), decimals: state.decimals, uiAmount: null } }].filter((value) => value.accountIndex >= 0) : [];
  connection.getMultipleAccountsInfoAndContext = async (keys) => ({ context: { slot: state.accountSlot }, value: keys.map((address) => state.accountTransform(accountInfo(address), address)) });
  connection.getMinimumBalanceForRentExemption = async (size) => rent(size);
  connection.sendRawTransaction = async (bytes) => {
    const inspected = inspectSolanaTransaction(bytes); await state.beforeSend?.(inspected); state.sends.push(inspected);
    if (!state.receipts.has(inspected.signature)) {
      const wire = VersionedTransaction.deserialize(bytes), tx = Transaction.from(bytes), message = wire.message, keys = message.staticAccountKeys;
      const preBalances = keys.map((address) => accountInfo(address)?.lamports || 0), preTokenBalances = balances(keys);
      for (const ix of tx.instructions.slice(2)) {
        if (ix.programId.equals(SystemProgram.programId)) {
          if (SystemInstruction.decodeInstructionType(ix) === 'Create') {
            const value = SystemInstruction.decodeCreateAccount(ix);
            assert.equal(value.newAccountPubkey.toBase58(), mint.toBase58()); assert.equal(state.mintExists, false);
            assert.ok(value.programId.equals(program)); state.mintExists = true; state.mintLamports = value.lamports; state.balance -= value.lamports;
          } else {
            const value = SystemInstruction.decodeTransfer(ix); assert.ok(value.toPubkey.equals(mint));
            state.balance -= Number(value.lamports); state.mintLamports += Number(value.lamports);
          }
        } else if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
          assert.ok(ix.keys[1].pubkey.equals(ata));
          if (!state.holdingExists) { state.holdingExists = true; state.holdingLamports = rent(inline ? 170 : 165); state.balance -= state.holdingLamports; }
        } else if (ix.programId.equals(METADATA_PROGRAM_ID)) {
          const [value] = getCreateMetadataAccountV3InstructionDataSerializer().deserialize(ix.data);
          assert.equal(state.metadata, null); state.metadata = value.data; state.metadataLamports = rent(679); state.balance -= state.metadataLamports;
        } else {
          assert.ok(ix.programId.equals(program));
          if (ix.data[0] === 20) {
            const value = decodeInitializeMint2Instruction(ix, program);
            state.initialized = true; state.decimals = value.data.decimals; state.mintAuthority = value.data.mintAuthority; state.freezeAuthority = value.data.freezeAuthority;
          } else if (ix.data[0] === 39) { assert.equal(ix.data[1], 0); state.pointer = true; }
          else if (ix.data[0] === 7) {
            const value = decodeMintToInstruction(ix, program); assert.ok(state.mintAuthority?.equals(wallet));
            state.supply += value.data.amount; state.holdingAmount += value.data.amount;
          } else if (ix.data[0] === 6) { const value = decodeSetAuthorityInstruction(ix, program); assert.ok(state.mintAuthority?.equals(wallet)); state.mintAuthority = value.data.newAuthority; }
          else {
            let cursor = 8;
            const string = () => { const length = ix.data.readUInt32LE(cursor); cursor += 4; const value = ix.data.subarray(cursor, cursor + length).toString(); cursor += length; return value; };
            if (ix.data[0] === 210) { assert.equal(state.metadata, null); state.metadata = { name: string(), symbol: string(), uri: string() }; }
            else { assert.equal(ix.data[0], 221); assert.equal(ix.data[cursor++], 3); assert.equal(string(), 'trebuchet:sha256'); state.metadata.hash = string(); }
          }
        }
      }
      state.balance -= state.fee;
      assert.ok(state.balance >= 0);
      state.receipts.set(inspected.signature, { slot: state.slot, blockTime: 1700000000, transaction: { message, signatures: wire.signatures.map((signature) => bs58.encode(signature)) },
        meta: { err: null, fee: state.fee, preBalances, postBalances: keys.map((address) => accountInfo(address)?.lamports || 0), preTokenBalances, postTokenBalances: balances(keys) } });
    }
    await state.afterSend?.(inspected); return inspected.signature;
  };
  const plan = { mint: mint.toBase58(), programId: program.toBase58(), decimals: 9, supplyRaw: '1000000000000', metadata: { name: 'Engine Token', symbol: 'ENG', uri: 'https://example.invalid/token.json', hash: 'c'.repeat(64) } };
  return { ...ledger, mint, ata, pda, program, accountInfo, plan, rent };
}
