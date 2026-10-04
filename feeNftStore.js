import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = () => path.join(process.env.TREBUCHET_CONFIG_DIR || path.dirname(fileURLToPath(import.meta.url)), 'feeNfts');
const file = (id) => {
  if (!/^fee_[0-9a-f-]{36}$/.test(String(id))) throw Object.assign(new Error('Unknown fee collection'), { statusCode: 404 });
  return path.join(root(), `${id}.json`);
};
export function save(record) {
  const target = file(record.id);
  fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, target);
  return record;
}
export function create(plan) { return save({ id: `fee_${randomUUID()}`, plan, status: 'draft', operations: {}, createdAt: new Date().toISOString() }); }
export function get(id) { return JSON.parse(fs.readFileSync(file(id), 'utf8')); }
export function list() { return fs.existsSync(root()) ? fs.readdirSync(root()).filter((name) => /^fee_[0-9a-f-]{36}\.json$/.test(name)).map((name) => get(name.slice(0, -5))) : []; }
export function publicView(record) {
  const { operations, ...view } = record;
  return { ...view, operations: Object.fromEntries(Object.entries(operations).map(([key, op]) => [key, { signature: op.signature, status: op.status, spentLamports: op.spentLamports }])) };
}
