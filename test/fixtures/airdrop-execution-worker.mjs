import { Connection } from '@solana/web3.js';
import { acquireProfileOwner } from '../../packages/runtime/src/owner.js';
import { airdropContext, airdropInput } from './airdrop-chain.mjs';
const [profile, rpcUrl] = process.argv.slice(2);
const owner = acquireProfileOwner(profile);
try {
  const host = airdropContext({ owner, connection: new Connection(rpcUrl, 'finalized') });
  const result = await host.runtime.execute(airdropInput);
  process.stdout.write('RESULT:' + JSON.stringify(result) + '\n');
} finally { owner.release(); }
