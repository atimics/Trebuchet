// App adapter for planned launches in the runtime's SQLite profile store.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProfileLaunchStore } from '@trebuchet/runtime/profile-stores';
const root = path.dirname(fileURLToPath(import.meta.url));
export const store = () => createProfileLaunchStore(process.env.TREBUCHET_CONFIG_DIR || root);
export const list = (...args) => store().list(...args);
export const get = (...args) => store().get(...args);
export const save = (...args) => store().save(...args);
export const remove = (...args) => store().remove(...args);
export const storeFilePath = () => store().filePath;
