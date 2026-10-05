// Print the build hash used by the app's deployment check.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const bytes = fs.readFileSync(process.argv[2] || 'programs/fee-vault/target/deploy/trebuchet_fee_vault.so');
let end = bytes.length;
while (end && bytes[end - 1] === 0) end--;
console.log(createHash('sha256').update(bytes.subarray(0, end)).digest('hex'));
