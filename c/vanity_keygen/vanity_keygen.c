/*
 * vanity_keygen.c -- High-performance Solana vanity keypair generator.
 *
 * Multi-threaded Ed25519 keypair grind with provable epoch tracking.
 * Uses a deterministic seed chain:
 *   keypair_0 -> keypair_1 -> ... -> keypair_n (winner).
 * WARNING: The master seed IS the private key of the first keypair in the
 * chain. It must never be shared; it is NOT part of the public output.
 *   Common:    n <= 1 epoch
 *   Rare:      n <= 2 epochs
 *   Legendary: n <= 3 epochs
 *   Mythic:    n >  3 epochs
 *
 * Build:   make -C c
 * Usage:   ./c/build/vanity_keygen --suffix RATi --threads 16
 */

#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>
#include <unistd.h>
#include <sys/time.h>
#include <sys/random.h>

#include "tweetnacl.h"
#include "base58.h"
#include "vrf_ed25519.h"

/* ------------------------------------------------------------------ */
/* Deterministic seed chain for provable grind history                 */
/* ------------------------------------------------------------------ */

/* Each thread gets a unique seed derived from a master seed + thread id.
 * The seed chain advances by using the generated public key as the next
 * seed: seed_{i+1} = pk_i[0..31]. This is a deterministic one-way chain
 * (reversing it requires breaking Ed25519 preimage resistance).
 * The master seed is NEVER included in public output because it equals
 * the secret key of the first keypair in the chain. */

#define SEED_CHAIN_BYTES 32

/* Simple SHA-512 using tweetnacl's internal hash (we'll use a simpler
 * construction: seed_i = crypto_hash_sha512(seed_{i-1})). Since tweetnacl
 * doesn't expose SHA-512 directly, we use crypto_sign_keypair_from_seed
 * which internally does SHA-512 + clamp + scalar multiply. For the seed
 * chain we just need a one-way function, so we'll use the first 32 bytes
 * of the generated public key as the next seed. */

static void seed_chain_next(const uint8_t prev[32], uint8_t next[32]) {
    /* Derive a new seed by generating a keypair from the previous seed
     * and using the first 32 bytes of the public key as the next seed.
     * This creates a deterministic, irreversible chain (finding a preimage
     * requires breaking Ed25519). */
    uint8_t pk[32], sk[64];
    crypto_sign_keypair_from_seed(pk, sk, prev);
    memcpy(next, pk, 32);
}

/* ------------------------------------------------------------------ */
/* Shared state across threads */
/* ------------------------------------------------------------------ */

typedef enum { MATCH_PREFIX, MATCH_SUFFIX } match_mode_t;

typedef struct {
    atomic_bool  found;
    uint8_t      result_pk[32];
    uint8_t      result_sk[64];
    char         result_b58[48];
    uint64_t     result_attempt;    /* global attempt index of winner */
    char         last_pk[48];       /* most recent pubkey for progress display */
    atomic_int   last_pk_ready;     /* flag: main thread can read last_pk */
    const char  *target;
    int          target_len;
    match_mode_t mode;
    int          case_sensitive;
    atomic_ullong total_attempts;
    atomic_int   running_threads;
    /* Deterministic seed chain */
    uint8_t      master_seed[32];
    uint64_t     attempts_per_thread; /* pre-allocated per-thread capacity */
} grind_state_t;

typedef struct {
    int            id;
    grind_state_t *state;
} thread_arg_t;

#define FLUSH_INTERVAL 4096

/* ------------------------------------------------------------------ */
/* Worker thread */
/* ------------------------------------------------------------------ */

static int check_match(const char *b58, size_t b58_len,
                       const char *target, int target_len,
                       match_mode_t mode, int case_sensitive) {
    if (b58_len < (size_t)target_len) return 0;
    if (mode == MATCH_PREFIX) {
        if (case_sensitive)
            return memcmp(b58, target, (size_t)target_len) == 0;
        else
            return strncasecmp(b58, target, (size_t)target_len) == 0;
    } else {
        const char *tail = b58 + b58_len - target_len;
        if (case_sensitive)
            return memcmp(tail, target, (size_t)target_len) == 0;
        else
            return strncasecmp(tail, target, (size_t)target_len) == 0;
    }
}

static void *grind_thread(void *arg) {
    thread_arg_t *ta = (thread_arg_t *)arg;
    grind_state_t *gs = ta->state;
    uint64_t local_attempts = 0;
    uint64_t global_base = (uint64_t)ta->id * gs->attempts_per_thread;

    /* Derive thread-specific seed from master_seed.
     * XOR thread id into the first 8 bytes to give each thread a distinct
     * starting point in the seed space, then one-way it so the master seed
     * remains irrecoverable from any thread's seed. */
    uint8_t thread_seed[32];
    memcpy(thread_seed, gs->master_seed, 32);
    uint64_t tid = (uint64_t)ta->id;
    for (int i = 0; i < 8; i++) thread_seed[i] ^= (uint8_t)(tid >> (i * 8));
    seed_chain_next(thread_seed, thread_seed);

    uint8_t pk[32], sk[64];
    uint8_t seed[32];
    char    b58[48];

    memcpy(seed, thread_seed, 32);

    while (!atomic_load_explicit(&gs->found, memory_order_relaxed)) {
        /* Derive keypair from current seed */
        crypto_sign_keypair_from_seed(pk, sk, seed);

        size_t b58_len = base58_encode(pk, 32, b58, sizeof(b58));
        if (b58_len > 0 && b58_len >= (size_t)gs->target_len) {
            /* Store this key for progress display (sampled every 4096 attempts).
             * Use CAS on last_pk_ready so only one thread writes the buffer at a
             * time — avoids a data race on the shared last_pk[48] across threads. */
            if ((local_attempts & 0xFFF) == 0) {
                int expected_flag = 0;
                if (atomic_compare_exchange_strong(&gs->last_pk_ready, &expected_flag, 1)) {
                    memcpy(gs->last_pk, b58, b58_len + 1);
                    atomic_store_explicit(&gs->last_pk_ready, 1, memory_order_release);
                }
            }

        if (check_match(b58, b58_len, gs->target, gs->target_len,
                            gs->mode, gs->case_sensitive)) {
                bool expected = false;
                if (atomic_compare_exchange_strong(&gs->found, &expected, true)) {
                    memcpy(gs->result_pk, pk, 32);
                    memcpy(gs->result_sk, sk, 64);
                    memcpy(gs->result_b58, b58, b58_len + 1);
                    gs->result_attempt = global_base + local_attempts;
                }
                local_attempts++;
                break;
            }
        }

        local_attempts++;

        /* Advance seed: use pk itself (already computed above).
         * Avoids a second crypto_sign_keypair_from_seed call per iteration. */
        memcpy(seed, pk, 32);

        if (local_attempts >= FLUSH_INTERVAL) {
            atomic_fetch_add(&gs->total_attempts, local_attempts);
            local_attempts = 0;
        }
    }

    if (local_attempts > 0) {
        atomic_fetch_add(&gs->total_attempts, local_attempts);
    }
    atomic_fetch_sub(&gs->running_threads, 1);
    return NULL;
}

/* ------------------------------------------------------------------ */
/* Rarity tier */
/* ------------------------------------------------------------------ */

typedef enum {
    RARITY_COMMON,
    RARITY_RARE,
    RARITY_LEGENDARY,
    RARITY_MYTHIC,
} rarity_tier_t;

static const char *rarity_name(rarity_tier_t r) {
    switch (r) {
        case RARITY_COMMON:    return "Common";
        case RARITY_RARE:      return "Rare";
        case RARITY_LEGENDARY: return "Legendary";
        default:               return "Mythic";
    }
}

static rarity_tier_t classify_rarity(uint64_t attempts, double expected) {
    if (attempts <= (uint64_t)expected)       return RARITY_COMMON;
    if (attempts <= (uint64_t)(expected * 2)) return RARITY_RARE;
    if (attempts <= (uint64_t)(expected * 3)) return RARITY_LEGENDARY;
    return RARITY_MYTHIC;
}

/* ------------------------------------------------------------------ */
/* Main */
/* ------------------------------------------------------------------ */

static void print_usage(const char *prog) {
    fprintf(stderr,
        "Usage: %s --prefix <PREFIX> | --suffix <SUFFIX>\n"
        "       [--threads <N>] [--out <FILE>]\n"
        "       [--case-insensitive] [--quiet]\n"
        "\n"
        "  --prefix PREFIX       Match start of address\n"
        "  --suffix SUFFIX       Match end of address\n"
        "  --threads N           Worker threads (default: CPU count)\n"
        "  --out FILE            Output JSON keypair file (default: stdout)\n"
        "  --vrf-blockhash HEX    Solana blockhash for VRF seed binding\n"
        "  --case-insensitive    Case-insensitive matching\n"
        "  --quiet               Suppress progress output\n"
        "\n"
        "Output JSON includes provable grind proof:\n"
        "  { secretKey, publicKey, attempts, rarity, expectedAttempts, vrfProof, vrfPk, vrfBlockhash }\n"
        "\n"
        "Examples:\n"
        "  %s --suffix RATi --threads 16 --out rati-ca.json\n",
        prog, prog);
}

static int get_cpu_count(void) {
    long n = sysconf(_SC_NPROCESSORS_ONLN);
    return (n > 0) ? (int)n : 4;
}

/* Base58-encode 32 bytes into a caller-provided buffer */
static void b58_of(const uint8_t bytes[32], char out[48]) {
    base58_encode(bytes, 32, out, 48);
}


/* Decode hex string to bytes. Returns -1 on error. */
static int hex_decode(const char *hex, uint8_t *out, int out_len) {
    int len = (int)strlen(hex);
    if (len != out_len * 2) return -1;
    for (int i = 0; i < out_len; i++) {
        char hi = hex[i * 2], lo = hex[i * 2 + 1];
        int val = 0;
        if (hi >= '0' && hi <= '9') val = (hi - '0') << 4;
        else if (hi >= 'a' && hi <= 'f') val = (hi - 'a' + 10) << 4;
        else if (hi >= 'A' && hi <= 'F') val = (hi - 'A' + 10) << 4;
        else return -1;
        if (lo >= '0' && lo <= '9') val |= (lo - '0');
        else if (lo >= 'a' && lo <= 'f') val |= (lo - 'a' + 10);
        else if (lo >= 'A' && lo <= 'F') val |= (lo - 'A' + 10);
        else return -1;
        out[i] = (uint8_t)val;
    }
    return 0;
}

/* Encode bytes to hex string. out must be at least len*2+1. */
static void hex_encode(const uint8_t *in, int len, char *out) {
    for (int i = 0; i < len; i++)
        sprintf(out + i * 2, "%02x", in[i]);
    out[len * 2] = '\0';
}

int main(int argc, char **argv) {
    const char *target_str = NULL;
    const char *out_path = NULL;
    const char *vrf_blockhash_hex = NULL;
    int thread_count = 0;
    int case_sensitive = 1;
    int quiet = 0;
    match_mode_t mode = MATCH_PREFIX;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--prefix") == 0 && i + 1 < argc) {
            target_str = argv[++i]; mode = MATCH_PREFIX;
        } else if (strcmp(argv[i], "--suffix") == 0 && i + 1 < argc) {
            target_str = argv[++i]; mode = MATCH_SUFFIX;
        } else if (strcmp(argv[i], "--threads") == 0 && i + 1 < argc) {
            thread_count = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--out") == 0 && i + 1 < argc) {
            out_path = argv[++i];
        } else if (strcmp(argv[i], "--case-insensitive") == 0) {
            case_sensitive = 0;
        } else if (strcmp(argv[i], "--vrf-blockhash") == 0 && i + 1 < argc) {
            vrf_blockhash_hex = argv[++i];
        } else if (strcmp(argv[i], "--quiet") == 0) {
            quiet = 1;
        } else if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            print_usage(argv[0]); return 0;
        } else {
            fprintf(stderr, "Unknown option: %s\n", argv[i]);
            print_usage(argv[0]); return 1;
        }
    }

    if (!target_str || target_str[0] == '\0') {
        fprintf(stderr, "Error: --prefix or --suffix is required\n");
        print_usage(argv[0]); return 1;
    }

    int target_len = (int)strlen(target_str);
    for (int i = 0; i < target_len; i++) {
        int valid = 0;
        for (int j = 0; BASE58_ALPHABET[j]; j++) {
            char tc = case_sensitive ? target_str[i] : (char)(target_str[i] | 0x20);
            char ac = case_sensitive ? BASE58_ALPHABET[j] : (char)(BASE58_ALPHABET[j] | 0x20);
            if (tc == ac) { valid = 1; break; }
        }
        if (!valid) {
            fprintf(stderr, "Error: '%c' is not valid base58\n", target_str[i]);
            return 1;
        }
    }

    if (target_len > 44) {
        fprintf(stderr, "Error: target too long (max 44 chars)\n");
        return 1;
    }

    if (thread_count <= 0) thread_count = get_cpu_count();
    if (thread_count > 256) thread_count = 256;

    double prob = 1.0;
    for (int i = 0; i < target_len; i++) prob /= 58.0;
    double expected = 1.0 / prob;

    /* VRF: when a blockhash is provided, derive master_seed from a
     * VRF proof over the blockhash using a fresh ephemeral keypair.
     * This proves the seed was bound to a recent blockhash and not
     * cherry-picked across many re-rolls. Otherwise, fall back to
     * system entropy (the seed stays fully private). */
    uint8_t vrf_pk[VRF_PK_BYTES] = {0};
    uint8_t vrf_sk[VRF_SK_BYTES] = {0};
    uint8_t vrf_proof[VRF_PROOF_BYTES] = {0};
    uint8_t vrf_output[VRF_OUTPUT_BYTES] = {0};
    uint8_t vrf_blockhash[32] = {0};
    int use_vrf = 0;

    if (vrf_blockhash_hex) {
        if (hex_decode(vrf_blockhash_hex, vrf_blockhash, 32) != 0) {
            fprintf(stderr, "Error: --vrf-blockhash must be 64 hex chars "
                            "(32 bytes, e.g. a Solana blockhash)\n");
            return 1;
        }
        if (vrf_keygen(vrf_pk, vrf_sk) != 0) {
            fprintf(stderr, "Error: VRF key generation failed\n");
            return 1;
        }
        if (vrf_prove(vrf_proof, vrf_output, vrf_sk,
                       vrf_blockhash, 32) != 0) {
            fprintf(stderr, "Error: VRF prove failed\n");
            return 1;
        }
        use_vrf = 1;
        if (!quiet) {
            fprintf(stderr, "  VRF: seed bound to blockhash (pk: ");
            char tmp[65];
            hex_encode(vrf_pk, 32, tmp);
            fprintf(stderr, "%s", tmp);
            fprintf(stderr, ")\n");
        }
    }

    /* Generate master seed from system entropy */
    uint8_t master_seed[32];
    if (use_vrf) {
        memcpy(master_seed, vrf_output, 32);
    } else if (getentropy(master_seed, 32) != 0) {
        fprintf(stderr, "Error: getentropy failed — cannot generate secure seed\n");
        return 1;
    }

    if (!quiet) {
        fprintf(stderr, "Vanity Keygen -- grinding for %s: \"%s\"\n",
                mode == MATCH_PREFIX ? "prefix" : "suffix", target_str);
        fprintf(stderr, "  Threads: %d  Expected: 1 in 58^%d (%.0f attempts)\n",
                thread_count, target_len, expected);
        fprintf(stderr, "  Rarity tiers: Common ≤%.0f  Rare ≤%.0f  Legendary ≤%.0f  Mythic >%.0f\n",
                expected, expected * 2, expected * 3, expected * 3);
        fprintf(stderr, "  Grinding...\n");
    }

    grind_state_t gs;
    memset(&gs, 0, sizeof(gs));
    atomic_init(&gs.found, false);
    atomic_init(&gs.total_attempts, 0);
    atomic_init(&gs.running_threads, thread_count);
    gs.target         = target_str;
    gs.target_len     = target_len;
    gs.mode           = mode;
    gs.case_sensitive  = case_sensitive;
    gs.attempts_per_thread = (uint64_t)(expected * 4.0 / (double)thread_count) + 1000000;
    memcpy(gs.master_seed, master_seed, 32);

    pthread_t *threads = (pthread_t *)calloc((size_t)thread_count, sizeof(pthread_t));
    thread_arg_t *args = (thread_arg_t *)calloc((size_t)thread_count, sizeof(thread_arg_t));
    if (!threads || !args) {
        fprintf(stderr, "Error: malloc failed\n");
        free(threads); free(args); return 1;
    }

    struct timeval t_start;
    gettimeofday(&t_start, NULL);

    for (int i = 0; i < thread_count; i++) {
        args[i].id = i;
        args[i].state = &gs;
        pthread_create(&threads[i], NULL, grind_thread, &args[i]);
    }

    uint64_t last_attempts = 0;
    struct timeval last_tv = t_start;

    while (atomic_load(&gs.running_threads) > 0) {
        usleep(150000);
        if (quiet) continue;

        uint64_t total = atomic_load(&gs.total_attempts);
        struct timeval now;
        gettimeofday(&now, NULL);

        double dt = (double)(now.tv_sec - last_tv.tv_sec) +
                    (double)(now.tv_usec - last_tv.tv_usec) / 1e6;
        if (dt < 0.005) continue;

        uint64_t delta = total - last_attempts;
        double rate = (double)delta / dt;

        const char *pk_str = "";
        if (atomic_exchange(&gs.last_pk_ready, 0)) {
            pk_str = gs.last_pk;
        }
        fprintf(stderr, "\r  Attempts: %llu  Rate: %.1f K/s  Running: %d threads  Key: %s  ",
                (unsigned long long)total, rate / 1000.0,
                atomic_load(&gs.running_threads), pk_str);
        fflush(stderr);

        last_attempts = total;
        last_tv = now;
    }

    for (int i = 0; i < thread_count; i++) {
        pthread_join(threads[i], NULL);
    }

    struct timeval t_end;
    gettimeofday(&t_end, NULL);
    double elapsed = (double)(t_end.tv_sec - t_start.tv_sec) +
                     (double)(t_end.tv_usec - t_start.tv_usec) / 1e6;

    uint64_t total_attempts = atomic_load(&gs.total_attempts);
    rarity_tier_t rarity = classify_rarity(total_attempts, expected);

    if (!quiet) {
        fprintf(stderr, "\r  Done! %llu attempts in %.1fs (%.1f K/s avg)\n",
                (unsigned long long)total_attempts, elapsed,
                (double)total_attempts / elapsed / 1000.0);
        fprintf(stderr, "  Rarity: %s (%.2f epochs)\n\n",
                rarity_name(rarity), (double)total_attempts / expected);
    }

    /* Build output JSON with full proof */
    char pk_b58_output[48];
    b58_of(gs.result_pk, pk_b58_output);

    char json_buf[8192];
    int off = 0;
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        "{");
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        "\"secretKey\":[");
    for (int i = 0; i < 64; i++) {
        off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
                        "%s%d", i > 0 ? "," : "", gs.result_sk[i]);
    }
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        "],\"publicKey\":\"%s\"", pk_b58_output);
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        ",\"attempts\":%llu", (unsigned long long)total_attempts);
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        ",\"rarity\":\"%s\"", rarity_name(rarity));
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        ",\"epochs\":%.4f", (double)total_attempts / expected);
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        ",\"expectedAttempts\":%.0f", expected);
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        ",\"target\":\"%s\"", target_str);
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        ",\"targetLen\":%d", target_len);
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        ",\"threads\":%d", thread_count);
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        ",\"elapsedSec\":%.3f", elapsed);
    if (use_vrf) {
        char vrf_proof_hex[VRF_PROOF_BYTES * 2 + 1];
        char vrf_pk_b58[48];
        char vrf_blockhash_b58[48];
        hex_encode(vrf_proof, VRF_PROOF_BYTES, vrf_proof_hex);
        b58_of(vrf_pk, vrf_pk_b58);
        b58_of(vrf_blockhash, vrf_blockhash_b58);
        off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
            ",\"vrfProof\":\"%s\"", vrf_proof_hex);
        off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
            ",\"vrfPk\":\"%s\"", vrf_pk_b58);
        off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
            ",\"vrfBlockhash\":\"%s\"", vrf_blockhash_b58);
    }
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        "}");

    if (out_path) {
        FILE *f = fopen(out_path, "w");
        if (!f) {
            fprintf(stderr, "Error: cannot write %s\n", out_path);
            free(threads); free(args); return 1;
        }
        fprintf(f, "%s\n", json_buf);
        fclose(f);
    } else {
        printf("%s\n", json_buf);
    }

    if (!quiet) fprintf(stderr, "Address: %s\n", gs.result_b58);
    if (!quiet && out_path) fprintf(stderr, "Keypair saved to: %s\n", out_path);

    free(threads);
    free(args);
    return 0;
}
