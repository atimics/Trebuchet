import * as walletHelpers from '../../walletHelpers.js';
import { Connection } from '@solana/web3.js';
import { acquireProfileOwner } from '../../packages/runtime/src/owner.js';
import { createWalletExecutionRuntime } from '../../walletExecution.js';
import { sweepWallet, sweepDestination } from '../../packages/runtime/test/fixtures/sol-sweep-chain.mjs';

const [profile, rpcUrl, mode = 'SOL'] = process.argv.slice(2);
const owner = acquireProfileOwner(profile);
try {
  const runtime = createWalletExecutionRuntime({ owner, getScopeId: () => 'journal-a',
    networkForRequest: () => 'devnet', createConnection: () => new Connection(rpcUrl, 'finalized'), timeoutMs: 1000 });
  const input = { tempWalletSecretKey: Array.from(sweepWallet.secretKey), destinationWallet: sweepDestination };
  let result;
  if (mode === 'SOL') result = await runtime.sweepSolToDestination(input);
  else {
    await runtime.recover(input);
    walletHelpers.setConnectionFactoryForTests(() => new Connection(rpcUrl, 'finalized'));
    const helper = mode === 'nft' ? walletHelpers.sweepNftsToDestination : walletHelpers.sweepAllTokensToDestination;
    await helper({ ...input, transferToken: runtime.transferTokenWithProgram });
    result = runtime.getTransferReceipts(sweepWallet.publicKey.toBase58())[0];
  }
  process.stdout.write('RESULT:' + JSON.stringify(result) + '\n');
} finally { owner.release(); }
