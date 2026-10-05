// Browser checks for review, saved form input and wallet-held claims.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { claimFeeShare } from '../../feeVaultClient.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fee-ui-'));
const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), TREBUCHET_CONFIG_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
const addr = () => Keypair.generate().publicKey.toBase58();
const creator = addr(); const holder = addr(); const programId = addr();
const sample = JSON.parse(fs.readFileSync('docs/airdrop-lists/sample.json'));
const source = { venue: 'meteora', pool: addr(), position: addr(), nativeNftMint: addr(), nativeTokenProgram: TOKEN_PROGRAM_ID.toBase58(), mints: [addr(), addr()], tokenPrograms: [TOKEN_PROGRAM_ID.toBase58(), TOKEN_PROGRAM_ID.toBase58()], decimals: [6, 9] };
const shares = sample.wallets.map((recipient, index) => ({ index, name: `Brand #${index + 1}`, asset: addr(), recipient, weight: '1' }));
const record = { id: 'fee_ui', vault: addr(), status: 'draft', estimate: { totalLamports: 30_000_000 }, operations: {}, plan: { collection: addr(), name: 'Brand fees', creator, source, digest: 'reviewed', count: 54, shares, transferRule: 'The current NFT owner receives its unclaimed fees. Paid amounts stay with the NFT.' } };
let detail = record; let claims = 0;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/v2/`)).ok) break; } catch {}
    assert.ok(i < 120, log.slice(-1000)); await new Promise((r) => setTimeout(r, 250));
  }
  await page.addInitScript(({ holder }) => {
    const account = { address: holder, chains: ['solana:devnet'], features: ['solana:signAndSendTransaction'] };
    const wallet = { name: 'Test wallet', accounts: [account], features: {
      'standard:connect': { connect: async () => ({ accounts: [account] }) },
      'solana:signAndSendTransaction': { signAndSendTransaction: async (input) => { window.feeWalletProposal = { address: input.account.address, chain: input.chain, bytes: [...input.transaction] }; return [{ signature: new Uint8Array(64) }]; } },
    } };
    window.addEventListener('wallet-standard:app-ready', (e) => e.detail.register(wallet));
  }, { holder });
  await page.route(/\/api\/v2\/wallets$/, (r) => r.fulfill({ json: { success: true, wallets: [{ publicKey: creator, label: 'Creator', hasSecretKey: true }] } }));
  await page.route(/\/api\/v2\/fee-nfts(?:\/.*)?$/, async (r) => {
    const u = new URL(r.request().url());
    if (u.pathname.endsWith('/prepare')) return r.fulfill({ status: 409, json: { success: false, error: 'Choose a permanently locked Meteora position' } });
    if (u.pathname.endsWith('/prepare-claim')) {
      const body = r.request().postDataJSON(); claims++; assert.equal(body.walletPublicKey, holder);
      const tx = new Transaction({ feePayer: new PublicKey(holder), recentBlockhash: addr() });
      tx.add(claimFeeShare({ programId, vault: record.vault, collection: record.plan.collection, source, owner: holder, asset: shares[0].asset, index: 0 }));
      return r.fulfill({ json: { success: true, transaction: tx.serialize({ requireAllSignatures: false }).toString('base64'), chain: 'solana:devnet', maxDebitLamports: 5000 } });
    }
    if (u.pathname.endsWith('/fee_ui')) return r.fulfill({ json: { success: true, vault: detail } });
    return r.fulfill({ json: { success: true, programId, sample, collections: [{ id: 'brand', name: 'Brand fees', count: 54, minted: 54 }], vaults: [detail] } });
  });
  await page.goto(`http://127.0.0.1:${port}/v2/`);
  await page.click('.nav-item[data-view="fee-nfts"]');
  await page.waitForSelector('#feeRecipients');
  assert.equal((await page.inputValue('#feeRecipients')).split('\n').length, 54);
  await page.selectOption('#feeCollection', 'brand'); await page.fill('#feeBacking', source.nativeNftMint);
  await page.click('[data-fee-action="prepare"]');
  await page.getByRole('alert').filter({ hasText: 'permanently locked' }).waitFor();
  assert.equal(await page.inputValue('#feeBacking'), source.nativeNftMint);
  assert.equal(await page.inputValue('#feeCollection'), 'brand');
  console.log('PASS: 54-wallet sample and prepared inputs survive a source error');

  await page.selectOption('#feeSaved', 'fee_ui'); await page.waitForSelector('#feeApprove');
  assert.match(await page.textContent('#feeNftRoot'), /1\/54/);
  await page.click('[data-fee-action="run"]');
  await page.getByRole('alert').filter({ hasText: 'Approve the NFT shares' }).waitFor();
  console.log('PASS: setup requires review of backing and fixed shares');
  detail = { ...record, status: 'active', onChain: { active: true, shares: shares.map((s, i) => ({ ...s, owner: i === 0 ? holder : s.recipient, claimable: ['1200000', '22000000'] })) } };
  await page.click('[data-fee-action="refresh"]'); await page.waitForSelector('#feeActionCap');
  await page.click('[data-fee-action="connect"]'); await page.waitForSelector('[data-fee-action="claim"]');
  await page.click('[data-fee-action="claim"]'); await page.waitForFunction(() => Boolean(window.feeWalletProposal));
  const proposal = await page.evaluate(() => window.feeWalletProposal);
  assert.equal(proposal.address, holder); assert.equal(proposal.chain, 'solana:devnet'); assert.equal(claims, 1);
  assert.equal(Transaction.from(Buffer.from(proposal.bytes)).signatures[0].signature, null);
  console.log('PASS: external holder wallet receives the unsigned claim');

  const shots = process.env.TREBUCHET_FEE_UI_SHOTS || path.join(dir, 'screens'); fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, 'desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: path.join(shots, 'phone.png') });
  await page.locator('[data-fee-action="claim"]').scrollIntoViewIfNeeded();
  const claimBox = await page.locator('[data-fee-action="claim"]').boundingBox();
  assert.ok(claimBox.x >= 0 && claimBox.x + claimBox.width <= 390 && claimBox.y >= 0 && claimBox.y + claimBox.height <= 774, JSON.stringify(claimBox));
  await page.screenshot({ path: path.join(shots, 'phone-claim.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: desktop and 390px holder view, with no page errors or page overflow');
} finally {
  await browser.close(); server.kill('SIGTERM'); fs.rmSync(dir, { recursive: true, force: true });
}
