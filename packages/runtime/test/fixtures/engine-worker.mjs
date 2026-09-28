import { Connection, Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { ExecutionEngine } from '../../src/engine.js';
import { createSolanaChain, createSolanaSigner } from '../../src/solana.js';
import { acquireProfileOwner } from '../../src/owner.js';
import { openRuntimeStore } from '../../src/store.js';

const [profile, rpcUrl] = process.argv.slice(2);
const owner = acquireProfileOwner(profile);
const store = openRuntimeStore(profile);
const wallet = Keypair.fromSeed(new Uint8Array(32).fill(7));
const recipient = Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey;
const connection = new Connection(rpcUrl, 'finalized');
const engine = new ExecutionEngine({
  owner, store,
  signer: createSolanaSigner({ getSigners: async () => [wallet] }),
  chain: createSolanaChain({ connection, network: 'localnet', expectedGenesisHash: 'fixture-genesis' }),
  authorize: async () => true,
  operations: { transfer: {
    async checkState({ minContextSlot }) {
      const result = await connection.getBalanceAndContext(recipient, { commitment: 'finalized', minContextSlot });
      return { state: result.value === 3 ? 'complete' : 'ready', evidence: { recipient: recipient.toBase58(), balance: result.value, slot: result.context.slot } };
    },
    async buildTransaction() {
      const expiry = await connection.getLatestBlockhash('finalized');
      return { ...expiry, transaction: new Transaction({ feePayer: wallet.publicKey, recentBlockhash: expiry.blockhash }).add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: recipient, lamports: 3 })) };
    },
  } },
});
try {
  const operation = engine.prepare({ launch: { id: 'crash-launch', walletPublicKey: wallet.publicKey.toBase58(), network: 'localnet', planDigest: 'a'.repeat(64), config: { recipient: recipient.toBase58() } }, kind: 'transfer', payload: { amountLamports: '3' } });
  const result = await engine.resume(operation.id);
  process.stdout.write(JSON.stringify(result) + '\n');
} finally { owner.release(); store.close(); }
