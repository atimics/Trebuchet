import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { LockClPositionLayoutV2, PositionInfoLayout, getPdaPersonalPositionAddress, getPdaLockClPositionIdV2 } from '@raydium-io/raydium-sdk-v2';
import { clmmLockPrograms, findClmmPositionLock, decodeClmmLock } from '../clmmLockEvidence.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/rugoween-locks.json', import.meta.url)));
const info = (account) => ({ ...account, owner: new PublicKey(account.owner), data: Buffer.from(account.data[0], 'base64') });

function setup(network = 'mainnet') {
  const programs = clmmLockPrograms(network);
  const position = info(fixture.positions[0]);
  position.owner = programs.poolProgramId;
  const decodedPosition = PositionInfoLayout.decode(position.data);
  const nftMint = decodedPosition.nftMint.toBase58();
  const positionId = getPdaPersonalPositionAddress(programs.poolProgramId, decodedPosition.nftMint).publicKey;
  const account = info(fixture.locks[0].account);
  account.owner = programs.programId;
  positionId.toBuffer().copy(account.data, LockClPositionLayoutV2.offsetOf('positionId'));
  const decodedLock = LockClPositionLayoutV2.decode(account.data);
  const pubkey = getPdaLockClPositionIdV2(programs.programId, decodedLock.lockNftMint).publicKey;
  const calls = [];
  const connection = {
    async getAccountInfo(address, commitment) {
      assert.equal(address.toBase58(), positionId.toBase58());
      assert.equal(commitment, 'finalized');
      return position;
    },
    async getProgramAccounts(program, options) {
      calls.push({ program, options });
      return [{ pubkey, account }];
    },
  };
  return { programs, position, account, pubkey, decodedLock, nftMint, positionId, calls, connection };
}

for (const network of ['mainnet', 'devnet']) {
  test(`recovery finds a landed ${network} lock through its position account`, async () => {
    const s = setup(network);
    const lock = await findClmmPositionLock(s.connection, s.nftMint, network);
    assert.equal(lock.feeKeyMint, s.decodedLock.lockNftMint.toBase58());
    assert.equal(lock.positionId, s.positionId.toBase58());
    assert.equal(s.calls[0].program.toBase58(), s.programs.programId.toBase58());
    assert.equal(s.calls[0].options.filters[1].memcmp.bytes, s.positionId.toBase58());
    assert.notEqual(s.calls[0].options.filters[1].memcmp.bytes, s.nftMint);
  });
}

test('the public RUGOWEEN fixture resolves the exact mainnet lock and Fee Key', async () => {
  const s = setup();
  assert.equal(s.pubkey.toBase58(), fixture.locks[0].pubkey);
  const lock = await findClmmPositionLock(s.connection, s.nftMint);
  assert.equal(lock.address, '9Ed6m2hwTHkMyPJgeqS3Mc7JuiKZXUC21HTFrh1XtesA');
  assert.equal(lock.feeKeyMint, 'GrUWbqKcLtEScJivLSXaZbapB5ARSpiKCgR2ad9QDJbM');
});

test('absent, mismatched and foreign accounts stay unresolved', async () => {
  const s = setup();
  assert.equal(await findClmmPositionLock({ ...s.connection, getAccountInfo: async () => null }, s.nftMint), null);
  assert.equal(await findClmmPositionLock({ ...s.connection, getProgramAccounts: async () => [] }, s.nftMint), null);
  s.account.owner = PublicKey.default;
  assert.equal(await findClmmPositionLock(s.connection, s.nftMint), null);
  s.account.owner = s.programs.programId;
  PublicKey.default.toBuffer().copy(s.account.data, LockClPositionLayoutV2.offsetOf('poolId'));
  assert.equal(await findClmmPositionLock(s.connection, s.nftMint), null);
});

test('a forged lock account address and a failed RPC preserve the recovery error', async () => {
  const s = setup();
  assert.equal(decodeClmmLock({ pubkey: PublicKey.default, account: s.account }), null);
  await assert.rejects(findClmmPositionLock({ ...s.connection, getProgramAccounts: async () => { throw new Error('RPC timeout'); } }, s.nftMint), /RPC timeout/);
});
