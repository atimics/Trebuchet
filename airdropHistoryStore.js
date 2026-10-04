// airdropHistoryStore.js
//
// What each airdrop wallet has done with a coin, as read from the chain so far,
// kept on disk so a page load reads only what is new. Per mint and wallet: running
// totals (burned, sold, bought, sent, got), the newest transaction read on each of
// the wallet's token accounts, and the balance the totals explain.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_MINTS = 200;

function filePath() {
  return path.join(process.env.TREBUCHET_CONFIG_DIR || __dirname, 'airdropHistory.json');
}

function load() {
  try {
    const file = filePath();
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    console.warn(`airdropHistoryStore: failed to read, starting empty: ${error.message}`);
    return {};
  }
}

function persist(all) {
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const kept = Object.entries(all)
    .sort(([, a], [, b]) => String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')))
    .slice(0, MAX_MINTS);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(kept), null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** The saved history for a mint's airdrop wallets, keyed by wallet. Empty when none is saved. */
export function get(mint) {
  const entry = load()[mint];
  return entry?.wallets && typeof entry.wallets === 'object' ? JSON.parse(JSON.stringify(entry.wallets)) : {};
}

/** Save these wallets' history for a mint, keeping the others already saved. */
export function save(mint, wallets) {
  if (!mint || !wallets || !Object.keys(wallets).length) return;
  const all = load();
  all[mint] = { updatedAt: new Date().toISOString(), wallets: { ...(all[mint]?.wallets || {}), ...wallets } };
  persist(all);
}
