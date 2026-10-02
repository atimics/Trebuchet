import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('opening a draft asks the server before saying it is gone', () => {
  const coins = read('public/v2/features/discovery/coins.js');
  // The coin list and the page's saved-launch list are separate requests.
  assert.match(coins, /async function savedDraftEntry\(draftId\)/);
  assert.match(coins, /state\.apiClient\?\.listSavedLaunches\?\.\(\)/);
  assert.match(coins, /const entry = await savedDraftEntry\(draftId\);/);
});

test('a failed saved-launch request does not wipe the list the page already has', () => {
  const connection = read('public/v2/features/shell/connection.js');
  assert.match(connection, /boot\.savedLaunches\?\.available !== false \|\| !state\.savedLaunches\?\.length/);
});

test('the shipped renderer carries both changes', () => {
  const app = read('public/v2/app.js');
  assert.match(app, /async function savedDraftEntry\(draftId\)/);
  assert.match(app, /boot\.savedLaunches\?\.available !== false/);
});
