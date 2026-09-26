import test from 'node:test';
import assert from 'node:assert/strict';
import { pickFundingTransfer, MIN_FUNDING_LAMPORTS } from '../tokenService.js';

const LAUNCH = 'C4TxWRv1NYKDUMuVktT2AZELRj9mMVgyxRSHby458VR2';
const REAL = 'AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j';
const LOOKALIKE = 'AtPVywEPtuj6uuTiCzHr3YG8YB1XsnNKYtszCrXdN54j';

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
