import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { Keypair } from '@solana/web3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BINARY = path.join(__dirname, 'c', 'build', 'vanity_keygen');

/**
 * Generate a Solana keypair with a vanity prefix or suffix.
 *
 * Spawns the C vanity keygen binary and reads its JSON output.
 * The output includes a provable grind proof: seed, attempts, rarity tier.
 *
 * @param {object} opts
 * @param {string} [opts.prefix]  - Desired base58 prefix
 * @param {string} [opts.suffix]  - Desired base58 suffix
 * @param {number} [opts.threads] - Worker threads (default: CPU count)
 * @returns {Promise<{publicKey: string, secretKey: number[], keypair: Keypair, seed: string, attempts: number, rarity: string, epochs: number}>}
 */
export function generateVanityKeypair({ prefix, suffix, threads } = {}) {
  return new Promise((resolve, reject) => {
    const args = [];
    if (prefix) {
      args.push('--prefix', prefix);
    } else if (suffix) {
      args.push('--suffix', suffix);
    } else {
      reject(new Error('Must specify either prefix or suffix'));
      return;
    }

    if (threads && threads > 0) {
      args.push('--threads', String(threads));
    }

    const child = spawn(BINARY, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      // Progress lines are captured by the caller via stderr if needed
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Vanity keygen exited ${code}: ${stderr}`));
        return;
      }
      try {
        const result = JSON.parse(stdout.trim());
        if (!result.secretKey || !result.publicKey) {
          reject(new Error('Output missing secretKey or publicKey'));
          return;
        }
        const keypair = Keypair.fromSecretKey(Uint8Array.from(result.secretKey));
        resolve({
          publicKey: result.publicKey,
          secretKey: result.secretKey,
          keypair,
          seed: result.seed,
          attempts: result.attempts,
          rarity: result.rarity,
          epochs: result.epochs,
          expectedAttempts: result.expectedAttempts,
          elapsedSec: result.elapsedSec,
        });
      } catch (err) {
        reject(new Error(`Parse error: ${err.message}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Spawn failed: ${err.message}`));
    });
  });
}
