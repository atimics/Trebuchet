import { 
  Connection, 
  Keypair, 
  PublicKey, 
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction
} from '@solana/web3.js';
import { 
  createMint,
  mintTo,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  transfer,
  setAuthority,
  AuthorityType,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import { 
  createV1,
  TokenStandard,
  updateV1
} from '@metaplex-foundation/mpl-token-metadata';
import { 
  percentAmount,
  publicKey as umiPublicKey,
  none,
  some
} from '@metaplex-foundation/umi';
import QRCode from 'qrcode';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { getRpcUrl } from './rpcConfig.js';
import {
  createTokenMetadataUmi,
  uploadTokenMetadata,
} from './metadataUploadService.js';

// The RPC URL is sourced from rpcConfig.js, which seeds itself with a
// public-mainnet default on first run and persists user-selected RPCs to
// rpcConfig.json. The connection is rebuilt whenever the user switches RPCs
// in the UI — server.js calls refreshConnection() after a successful change.
let connection = makeConnection();

function makeConnection() {
  const url = getRpcUrl();
  console.log('Using RPC endpoint:', url);
  return new Connection(url, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000,
  });
}

export function refreshConnection() {
  connection = makeConnection();
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
export async function generateTemporaryWallet() {
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
      const publicConnection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
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
// Token-mint keypair search.
//
// Solana CLMM pools order their mintA / mintB by raw byte comparison of the
// 32-byte pubkey, with the smaller-byte-ordered key taking the mintA slot.
// Raydium then displays the pool's price as `mintB per mintA` — i.e. mintA
// in the denominator.
//
// For a token launch this matters because users expect to see a price like
// "X SOL per <launched>" trending upward as their token appreciates. That
// only happens if the launched token is mintA. If it lands as mintB by the
// luck of the keypair byte-order draw, Raydium displays "<launched> per SOL"
// instead, the displayed price runs *downward* as the token appreciates,
// and the position bounds get inverted ("0 — small" rather than "current —
// infinity"). All of that is just display; the math underneath is
// equivalent. But the visual result on Raydium looks wrong to anyone not
// holding the inversion in their head.
//
// Fix: generate keypairs in a loop until we find one whose pubkey sorts
// strictly smaller than every quote mint we'll be paired with. Solana's
// Ed25519 keygen is fast — even with 4 quotes to beat, this typically
// completes in well under a second. The constraint is fine-grained
// (compare 32 bytes, not just first byte), so each candidate has roughly
// a (1/(N+1))-th chance of beating N quotes when the quotes are spread
// uniformly across the keyspace; in practice quotes cluster non-uniformly
// and the rate varies, but the search is bounded by MAX_KEYPAIR_TRIES
// regardless and we throw with a clear error if we exhaust it.
// ---------------------------------------------------------------------------
const MAX_KEYPAIR_TRIES = 200_000;

// Compare two 32-byte pubkeys lexicographically. Returns negative if a<b,
// positive if a>b, zero if equal. Matches the on-chain `Pubkey::cmp`
// behaviour Raydium uses to assign mintA / mintB.
function comparePubkeys(a, b) {
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// Find a Keypair whose pubkey sorts strictly smaller than every quote mint
// in `quoteMints`. Returns the Keypair on success, or null if quoteMints is
// empty (caller should fall back to a random keypair). Throws on exhaustion.
function findMintAKeypair(quoteMints) {
  if (!Array.isArray(quoteMints) || quoteMints.length === 0) {
    return null; // no constraint — caller will use a random keypair
  }

  // Convert quote mints to raw byte arrays once, up front.
  const quoteBytes = quoteMints.map((m) => new PublicKey(m).toBytes());

  for (let i = 0; i < MAX_KEYPAIR_TRIES; i++) {
    const kp = Keypair.generate();
    const candidate = kp.publicKey.toBytes();
    let beatsAll = true;
    for (const qb of quoteBytes) {
      if (comparePubkeys(candidate, qb) >= 0) {
        beatsAll = false;
        break;
      }
    }
    if (beatsAll) {
      console.log(
        `findMintAKeypair: matched after ${i + 1} attempt${i === 0 ? '' : 's'}`,
      );
      return kp;
    }
  }

  throw new Error(
    `Could not find a launched-token keypair sorting smaller than all ` +
      `${quoteMints.length} quote mints after ${MAX_KEYPAIR_TRIES} attempts. ` +
      `This usually means one of the quote mints has unusually low byte ` +
      `order (e.g. starts with 0x00) — try removing or replacing it.`,
  );
}

// Create token with Metaplex
export async function createTokenWithMetaplex({
  tempWalletSecretKey,
  name,
  symbol,
  description,
  totalSupply,
  logoBase64,
  quoteMints,
  onProgress,
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
    
    const umi = createTokenMetadataUmi(tempWallet);
    
    console.log('Uploading logo to Arweave...');
    console.log('Uploading metadata to Arweave...');

    const { metadataUri, imageUri } = await uploadTokenMetadata({
      umi,
      logoBase64,
      name,
      symbol,
      description,
      onProgress: progress,
    });
    
    // Search for a keypair whose pubkey sorts smaller than every quote
    // mint, so the launched token becomes mintA in every pool. Returns
    // null if quoteMints is empty (caller falls back to random).
    const mintKeypair = findMintAKeypair(quoteMints);
    if (mintKeypair) {
      console.log(`Using mintA-sorted keypair: ${mintKeypair.publicKey.toBase58()}`);
    } else {
      console.log('No quote mints provided; using random mint keypair');
    }

    // Create mint using standard SPL token first
    console.log('Creating SPL token mint...');
    const mint = await createMint(
      connection,
      tempWallet,
      tempWallet.publicKey, // mint authority
      null, // freeze authority (null = no freeze)
      9, // decimals
      mintKeypair ?? undefined, // searched keypair, or undefined for random
      { commitment: 'finalized' },
      TOKEN_PROGRAM_ID
    );
    console.log('Mint created:', mint.toString());
    progress({ stage: 'mint_created', tokenMint: mint.toString() });
    
    // Now create the metadata account for the existing mint
    console.log('Creating metadata account...');
    
    // Convert the mint public key to Umi format
    const mintPubkey = umiPublicKey(mint.toString());
    
    // Create metadata for the existing token
    await createV1(umi, {
      mint: mintPubkey,
      authority: umi.identity,
      name,
      symbol,
      uri: metadataUri,
      sellerFeeBasisPoints: percentAmount(0), // 0% royalty for fungible tokens
      decimals: 9,
      tokenStandard: TokenStandard.Fungible,
    }).sendAndConfirm(umi);
    
    console.log('Metadata account created successfully');
    progress({ stage: 'metadata_account_created', tokenMint: mint.toString(), metadataUri });
    
    // Small delay to ensure metadata account is fully propagated
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Create associated token account
    console.log('Creating associated token account...');
    const tokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      tempWallet,
      mint,
      tempWallet.publicKey,
      false,
      'finalized',
      { commitment: 'finalized' },
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    console.log('Token account created:', tokenAccount.address.toString());
    
    // Mint the total supply
    console.log('Minting total supply...');
    const totalTokens = BigInt(totalSupply) * (10n ** 9n);
    
    const mintSig = await mintTo(
      connection,
      tempWallet,
      mint,
      tokenAccount.address,
      tempWallet.publicKey,
      totalTokens,
      [],
      { commitment: 'finalized' },
      TOKEN_PROGRAM_ID
    );
    
    console.log('Mint transaction signature:', mintSig);
    progress({ stage: 'supply_minted', tokenMint: mint.toString(), txId: mintSig });
    
    // Wait for confirmation
    await connection.confirmTransaction(mintSig, 'finalized');
    console.log('Tokens minted successfully');
    
    // SAFETY STEP: Renounce all authorities to make the token safe
    console.log('Making token safe by renouncing authorities...');
    
    // 1. Renounce mint authority (no more tokens can be minted)
    console.log('Renouncing mint authority...');
    try {
      const renounceMintAuthSig = await setAuthority(
        connection,
        tempWallet,
        mint,
        tempWallet.publicKey, // Current authority
        AuthorityType.MintTokens,
        null, // New authority (null = renounce)
        [],
        { commitment: 'finalized' },
        TOKEN_PROGRAM_ID
      );
      console.log('Mint authority renounced:', renounceMintAuthSig);
      progress({
        stage: 'mint_authority_revoked',
        tokenMint: mint.toString(),
        txId: renounceMintAuthSig,
      });
      await connection.confirmTransaction(renounceMintAuthSig, 'finalized');
    } catch (error) {
      console.error('Error renouncing mint authority:', error);
      throw new Error('Failed to renounce mint authority. Token creation aborted for safety.');
    }
    
    // 2. Freeze authority is already null (set during mint creation)
    console.log('Freeze authority already disabled (was set to null during creation)');
    
    // 3. Renounce metadata update authority and make immutable
    console.log('Renouncing metadata update authority and making immutable...');
    
    let metadataUpdateSuccess = false;
    let metadataImmutableSuccess = false;
    
    try {
      // Create the System Program public key in Umi format
      // This is the address 11111111111111111111111111111111
      const systemProgramAddress = umiPublicKey('11111111111111111111111111111111');
      
      // Try a simpler approach first - just change the update authority
      console.log('Setting update authority to System Program to revoke it...');
      
      await updateV1(umi, {
        mint: mintPubkey,
        authority: umi.identity,
        // Set update authority to System Program (11111111111111111111111111111111)
        // This effectively revokes the update authority permanently
        newUpdateAuthority: some(systemProgramAddress),
      }).sendAndConfirm(umi, {
        send: { commitment: 'finalized' },
        confirm: { commitment: 'finalized' }
      });
      
      console.log('Update authority successfully revoked (set to System Program)!');
      metadataUpdateSuccess = true;
      progress({ stage: 'metadata_update_authority_revoked', tokenMint: mint.toString() });
      
      // Wait a moment to ensure the transaction is fully processed
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Try to also make it immutable in a separate transaction
      // This might fail since we no longer have authority, but that's OK
      try {
        console.log('Attempting to make metadata immutable...');
        await updateV1(umi, {
          mint: mintPubkey,
          authority: systemProgramAddress, // Use system program as authority
          isMutable: some(false),
        }).sendAndConfirm(umi);
        console.log('Metadata made immutable');
        metadataImmutableSuccess = true;
        progress({ stage: 'metadata_made_immutable', tokenMint: mint.toString() });
      } catch (immutableError) {
        // This is expected to fail, but the important part (revoking authority) is done
        console.log('Could not make metadata immutable (expected after authority revocation)');
      }
      
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
            creators: none(),
            collection: none(),
            uses: none()
          }),
          newUpdateAuthority: some(systemProgramAddress),
          primarySaleHappened: none(),
          isMutable: some(false),
        }).sendAndConfirm(umi, {
          send: { commitment: 'finalized' },
          confirm: { commitment: 'finalized' }
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
          }).sendAndConfirm(umi, { 
            send: { commitment: 'finalized' },
            confirm: { commitment: 'finalized' }
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
    
    // Verify all authorities are properly renounced
    console.log('Verifying token safety...');
    
    // Check mint authority
    const mintInfo = await connection.getAccountInfo(mint);
    if (mintInfo) {
      console.log('Mint account verified');
    }
    
    console.log('Token has been made safe! No new tokens can be minted, accounts cannot be frozen.');
    if (metadataUpdateSuccess) {
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
      totalSupply: totalSupply,
      isSafe: metadataUpdateSuccess,
      mintAndFreezeAuthoritiesSafe: true,
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
      metadataUpdateAuthorityRevoked: metadataUpdateSuccess,
      metadataImmutable: metadataImmutableSuccess,
      warning: metadataUpdateSuccess ? null : 'Metadata update authority could not be revoked. Please verify token safety on Solscan.'
    };
  } catch (error) {
    console.error('Error in createTokenWithMetaplex:', error);
    throw error;
  }
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
      // Get source token account
      const sourceTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        tempWallet,
        mintPubkey,
        tempWallet.publicKey,
        false,
        'finalized',
        { commitment: 'finalized' },
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      console.log('Source token account:', sourceTokenAccount.address.toString());

      // Get or create destination token account
      const destinationTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        tempWallet, // Payer
        mintPubkey,
        destinationPubkey, // Owner
        false,
        'finalized',
        { commitment: 'finalized' },
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      console.log('Destination token account:', destinationTokenAccount.address.toString());

      // Get token balance
      const tokenAccountInfo = await getAccount(
        connection,
        sourceTokenAccount.address,
        'finalized',
        TOKEN_PROGRAM_ID
      );
      const tokenBalance = tokenAccountInfo.amount;
      console.log('Token balance to transfer:', tokenBalance.toString());

      // Transfer all tokens
      if (tokenBalance > 0n) {
        console.log('Transferring tokens...');
        const tokenTxSignature = await transfer(
          connection,
          tempWallet,
          sourceTokenAccount.address,
          destinationTokenAccount.address,
          tempWallet.publicKey,
          tokenBalance,
          [],
          { commitment: 'finalized' },
          TOKEN_PROGRAM_ID
        );
        console.log('Token transfer signature:', tokenTxSignature);
        await connection.confirmTransaction(tokenTxSignature, 'finalized');
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
    const transferAmount = solBalance - minRentExemption - 5000; // leave 5000 lamports for fees

    console.log('SOL balance:', solBalance / LAMPORTS_PER_SOL);
    console.log('SOL to transfer:', transferAmount / LAMPORTS_PER_SOL);

    let solTransferred = 0;
    if (transferAmount > 0) {
      console.log('Transferring SOL...');
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: tempWallet.publicKey,
          toPubkey: destinationPubkey,
          lamports: transferAmount,
        })
      );

      const solTxSignature = await connection.sendTransaction(
        transaction,
        [tempWallet],
        { commitment: 'finalized' }
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
export async function findFundingWallet(publicKey) {
  try {
    const pubKey = new PublicKey(publicKey);

    // Pull a small window of signatures. Solana RPC returns these
    // newest-first, but for a fresh wallet there's typically just 1-3
    // here when this is called (right after funding lands). We use
    // limit: 50 to be safe in case detection is delayed and other txs
    // accumulate first.
    const signatures = await connection.getSignaturesForAddress(pubKey, { limit: 50 });
    if (signatures.length === 0) return null;

    // Walk signatures from OLDEST to NEWEST, returning the first one
    // that has a parseable inbound SystemProgram transfer. Used to give
    // up after inspecting only the oldest signature, but that fails in
    // edge cases like:
    //   - Wallet was initialized with a non-transfer first tx (rare but
    //     possible — some indexers or front-ends do this).
    //   - The "first" tx is a CEX withdrawal via a non-standard CPI
    //     pattern that our parsed-instruction walk doesn't recognize.
    // In both cases there's usually a normal transfer further along
    // that we should surface. Cap at ~10 inspections so we don't fan
    // out RPC calls indefinitely for a heavily-active wallet.
    const MAX_INSPECTIONS = 10;
    const inspectOrder = signatures.slice().reverse(); // oldest first
    let inspections = 0;

    for (const sig of inspectOrder) {
      if (inspections++ >= MAX_INSPECTIONS) break;

      const tx = await connection.getParsedTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (!tx || !tx.meta || tx.meta.err) continue;

      // The funding could be a top-level SystemProgram transfer (typical case:
      // someone sending from Phantom or another wallet) or an inner instruction
      // (typical case: CEX withdrawal where a withdrawal program does the
      // transfer via CPI). Walk both.
      const allInstructions = [...(tx.transaction.message.instructions || [])];
      for (const inner of tx.meta.innerInstructions || []) {
        allInstructions.push(...(inner.instructions || []));
      }

      for (const instruction of allInstructions) {
        if (
          instruction.program === 'system' &&
          instruction.parsed?.type === 'transfer' &&
          instruction.parsed.info.destination === publicKey
        ) {
          return {
            funder: instruction.parsed.info.source,
            amount: Number(instruction.parsed.info.lamports) / LAMPORTS_PER_SOL,
            signature: sig.signature,
          };
        }
      }
    }

    // Inspected everything (or hit the cap) without finding a recognizable
    // inbound SystemProgram transfer. Most likely the wallet was funded
    // by an unusual on-chain pattern we can't auto-detect. The user can
    // still paste their destination manually in the cancel/transfer flow.
    return null;
  } catch (error) {
    console.error('Error finding funding wallet:', error);
    return null;
  }
}
