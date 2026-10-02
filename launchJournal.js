// App adapter: the runtime owns durable journals in the selected profile.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProfileJournalStore } from '@trebuchet/runtime/profile-stores';
export { errorMessage, errorDetails, tokenCreationComplete } from '@trebuchet/core/launch-journal';
const root = path.dirname(fileURLToPath(import.meta.url));
const store = () => createProfileJournalStore(process.env.TREBUCHET_CONFIG_DIR || root);
export const start = (...args) => store().start(...args);
export const get = (...args) => store().get(...args);
export const activeForWallet = (...args) => store().activeForWallet(...args);
export const update = (...args) => store().update(...args);
export const upsertForWallet = (...args) => store().upsertForWallet(...args);
export const recordEvent = (...args) => store().recordEvent(...args);
export const list = (...args) => store().list(...args);
export const archive = (...args) => store().archive(...args);
