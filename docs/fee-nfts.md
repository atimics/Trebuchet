# Branded fee NFTs

The **Fee NFTs** view gives branded Metaplex Core NFTs equal shares of trading fees from one permanently locked liquidity position. It supports Meteora DAMM v2 positions and Raydium CLMM Burn & Earn Fee Keys. The sample recipient list contains 54 wallets, including both added addresses.

Each NFT gets one fixed share. A 54-NFT collection gives each holder 1/54 of the backing position's LP fees. The fee vault holds the native position NFT or Fee Key. It collects fees into two token accounts. Each current branded NFT owner can claim their share of both tokens. SOL fees arrive as wrapped SOL. Holders can unwrap them through their wallet.

Paid amounts stay with each branded NFT. A transfer moves its remaining fee rights to the new owner. The new owner receives fees accrued before the transfer that the previous owner left unclaimed. Integer rounding carries into later income. Trading fees belong to the whole backing position. To allocate only part of a position's fees, split the native position first and choose that smaller position as backing.

## Create a collection

1. In **NFTs**, create your artwork, names, symbol, metadata and collection. Mint one NFT for each recipient. Keep these assets in the signing wallet for setup.
2. In **Fee NFTs**, choose that collection and its signing wallet. Choose Meteora or Raydium. Enter the native position NFT mint or Fee Key mint.
3. Review the recipient list. The sample list fills the form with all 54 saved wallets. Each listed address receives one branded NFT.
4. Prepare the plan. Review the backing mint, pool, vault address, fixed shares and setup estimate.
5. Set a SOL spend cap and approve the plan. Setup creates the vault, registers its shares, transfers the backing NFT, activates the rights and sends the branded NFTs.
6. Use **Collect pool fees** to harvest the backing position. A holder can then use **Claim**.

Setup requires a fully minted Core collection with 1–128 assets and the same number of unique recipient wallets. The backing position must contain permanently locked liquidity. This version accepts pools with trading fees only, plus SPL tokens or Token-2022 tokens with metadata extensions. NFT resale royalties use the collection's existing rules and remain separate from the LP fee share.

## Holder claims

Download the fee proof from the collection view and share it with recipients. In a browser with a Solana Wallet Standard extension, recipients can import that proof, connect their wallet and claim. The app checks the proof against the on-chain vault and pool. It prepares an unsigned claim. The wallet signs and sends the transaction. Managed Trebuchet wallets can also claim in the desktop app.

The proof includes the program ID, network genesis hash, vault seed, pool, backing NFT, asset addresses, fixed shares and public transaction receipts. It also provides the information needed to build claims with `feeVaultClient.js` or another Solana client.

## Recovery and authority

Each managed send saves its signed bytes and cost reservation before broadcast. An interrupted action retries those same bytes. It checks transaction history and finalized block height before replacing an expired send. Failed attempt fees remain inside the approved cap. A pending send reserves its wallet across app restarts. Actions for the same collection run in sequence.

**Resume setup** continues from saved receipts. Before activation, the creator can return the backing NFT to their signing wallet. After activation, the fixed shares and backing custody are permanent. Fee collection can be called by anyone. Claims require the current branded NFT owner. The contract binds fee accounting to the vault's associated token accounts.

Keep the Trebuchet profile directory and its `feeNfts` records backed up. Portable proofs restore holder access. Setup recovery uses the private transaction journal in that profile.

## Program setup

The app checks both the deployed program's build hash and its immutable deployment before accepting backing. Building the app prepares this feature for deployment. The operator chooses the network, funding wallet and deployment spend cap before sending a deployment transaction.

Requirements: Node 22, Rust, Solana/Agave CLI and `cargo-build-sbf`. The checked-in Cargo lockfile pins versions supported by the Solana SBF compiler.

```sh
npm ci
npm run test:fee-vault
npm run build:fee-vault
node scripts/fee-vault-hash.mjs
```

After reviewing the build and deployment budget, deploy on the selected network with an explicit funding keypair and a saved program keypair:

```sh
solana program deploy --url devnet --keypair /path/to/funding.json \
  --program-id /path/to/program.json --final \
  programs/fee-vault/target/deploy/trebuchet_fee_vault.so
```

Set these environment variables when starting Trebuchet. Use the public program address and the hash printed by the build tool:

```sh
export TREBUCHET_FEE_VAULT_PROGRAM_ID=PUBLIC_PROGRAM_ADDRESS
export TREBUCHET_FEE_VAULT_PROGRAM_SHA256=VERIFIED_BUILD_HASH
npm run start:v2
```

`--final` makes the deployment permanent. Retain the reviewed source, lockfile and compiled binary for that program address. Changes use a new program and new collections. The app checks the saved network genesis hash for setup and claims.

## Verification

Host tests cover integer payouts, conservation and paid balances. JavaScript tests cover plan binding, the 54-wallet sample list, binary layouts, Raydium SDK harvest accounts, mode and PIN gates, failed fees and uncertain sends.

The local validator test loads real Core and DAMM v2 programs. It creates a locked position and branded NFTs, generates trading fees, harvests through the vault, checks equal payouts, repeats a claim, transfers an NFT and checks the new owner's rights. It also checks backing recovery, fixed shares, source account substitution, completed setup recovery, portable proofs and unsigned wallet claims.

```sh
# Choose and retain the Core and DAMM v2 binaries to test.
TREBUCHET_CORE_SO=/path/to/mpl-core.so \
TREBUCHET_DAMM_SO=/path/to/cp-amm.so npm run test:e2e:fee-nfts:localnet

npm run test:e2e:fee-nfts:ui
```

The Raydium path has SDK layout tests. Its live harvest still needs a funded devnet Burn & Earn position test before production use. The initial local validator evidence covers Meteora. Deployment and recipient transfers require the operator's selected backing position and spend cap.
