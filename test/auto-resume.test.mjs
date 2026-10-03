import test from 'node:test';
import assert from 'node:assert/strict';
import { withAutoResume, isTransientLaunchError, autoResumingLaunchServices } from '../autoResume.js';

const quiet = { warn() {} };
const recovery = (causeCode, message = 'x') => Object.assign(new Error('wrapped'), { code: 'EXECUTION_RECOVERY_REQUIRED', errorDetails: { code: causeCode, message } });

test('an interrupted step runs again on its own until it completes', async () => {
  let runs = 0;
  const result = await withAutoResume(async () => { if (++runs < 3) throw recovery('CHAIN_STATE_UNAVAILABLE'); return 'done'; }, { sleep: async () => {}, log: quiet });
  assert.equal(result, 'done'); assert.equal(runs, 3);
});

test('a cause another run cannot change stops at once', async () => {
  for (const code of ['INSUFFICIENT_FUNDS', 'EXECUTION_APPROVAL_REQUIRED', 'NETWORK_MISMATCH', 'TRANSACTION_FAILED', 'TOKEN_PROGRAM_MISMATCH', 'INVALID_INPUT']) {
    let runs = 0;
    await assert.rejects(withAutoResume(async () => { runs++; throw recovery(code); }, { sleep: async () => {}, log: quiet }));
    assert.equal(runs, 1, code);
  }
  assert.equal(isTransientLaunchError(Object.assign(new Error('Bad input'), { statusCode: 400 })), false);
  // A wallet held by an earlier step refuses the request before it starts; a failed step names its cause.
  const refused = Object.assign(new Error('An earlier SOL transfer is not confirmed yet'), { statusCode: 409, code: 'EXECUTION_RECOVERY_REQUIRED', payload: { code: 'EXECUTION_RECOVERY_REQUIRED', operationId: 'op-a' } });
  assert.equal(isTransientLaunchError(refused), false);
  assert.equal(isTransientLaunchError(Object.assign(new Error('Use the saved airdrop token and recipient amounts'), { statusCode: 409, code: 'EXECUTION_RECOVERY_REQUIRED' })), false);
  const interrupted = Object.assign(new Error('A pool step could not be confirmed'), { statusCode: 409, code: 'EXECUTION_RECOVERY_REQUIRED', payload: { code: 'EXECUTION_RECOVERY_REQUIRED', errorDetails: { code: 'CHAIN_STATE_UNAVAILABLE' } } });
  assert.equal(isTransientLaunchError(interrupted), true);
  assert.equal(isTransientLaunchError(Object.assign(new Error('Verify the saved airdrop receipt', { cause: new Error('fetch failed') }), { code: 'EXECUTION_RECOVERY_REQUIRED' })), true);
});

test('rate limits and lagging nodes count as passing; retries are bounded', async () => {
  assert.ok(isTransientLaunchError(new Error('429 Too Many Requests')));
  assert.ok(isTransientLaunchError(new Error('failed: Minimum context slot has not been reached')));
  let runs = 0;
  await assert.rejects(withAutoResume(async () => { runs++; throw recovery('EXECUTION_INTERRUPTED'); }, { attempts: 4, sleep: async () => {}, log: quiet }));
  assert.equal(runs, 4);
});

test('token creation is never run again automatically', async () => {
  let creates = 0, sweeps = 0;
  const services = autoResumingLaunchServices({
    createToken: async () => { creates++; throw recovery('CHAIN_STATE_UNAVAILABLE'); },
    transferAssets: async () => { if (++sweeps < 2) throw recovery('CHAIN_STATE_UNAVAILABLE'); return 'swept'; },
    finishToken() {}, revealMetadata() {}, createLiquidity() {}, resumeLiquidity() {}, runAirdrop() {},
  }, { sleep: async () => {}, log: quiet });
  await assert.rejects(services.createToken()); assert.equal(creates, 1);
  assert.equal(await services.transferAssets(), 'swept'); assert.equal(sweeps, 2);
});
