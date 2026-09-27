import test from 'node:test';
import assert from 'node:assert/strict';
import { pickFundingTransfer, collectFundingTransfers, getParsedTransactionAnyVersion, MIN_FUNDING_LAMPORTS } from '../tokenService.js';

const LAUNCH = 'C4TxWRv1NYKDUMuVktT2AZELRj9mMVgyxRSHby458VR2';
const REAL = 'AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j';
const LOOKALIKE = 'AtPVywEPtuj6uuTiCzHr3YG8YB1XsnNKYtszCrXdN54j';
const FRIEND = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

function transfer(signature, source, lamports, { inner = false, err = null } = {}) {
  const instruction = { program: 'system', parsed: { type: 'transfer', info: { source, destination: LAUNCH, lamports } } };
  return {
    signature,
    tx: {
      meta: { err, innerInstructions: inner ? [{ instructions: [instruction] }] : [] },
      transaction: { message: { instructions: inner ? [] : [instruction] } },
    },
  };
}

test('the funder is the earliest real transfer, not a later lookalike dust transfer', () => {
  // The real sequence from the RUGOWEEN launch wallet, oldest first.
  const history = [
    transfer('fund1', REAL, 100_000_000),
    transfer('fund2', REAL, 4_200_000_000),
    transfer('poison', LOOKALIKE, 1),
  ];
  assert.equal(pickFundingTransfer(history, LAUNCH).funder, REAL);
});

test('dust never counts as funding, even when it comes first', () => {
  const history = [transfer('poison', LOOKALIKE, 0), transfer('fund', REAL, 500_000_000)];
  assert.equal(pickFundingTransfer(history, LAUNCH).funder, REAL);
  assert.equal(pickFundingTransfer([transfer('dust', LOOKALIKE, MIN_FUNDING_LAMPORTS - 1)], LAUNCH), null);
});

test('failed transactions are skipped; exchange withdrawals via inner instructions count', () => {
  const history = [
    transfer('failed', LOOKALIKE, 900_000_000, { err: { InstructionError: [0, 'x'] } }),
    transfer('cex', REAL, 300_000_000, { inner: true }),
  ];
  assert.equal(pickFundingTransfer(history, LAUNCH).funder, REAL);
});

test('every funder is listed earliest first with the total each sent', () => {
  const history = [
    transfer('fund1', REAL, 1_000_000_000),
    transfer('friend', FRIEND, 500_000_000, { inner: true }),
    transfer('fund2', REAL, 2_000_000_000),
    transfer('poison', LOOKALIKE, 1),
    transfer('failed', LOOKALIKE, 900_000_000, { err: { InstructionError: [0, 'x'] } }),
  ];
  assert.deepEqual(collectFundingTransfers(history, LAUNCH), [
    { address: REAL, sol: 3, firstSignature: 'fund1', transfers: 2 },
    { address: FRIEND, sol: 0.5, firstSignature: 'friend', transfers: 1 },
  ]);
});

test('funder listing agrees with the trusted single funder', () => {
  const history = [transfer('poison', LOOKALIKE, 0), transfer('fund', REAL, 500_000_000), transfer('late', LOOKALIKE, 20_000_000)];
  const funders = collectFundingTransfers(history, LAUNCH);
  assert.equal(funders[0].address, pickFundingTransfer(history, LAUNCH).funder);
  // A later lookalike above the dust floor is listed, never first.
  assert.equal(funders[1].address, LOOKALIKE);
});

test('version-1 transactions are read as raw parsed JSON instead of failing the lookup', async () => {
  const raw = transfer('v1', REAL, 500_000_000).tx;
  const calls = [];
  const conn = {
    async getParsedTransaction() {
      throw new Error('At path: version -- Expected the value to satisfy a union of `literal | literal`, but received: 1');
    },
    async _rpcRequest(method, args) {
      calls.push([method, args[1]]);
      return { result: { ...raw, version: 1 } };
    },
  };
  const tx = await getParsedTransactionAnyVersion('v1', conn);
  assert.equal(pickFundingTransfer([{ signature: 'v1', tx }], LAUNCH).funder, REAL);
  assert.deepEqual(calls, [['getTransaction', { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]]);
});
