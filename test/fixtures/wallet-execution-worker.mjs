import { Connection } from '@solana/web3.js';
import { acquireProfileOwner } from '../../packages/runtime/src/owner.js';
import { createWalletExecutionRuntime } from '../../walletExecution.js';
import { sweepWallet, sweepDestination } from '../../packages/runtime/test/fixtures/sol-sweep-chain.mjs';

const [profile, rpcUrl] = process.argv.slice(2);
const owner = acquireProfileOwner(profile);
try {
  const runtime = createWalletExecutionRuntime({ owner, getScopeId: () => 'journal-a',
    networkForRequest: () => 'devnet', createConnection: () => new Connection(rpcUrl, 'finalized'), timeoutMs: 1000 });
  const result = await runtime.sweepSolToDestination({ tempWalletSecretKey: Array.from(sweepWallet.secretKey), destinationWallet: sweepDestination });
  process.stdout.write('RESULT:' + JSON.stringify(result) + '\n');
} finally { owner.release(); }
