import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { Keypair } from '@solana/web3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let _binaryPath = null;

function getBinaryPath() {
  if (_binaryPath) return _binaryPath;

  // In the packaged app, the C binary is unpacked from the asar archive.
  // __dirname ends with e.g. 'app.asar' (no trailing slash), so we
  // replace '.asar' at the end of a path segment, not '.asar/'.
  const unpackedDir = __dirname.replace(/\.asar(\/|$)/, '.asar.unpacked$1');
  const unpackedBin = path.join(unpackedDir, 'c', 'build', 'vanity_keygen');
  if (fs.existsSync(unpackedBin)) {
    _binaryPath = unpackedBin;
    return _binaryPath;
  }

  // Dev-mode path
  const devBin = path.join(__dirname, 'c', 'build', 'vanity_keygen');
  if (fs.existsSync(devBin)) {
    _binaryPath = devBin;
    return _binaryPath;
  }

  // Also try the unpacked path directly (Electron may unpack to a
  // Resources sibling of the asar)
  const altUnpacked = path.join(
    path.dirname(__dirname),
    'app.asar.unpacked', 'c', 'build', 'vanity_keygen'
  );
  if (fs.existsSync(altUnpacked)) {
    _binaryPath = altUnpacked;
    return _binaryPath;
  }

  throw new Error(
    `vanity_keygen binary not found. Tried:\n  ${unpackedBin}\n  ${devBin}\n  ${altUnpacked}`
  );
}

/**
 * Generate a Solana keypair with a vanity prefix or suffix.
 *
 * Spawns the C vanity keygen binary and reads its JSON output.
 * The output includes the keypair, attempt count, and rarity tier.
 * The deterministic seed is NOT exposed — it equals the private key.
 */
export function generateVanityKeypair({ prefix, suffix, threads, blockhash, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let binary;
    try {
      binary = getBinaryPath();
    } catch (e) {
      reject(e);
      return;
    }

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
    if (blockhash) {
      args.push('--vrf-blockhash', blockhash);
    }

    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      if (onProgress) {
        const m = text.match(/Attempts:\s*(\d+)/);
        if (m) {
          const keyMatch = text.match(/Key:\s*(\S+)/);
          onProgress({ attempts: Number(m[1]), key: keyMatch ? keyMatch[1] : null });
        }
      }
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
        const vrfFields = {};
        if (result.vrfProof) {
          vrfFields.vrfProof = result.vrfProof;
          vrfFields.vrfPk = result.vrfPk;
          vrfFields.vrfBlockhash = result.vrfBlockhash;
        }
        resolve({
          publicKey: result.publicKey,
          secretKey: result.secretKey,
          keypair,
          attempts: result.attempts,
          rarity: result.rarity,
          epochs: result.epochs,
          expectedAttempts: result.expectedAttempts,
          elapsedSec: result.elapsedSec,
          ...vrfFields,
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
