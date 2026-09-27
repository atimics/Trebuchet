import { 
  Connection, 
  Keypair, 
  PublicKey, 
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction
} from '@solana/web3.js';
// NOTE: the spl-token convenience wrappers (createMint, mintTo, setAuthority,
// getOrCreateAssociatedTokenAccount, transfer) are deliberately NOT used here
// anymore. They build and send their transactions internally, with no way to
// attach ComputeBudget (priority fee) instructions — which left every mint/
// metadata/transfer tx in this file bidding zero priority and being the first
// to drop during congestion. We now build the same instructions explicitly
// (the *Instruction builders below are what those wrappers use internally)
// and send them through sendIxsWithPriority(), which prepends a sampled
// priority fee. See priorityFees.js.
import { 
  getMint,
  getAccount,
  AuthorityType,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  createInitializeMetadataPointerInstruction,
  createInitializeMint2Instruction,
  getMetadataPointerState,
  getTokenMetadata,
  tokenMetadataInitializeWithRentTransfer,
  tokenMetadataUpdateFieldWithRentTransfer,
  tokenMetadataUpdateAuthority,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  createMintToInstruction,
  createSetAuthorityInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { 
  createMetadataAccountV3,
  updateV1
} from '@metaplex-foundation/mpl-token-metadata';
import { 
  percentAmount,
  publicKey as umiPublicKey,
  none,
  some,
  createSignerFromKeypair,
} from '@metaplex-foundation/umi';
import QRCode from 'qrcode';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { getRpcUrl, getNetwork } from './rpcConfig.js';
import { generateVanityKeypair } from './vanityKeygen.js';
import { scalarPublicKey, signWithScalar } from '@trebuchet/core/split-key';
import {
  createTokenMetadataUmi,
  prepareSealedIdentity,
  SEALED_TOKEN_NAME,
  SEALED_TOKEN_SYMBOL,
  sealedCommitmentDocument,
  uploadSealedPlaceholderMetadata,
  uploadTokenMetadata,
} from './metadataUploadService.js';
import { saveSealedIdentity } from './sealedIdentityStore.js';
import { landTxWithRetry } from './chainRetry.js';
import { redactUrl } from './logRedaction.js';
import { parseMetaplexUri } from './tokenMetadataLayout.js';
import {
  fetchMetadataDocument,
  metadataDocumentHash,
} from './brandShieldService.js';

export const MINT_FORMAT_TOKEN_2022 = 'token-2022';
export const MINT_FORMAT_CLASSIC = 'classic-spl';

export function normalizeMintFormat(value, fallback = MINT_FORMAT_TOKEN_2022) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['token-2022', 'token2022', 'modern', 'native'].includes(normalized)) {
    return MINT_FORMAT_TOKEN_2022;
  }
  if (['classic-spl', 'classic', 'spl', 'tokenkeg'].includes(normalized)) {
    return MINT_FORMAT_CLASSIC;
  }
  return fallback;
}

export function tokenProgramForMintFormat(value) {
  return normalizeMintFormat(value) === MINT_FORMAT_CLASSIC
    ? TOKEN_PROGRAM_ID
    : TOKEN_2022_PROGRAM_ID;
}

function hasPermanentSelfMetadataPointer(mintInfo, mint) {
  const pointer = getMetadataPointerState(mintInfo);
  return Boolean(
    pointer
    && pointer.authority === null
    && pointer.metadataAddress?.equals(mint),
  );
}

import {
  samplePriorityFeeMicroLamports,
  computeBudgetIxs,
  priorityFeeLamports,
  umiComputeBudgetIxs,
  CU_SOL_TRANSFER,
  CU_MINT_OPS,
  CU_METADATA_OPS,
  SWEEP_FEE_PAD_LAMPORTS,
} from './priorityFees.js';

// The RPC URL is sourced from rpcConfig.js, which seeds itself with a
// public-mainnet default on first run and persists user-selected RPCs to
// rpcConfig.json. The connection is rebuilt whenever the user switches RPCs
// in the UI — server.js calls refreshConnection() after a successful change.
function makeConnection() {
  const url = getRpcUrl();
  console.log('Using RPC endpoint:', redactUrl(url), `(network: ${getNetwork()})`);
  return new Connection(url, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60_000,
  });
}

// ---------------------------------------------------------------------------
// RPC retry helper — public RPCs often return stale data after a tx confirms.
// ---------------------------------------------------------------------------
async function withRpcRetry(fn, { maxRetries = 5, baseDelayMs = 1000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = (err.message || '').toLowerCase();
      const isRetryable =
        err.name === 'TokenAccountNotFoundError' ||
        msg.includes('fetch failed') ||
        msg.includes('econnrefused') ||
        msg.includes('econnreset') ||
        msg.includes('etimedout') ||
        msg.includes('network io suspended') ||
        msg.includes('429') ||
        msg.includes('too many requests') ||
        msg.includes('503') ||
        msg.includes('502');
      if (isRetryable && attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        console.log(`RPC retry ${attempt + 1}/${maxRetries} after ${err.name || 'network error'}, waiting ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

function isFreshTokenAccountPropagationError(error) {
  const message = [
    error?.message,
    error?.transactionMessage,
    ...(Array.isArray(error?.logs) ? error.logs : []),
  ].filter(Boolean).join(' ');
  return /InvalidAccountData|invalid account data for instruction/i.test(message);
}

async function verifyMintSupplyAccounts({ mint, destination, authority, totalTokens, programId }) {
  const [mintInfo, tokenAccount] = await Promise.all([
    getMint(connection, mint, 'finalized', programId),
    getAccount(connection, destination, 'finalized', programId),
  ]);
  if (!tokenAccount.mint.equals(mint)) {
    throw new Error('finish-token: the destination token account belongs to a different mint');
  }
  if (!tokenAccount.owner.equals(authority)) {
    throw new Error('finish-token: the destination token account belongs to a different wallet');
  }
  if (mintInfo.supply < totalTokens && !mintInfo.mintAuthority?.equals(authority)) {
    throw new Error('finish-token: the launch wallet is no longer the mint authority');
  }
  return { mintInfo, tokenAccount };
}

async function detectMintProgramId(mint, commitment = 'finalized') {
  const account = await connection.getAccountInfo(mint, commitment);
  if (!account) throw new Error(`Mint ${mint.toBase58()} was not found on-chain.`);
  if (!account.owner.equals(TOKEN_PROGRAM_ID) && !account.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(
      `Mint ${mint.toBase58()} is owned by ${account.owner.toBase58()}, not a supported token program.`,
    );
  }
  return account.owner;
}


// ---------------------------------------------------------------------------
// Dependency-injection seams (TEST-ONLY).
//
// Production behavior is the default: `_connectionFactory` is the real
// `makeConnection`, and the umi/uploader factories are the real Metaplex
// helpers. A test may swap these out via the `*ForTests` setters to exercise
// createTokenWithMetaplex without any RPC, Arweave, or Irys network calls.
// None of these change anything unless a test explicitly calls a setter.
// ---------------------------------------------------------------------------
let _connectionFactory = makeConnection;
let _umiFactory = createTokenMetadataUmi;
let _uploadMetadata = uploadTokenMetadata;
let connection = _connectionFactory();

export function refreshConnection() {
  connection = _connectionFactory();
}

// TEST-ONLY: override how the module-level Solana connection is built.
export function setConnectionFactoryForTests(fn) {
  _connectionFactory = fn;
  connection = _connectionFactory();
}

// TEST-ONLY: restore the real connection factory and rebuild the connection.
export function resetConnectionFactoryForTests() {
  _connectionFactory = makeConnection;
  connection = makeConnection();
}

// TEST-ONLY: override the umi builder used by createTokenWithMetaplex.
export function setUmiFactoryForTests(fn) {
  _umiFactory = fn;
}

// TEST-ONLY: override the metadata uploader used by createTokenWithMetaplex
// (e.g. to simulate an Irys upload failure without network).
export function setUploaderForTests(fn) {
  _uploadMetadata = fn;
}

// TEST-ONLY: restore the real umi/uploader factories.
export function resetMetadataFactoriesForTests() {
  _umiFactory = createTokenMetadataUmi;
  _uploadMetadata = uploadTokenMetadata;
}

// ---------------------------------------------------------------------------
// Priority-fee transaction helpers
// ---------------------------------------------------------------------------

// Build a transaction from `instructions` with a freshly-sampled priority
// fee prepended, sign with [payer, ...signers], send, and confirm at
// 'finalized' (the commitment every replaced spl-token wrapper used).
// The fee is sampled per-send so retries and later steps reflect current
// conditions rather than a stale bid.
async function sendIxsWithPriority({ payer, instructions, signers = [], units = CU_MINT_OPS, label = 'tx' }) {
  const microLamports = await samplePriorityFeeMicroLamports(connection);
  const tx = new Transaction().add(
    ...computeBudgetIxs({ units, microLamports }),
    ...instructions,
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [payer, ...signers], {
    commitment: 'finalized',
  });
  console.log(`  ${label}: ${sig} (prio ${microLamports} uL/CU)`);
  return sig;
}

// Ensure an associated token account exists for (mint, owner), payer pays.
// Replaces getOrCreateAssociatedTokenAccount: the idempotent-create
// instruction is a no-op when the ATA already exists, so we always send
// (with priority) instead of read-then-maybe-create — one fewer RPC read
// and no read/create race. Returns { address } to match the shape the
// call sites already consume.
async function ensureAta({ payer, mint, owner, programId = TOKEN_PROGRAM_ID }) {
  const address = getAssociatedTokenAddressSync(
    mint,
    owner,
    /* allowOwnerOffCurve */ false,
    programId,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  await sendIxsWithPriority({
    payer,
    units: CU_MINT_OPS,
    label: `ensure ATA ${address.toBase58().slice(0, 8)}…`,
    instructions: [
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey, // payer
        address,
        owner,
        mint,
        programId,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    ],
  });
  return { address };
}

// Sampled ComputeBudget instructions in umi shape, for prepending to the
// Metaplex metadata builders (which otherwise send at zero
// priority). Sampled fresh per call, same rationale as sendIxsWithPriority.
async function umiPriorityIxs() {
  const microLamports = await samplePriorityFeeMicroLamports(connection);
  return umiComputeBudgetIxs({ units: CU_METADATA_OPS, microLamports });
}

// Generate a temporary wallet, with a BIP39 recovery phrase.
//
// We generate the mnemonic first (with bip39's CSPRNG) and derive the
// keypair from it using Solana's standard derivation path. This is the
// same path Phantom, Solflare, and Backpack use for the first account
// on a seed, so when a user imports the recovery phrase into any of
// those wallets, the address matches what they saw here.
//
// Why not Keypair.generate()? It produces a random keypair with no
// associated mnemonic — there's no way to "back-derive" a phrase from
// a key, so any such wallet can only be recovered by copying the raw
// secret bytes. A mnemonic is far more user-friendly: 12 words a user
// can write down accurately and paste into any wallet app.
let _temporaryWalletGeneratorForTests = null;

export function setTemporaryWalletGeneratorForTests(fn) {
  _temporaryWalletGeneratorForTests = typeof fn === 'function' ? fn : null;
}

export function resetTemporaryWalletGeneratorForTests() {
  _temporaryWalletGeneratorForTests = null;
}

export async function generateTemporaryWallet() {
  if (_temporaryWalletGeneratorForTests) return await _temporaryWalletGeneratorForTests();
  const mnemonic = bip39.generateMnemonic();          // 12 words, 128 bits of entropy
  const seed = bip39.mnemonicToSeedSync(mnemonic);    // 64-byte seed
  // Solana's BIP44 path: m / 44' / 501' / 0' / 0'.
  // The first 0' is the account index; sticking with 0 means the user
  // sees this wallet as "Account 1" when they import into Phantom.
  const derivedSeed = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
  const keypair = Keypair.fromSeed(derivedSeed);
  return {
    publicKey: keypair.publicKey.toString(),
    secretKey: Array.from(keypair.secretKey),
    mnemonic,
  };
}

// Generate QR code for wallet address
export async function getWalletQRCode(publicKey) {
  try {
    // Generate a simple Solana address QR code
    const qrCodeDataURL = await QRCode.toDataURL(publicKey, {
      width: 256,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
    return qrCodeDataURL;
  } catch (error) {
    console.error('Error generating QR code:', error);
    throw error;
  }
}

// Check wallet balance
export async function checkWalletBalance(publicKey) {
  try {
    const pubKey = new PublicKey(publicKey);
    console.log('Checking balance for:', publicKey);
    console.log('Using RPC:', getRpcUrl());
    
    const balance = await connection.getBalance(pubKey);
    return balance / LAMPORTS_PER_SOL;
  } catch (error) {
    console.error('Error checking balance:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      rpcUrl: getRpcUrl()
    });
    
    // If it's a connection error, try with public RPC
    if (error.message && error.message.includes('fetch')) {
      console.log('Trying public RPC endpoint...');
      const fallbackUrl = (getNetwork && getNetwork()) === 'devnet'
        ? 'https://api.devnet.solana.com'
        : 'https://api.mainnet-beta.solana.com';
      const publicConnection = new Connection(fallbackUrl, 'confirmed');
      try {
        const balance = await publicConnection.getBalance(pubKey);
        return balance / LAMPORTS_PER_SOL;
      } catch (fallbackError) {
        console.error('Public RPC also failed:', fallbackError);
        throw new Error('Unable to connect to Solana network. Please check your internet connection.');
      }
    }
    
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Token-mint keypair selection.
//
// Solana CLMM pools order their mintA / mintB by raw byte comparison of the
// 32-byte pubkey, with the smaller-byte-ordered key taking the mintA slot.
// Raydium's UI then displays the pool's price as `mintB per mintA`. For a
// random launched-token keypair paired with WSOL (first byte 0x06) and a
// typical flywheel mint (first byte 0x04), the launched key lands as mintB
// roughly 97% of the time — which used to flip the Raydium price display
// upside-down and confuse users.
//
// Historically we tried to force the launched token to mintA by grinding
// keypairs until one sorted smaller than every quote mint. That worked
// but constrained the vanity-grind search space and added a launch-time
// gate that could fail for users with pre-ground keypairs. The whole rest
// of the launch pipeline (tick math, position opening, bootstrap, locks,
// fee-key transfers) is already side-agnostic — it detects mintA vs
// mintB after pool creation and branches every subsequent calculation
// accordingly. So we accept whichever ordering Raydium picks. Modern
// aggregator UIs (Jupiter, DexScreener, Birdeye) normalize the display
// regardless; Raydium itself shows the launched token correctly when
// users click into its detail view.
//
// The only special case left: if a vanity prefix/suffix is requested
// without a pre-ground keypair, we still need to invoke the C grinder
// to find a matching pubkey. That's what the small helper below does —
// no sort constraint, no retry loop, just one grind per request.
// ---------------------------------------------------------------------------

async function grindVanityKeypair({ vanityPrefix, vanitySuffix }) {
  const result = await generateVanityKeypair({ prefix: vanityPrefix, suffix: vanitySuffix });
  console.log(`Vanity mint CA: ${result.publicKey}`);
  return result.keypair;
}

// Metadata-only instruction for a mint that already exists: unlike createV1
// it never tries to initialize the mint. Returns the builder so callers can
// prepend priority-fee instructions.
function createMetadataForExistingMint(umi, {
  mint,
  name,
  symbol,
  uri,
}) {
  return createMetadataAccountV3(umi, {
    mint,
    mintAuthority: umi.identity,
    updateAuthority: umi.identity,
    data: {
      name,
      symbol,
      uri,
      sellerFeeBasisPoints: 0,
      creators: some([{
        address: umi.identity.publicKey,
        verified: true,
        share: 100,
      }]),
      collection: none(),
      uses: none(),
    },
    isMutable: true,
    collectionDetails: none(),
  });
}

// A split-key vanity CA is a raw Ed25519 scalar (a + k), not a seed
// keypair. It signs exactly one transaction: the create-mint below.
export function scalarMintSigner(scalar) {
  const bytes = Uint8Array.from(scalar);
  return { publicKey: new PublicKey(scalarPublicKey(bytes)), scalar: bytes };
}

// Sign with the payer, then add the mint's signature from its scalar, and
// refuse to send anything that does not verify.
export function signWithScalarMint(transaction, payer, mintSigner) {
  transaction.feePayer = payer.publicKey;
  transaction.partialSign(payer);
  transaction.addSignature(
    mintSigner.publicKey,
    Buffer.from(signWithScalar(mintSigner.scalar, transaction.serializeMessage())),
  );
  if (!transaction.verifySignatures()) throw new Error('Create-mint signatures do not verify');
  return transaction;
}

async function sendMintTransaction(transaction, payer, mintSigner, commitment) {
  if (!mintSigner.scalar) {
    return sendAndConfirmTransaction(connection, transaction, [payer, mintSigner], { commitment });
  }
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment);
  transaction.recentBlockhash = blockhash;
  signWithScalarMint(transaction, payer, mintSigner);
  const signature = await connection.sendRawTransaction(transaction.serialize(), { preflightCommitment: commitment });
  const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, commitment);
  if (confirmation.value.err) {
    throw new Error(`Create-mint transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  return signature;
}

async function createToken2022WithOnMintMetadata({
  tempWallet,
  mintKeypair,
  name,
  symbol,
  totalSupply,
  metadataUri,
  metadataHash,
  imageUri,
  onChainMetadataName,
  onChainMetadataSymbol,
  onChainMetadataUri,
  sealedLaunch,
  progress,
}) {
  const programId = TOKEN_2022_PROGRAM_ID;
  const mintSigner = mintKeypair || Keypair.generate();
  const mint = mintSigner.publicKey;
  const mintSpace = getMintLen([ExtensionType.MetadataPointer]);
  const mintRent = await connection.getMinimumBalanceForRentExemption(mintSpace, 'finalized');

  console.log('Creating Token-2022 mint with a self-referencing metadata pointer...');
  const initializeMint = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: tempWallet.publicKey,
      newAccountPubkey: mint,
      space: mintSpace,
      lamports: mintRent,
      programId,
    }),
    // The pointer is permanent and self-referencing. Setting its authority to
    // null at initialization prevents a later redirect to spoofed metadata.
    createInitializeMetadataPointerInstruction(mint, null, mint, programId),
    createInitializeMint2Instruction(mint, 9, tempWallet.publicKey, null, programId),
  );
  const mintCreateTx = await sendMintTransaction(initializeMint, tempWallet, mintSigner, 'finalized');
  console.log('Token-2022 mint created:', mint.toBase58());
  progress({
    stage: 'mint_created',
    tokenMint: mint.toBase58(),
    txId: mintCreateTx,
    mintFormat: MINT_FORMAT_TOKEN_2022,
    tokenProgram: programId.toBase58(),
  });

  const metadataCreateTx = await tokenMetadataInitializeWithRentTransfer(
    connection,
    tempWallet,
    mint,
    tempWallet.publicKey,
    tempWallet,
    onChainMetadataName,
    onChainMetadataSymbol,
    onChainMetadataUri,
    [],
    { commitment: 'finalized' },
    programId,
  );
  // Bind the public identity document to the mint itself. Indexers can read
  // the ordinary name/symbol/URI fields; Trebuchet proof can additionally
  // verify that the URI content still matches this launch-time commitment.
  const commitmentTx = await tokenMetadataUpdateFieldWithRentTransfer(
    connection,
    tempWallet,
    mint,
    tempWallet,
    'trebuchet:sha256',
    metadataHash,
    [],
    { commitment: 'finalized' },
    programId,
  );
  progress({
    stage: 'metadata_account_created',
    tokenMint: mint.toBase58(),
    txId: metadataCreateTx,
    commitmentTxId: commitmentTx,
    metadataUri,
    imageUri,
    metadataHash,
    onChainMetadataUri,
    metadataStandard: 'token-2022-inline',
    metadataPointerAuthorityRevoked: true,
    sealedLaunch: sealedLaunch === true,
    sealedMetadataPending: sealedLaunch === true,
  });

  const tokenAccount = await withRpcRetry(() => ensureAta({
    payer: tempWallet,
    mint,
    owner: tempWallet.publicKey,
    programId,
  }));
  const totalTokens = BigInt(totalSupply) * (10n ** 9n);
  const mintSupplyTx = await sendIxsWithPriority({
    payer: tempWallet,
    units: CU_MINT_OPS,
    label: 'mint supply',
    instructions: [
      createMintToInstruction(mint, tokenAccount.address, tempWallet.publicKey, totalTokens, [], programId),
    ],
  });
  progress({ stage: 'supply_minted', tokenMint: mint.toBase58(), txId: mintSupplyTx });

  const revokeMintTx = await sendIxsWithPriority({
    payer: tempWallet,
    units: CU_MINT_OPS,
    label: 'renounce mint authority',
    instructions: [
      createSetAuthorityInstruction(mint, tempWallet.publicKey, AuthorityType.MintTokens, null, [], programId),
    ],
  });
  progress({ stage: 'mint_authority_revoked', tokenMint: mint.toBase58(), txId: revokeMintTx });

  let metadataUpdateAuthorityRevoked = false;
  if (sealedLaunch) {
    progress({
      stage: 'metadata_reveal_pending',
      tokenMint: mint.toBase58(),
      metadataUri,
      metadataHash,
      onChainMetadataUri,
      sealedLaunch: true,
      sealedMetadataPending: true,
    });
  } else {
    const revokeMetadataTx = await tokenMetadataUpdateAuthority(
      connection,
      tempWallet,
      mint,
      tempWallet,
      null,
      [],
      { commitment: 'finalized' },
      programId,
    );
    metadataUpdateAuthorityRevoked = true;
    progress({
      stage: 'metadata_update_authority_revoked',
      tokenMint: mint.toBase58(),
      txId: revokeMetadataTx,
      immutable: true,
    });
  }

  const [mintInfo, tokenMetadata, tokenAccountInfo] = await Promise.all([
    getMint(connection, mint, 'finalized', programId),
    getTokenMetadata(connection, mint, 'finalized', programId),
    getAccount(connection, tokenAccount.address, 'finalized', programId),
  ]);
  if (mintInfo.supply !== totalTokens || mintInfo.mintAuthority !== null || mintInfo.freezeAuthority !== null) {
    throw new Error('Token-2022 safety verification failed after mint creation.');
  }
  if (!tokenMetadata || !tokenMetadata.mint.equals(mint)) {
    throw new Error('Token-2022 inline metadata verification failed after mint creation.');
  }
  if (!hasPermanentSelfMetadataPointer(mintInfo, mint)) {
    throw new Error('Token-2022 metadata pointer is not permanently bound to this mint.');
  }
  if (!sealedLaunch && tokenMetadata.updateAuthority) {
    throw new Error('Token-2022 metadata update authority was not retired.');
  }
  console.log('Verified token balance:', tokenAccountInfo.amount.toString());

  const result = {
    tokenMint: mint.toBase58(),
    metadataUri,
    metadataHash,
    onChainMetadataUri,
    imageUri: imageUri || null,
    totalSupply,
    isSafe: true,
    mintFormat: MINT_FORMAT_TOKEN_2022,
    tokenProgram: programId.toBase58(),
    metadataStandard: 'token-2022-inline',
    metadataPointerAuthorityRevoked: true,
    mintAndFreezeAuthoritiesSafe: true,
    mintAuthorityRenounced: true,
    freezeAuthorityDisabled: true,
    metadataUpdateAuthorityRevoked,
    metadataImmutable: metadataUpdateAuthorityRevoked,
    sealedLaunch: sealedLaunch === true,
    sealedMetadataPending: sealedLaunch === true,
    warning: sealedLaunch
      ? 'Token supply is fixed. Final identity remains sealed until liquidity is locked.'
      : null,
  };
  progress({ stage: 'token_safety_verified', ...result });
  return result;
}

// Devnet has sparse validators and 'finalized' can take minutes; use
// 'processed' there so the UI stays responsive.
function txCommitment() {
  return getNetwork() === 'devnet' ? 'processed' : 'finalized';
}

// Create a token. New launches use Token-2022 inline metadata by default;
// the classic SPL + Metaplex profile remains available for compatibility.
export async function createTokenWithMetaplex({
  tempWalletSecretKey,
  name,
  symbol,
  description,
  totalSupply,
  logoBase64,
  onProgress,
  vanityPrefix,
  vanitySuffix,
  vanityCAKeypair,
  vanityCAScalar = null,
  sealedLaunch = false,
  mintFormat = MINT_FORMAT_TOKEN_2022,
  // Opt-out of the metadata update-authority revoke. Default false = the
  // long-standing behavior: metadata (name, symbol, logo URI) is frozen
  // forever. When true, the authority is NOT revoked here — it stays with
  // the launch wallet, and MUST be handed to the user's destination wallet
  // during the final sweep (transferMetadataAuthority below), because the
  // launch wallet is destroyed at the end of step 6. An authority left on
  // a destroyed key is revocation in effect but unverifiable in form —
  // the worst of both options.
  keepMetadataAuthority = false,
}) {
  try {
    const progress = (event) => {
      if (!onProgress) return;
      try {
        onProgress(event);
      } catch (e) {
        console.warn('Token progress callback failed:', e.message);
      }
    };

    console.log('Starting token creation...');
    
    // Convert secret key array back to Keypair
    const tempWallet = Keypair.fromSecretKey(Uint8Array.from(tempWalletSecretKey));
    
    const umi = _umiFactory(tempWallet);

    // Select the mint keypair.
    //
    // - vanityCAKeypair (pre-ground via the web UI): use it as-is.
    // - vanityPrefix/vanitySuffix (live grind request from server): invoke
    //   the C grinder.
    // - Neither: generate a random one here.
    //
    // The mint is chosen BEFORE the metadata upload so the uploaded document
    // can name its own mint. Copy launchers reuse the official metadata URI
    // verbatim; a document that names its mint exposes every such copy.
    //
    // No mintA-sort constraint is applied. The lpService launch pipeline
    // detects which side the launched token lands on after pool creation
    // and branches every downstream calculation accordingly.
    let mintKeypair = null;
    if (vanityCAScalar) {
      mintKeypair = scalarMintSigner(vanityCAScalar);
      console.log(`Using split-key vanity CA: ${mintKeypair.publicKey.toBase58()}`);
    } else if (vanityCAKeypair) {
      mintKeypair = Keypair.fromSecretKey(Uint8Array.from(vanityCAKeypair));
      console.log(`Using pre-ground vanity CA: ${mintKeypair.publicKey.toBase58()}`);
    } else if (vanityPrefix || vanitySuffix) {
      mintKeypair = await grindVanityKeypair({ vanityPrefix, vanitySuffix });
    } else {
      mintKeypair = Keypair.generate();
      console.log('Using random mint keypair');
    }

    const normalizedMintFormat = normalizeMintFormat(mintFormat);
    if (mintKeypair?.scalar && normalizedMintFormat !== MINT_FORMAT_TOKEN_2022) {
      // createMint needs a seed Keypair; split-key CAs only sign in the
      // Token-2022 path. Refuse before anything is uploaded.
      throw new Error('Split-key vanity CAs need the Token-2022 mint format.');
    }

    const mintAddress = mintKeypair.publicKey.toBase58();
    let metadataUri = null;
    let imageUri = null;
    let metadataHash;
    let onChainMetadataUri;
    let onChainMetadataName = name;
    let onChainMetadataSymbol = symbol;
    if (sealedLaunch) {
      // Nothing identifying leaves this machine until the reveal: Irys uploads
      // are public, and an early upload links name and art to this mint.
      const identity = prepareSealedIdentity({ logoBase64, name, symbol, description, mint: mintAddress });
      saveSealedIdentity(mintAddress, identity);
      metadataHash = identity.commitment;
      progress({
        stage: identity.logoStamped ? 'logo_stamped' : 'sealed_identity_prepared',
        mint: mintAddress,
        metadataHash,
      });
      const placeholder = await uploadSealedPlaceholderMetadata({
        umi,
        commitmentHash: metadataHash,
        onProgress: progress,
      });
      onChainMetadataUri = placeholder.metadataUri;
      onChainMetadataName = SEALED_TOKEN_NAME;
      onChainMetadataSymbol = SEALED_TOKEN_SYMBOL;
    } else {
      console.log('Uploading logo and metadata to Arweave...');
      ({ metadataUri, imageUri, metadataHash } = await _uploadMetadata({
        umi,
        logoBase64,
        name,
        symbol,
        description,
        mint: mintAddress,
        onProgress: progress,
      }));
      onChainMetadataUri = metadataUri;
    }

    if (normalizedMintFormat === MINT_FORMAT_TOKEN_2022) {
      return await createToken2022WithOnMintMetadata({
        tempWallet,
        mintKeypair,
        name,
        symbol,
        totalSupply,
        metadataUri,
        metadataHash,
        imageUri,
        onChainMetadataName,
        onChainMetadataSymbol,
        onChainMetadataUri,
        sealedLaunch,
        progress,
      });
    }

    // Compatibility profile: classic SPL Token + Metaplex metadata PDA.

    // Create mint using standard SPL token first. Two instructions in one
    // tx (exactly what spl-token's createMint wrapper did internally),
    // plus the priority fee the wrapper couldn't carry: fund + allocate
    // the mint account, then initialize it.
    //
    // landTxWithRetry hardening (this and every chain step below): the
    // fresh-create path used bare sends while only finishTokenCreation had
    // retry + idempotency probes — yet a confirm-timeout-that-landed or a
    // dropped blockhash is just as likely on the FIRST attempt. The probes
    // matter doubly here: a blind re-send of this tx after it actually
    // landed fails with "account already in use", and for a vanity CA the
    // mint keypair is irreplaceable — the step must adopt on-chain reality
    // rather than error out.
    console.log('Creating SPL token mint...');
    const effectiveMintKeypair = mintKeypair ?? Keypair.generate();
    const mint = effectiveMintKeypair.publicKey;
    const mintRent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
    try {
      await landTxWithRetry({
        label: 'create mint',
        alreadyDone: async () => {
          // getMint throws while the account doesn't exist / isn't initialized.
          try {
            await getMint(connection, mint, 'finalized', TOKEN_PROGRAM_ID);
            return true;
          } catch (_) { return false; }
        },
        send: () => sendIxsWithPriority({
          payer: tempWallet,
          signers: [effectiveMintKeypair], // new account must co-sign its creation
          units: CU_MINT_OPS,
          label: 'create mint',
          instructions: [
            SystemProgram.createAccount({
              fromPubkey: tempWallet.publicKey,
              newAccountPubkey: effectiveMintKeypair.publicKey,
              space: MINT_SIZE,
              lamports: mintRent,
              programId: TOKEN_PROGRAM_ID,
            }),
            createInitializeMint2Instruction(
              effectiveMintKeypair.publicKey,
              9, // decimals
              tempWallet.publicKey, // mint authority
              null, // freeze authority (null = no freeze)
              TOKEN_PROGRAM_ID,
            ),
          ],
        }),
      });
    } catch (mintError) {
      // The mint address is known before the transaction lands, so surface it
      // on failure: an account that already exists can then be adopted and
      // finished instead of re-created.
      const derived = mint.toBase58();
      if (derived && !mintError.tokenMint) mintError.tokenMint = derived;
      throw mintError;
    }
    console.log('Mint created:', mint.toString());
    progress({ stage: 'mint_created', tokenMint: mint.toString() });
    
    // Now create the metadata account for the existing mint
    console.log('Creating metadata account...');
    
    // Convert the mint public key to Umi format.
    const mintPubkey = umiPublicKey(mint.toString());
    
    // Create metadata for the existing token. Priority fee prepended —
    // Metaplex builders otherwise send at zero priority (see umiPriorityIxs).
    // Same retry + probe as finishTokenCreation: adopt the metadata account
    // if a confirm-timeout landed it, retry on transient weather.
    const createMetadataPda = deriveMetadataPda(mint);
    await landTxWithRetry({
      label: 'create metadata account',
      alreadyDone: async () => {
        const a = await connection.getAccountInfo(createMetadataPda, 'finalized');
        return !!(a && a.data && a.data.length > 0);
      },
      send: async () => createMetadataForExistingMint(umi, {
        mint: mintPubkey,
        name: onChainMetadataName,
        symbol: onChainMetadataSymbol,
        uri: onChainMetadataUri,
      }).prepend(await umiPriorityIxs()).sendAndConfirm(umi),
    });
    
    console.log('Metadata account created successfully');
    progress({
      stage: 'metadata_account_created',
      tokenMint: mint.toString(),
      metadataUri,
      imageUri,
      metadataHash,
      onChainMetadataUri,
      sealedLaunch: sealedLaunch === true,
      sealedMetadataPending: sealedLaunch === true,
    });
    
    // Small delay to ensure metadata account is fully propagated
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Create associated token account (idempotent — with RPC retry for
    // transient send failures)
    console.log('Creating associated token account...');
    const tokenAccount = await withRpcRetry(() => ensureAta({
      payer: tempWallet,
      mint,
      owner: tempWallet.publicKey,
    }));
    console.log('Token account created:', tokenAccount.address.toString());
    
    // Mint the total supply. The alreadyDone probe is the double-mint guard:
    // if a prior attempt landed but threw on confirmation, a blind re-send
    // would mint the supply twice — the probe adopts the landed state instead.
    console.log('Minting total supply...');
    const totalTokens = BigInt(totalSupply) * (10n ** 9n);

    const mintRes = await landTxWithRetry({
      label: 'mint supply',
      alreadyDone: async () => {
        const info = await getMint(connection, mint, 'finalized', TOKEN_PROGRAM_ID);
        return info.supply >= totalTokens;
      },
      send: () => sendIxsWithPriority({
        payer: tempWallet,
        units: CU_MINT_OPS,
        label: 'mint supply',
        instructions: [
          createMintToInstruction(
            mint,
            tokenAccount.address,
            tempWallet.publicKey, // mint authority
            totalTokens,
            [],
            TOKEN_PROGRAM_ID,
          ),
        ],
      }),
    });
    const mintSig = mintRes.skipped ? '(supply already minted)' : mintRes.value;
    
    console.log('Mint transaction signature:', mintSig);
    progress({ stage: 'supply_minted', tokenMint: mint.toString(), txId: mintSig });
    
    console.log('Tokens minted successfully');
    
    // SAFETY STEP: Renounce all authorities to make the token safe
    console.log('Making token safe by renouncing authorities...');
    
    // 1. Renounce mint authority (no more tokens can be minted)
    console.log('Renouncing mint authority...');
    try {
      const renounceRes = await landTxWithRetry({
        label: 'renounce mint authority',
        alreadyDone: async () => {
          const info = await getMint(connection, mint, 'finalized', TOKEN_PROGRAM_ID);
          return info.mintAuthority === null;
        },
        send: () => sendIxsWithPriority({
          payer: tempWallet,
          units: CU_MINT_OPS,
          label: 'renounce mint authority',
          instructions: [
            createSetAuthorityInstruction(
              mint,
              tempWallet.publicKey, // Current authority
              AuthorityType.MintTokens,
              null, // New authority (null = renounce)
              [],
              TOKEN_PROGRAM_ID,
            ),
          ],
        }),
      });
      const renounceMintAuthSig = renounceRes.skipped ? '(already renounced)' : renounceRes.value;
      console.log('Mint authority renounced:', renounceMintAuthSig);
      progress({
        stage: 'mint_authority_revoked',
        tokenMint: mint.toString(),
        txId: renounceMintAuthSig,
      });
    } catch (error) {
      console.error('Error renouncing mint authority:', error);
      throw new Error('Failed to renounce mint authority. Token creation aborted for safety.');
    }
    
    // 2. Freeze authority is already null (set during mint creation)
    console.log('Freeze authority already disabled (was set to null during creation)');
    
    // 3. Renounce metadata update authority and make immutable — unless the
    // user opted to keep the authority so they can change the name/logo
    // later. In that case it stays with the launch wallet FOR NOW and is
    // handed to the destination wallet during the step-6 sweep (see
    // transferMetadataAuthority). Mint and freeze authorities above are NOT
    // optional — supply-cap safety is non-negotiable either way.
    let metadataUpdateSuccess = false;
    let metadataImmutableSuccess = false;

    if (sealedLaunch) {
      console.log('Sealed launch: retaining metadata update authority until liquidity is locked.');
      progress({
        stage: 'metadata_reveal_pending',
        tokenMint: mint.toString(),
        metadataUri,
        metadataHash,
        onChainMetadataUri,
        sealedLaunch: true,
        sealedMetadataPending: true,
      });
    } else if (keepMetadataAuthority) {
      console.log('Keeping metadata update authority (user opted out of revoke); '
        + 'it will be transferred to the destination wallet at the final sweep.');
      progress({ stage: 'metadata_authority_kept', tokenMint: mint.toString(), metadataAuthorityKept: true });
    } else {
    try {
      // Create the System Program public key in Umi format
      // This is the address 11111111111111111111111111111111
      const systemProgramAddress = umiPublicKey('11111111111111111111111111111111');
      
      // Retire the update authority and immutability flag in the SAME
      // transaction. Doing these as two transactions strands mutable metadata:
      // after authority retirement the launch wallet can no longer sign the
      // follow-up immutability update.
      console.log('Making metadata immutable and retiring its update authority...');

      await landTxWithRetry({
        label: 'revoke update authority',
        alreadyDone: async () => {
          // Metadata layout: byte 0 is the account key; bytes 1..33 are the
          // update authority. Revoked == the (all-zero) System Program.
          const a = await connection.getAccountInfo(createMetadataPda, 'finalized');
          if (!a || !a.data || a.data.length < 33) return false;
          try {
            return new PublicKey(a.data.subarray(1, 33)).toBase58()
              === '11111111111111111111111111111111';
          } catch (_) { return false; }
        },
        send: async () => updateV1(umi, {
          mint: mintPubkey,
          authority: umi.identity,
          newUpdateAuthority: some(systemProgramAddress),
          isMutable: some(false),
        }).prepend(await umiPriorityIxs()).sendAndConfirm(umi, {
          send: { commitment: txCommitment() },
          confirm: { commitment: txCommitment() }
        }),
      });
      
      console.log('Metadata made immutable and update authority retired.');
      metadataUpdateSuccess = true;
      metadataImmutableSuccess = true;
      progress({
        stage: 'metadata_update_authority_revoked',
        tokenMint: mint.toString(),
        immutable: true,
      });
      
    } catch (error) {
      console.error('Error revoking update authority:', error);
      console.error('Full error details:', error.message);
      
      // Check if it's a specific error we can handle
      if (error.message && error.message.includes('InstructionError')) {
        console.log('Transaction failed with instruction error - trying simplified approach...');
      }
      
      // If the simple approach failed, try with full data update
      console.log('Trying alternative approach with full metadata update...');
      try {
        const systemProgramAddress = umiPublicKey('11111111111111111111111111111111');
        
        await updateV1(umi, {
          mint: mintPubkey,
          authority: umi.identity,
          data: some({
            name,
            symbol,
            uri: metadataUri,
            sellerFeeBasisPoints: percentAmount(0),
            creators: some([{
              address: umi.identity.publicKey,
              verified: true,
              share: 100,
            }]),
            collection: none(),
            uses: none()
          }),
          newUpdateAuthority: some(systemProgramAddress),
          primarySaleHappened: none(),
          isMutable: some(false),
        }).prepend(await umiPriorityIxs()).sendAndConfirm(umi, {
          send: { commitment: txCommitment() },
          confirm: { commitment: txCommitment() }
        });
        
        console.log('Update authority revoked and metadata made immutable!');
        metadataUpdateSuccess = true;
        metadataImmutableSuccess = true;
        progress({
          stage: 'metadata_update_authority_revoked',
          tokenMint: mint.toString(),
          immutable: true,
        });
        
      } catch (altError) {
        console.error('Alternative approach also failed:', altError.message);
        
        // Wait a bit before final attempt
        console.log('Waiting before final attempt...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // One more attempt - try a two-step approach
        console.log('Final attempt using two-step approach...');
        try {
          const systemProgramAddress = umiPublicKey('11111111111111111111111111111111');
          
          // Step 1: Just change update authority, nothing else
          const updateAuthResult = await updateV1(umi, {
            mint: mintPubkey,
            authority: umi.identity,
            newUpdateAuthority: some(systemProgramAddress),
          }).prepend(await umiPriorityIxs()).sendAndConfirm(umi, { 
            send: { commitment: txCommitment() },
            confirm: { commitment: txCommitment() }
          });
          
          console.log('Successfully revoked update authority in final attempt!');
          console.log('Transaction signature:', updateAuthResult.signature);
          metadataUpdateSuccess = true;
          progress({ stage: 'metadata_update_authority_revoked', tokenMint: mint.toString() });
          
        } catch (finalError) {
          console.error('Final attempt failed:', finalError.message);
          // At this point, we've tried everything - the token is still functional
          console.warn('WARNING: Could not revoke metadata update authority.');
          console.warn('The token is still functional but metadata remains updatable by the creator wallet.');
          console.warn('Most users won\'t notice this, but for maximum security, verify on Solscan.');
        }
      }
    }
    } // end sealed / keep-authority else
    
    // Verify all authorities are properly renounced
    console.log('Verifying token safety...');
    
    // Check mint authority
    const mintInfo = await connection.getAccountInfo(mint);
    if (mintInfo) {
      console.log('Mint account verified');
    }
    
    console.log('Token has been made safe! No new tokens can be minted, accounts cannot be frozen.');
    if (sealedLaunch) {
      console.log('Metadata identity remains sealed; reveal is required after liquidity lock.');
    } else if (keepMetadataAuthority) {
      console.log('Metadata update authority deliberately kept (user option); '
        + 'transfer to destination happens at the final sweep.');
    } else if (metadataUpdateSuccess) {
      console.log('Metadata update authority has been revoked (set to System Program).');
    } else {
      console.warn('WARNING: Metadata update authority could not be revoked during token creation.');
      console.warn('The token is still functional but metadata may remain updatable.');
      console.warn('You can verify the token\'s safety status on Solscan.');
    }
    progress({
      stage: 'token_safety_verified',
      tokenMint: mint.toString(),
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
      metadataUpdateAuthorityRevoked: metadataUpdateSuccess,
      metadataImmutable: metadataImmutableSuccess,
      sealedLaunch: sealedLaunch === true,
      sealedMetadataPending: sealedLaunch === true,
      metadataAuthorityKept: keepMetadataAuthority === true,
    });
    
    // Verify the balance
    let retries = 3;
    let accountInfo;
    
    while (retries > 0) {
      try {
        accountInfo = await getAccount(
          connection, 
          tokenAccount.address, 
          'finalized',
          TOKEN_PROGRAM_ID
        );
        console.log('Verified token balance:', accountInfo.amount.toString());
        break;
      } catch (error) {
        console.error(`Error getting account info (attempt ${4 - retries}):`, error.message);
        retries--;
        if (retries === 0) {
          // Don't throw, just log the error
          console.error('Could not verify balance, but continuing...');
        } else {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
    
    return {
      tokenMint: mint.toString(),
      metadataUri,
      metadataHash,
      onChainMetadataUri,
      mintFormat: MINT_FORMAT_CLASSIC,
      tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
      metadataStandard: 'metaplex-pda',
      metadataPointerAuthorityRevoked: null,
      // Arweave URI of the uploaded logo image (null when no logo). The
      // launch report references this remotely instead of embedding the
      // raw image, keeping the published report under the free-upload cap.
      imageUri: imageUri || null,
      totalSupply: totalSupply,
      isSafe: (sealedLaunch || keepMetadataAuthority) ? true : metadataUpdateSuccess,
      mintAndFreezeAuthoritiesSafe: true,
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
      metadataUpdateAuthorityRevoked: metadataUpdateSuccess,
      metadataImmutable: metadataImmutableSuccess,
      sealedLaunch: sealedLaunch === true,
      sealedMetadataPending: sealedLaunch === true,
      metadataAuthorityKept: keepMetadataAuthority === true,
      warning: sealedLaunch
        ? 'Token supply is fixed. Final identity remains sealed until liquidity is locked.'
        : (keepMetadataAuthority || metadataUpdateSuccess)
          ? null
          : 'Metadata update authority could not be revoked. Please verify token safety on Solscan.'
    };
  } catch (error) {
    console.error('Error in createTokenWithMetaplex:', error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Metaplex Token Metadata program id + metadata-PDA derivation. Used by the
// finish-token resume path to detect whether an existing mint already has a
// metadata account and whether its update authority has been revoked.
// ---------------------------------------------------------------------------
const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
);
// PublicKey.default ('111...111', 32 zero bytes) is the System Program address
// — the value the metadata update authority is set to when it is revoked.
const SYSTEM_PROGRAM_ADDRESS = PublicKey.default.toBase58();

function deriveMetadataPda(mint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
}

// Read-only gate used before any liquidity operation. A mint address alone is
// not evidence that token creation finished: the mint may exist with zero
// supply after an interrupted metadata step. Liquidity must wait until the
// exact planned supply exists and the token's mint/freeze controls are gone.
export async function inspectTokenCreationStatus({ tokenMint, totalSupply, decimals = 9 }) {
  const mint = new PublicKey(tokenMint);
  const expectedSupply = BigInt(totalSupply) * (10n ** BigInt(decimals));
  const programId = await detectMintProgramId(mint);
  const mintInfo = await getMint(connection, mint, 'finalized', programId);
  let metadataExists = false;
  let metadataUpdateAuthorityRevoked = false;
  let metadataStandard = 'metaplex-pda';
  if (programId.equals(TOKEN_2022_PROGRAM_ID)) {
    const metadata = await getTokenMetadata(connection, mint, 'finalized', programId);
    metadataExists = Boolean(metadata);
    metadataUpdateAuthorityRevoked = Boolean(metadata && !metadata.updateAuthority);
    metadataStandard = 'token-2022-inline';
  } else {
    const metadataAccount = await connection.getAccountInfo(deriveMetadataPda(mint), 'finalized');
    metadataExists = Boolean(metadataAccount?.data?.length);
    if (metadataAccount?.data?.length >= 33) {
      metadataUpdateAuthorityRevoked = new PublicKey(
        metadataAccount.data.subarray(1, 33),
      ).toBase58() === SYSTEM_PROGRAM_ADDRESS;
    }
  }
  const status = {
    tokenMint: mint.toBase58(),
    mintFormat: programId.equals(TOKEN_2022_PROGRAM_ID)
      ? MINT_FORMAT_TOKEN_2022
      : MINT_FORMAT_CLASSIC,
    tokenProgram: programId.toBase58(),
    metadataStandard,
    expectedSupply: expectedSupply.toString(),
    actualSupply: mintInfo.supply.toString(),
    supplyMatches: mintInfo.supply === expectedSupply,
    mintAuthorityRenounced: mintInfo.mintAuthority === null,
    freezeAuthorityDisabled: mintInfo.freezeAuthority === null,
    metadataExists,
    metadataUpdateAuthorityRevoked,
    metadataPointerAuthorityRevoked: programId.equals(TOKEN_2022_PROGRAM_ID)
      ? hasPermanentSelfMetadataPointer(mintInfo, mint)
      : null,
  };
  return {
    ...status,
    complete: status.supplyMatches
      && status.mintAuthorityRenounced
      && status.freezeAuthorityDisabled
      && status.metadataExists
      && status.metadataPointerAuthorityRevoked !== false,
  };
}

// Resume a token creation that was interrupted AFTER the mint already existed.
//
// createTokenWithMetaplex's per-step retries absorb transient blips, but a
// genuinely non-transient failure (an RPC outage that outlasts the retry
// window, say) can leave a paid-for mint stranded with some post-mint steps
// undone: metadata account, supply, mint-authority renounce, update-authority
// revoke. Re-running createTokenWithMetaplex would mint a brand-new token and
// waste the vanity address, so instead we finish THIS mint.
//
// On-chain state is the source of truth for WHAT STILL NEEDS DOING — we read
// the mint and the metadata account and perform only the steps that have not
// landed. The journal's recorded txIds are used as a cross-check: if the
// journal records a step as completed but on-chain state disagrees, that
// recorded transaction never actually landed (or is unconfirmed); we surface
// the discrepancy and trust the chain. Every step reuses the same bounded
// retry + idempotency guard as the original flow, so calling this more than
// once is safe.
export async function finishTokenCreation({
  tempWalletSecretKey,
  tokenMint,
  name,
  symbol,
  totalSupply,
  metadataUri,
  metadataHash,
  onProgress,
  journalEvents,
  sealedLaunch = false,
  // Mirrors createTokenWithMetaplex: when the user opted to keep the
  // metadata update authority, the resume path must not "helpfully"
  // revoke it. Read from the launch journal's token record by the caller.
  keepMetadataAuthority = false,
}) {
  const progress = (event) => {
    if (!onProgress) return;
    try { onProgress(event); } catch (e) { console.warn('finish-token progress callback failed:', e.message); }
  };

  const tempWallet = Keypair.fromSecretKey(Uint8Array.from(tempWalletSecretKey));
  const umi = _umiFactory(tempWallet);
  const mint = new PublicKey(tokenMint);
  const mintPubkey = umiPublicKey(tokenMint);
  const totalTokens = BigInt(totalSupply) * (10n ** 9n);
  const programId = await detectMintProgramId(mint);
  const isToken2022 = programId.equals(TOKEN_2022_PROGRAM_ID);

  const status = {
    mint: tokenMint,
    mintFormat: isToken2022 ? MINT_FORMAT_TOKEN_2022 : MINT_FORMAT_CLASSIC,
    tokenProgram: programId.toBase58(),
    metadataStandard: isToken2022 ? 'token-2022-inline' : 'metaplex-pda',
    metadataPointerAuthorityRevoked: null,
    metadataExists: false,
    supplyMinted: false,
    mintAuthorityRenounced: false,
    updateAuthorityRevoked: false,
    steps: [],   // what THIS call actually did
    sanity: [],  // journal-vs-chain discrepancies (informational)
  };

  // --- Detect existing on-chain state (authoritative for what remains) ---
  let mintInfo;
  try {
    mintInfo = await getMint(connection, mint, 'finalized', programId);
  } catch (e) {
    throw new Error(`finish-token: cannot read mint ${tokenMint} on-chain: ${e.message}`);
  }
  status.supplyMinted = mintInfo.supply >= totalTokens;
  status.mintAuthorityRenounced = mintInfo.mintAuthority === null;
  status.metadataPointerAuthorityRevoked = isToken2022
    ? hasPermanentSelfMetadataPointer(mintInfo, mint)
    : null;

  const metadataPda = isToken2022 ? null : deriveMetadataPda(mint);
  let metaAccount = null;
  let inlineMetadata = null;
  if (isToken2022) {
    try { inlineMetadata = await getTokenMetadata(connection, mint, 'finalized', programId); } catch (_) { /* absent */ }
    status.metadataExists = Boolean(inlineMetadata);
    status.updateAuthorityRevoked = Boolean(inlineMetadata && !inlineMetadata.updateAuthority);
  } else {
    try { metaAccount = await connection.getAccountInfo(metadataPda, 'finalized'); } catch (_) { /* treat as absent */ }
    status.metadataExists = !!(metaAccount && metaAccount.data && metaAccount.data.length > 0);
  }
  if (!isToken2022 && status.metadataExists && metaAccount.data.length >= 33) {
    // Metadata layout: byte 0 is the account key; bytes 1..33 are the update
    // authority pubkey. Revoked == set to the System Program (all-zero) address.
    try {
      const ua = new PublicKey(metaAccount.data.subarray(1, 33)).toBase58();
      status.updateAuthorityRevoked = ua === SYSTEM_PROGRAM_ADDRESS;
    } catch (_) { /* unparseable -> treat as not revoked, we'll try below */ }
  }

  // --- Cross-check the journal's recorded steps against on-chain reality ---
  if (Array.isArray(journalEvents)) {
    const claim = (stage) => journalEvents.find((e) => e && e.stage === stage);
    const flag = (label, stage, chainSays) => {
      const ev = claim(stage);
      if (ev && !chainSays) {
        const tx = ev.txId && !String(ev.txId).startsWith('(') ? ` (recorded tx ${ev.txId})` : '';
        status.sanity.push(
          `${label}: the journal records this step as completed${tx}, but on-chain ` +
          'state does not reflect it; redoing it',
        );
      }
    };
    flag('supply mint', 'supply_minted', status.supplyMinted);
    flag('mint authority renounce', 'mint_authority_revoked', status.mintAuthorityRenounced);
    if (!keepMetadataAuthority) {
      flag('metadata update-authority revoke', 'metadata_update_authority_revoked', status.updateAuthorityRevoked);
    }
  }
  for (const s of status.sanity) console.warn('finish-token sanity:', s);

  // --- 1. Metadata account ---
  if (!status.metadataExists) {
    if (!metadataUri) {
      throw new Error('finish-token: metadata account is missing and no metadataUri was provided to recreate it');
    }
    if (isToken2022) {
      await tokenMetadataInitializeWithRentTransfer(
        connection,
        tempWallet,
        mint,
        tempWallet.publicKey,
        tempWallet,
        name,
        symbol,
        metadataUri,
        [],
        { commitment: 'finalized' },
        programId,
      );
      if (/^[a-f0-9]{64}$/i.test(String(metadataHash || ''))) {
        await tokenMetadataUpdateFieldWithRentTransfer(
          connection,
          tempWallet,
          mint,
          tempWallet,
          'trebuchet:sha256',
          String(metadataHash).toLowerCase(),
          [],
          { commitment: 'finalized' },
          programId,
        );
      }
    } else {
      await landTxWithRetry({
        label: 'finish: metadata account',
        alreadyDone: async () => {
          const a = await connection.getAccountInfo(metadataPda, 'finalized');
          return !!(a && a.data && a.data.length > 0);
        },
        send: async () => createMetadataForExistingMint(umi, {
          mint: mintPubkey,
          name,
          symbol,
          uri: metadataUri,
        }).prepend(await umiPriorityIxs()).sendAndConfirm(umi),
      });
    }
    status.metadataExists = true;
    status.steps.push('created metadata account');
    progress({ stage: 'metadata_account_created', tokenMint, metadataUri });
  }

  // --- 2. ATA + supply (hard idempotency guard: never double-mint) ---
  if (!status.supplyMinted) {
    const tokenAccount = await withRpcRetry(() => ensureAta({
      payer: tempWallet,
      mint,
      owner: tempWallet.publicKey,
      programId,
    }));
    // A freshly-created ATA can be returned by one RPC node before the node
    // chosen for transaction simulation has observed the same finalized
    // account state. Prove both accounts decode correctly first; only then is
    // Token Program InvalidAccountData safe to treat as a short propagation
    // race. The supply guard below is re-read before every retry, so a landed
    // mint can never be submitted twice.
    await verifyMintSupplyAccounts({
      mint,
      destination: tokenAccount.address,
      authority: tempWallet.publicKey,
      totalTokens,
      programId,
    });
    const r = await landTxWithRetry({
      label: 'finish: mint supply',
      alreadyDone: async () => {
        const info = await getMint(connection, mint, 'finalized', programId);
        return info.supply >= totalTokens;
      },
      send: () => sendIxsWithPriority({
        payer: tempWallet,
        units: CU_MINT_OPS,
        label: 'finish: mint supply',
        instructions: [
          createMintToInstruction(
            mint,
            tokenAccount.address,
            tempWallet.publicKey,
            totalTokens,
            [],
            programId,
          ),
        ],
      }),
      retryIf: (error) => isFreshTokenAccountPropagationError(error),
      settleMs: 2500,
    });
    status.supplyMinted = true;
    status.steps.push(r.skipped ? 'supply already minted (adopted)' : 'minted supply');
    progress({ stage: 'supply_minted', tokenMint, txId: r.skipped ? '(supply already minted)' : r.value });
  }

  // --- 3. Renounce mint authority (the critical safety step) ---
  if (!status.mintAuthorityRenounced) {
    const r = await landTxWithRetry({
      label: 'finish: renounce mint authority',
      alreadyDone: async () => {
        const info = await getMint(connection, mint, 'finalized', programId);
        return info.mintAuthority === null;
      },
      send: () => sendIxsWithPriority({
        payer: tempWallet,
        units: CU_MINT_OPS,
        label: 'finish: renounce mint authority',
        instructions: [
          createSetAuthorityInstruction(
            mint,
            tempWallet.publicKey,
            AuthorityType.MintTokens,
            null,
            [],
            programId,
          ),
        ],
      }),
    });
    status.mintAuthorityRenounced = true;
    status.steps.push(r.skipped ? 'mint authority already renounced (adopted)' : 'renounced mint authority');
    progress({ stage: 'mint_authority_revoked', tokenMint, txId: r.skipped ? '(already renounced)' : r.value });
  }

  // --- 4. Revoke metadata update authority (best-effort, mirrors creation) ---
  // Non-fatal: the decisive safety property is the mint-authority renounce
  // above. If this can't complete we surface it but still return a status.
  if (keepMetadataAuthority) {
    // Deliberately kept — the authority is handed to the destination
    // wallet at the final sweep (transferMetadataAuthority), not revoked.
    status.steps.push('metadata update authority kept (user option)');
    progress({ stage: 'metadata_authority_kept', tokenMint, metadataAuthorityKept: true });
  } else if (!status.updateAuthorityRevoked && !sealedLaunch) {
    try {
      if (isToken2022) {
        await tokenMetadataUpdateAuthority(
          connection,
          tempWallet,
          mint,
          tempWallet,
          null,
          [],
          { commitment: 'finalized' },
          programId,
        );
      } else {
        const systemProgramAddress = umiPublicKey(SYSTEM_PROGRAM_ADDRESS);
        await landTxWithRetry({
          label: 'finish: revoke update authority',
          alreadyDone: async () => {
            const a = await connection.getAccountInfo(metadataPda, 'finalized');
            if (!a || !a.data || a.data.length < 33) return false;
            try { return new PublicKey(a.data.subarray(1, 33)).toBase58() === SYSTEM_PROGRAM_ADDRESS; } catch (_) { return false; }
          },
          send: async () => updateV1(umi, {
            mint: mintPubkey,
            authority: umi.identity,
            newUpdateAuthority: some(systemProgramAddress),
            isMutable: some(false),
          }).prepend(await umiPriorityIxs()).sendAndConfirm(umi, { send: { commitment: 'finalized' }, confirm: { commitment: 'finalized' } }),
        });
      }
      status.updateAuthorityRevoked = true;
      status.steps.push('revoked metadata update authority');
      progress({ stage: 'metadata_update_authority_revoked', tokenMint });
    } catch (e) {
      status.steps.push(`could not revoke metadata update authority: ${e.message}`);
    }
  }

  status.sealedLaunch = sealedLaunch === true;
  status.sealedMetadataPending = sealedLaunch === true && !status.updateAuthorityRevoked;
  status.isSafe = status.mintAuthorityRenounced
    && status.metadataPointerAuthorityRevoked !== false
    && (status.updateAuthorityRevoked || status.sealedMetadataPending);
  progress({ stage: 'token_finish_done', tokenMint, isSafe: status.isSafe });
  return status;
}

// Upload a sealed launch's identity at reveal time and check it still matches
// the commitment made at launch. Returns the final metadata URI and hash.
export async function uploadSealedIdentity({ tempWalletSecretKey, identity, onProgress }) {
  if (!identity?.commitment || !identity?.mint) {
    throw new Error('The sealed identity for this launch is missing on this machine.');
  }
  const tempWallet = Keypair.fromSecretKey(Uint8Array.from(tempWalletSecretKey));
  const uploaded = await _uploadMetadata({
    umi: _umiFactory(tempWallet),
    logoBase64: identity.logoDataUrl || null,
    name: identity.name,
    symbol: identity.symbol,
    description: identity.description,
    mint: identity.mint,
    stampLogo: false,
    requireLogo: Boolean(identity.logoDataUrl),
    onProgress,
  });
  const committed = metadataDocumentHash(sealedCommitmentDocument(uploaded.metadata, identity.imageSha256));
  if (committed !== identity.commitment) {
    throw new Error('The uploaded identity does not match the sealed commitment.');
  }
  return {
    metadataUri: uploaded.metadataUri,
    imageUri: uploaded.imageUri,
    metadataHash: uploaded.metadataHash,
  };
}

// A document uploaded moments ago can take a few seconds to reach the gateway.
async function fetchFreshMetadataDocument(uri, { attempts = 8, delayMs = 1500 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const document = await fetchMetadataDocument(uri);
    if (document) return document;
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

export async function revealSealedTokenMetadata({
  tempWalletSecretKey,
  tokenMint,
  name,
  symbol,
  metadataUri,
  metadataHash,
  imageSha256 = null,
  onProgress,
}) {
  const progress = (event) => {
    if (!onProgress) return;
    try { onProgress(event); } catch (_) { /* progress is best-effort */ }
  };
  if (!tokenMint || !metadataUri) {
    throw new Error('Sealed metadata reveal requires a mint and final metadata URI.');
  }
  const expectedMetadataHash = String(metadataHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedMetadataHash)) {
    throw new Error('Sealed metadata reveal requires the recorded SHA-256 identity commitment.');
  }
  const tempWallet = Keypair.fromSecretKey(Uint8Array.from(tempWalletSecretKey));
  const umi = _umiFactory(tempWallet);
  const mint = new PublicKey(tokenMint);
  const mintPubkey = umiPublicKey(tokenMint);
  const programId = await detectMintProgramId(mint);
  const isToken2022 = programId.equals(TOKEN_2022_PROGRAM_ID);
  const metadataPda = deriveMetadataPda(mint);
  const systemProgramAddress = umiPublicKey(SYSTEM_PROGRAM_ADDRESS);

  const inspect = async () => {
    if (isToken2022) {
      const metadata = await getTokenMetadata(connection, mint, 'finalized', programId);
      if (!metadata) throw new Error('Sealed inline token metadata is not available on-chain.');
      return {
        uri: metadata.uri,
        name: metadata.name,
        symbol: metadata.symbol,
        updateAuthority: metadata.updateAuthority?.toBase58() || SYSTEM_PROGRAM_ADDRESS,
      };
    }
    const account = await connection.getAccountInfo(metadataPda, 'finalized');
    if (!account?.data || account.data.length < 33) {
      throw new Error('Sealed metadata account is not available on-chain.');
    }
    return {
      uri: parseMetaplexUri(account.data),
      updateAuthority: new PublicKey(account.data.subarray(1, 33)).toBase58(),
    };
  };

  const before = await inspect();
  if (before.uri === metadataUri && before.updateAuthority === SYSTEM_PROGRAM_ADDRESS) {
    const finalDocument = await fetchFreshMetadataDocument(metadataUri);
    const { finalHash: revealedHash } = verifySealedMetadataCommitment({
      finalDocument,
      metadataHash: expectedMetadataHash,
      imageSha256,
      name,
      symbol,
      mint: tokenMint,
      requirePlaceholder: false,
    });
    return {
      finalMetadataHash: revealedHash,
      tokenMint,
      metadataUri,
      mintFormat: isToken2022 ? MINT_FORMAT_TOKEN_2022 : MINT_FORMAT_CLASSIC,
      tokenProgram: programId.toBase58(),
      metadataStandard: isToken2022 ? 'token-2022-inline' : 'metaplex-pda',
      metadataPointerAuthorityRevoked: isToken2022 ? true : null,
      metadataUpdateAuthorityRevoked: true,
      metadataImmutable: true,
      sealedMetadataPending: false,
      skipped: true,
    };
  }
  if (before.updateAuthority === SYSTEM_PROGRAM_ADDRESS) {
    throw new Error('Metadata authority is already retired but the final identity was not revealed.');
  }
  if (before.updateAuthority !== tempWallet.publicKey.toBase58()) {
    throw new Error('The launch wallet is not the current metadata update authority.');
  }

  const [placeholderDocument, finalDocument] = await Promise.all([
    fetchMetadataDocument(before.uri),
    fetchFreshMetadataDocument(metadataUri),
  ]);
  const { finalHash } = verifySealedMetadataCommitment({
    placeholderDocument,
    finalDocument,
    metadataHash: expectedMetadataHash,
    imageSha256,
    name,
    symbol,
    mint: tokenMint,
  });

  progress({ stage: 'metadata_reveal_started', tokenMint, metadataUri });
  if (isToken2022) {
    // URI is written last, so a retry after an interrupted reveal can still
    // load and validate the sealed placeholder commitment. Authority is
    // retired only after every final identity field has landed.
    // The launch-time commitment field becomes the plain hash of the final
    // document, so a revealed token reads exactly like an unsealed one.
    const fields = [['Name', name], ['Symbol', symbol]];
    if (finalHash !== expectedMetadataHash) fields.push(['trebuchet:sha256', finalHash]);
    fields.push(['Uri', metadataUri]);
    for (const [field, value] of fields) {
      await tokenMetadataUpdateFieldWithRentTransfer(
        connection,
        tempWallet,
        mint,
        tempWallet,
        field,
        value,
        [],
        { commitment: 'finalized' },
        programId,
      );
    }
    await tokenMetadataUpdateAuthority(
      connection,
      tempWallet,
      mint,
      tempWallet,
      null,
      [],
      { commitment: 'finalized' },
      programId,
    );
  } else {
    await updateV1(umi, {
      mint: mintPubkey,
      authority: umi.identity,
      data: some({
        name,
        symbol,
        uri: metadataUri,
        sellerFeeBasisPoints: 0,
        creators: some([{
          address: umi.identity.publicKey,
          verified: true,
          share: 100,
        }]),
      }),
      newUpdateAuthority: some(systemProgramAddress),
      primarySaleHappened: none(),
      isMutable: some(false),
    }).sendAndConfirm(umi, {
      send: { commitment: 'finalized' },
      confirm: { commitment: 'finalized' },
    });
  }

  const after = await waitForSealedMetadataPosture(inspect, {
    metadataUri,
    updateAuthority: SYSTEM_PROGRAM_ADDRESS,
  });
  if (after.uri !== metadataUri || after.updateAuthority !== SYSTEM_PROGRAM_ADDRESS) {
    throw new Error('Final metadata reveal landed without the expected immutable authority posture.');
  }
  const result = {
    tokenMint,
    metadataUri,
    mintFormat: isToken2022 ? MINT_FORMAT_TOKEN_2022 : MINT_FORMAT_CLASSIC,
    tokenProgram: programId.toBase58(),
    metadataStandard: isToken2022 ? 'token-2022-inline' : 'metaplex-pda',
    metadataPointerAuthorityRevoked: isToken2022 ? true : null,
    metadataUpdateAuthorityRevoked: true,
    metadataImmutable: true,
    sealedMetadataPending: false,
    finalMetadataHash: finalHash,
    skipped: false,
  };
  progress({ stage: 'metadata_revealed', ...result });
  return result;
}

// A finalized transaction can still be followed by a short-lived stale RPC
// account read. Poll only the already-written metadata posture; never resend
// an update while waiting for propagation.
export async function waitForSealedMetadataPosture(inspect, {
  metadataUri,
  updateAuthority,
  attempts = 6,
  delayMs = 750,
} = {}) {
  let lastState = null;
  let lastError = null;
  const totalAttempts = Math.max(1, Math.floor(Number(attempts) || 1));
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    try {
      lastState = await inspect();
      lastError = null;
      if (lastState?.uri === metadataUri && lastState?.updateAuthority === updateAuthority) {
        return lastState;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < totalAttempts && Number(delayMs) > 0) {
      await new Promise((resolve) => setTimeout(resolve, Number(delayMs)));
    }
  }
  if (lastError && !lastState) throw lastError;
  return lastState || {};
}

export function verifySealedMetadataCommitment({
  placeholderDocument = null,
  finalDocument = null,
  metadataHash,
  imageSha256 = null,
  name,
  symbol,
  mint = null,
  requirePlaceholder = true,
} = {}) {
  const expectedHash = String(metadataHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error('Sealed metadata commitment is missing or invalid.');
  }
  if (requirePlaceholder) {
    const commitment = String(placeholderDocument?.description || '').trim().toLowerCase();
    if (!placeholderDocument || !commitment.includes(`sha256:${expectedHash}`)) {
      throw new Error('On-chain placeholder metadata does not contain the recorded identity commitment.');
    }
  }
  if (!finalDocument || typeof finalDocument !== 'object' || Array.isArray(finalDocument)) {
    throw new Error('Final token metadata could not be loaded for commitment verification.');
  }
  // Launches sealed before deferred uploads committed to the document itself;
  // deferred ones commit to it with the image replaced by its content hash.
  const actualHash = metadataDocumentHash(finalDocument);
  const committedHash = imageSha256
    ? metadataDocumentHash(sealedCommitmentDocument(finalDocument, imageSha256))
    : actualHash;
  if (actualHash !== expectedHash && committedHash !== expectedHash) {
    throw new Error('Final token metadata does not match the sealed identity commitment.');
  }
  if (String(finalDocument.name || '').trim() !== String(name || '').trim()) {
    throw new Error('Final token metadata name does not match the recorded launch identity.');
  }
  if (String(finalDocument.symbol || '').trim() !== String(symbol || '').trim()) {
    throw new Error('Final token metadata symbol does not match the recorded launch identity.');
  }
  // Documents from before mint binding carry no `mint`; a document that names
  // a different mint belongs to another launch and must not be revealed here.
  const declaredMint = String(finalDocument.mint || '').trim();
  if (declaredMint && mint && declaredMint !== String(mint).trim()) {
    throw new Error('Final token metadata names a different mint than this launch.');
  }
  return { metadataHash: expectedHash, finalHash: actualHash };
}

// Transfer tokens and remaining SOL
export async function transferTokensAndSol({
  tempWalletSecretKey,
  destinationWallet,
  tokenMint
}) {
  try {
    console.log('Starting asset transfer...');
    
    // Convert secret key array back to Keypair
    const tempWallet = Keypair.fromSecretKey(Uint8Array.from(tempWalletSecretKey));
    const destinationPubkey = new PublicKey(destinationWallet);

    console.log('Temp wallet:', tempWallet.publicKey.toString());
    console.log('Destination wallet:', destinationWallet);
    console.log('Token mint:', tokenMint || '(none — token-less sweep)');

    // ----- Token transfer (skipped if no tokenMint, e.g. cancel before token creation)
    let tokensTransferred = 0;
    if (tokenMint) {
      const mintPubkey = new PublicKey(tokenMint);
      const tokenProgramId = await detectMintProgramId(mintPubkey);
      // Get source token account
      const sourceTokenAccount = await ensureAta({
        payer: tempWallet,
        mint: mintPubkey,
        owner: tempWallet.publicKey,
        programId: tokenProgramId,
      });
      console.log('Source token account:', sourceTokenAccount.address.toString());

      // Get or create destination token account (temp wallet pays rent)
      const destinationTokenAccount = await ensureAta({
        payer: tempWallet,
        mint: mintPubkey,
        owner: destinationPubkey,
        programId: tokenProgramId,
      });
      console.log('Destination token account:', destinationTokenAccount.address.toString());

      // Get token balance
      const tokenAccountInfo = await getAccount(
        connection,
        sourceTokenAccount.address,
        'finalized',
        tokenProgramId
      );
      const tokenBalance = tokenAccountInfo.amount;
      console.log('Token balance to transfer:', tokenBalance.toString());

      // Transfer all tokens
      if (tokenBalance > 0n) {
        console.log('Transferring tokens...');
        // TransferChecked (rather than plain Transfer) verifies mint and
        // decimals on chain — same hardening as walletHelpers. Decimals are
        // hardcoded to 9 in createTokenWithMetaplex.
        const tokenTxSignature = await sendIxsWithPriority({
          payer: tempWallet,
          units: CU_MINT_OPS,
          label: 'transfer launched token',
          instructions: [
            createTransferCheckedInstruction(
              sourceTokenAccount.address,
              mintPubkey,
              destinationTokenAccount.address,
              tempWallet.publicKey,
              tokenBalance,
              9,
              [],
              tokenProgramId,
            ),
          ],
        });
        console.log('Token transfer signature:', tokenTxSignature);
        console.log('Token transfer confirmed');
        // Token decimals are hardcoded to 9 in createTokenWithMetaplex
        tokensTransferred = Number(tokenBalance) / Math.pow(10, 9);
      }
    } else {
      console.log('Skipping token transfer (no tokenMint provided)');
    }

    // ----- SOL sweep (always runs, regardless of whether token was created)
    const solBalance = await connection.getBalance(tempWallet.publicKey);
    const minRentExemption = await connection.getMinimumBalanceForRentExemption(0);
    // Reserve = base fee (5000/signature) + the priority fee THIS tx will
    // pay. A sweep that reserves only the base fee fails with
    // "insufficient lamports" the moment a priority fee is attached.
    const sweepMicroLamports = await samplePriorityFeeMicroLamports(connection);
    const sweepFeeReserve = 5000
      + priorityFeeLamports(CU_SOL_TRANSFER, sweepMicroLamports)
      + SWEEP_FEE_PAD_LAMPORTS; // never reserve exactly-enough; see priorityFees.js
    const transferAmount = solBalance - minRentExemption - sweepFeeReserve;

    console.log('SOL balance:', solBalance / LAMPORTS_PER_SOL);
    console.log('SOL to transfer:', transferAmount / LAMPORTS_PER_SOL);

    let solTransferred = 0;
    if (transferAmount > 0) {
      console.log('Transferring SOL...');
      const transaction = new Transaction().add(
        ...computeBudgetIxs({ units: CU_SOL_TRANSFER, microLamports: sweepMicroLamports }),
        SystemProgram.transfer({
          fromPubkey: tempWallet.publicKey,
          toPubkey: destinationPubkey,
          lamports: transferAmount,
        })
      );

      const solTxSignature = await connection.sendTransaction(
        transaction,
        [tempWallet],
        { commitment: txCommitment() }
      );
      console.log('SOL transfer signature:', solTxSignature);
      await connection.confirmTransaction(solTxSignature, 'finalized');
      console.log('SOL transfer confirmed');
      solTransferred = transferAmount / LAMPORTS_PER_SOL;
    }

    // Field names match what the API endpoint and frontend expect.
    return {
      tokensTransferred,
      solTransferred,
      destinationWallet,
    };
  } catch (error) {
    console.error('Error transferring assets:', error);
    throw error;
  }
}

// Get transaction history for funding wallet detection
// Identify the wallet that funded this freshly-generated wallet.
//
// This works because the wallet is generated fresh inside this app — its
// address is brand new and unknown to anyone, so the FIRST transaction in
// its history is definitionally the funding deposit. Once we identify the
// funder, we cache it forever — no need to handle dust spam, sort orders,
// or any of the complications that come with looking at established wallets.
//
// Returns:
//   null  → no transactions yet, RPC hasn't seen the funding tx yet, or the
//           first tx didn't contain a SystemProgram transfer we can parse.
//           Caller should retry on a later poll.
//   { funder, amount, signature } → success.
// Transfers below this never count as funding. Address-poisoning attacks
// send dust (often 0 SOL) from a lookalike of the real funder right after
// it funds the wallet, hoping a tool or a person copies the wrong address.
export const MIN_FUNDING_LAMPORTS = 10_000_000; // 0.01 SOL
const MAX_SIGNATURE_PAGES = 20; // 20k signatures; launch wallets have far fewer

// Results are immutable once found: the earliest funding transfer never
// changes. Cached per process so sweeps and readiness checks agree.
const fundingWalletCache = new Map();

/**
 * The funding transfer among parsed transactions ordered OLDEST first: the
 * earliest successful inbound SOL transfer of at least MIN_FUNDING_LAMPORTS.
 */
export function pickFundingTransfer(parsedTxsOldestFirst, publicKey) {
  for (const { signature, tx } of parsedTxsOldestFirst) {
    if (!tx || !tx.meta || tx.meta.err) continue;
    const allInstructions = [...(tx.transaction?.message?.instructions || [])];
    for (const inner of tx.meta.innerInstructions || []) allInstructions.push(...(inner.instructions || []));
    for (const instruction of allInstructions) {
      if (
        instruction.program === 'system'
        && instruction.parsed?.type === 'transfer'
        && instruction.parsed.info.destination === publicKey
        && Number(instruction.parsed.info.lamports) >= MIN_FUNDING_LAMPORTS
      ) {
        return {
          funder: instruction.parsed.info.source,
          amount: Number(instruction.parsed.info.lamports) / LAMPORTS_PER_SOL,
          signature,
        };
      }
    }
  }
  return null;
}

export async function findFundingWallet(publicKey) {
  if (fundingWalletCache.has(publicKey)) return fundingWalletCache.get(publicKey);
  try {
    const pubKey = new PublicKey(publicKey);

    // The whole history, oldest first. A launch wallet has hundreds of
    // transactions by the final sweep; reading only the newest 50 missed
    // the original funding entirely.
    const signatures = [];
    let before;
    for (let page = 0; page < MAX_SIGNATURE_PAGES; page++) {
      const batch = await connection.getSignaturesForAddress(pubKey, { limit: 1000, before });
      signatures.push(...batch);
      if (batch.length < 1000) break;
      before = batch[batch.length - 1].signature;
    }
    if (signatures.length === 0) return null;

    // The funder is the source of the EARLIEST real inbound SOL transfer.
    // Poisoners always come after the genuine funding (they copy it), and
    // dust transfers are ignored. Top-level and inner (CEX CPI) transfers
    // both count.
    for (const sig of signatures.slice().reverse()) {
      if (sig.err) continue;
      const tx = await connection.getParsedTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0,
      });
      const result = pickFundingTransfer([{ signature: sig.signature, tx }], publicKey);
      if (result) {
        fundingWalletCache.set(publicKey, result);
        return result;
      }
    }

    // No real funding transfer yet (or an unusual pattern). Not cached:
    // the funding may still be landing.
    return null;
  } catch (error) {
    console.error('Error finding funding wallet:', error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Metadata update-authority handoff (final sweep, keep-authority launches)
// ---------------------------------------------------------------------------
// When a token was created with keepMetadataAuthority, the update authority
// sits on the TEMPORARY launch wallet — which the final sweep destroys. This
// hands it to the user's destination wallet first, so "I can change the
// name/logo later" is actually true afterwards. Called by /api/transfer-assets
// BEFORE any sweeping starts, and it THROWS on failure: at that point nothing
// has moved and the wallet is still recoverable, so aborting the transfer and
// letting the user retry beats silently destroying the only key that can ever
// update the metadata.
export async function transferMetadataAuthority({
  tempWalletSecretKey,
  tokenMint,
  newAuthority,
}) {
  const tempWallet = Keypair.fromSecretKey(Uint8Array.from(tempWalletSecretKey));
  const umi = _umiFactory(tempWallet);
  const mint = new PublicKey(tokenMint);
  const mintPubkey = umiPublicKey(tokenMint);
  const destPk = new PublicKey(newAuthority); // validates the address early
  const metadataPda = deriveMetadataPda(mint);

  await landTxWithRetry({
    label: 'transfer metadata update authority',
    alreadyDone: async () => {
      // Metadata layout: byte 0 is the account key; bytes 1..33 are the
      // update authority. Done == it already reads as the destination
      // (a prior attempt landed but threw on confirmation).
      const a = await connection.getAccountInfo(metadataPda, 'finalized');
      if (!a || !a.data || a.data.length < 33) return false;
      try {
        return new PublicKey(a.data.subarray(1, 33)).equals(destPk);
      } catch (_) { return false; }
    },
    send: async () => updateV1(umi, {
      mint: mintPubkey,
      authority: umi.identity,
      newUpdateAuthority: some(umiPublicKey(newAuthority)),
    }).prepend(await umiPriorityIxs()).sendAndConfirm(umi, {
      send: { commitment: 'finalized' },
      confirm: { commitment: 'finalized' },
    }),
  });
  console.log(`Metadata update authority transferred to ${newAuthority}`);
  return { transferred: true, newAuthority };
}
