# Build Plan: The Pipeline

## Current state audit

| What | Where | Status |
|------|-------|--------|
| SHA-256 | `signal/shared/sha256.h` | **Done.** Header-only, public domain. |
| Base58 | `signal/shared/base58.h` | **Done.** Header-only. |
| Ed25519 sign/verify/keygen | `signal/shared/signal_crypto.h` | **Done.** Backed by TweetNaCl. |
| Cargo unit types | `signal/shared/types.h` | **Done.** `cargo_unit_t`, `asteroid_t` with `rock_pub`/`fragment_pub`. |
| hash_ingot / hash_product | `signal/shared/manifest.h` | **Done.** |
| Chain log | `signal/server/chain_log.h` | **Done.** Signed events, verifier. |
| Burn-to-mint C SBF program | `rati/programs/burn-to-mint/onchain-c/src/rati_burn_to_mint.c` | **Done.** 1,277 lines. Handles initialize, register mints, migrate, pause, finalize, authority transfer. |
| Burn-to-mint Rust reference | `rati/programs/burn-to-mint/onchain/src/lib.rs` | **Done.** Reference implementation. |
| Burn-to-mint native vectors | `rati/programs/burn-to-mint/native/` | **Done.** Golden vectors for testing. |
| Burn-to-mint specs | `rati/programs/burn-to-mint/` | **Done.** SBF_OPTIMIZATION.md, ACCOUNT_ORDER.md, etc. |
| Ruby High C engine | `app-ruby-high/ruby2/c/` | **Done.** Engine, world, ranker, UI, LLM, tests. Makefile build. |
| Ruby High card catalog (TS) | `app-ruby-high/src/services/hall-pass-card-catalog.ts` | **Done.** 508 lines. 36 profiles across teachers, students, specials. |
| Ruby High reveal (TS) | `app-ruby-high/src/services/hall-pass-reveal-provenance.ts` | **Done.** 161 lines. Deterministic reveal algorithm. |
| Ruby High pack NFTs (TS) | `app-ruby-high/src/services/core-pack-nfts.ts` | **Done.** 1,463 lines. Pack mint, open, verify. |
| Ruby High card NFTs (TS) | `app-ruby-high/src/services/hall-pass-nfts.ts` | **Done.** 1,694 lines. Card mint, burn, metadata. |
| Ruby High metadata (TS) | `app-ruby-high/src/services/nft-metadata-storage.ts` | **Done.** 351 lines. Arweave upload. |
| Trebuchet packnft stubs | `trebuchet/packnft/` | **Redundant.** Delete — Signal already has sha256, base58. |
| Yield-split contract | — | **Not started.** Design in docs/yield-split-design.md. |
| packnft CLI | — | **Not started.** Needs catalog, reveal, metadata, txn in C. |
| #480 on-chain anchoring | — | **Not started.** Signal chain-tip hashes → Solana. |
| Trebuchet NFT/pack UI | — | **Not started.** |
| RATi stamp service | — | **Not started.** |


## Phase 1: Move C code to Signal

### 1.1 Delete Trebuchet packnft stubs
Signal already has `shared/sha256.h` and `shared/base58.h`. The stubs in `trebuchet/packnft/` are redundant.

```bash
rm -rf trebuchet/packnft/
```

### 1.2 Move burn-to-mint program to Signal

```bash
cp -r rati/programs/burn-to-mint/ signal/programs/burn-to-mint/
```

Signal gains:
- `signal/programs/burn-to-mint/onchain-c/src/rati_burn_to_mint.c` — 1,277 lines, ready to compile
- `signal/programs/burn-to-mint/onchain/src/lib.rs` — Rust reference
- `signal/programs/burn-to-mint/native/` — golden vectors
- `signal/programs/burn-to-mint/SBF_OPTIMIZATION.md` — byte/compute gates
- `signal/programs/burn-to-mint/ACCOUNT_ORDER.md` — account layout docs

**What needs to change:** Nothing in the C source. The program is self-contained against the Solana C SDK (`sol/cpi.h`, `sol/entrypoint.h`, `sol/pubkey.h`). Signal just needs to add SBF build targets.

### 1.3 Add SBF build target to Signal's Makefile/CMake

Add to `signal/Makefile`:

```makefile
PROGRAMS_DIR = programs/burn-to-mint

build-sbf:
	cd $(PROGRAMS_DIR)/onchain-c && \
	cargo build-sbf --manifest-path Cargo.toml --sbf-out-dir ../../build/sbf

test-sbf:
	cd $(PROGRAMS_DIR) && \
	cargo test-sbf --manifest-path onchain-c/Cargo.toml
```

The burn-to-mint C SBF compiles via `cargo build-sbf` (Solana tools wrap LLVM for SBF). The Rust build toolchain handles the C → SBF path through the `cc` crate or direct `clang --target=sbf` invocation.

### 1.4 Create packnft directory in Signal

```bash
mkdir -p signal/tools/packnft/
```

Signal's existing tools pattern (see `signal/tools/signal_verify.c`, `signal_chain_assets.c`) is: one C file, links against `shared/`, compiled by CMake. Packnft follows the same pattern but with multiple files.

### 1.5 Build packnft catalog (port from Ruby High TS)

**Source:** `app-ruby-high/src/services/hall-pass-card-catalog.ts` (508 lines)

**Target:** `signal/tools/packnft/catalog.c` + `catalog.h`

Port the card catalog to fixed-size C structs:

```c
// catalog.h
typedef struct {
    char character_id[32];
    char character_name[32];
    char role[16];
    char rarity[16];
    char title[64];
    char blurb[128];
    char color[8];
    char art_sheet[16];
    char art_position[16];
    char nft_description[256];
    int set_number;
    char profile_id[32];
    char card_name[64];
    char subject[32];
} card_profile_t;

#define FIRST_BELL_PROFILE_COUNT 36
extern const card_profile_t FIRST_BELL_CATALOG[36];

const card_profile_t* catalog_resolve(const char* profile_id);
const char* catalog_hash(void);  // SHA-256 of stable-serialized catalog
```

### 1.6 Build packnft reveal (port from Ruby High TS)

**Source:** `app-ruby-high/src/services/hall-pass-reveal-provenance.ts` (161 lines)

**Target:** `signal/tools/packnft/reveal.c` + `reveal.h`

The reveal algorithm is pure SHA-256 — already available in Signal's `shared/sha256.h`:

```c
// reveal.h
typedef struct {
    char pack_reveal_version[32];
    char catalog_hash[65];
    char commitment[65];
    char entropy_source[64];
    char reveal_seed[65];
    char reveal_proof[65];
    char pack_asset_address[48];
    uint64_t reveal_slot;
} reveal_provenance_t;

void reveal_pack_commitment(
    const char* catalog_hash,
    const char* asset_address,
    const char* mint_signature,
    const char* owner_address,
    const char* product_id,
    int card_count,
    const char* nonce,
    char commitment_out[65]
);

void reveal_pack_seed(
    const char* commitment,
    const char* asset_address,
    const char* transaction_id,
    const char* nonce,
    char seed_out[65]
);

void reveal_card_slot(
    const char* commitment,
    const char* reveal_seed,
    const char* asset_address,
    int slot_index,
    char proof_out[65],
    int* card_index_out  // index into FIRST_BELL_CATALOG
);
```

### 1.7 Build packnft metadata generator

**Source:** `app-ruby-high/src/services/nft-metadata-storage.ts` (351 lines) + `nft-arweave-assets.ts` (60 lines)

**Target:** `signal/tools/packnft/metadata.c` + `metadata.h`

Generates Metaplex Core NFT metadata JSON strings:

```c
// metadata.h
char* metadata_pack_json(
    const char* name,
    const char* symbol,
    const char* image_uri,
    const char* collection_address,
    const char* product_id,
    int pack_count,
    int card_count,
    int serial,
    const reveal_provenance_t* provenance
);

char* metadata_card_json(
    const card_profile_t* card,
    const char* image_uri,
    const char* collection_address,
    const reveal_provenance_t* provenance
);

char* metadata_ingot_json(
    const char* cargo_pub_hex,
    const char* parent_merkle_hex,
    const char* station_pubkey_b58,
    uint64_t smelt_epoch,
    int commodity,
    int grade,
    const char* fragment_pub_hex,
    const char* rock_pub_hex
);

// Returns malloc'd strings. Caller frees.
```

### 1.8 CMake build for packnft

```cmake
# signal/tools/packnft/CMakeLists.txt
add_library(packnft STATIC
    catalog.c reveal.c metadata.c
)
target_include_directories(packnft PRIVATE ../../shared)
target_link_libraries(packnft PRIVATE signal_shared)

add_executable(packnft_cli cli.c)
target_link_libraries(packnft_cli PRIVATE packnft)
```

### 1.9 Test packnft

```c
// signal/tools/packnft/test.c
void test_catalog_hash_deterministic(void);
void test_reveal_deterministic(void);
void test_card_slot_matches_ts(void);  // Cross-validate against TS golden outputs
```

```bash
make test-packnft
```


## Phase 2: Transaction building in packnft

### 2.1 Add Solana transaction primitives

**Target:** `signal/tools/packnft/txn.c` + `txn.h`

Signal already has Ed25519 via `shared/signal_crypto.h`. What's needed:

```c
// txn.h

// Compact-u16 encoding
int compact_u16_encode(uint16_t value, uint8_t* out);
int compact_u16_decode(const uint8_t* data, uint16_t* out);

// Solana message layout
typedef struct {
    uint8_t num_signers;
    uint8_t num_readonly_signed;
    uint8_t num_readonly_unsigned;
    uint8_t account_keys[64][32];  // up to 64 accounts
    int     account_count;
    uint8_t recent_blockhash[32];
    // instructions
    uint8_t ix_data[8][1024];      // up to 8 instructions, 1KB each
    int     ix_lengths[8];
    int     instruction_count;
} solana_message_t;

// Build a message from instructions
int solana_message_build(solana_message_t* msg);

// Serialize to bytes
int solana_message_serialize(const solana_message_t* msg, uint8_t* out, int cap);

// Sign with Ed25519 keypair
int solana_transaction_sign(
    const uint8_t* message_bytes, int message_len,
    const uint8_t signer_secrets[][64], int signer_count,
    uint8_t signatures_out[64][64]
);

// Base64-encode for RPC submission
int solana_transaction_to_base64(
    const uint8_t* signatures[64], int signer_count,
    const uint8_t* message_bytes, int message_len,
    char* out, int cap
);
```

### 2.2 Add Metaplex Core instruction builders

```c
// txn.h (continued)

// Create a Core asset (NFT)
int core_create_asset_ix(
    const uint8_t asset_signer[32],    // ephemeral keypair for the asset
    const uint8_t collection[32],       // collection address
    const uint8_t owner[32],            // destination wallet
    const uint8_t authority[32],        // update authority
    const char* name,
    const char* uri,
    uint8_t ix_data_out[1024], int* ix_len
);

// Create a Core collection
int core_create_collection_ix(
    const uint8_t collection_signer[32],
    const uint8_t authority[32],
    const char* name,
    const char* uri,
    uint8_t ix_data_out[1024], int* ix_len
);

// Burn a Core asset
int core_burn_asset_ix(
    const uint8_t asset[32],
    const uint8_t collection[32],
    const uint8_t owner[32],
    uint8_t ix_data_out[1024], int* ix_len
);

// Update a Core asset (e.g., mark pack as opened)
int core_update_asset_ix(
    const uint8_t asset[32],
    const uint8_t collection[32],
    const uint8_t authority[32],
    const char* new_name,
    const char* new_uri,
    uint8_t ix_data_out[1024], int* ix_len
);
```

### 2.3 CLI surface

The packnft CLI binary reads JSON on stdin, writes JSON on stdout:

```bash
echo '{"op":"build-pack-mint","authority":"base58_secret...","owner":"base58_pubkey...","collection":"base58...","paymentSig":"base58...","productId":"card-pack-1","packCount":1,"cardCount":5}' \
  | signal/build/tools/packnft/packnft
# → {"ok":true,"signedTransaction":"base64...","metadataUri":"https://...","assetAddress":"base58..."}
```

Operations: `build-pack-mint`, `build-card-mint`, `build-card-burn`, `build-collection-create`, `build-ingot-mint`, `build-compose`, `reveal-pack`, `reveal-slot`, `catalog-hash`, `validate-address`.


## Phase 3: Yield-split contract

### 3.1 Write yield-split SBF program

**Target:** `signal/programs/yield-split/onchain-c/`

New Solana program in C. Follows the same pattern as burn-to-mint (Solana C SDK, PDAs, checked arithmetic, no heap). Instructions:

1. `InitializeVault(pool_id, position_nft, token_mint, quote_mint, total_yield_shares)`
2. `MintIngot(cargo_pub, parent_merkle, station_pubkey, smelt_epoch, chain_log_proof)`
3. `Compose(ingot_records, target_tier)` — burn N ingots, mint 1 frame/module
4. `Harvest()` — claim CLMM fees, burn token side, deposit quote
5. `ClaimYield(ingot_record)` — transfer 1/N of harvested quote

Account layout follows the design in `docs/yield-split-design.md`.

### 3.2 Build and test

```bash
make build-sbf     # builds both burn-to-mint and yield-split
make test-programs # unit tests for both programs
```

### 3.3 Deploy to devnet

Use RATi's `deployment/DEVNET_RC_RUNBOOK.md` pattern. Deploy both programs, create PDA mints, register source mints, exercise migration + ingot mint + compose + harvest + claim end-to-end.


## Phase 4: Trebuchet integration

### 4.1 Add packnft routes to Trebuchet server

```javascript
// server.js — new routes

// POST /api/nft/pack-mint
// Body: { authority, owner, collection, paymentSig, productId, packCount, cardCount }
// Calls: exec("signal/build/tools/packnft/packnft") with op="build-pack-mint"
// Returns: { signedTransaction, metadataUri, assetAddress, serial }

// POST /api/nft/card-reveal
// Body: { commitment, revealSeed, assetAddress, slotIndex }
// Calls: exec("...") with op="reveal-slot"
// Returns: { proof, cardProfile, metadata }

// POST /api/nft/card-mint
// Body: { authority, owner, collection, cardProfileId, proof }
// Calls: exec("...") with op="build-card-mint"
// Returns: { signedTransaction, metadataUri, assetAddress }

// POST /api/nft/card-burn
// Body: { owner, asset, collection }
// Calls: exec("...") with op="build-card-burn"
// Returns: { signedTransaction }

// POST /api/nft/submit
// Body: { signedTransaction }
// Submits to Solana RPC, polls for confirmation
// Returns: { signature, slot, blockTime }
```

### 4.2 Add yield tab to frontend

New tab in Trebuchet's launch wizard (post-launch):

- **Yield Overview:** Total ingots minted, total yield shares, harvested quote, claimable per ingot
- **My Ingots:** Table of owned ingots with provenance, multiplier, claimable yield
- **Compose:** Select ingots → preview frame NFT → compose
- **Harvest:** Button to trigger harvest (if self-crank)
- **Claim:** Button to claim yield per ingot

### 4.3 Add NFT pack panel to frontend

- **Buy Pack:** Connect wallet, select pack type, pay RATi, receive pack NFT
- **Open Pack:** Reveal animation, card display
- **Card Collection:** Grid of owned cards with rarity, character, provenance
- **Burn Card:** Burn for Hall Passes / RATi credits


## Phase 5: Ruby High v2 integration

Ruby High v2 (`ruby2/c/`) is already C. It links against its own engine, world, and UI code. Adding packnft means:

### 5.1 Link packnft as a library

```makefile
# ruby2/c/Makefile
PACKNFT_DIR = ../../signal/tools/packnft
PACKNFT_LIB = $(PACKNFT_DIR)/build/libpacknft.a

$(PACKNFT_LIB):
	cd $(PACKNFT_DIR) && cmake -S . -B build && cmake --build build

ruby2: $(PACKNFT_LIB) $(RUBY2_OBJS)
	$(CC) $(RUBY2_OBJS) $(PACKNFT_LIB) -o $@
```

### 5.2 Replace Ruby High TypeScript NFT code

Delete these files (they become dead code):
- `app-ruby-high/src/services/core-pack-nfts.ts` (1,463 lines)
- `app-ruby-high/src/services/hall-pass-nfts.ts` (1,694 lines)
- `app-ruby-high/src/services/hall-pass-card-catalog.ts` (508 lines)
- `app-ruby-high/src/services/hall-pass-reveal-provenance.ts` (161 lines)
- `app-ruby-high/src/services/nft-metadata-storage.ts` (351 lines)
- `app-ruby-high/src/services/nft-arweave-assets.ts` (60 lines)

Ruby High's C code calls packnft directly:

```c
#include "packnft/catalog.h"
#include "packnft/reveal.h"
#include "packnft/metadata.h"

// Ruby High's pack purchase flow:
void on_pack_purchase(const char* owner, const char* payment_sig) {
    char commitment[65];
    reveal_pack_commitment(
        catalog_hash(), pack_asset, payment_sig,
        owner, "card-pack-1", 5, generate_nonce(),
        commitment
    );
    // Store commitment, mint pack via packnft
}

// Ruby High's card reveal flow:
void on_reveal_card(const char* commitment, const char* seed, int slot) {
    char proof[65];
    int card_index;
    reveal_card_slot(commitment, seed, pack_asset, slot, proof, &card_index);
    const card_profile_t* card = &FIRST_BELL_CATALOG[card_index];
    // Display card, store reveal proof
}
```


## Phase 6: #480 on-chain anchoring

Signal's chain-tip hashes are committed to Solana. This closes the provenance loop: every `CHAIN_EVT_SMELT` can be verified on-chain. The `MintIngot` instruction in the yield-split contract validates chain-log proofs against the anchored hashes.

**Dependency:** This is the last phase because everything else works without it (pack minting, card reveal, burn-to-mint migration). But the full "mine → prove → mint ingot" loop requires #480.


## Phase 7: RATi stamp service + cleanup

### 7.1 Build the stamp service

A thin Node script (or Rust binary) that:
1. Reads a contract block JSON from stdin
2. Validates against `registry/rati-token-registry.v1.json`
3. Attaches an identity stamp
4. Writes the stamped block to stdout

```bash
echo '{"contract":{...},"transaction":{...}}' | npm run stamp
# → {"contract":{...},"transaction":{...},"stamp":{...}}
```

### 7.2 Remove programs/ from RATi

After burn-to-mint moves to Signal:

```bash
rm -rf rati/programs/
```

RATi's README and SCOPE.md updated to reflect that execution lives in Signal.

### 7.3 Update validation scripts

RATi's `npm run check` now validates that Signal-built program hashes match the manifest:

```bash
npm run check:programs -- --sbf signal/build/sbf/rati_burn_to_mint.so
```

## Dependency order

```
Phase 1 (move C code)         ← we are here
    │
Phase 2 (transaction building)
    │
Phase 3 (yield-split contract)
    │
Phase 4 (Trebuchet integration)
    │
Phase 5 (Ruby High v2 integration)
    │
Phase 6 (#480 on-chain anchoring)
    │
Phase 7 (RATi stamp + cleanup)
```

Phases 2 and 3 can overlap (different programmers). Phases 4, 5, and 6 can overlap (different surfaces). Phase 7 is cleanup — only after everything else ships.
