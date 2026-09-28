// coinStore.js
//
// Coins added by address (launched elsewhere, or before this app kept
// records) and every coin's activity log. Drafts live in launchStore and
// launches in launchJournal; this only holds what neither records.
//
// Activity entries are events, not steps: each records one operation and
// how it ended ("landed", "failed", "unknown"). An "unknown" outcome means
// read the chain again, never assume it worked.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_COINS = 500;
const MAX_EVENTS_PER_COIN = 200;

function filePath() {
  return path.join(process.env.TREBUCHET_CONFIG_DIR || __dirname, 'coins.json');
}

function load() {
  try {
    const file = filePath();
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((coin) => coin && typeof coin.mint === 'string') : [];
  } catch (error) {
    console.warn(`coinStore: failed to read, treating as empty: ${error.message}`);
    return [];
  }
}

function persist(list) {
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(list.slice(-MAX_COINS), null, 2)}\n`);
  fs.renameSync(tmp, file);
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const nowIso = () => new Date().toISOString();

export function list() {
  return clone(load());
}

export function get(mint) {
  const coin = load().find((item) => item.mint === mint);
  return coin ? clone(coin) : null;
}

/** Add a coin by mint, or refresh its name and symbol. Keeps its activity. */
export function add({ mint, name = null, symbol = null, image = null, source = 'added' } = {}) {
  if (!mint) throw new Error('mint is required');
  const coins = load();
  const index = coins.findIndex((item) => item.mint === mint);
  const ts = nowIso();
  if (index >= 0) {
    coins[index] = {
      ...coins[index],
      name: name || coins[index].name || null,
      symbol: symbol || coins[index].symbol || null,
      image: image || coins[index].image || null,
      updatedAt: ts,
      hidden: source === 'added' ? false : coins[index].hidden === true,
    };
  } else {
    coins.push({ mint, name, symbol, image, source, addedAt: ts, updatedAt: ts, hidden: false, events: [] });
  }
  persist(coins);
  return clone(coins[index >= 0 ? index : coins.length - 1]);
}

/** Hide a coin from the list. Its activity is kept. */
export function remove(mint) {
  const coins = load();
  const index = coins.findIndex((item) => item.mint === mint);
  if (index < 0) return false;
  coins[index] = { ...coins[index], hidden: true, updatedAt: nowIso() };
  persist(coins);
  return true;
}

/** Append one operation to a coin's activity, adding the coin if needed. */
export function recordEvent(mint, event = {}) {
  if (!mint) return null;
  const coins = load();
  let index = coins.findIndex((item) => item.mint === mint);
  const ts = nowIso();
  if (index < 0) {
    coins.push({ mint, name: null, symbol: null, source: 'activity', addedAt: ts, updatedAt: ts, hidden: false, events: [] });
    index = coins.length - 1;
  }
  const entry = { at: ts, outcome: 'landed', ...event };
  const events = [...(coins[index].events || []), entry].slice(-MAX_EVENTS_PER_COIN);
  coins[index] = { ...coins[index], events, updatedAt: ts };
  persist(coins);
  return clone(entry);
}
