import { Connection } from '@solana/web3.js';
import { acquireProfileOwner } from '../../packages/runtime/src/owner.js';
import { createProfileJournalStore } from '../../packages/runtime/src/profile-stores.js';
import { createLiquidityExecutionRuntime } from '../../liquidityExecution.js';
import { buildLiquiditySdk, sweepWallet, plan, actionFor, actionKey } from './liquidity-chain.mjs';
const [profile, rpcUrl, mode] = process.argv.slice(2);
const owner = acquireProfileOwner(profile), journal = createProfileJournalStore(profile);
try {
  const walletPublicKey = sweepWallet.publicKey.toBase58();
  if (!journal.activeForWallet(walletPublicKey)) journal.start({ walletPublicKey });
  const connection = new Connection(rpcUrl, 'finalized');
  const runtime = createLiquidityExecutionRuntime({ owner, getScopeId: (wallet) => journal.activeForWallet(wallet)?.id,
    recordProgress: (wallet, event) => journal.recordEvent(wallet, event),
    createConnection: () => connection, networkForRequest: () => 'mainnet', timeoutMs: 1000 });
  const input = { ...plan, tempWalletSecretKey: Array.from(sweepWallet.secretKey) };
  await runtime.recover(input);
  const result = await runtime.forLaunch(input).execute({ key: actionKey(mode), action: actionFor(mode), build: (options) => buildLiquiditySdk(mode, connection, options) });
  process.stdout.write('RESULT:' + JSON.stringify(result.value.saved) + '\n');
} finally { owner.release(); }
