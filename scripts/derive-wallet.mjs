#!/usr/bin/env node
// scripts/derive-wallet.mjs — derive a Solana keypair from a BIP39 mnemonic.
//
// Prints the public key and a base64-encoded secret key suitable for
// storing as a GitHub secret. Uses the same derivation path as Phantom /
// Solflare / Backpack (m/44'/501'/0'/0').
//
// Usage:
//   node scripts/derive-wallet.mjs "twelve word mnemonic phrase here ..."

import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { Keypair } from '@solana/web3.js';

const mnemonic = process.argv[2];
if (!mnemonic) {
  console.error('Usage: node scripts/derive-wallet.mjs "twelve word mnemonic ..."');
  process.exit(1);
}

if (!bip39.validateMnemonic(mnemonic)) {
  console.error('Invalid BIP39 mnemonic. Check each word against the BIP39 wordlist.');
  process.exit(1);
}

const seed = bip39.mnemonicToSeedSync(mnemonic);
const derivedSeed = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
const keypair = Keypair.fromSeed(derivedSeed);

const secretB64 = Buffer.from(keypair.secretKey).toString('base64');

console.log('Public key: ' + keypair.publicKey.toBase58());
console.log('Secret key (base64, for GitHub secrets): ' + secretB64);
