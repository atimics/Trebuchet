/*
 * vanity_keygen.c -- High-performance Solana vanity keypair generator.
 *
 * Multi-threaded Ed25519 keypair grind with epoch tracking.
 * The master seed comes from the system CSPRNG and never leaves the process.
 * Each candidate's seed is secret: the master seed with the thread id and a
 * per-candidate counter mixed in. Ed25519 hashes every seed with SHA-512,
 * so candidates are independent and no public key (including the progress
 * sample) reveals any other candidate or the winner.
 *   Common:    n <= 1 epoch
 *   Rare:      n <= 2 epochs
 *   Legendary: n <= 3 epochs
 *   Mythic:    n >  3 epochs
 *
 * Build:   make -C c
 * Usage:   ./c/build/vanity_keygen --prefix RAT --suffix i --threads 16
 */

#include <ctype.h>
#include <math.h>
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

/* Cross-platform entropy source.
 *
 * On POSIX (macOS, Linux) we use getentropy() from <sys/random.h>.
 * Windows MinGW doesn't ship <sys/random.h> or getentropy(), so we
 * provide a same-shape static shim backed by BCryptGenRandom — the
 * Windows Crypto Next Generation RNG. This is the same source
 * randombytes.c uses for Windows, so the entropy story stays
 * consistent across the binary. The #pragma comment(lib, ...) is the
 * MinGW/MSVC idiom for telling the linker to pull in bcrypt.lib;
 * mirrors what randombytes.c already does. */
#if defined(_WIN32)
  #include <windows.h>
  #include <bcrypt.h>
  #include <io.h>      /* _setmode, _fileno */
  #include <fcntl.h>   /* _O_BINARY */
  #pragma comment(lib, "bcrypt.lib")

  static int getentropy(void *buf, size_t n) {
      while (n > 0) {
          ULONG chunk = (n > 0x7fffffffULL) ? 0x7fffffff : (ULONG)n;
          NTSTATUS s = BCryptGenRandom(NULL, (PUCHAR)buf, chunk,
                                       BCRYPT_USE_SYSTEM_PREFERRED_RNG);
          if (s != 0) return -1;
          buf = (char *)buf + chunk;
          n -= chunk;
      }
      return 0;
  }
#else
  #include <sys/random.h>
#endif

#ifndef TREBUCHET_SODIUM
#include "tweetnacl.h" /* portable fallback; libsodium builds do not link it */
#endif
#include "base58.h"
/* ref10 field/group arithmetic (vendor/ed25519-ref10) for the split-key walk. */
#include "ge.h"
#include "precomp_data.h" /* Bi[0] is the base point G in precomputed form */

#if defined(TREBUCHET_SODIUM)
#include <sodium.h>
#elif defined(TREBUCHET_OPENSSL_FAST)
#include <openssl/evp.h>
#include <string.h>
#endif

/* Derive an Ed25519 keypair from a 32-byte seed (sk = seed || pk).
 *
 * With TREBUCHET_OPENSSL_FAST (make fast), the public-key derivation goes
 * through OpenSSL's optimized Ed25519 code, roughly 30-50x faster than the
 * portable tweetnacl implementation. That is the difference between a
 * 6-character vanity grind taking days (tweetnacl, ~2K keys/s per core) and
 * taking under an hour (OpenSSL, ~20-50K keys/s per core). Both backends
 * produce byte-identical keypairs per RFC 8032; the fast build is verified
 * against tweetnacl in the repo's keygen tests.
 */
static inline int keypair_from_seed(uint8_t pk[32], uint8_t sk[64], const uint8_t seed[32])
{
#if defined(TREBUCHET_SODIUM)
    /* libsodium: same RFC 8032 derivation (sk = seed || pk), no global
     * locks. OpenSSL 3 looks up the Ed25519 implementation in a shared
     * store on every EVP_PKEY_new_raw_private_key call, which stops it
     * scaling: ~52K keys/s on one core but ~12K/s per core at 192 threads.
     * libsodium measured ~82K/s per core and scales linearly. */
    return crypto_sign_seed_keypair(pk, sk, seed);
#elif defined(TREBUCHET_OPENSSL_FAST)
    memcpy(sk, seed, 32);
    EVP_PKEY *pkey = EVP_PKEY_new_raw_private_key(EVP_PKEY_ED25519, NULL, seed, 32);
    if (!pkey) return -1;
    size_t publen = 32;
    int ok = EVP_PKEY_get_raw_public_key(pkey, pk, &publen);
    EVP_PKEY_free(pkey);
    if (!ok || publen != 32) return -1;
    memcpy(sk + 32, pk, 32);
    return 0;
#else
    return crypto_sign_keypair_from_seed(pk, sk, seed);
#endif
}

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

/* ------------------------------------------------------------------ */
/* Fast suffix pre-check helpers                                       */
/* ------------------------------------------------------------------ */

/* For suffix targets up to 10 chars (58^10 < 2^64), we pre-check
 * pk % 58^target_len against the target's numeric value.  This skips
 * the full base58_encode on ~98% of iterations for typical 4-char
 * targets -- the single largest optimization in the hot loop.
 *
 * For case-insensitive matching, base58 characters have different
 * indices for different cases (e.g. 'R'=24, 'r'=49), so we enumerate
 * all 2^k case-variant numeric values and check against each. */
#define MAX_FAST_TARGET_LEN 10
#define MAX_CASE_VARIANTS    64

static uint64_t pow58(int exp) {
    uint64_t r = 1;
    for (int i = 0; i < exp; i++) r *= 58ULL;
    return r;
}

static uint64_t b58_to_u64(const char *s, int len, int *ok) {
    uint64_t v = 0;
    for (int i = 0; i < len; i++) {
        int digit = -1;
        for (int j = 0; BASE58_ALPHABET[j]; j++) {
            if (BASE58_ALPHABET[j] == s[i]) { digit = j; break; }
        }
        if (digit < 0) { *ok = 0; return 0; }
        v = v * 58ULL + (uint64_t)digit;
    }
    *ok = 1;
    return v;
}

static uint64_t pk_mod64(const uint8_t pk[32], uint64_t mod) {
    uint64_t r = 0;
    for (int i = 0; i < 32; i++)
        r = ((r << 8) | (uint64_t)pk[i]) % mod;
    return r;
}

/* Generate all case-variant numeric forms of an L-char base58 target.
 * For each position that is a letter (a-z, A-Z), both cases produce
 * different base58 digit values.  Enumerates all 2^k combinations
 * (capped at MAX_CASE_VARIANTS).  Returns the number of variants,
 * or 0 if too many (caller falls back to full encode). */
static int gen_case_variants(const char *target, int len,
                              uint64_t *variants, int max_variants) {
    int letter_positions[10];
    int n_letters = 0;
    for (int i = 0; i < len && n_letters < 10; i++) {
        char c = target[i];
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))
            letter_positions[n_letters++] = i;
    }
    int total = 1 << n_letters;
    if (total > max_variants) return 0;

    /* Map each char to its two possible base58 indices */
    int b58_idx[2][10];
    for (int i = 0; i < len; i++) {
        char lo = (target[i] >= 'A' && target[i] <= 'Z')
                   ? (char)(target[i] | 0x20) : target[i];
        char up = (target[i] >= 'a' && target[i] <= 'z')
                   ? (char)(target[i] & ~0x20) : target[i];
        int idx_lo = -1, idx_up = -1;
        for (int j = 0; BASE58_ALPHABET[j]; j++) {
            if (BASE58_ALPHABET[j] == lo) idx_lo = j;
            if (BASE58_ALPHABET[j] == up) idx_up = j;
        }
        if (idx_lo < 0 || idx_up < 0) return 0;
        b58_idx[0][i] = idx_lo;
        b58_idx[1][i] = idx_up;
    }

    for (int mask = 0; mask < total; mask++) {
        uint64_t v = 0;
        for (int pos = 0; pos < len; pos++) {
            int use_up = 0;
            for (int k = 0; k < n_letters; k++) {
                if (letter_positions[k] == pos) {
                    use_up = (mask >> k) & 1;
                    break;
                }
            }
            v = v * 58ULL + (uint64_t)b58_idx[use_up][pos];
        }
        variants[mask] = v;
    }
    return total;
}

/* ------------------------------------------------------------------ */
/* Shared state across threads */
/* ------------------------------------------------------------------ */

typedef struct {
    atomic_bool  found;
    uint8_t      result_pk[32];
    uint8_t      result_sk[64];
    char         result_b58[48];
    uint64_t     result_attempt;
    char         last_pk[48];
    atomic_int   last_pk_ready;
    const char  *prefix;
    int          prefix_len;
    const char  *suffix;
    int          suffix_len;
    int          case_sensitive;
    int          address_length;   /* 0 = any length */
    /* Split-key mode: walk A + k*G for a customer point A; report k only. */
    int          split_mode;
    ge_p3        split_A;
    uint8_t      result_offset[32];
    atomic_ullong total_attempts;
    atomic_int   running_threads;
    uint8_t      master_seed[32];
    uint64_t     attempts_per_thread;
    /* Fast suffix match: modular check with case-variant support */
    int          use_fast_match;
    uint64_t     fast_mod;
    int          fast_num_variants;
    uint64_t     fast_target_vals[MAX_CASE_VARIANTS];
} grind_state_t;

typedef struct {
    int            id;
    grind_state_t *state;
} thread_arg_t;

#define FLUSH_INTERVAL 16384

/* ------------------------------------------------------------------ */
/* Worker thread */
/* ------------------------------------------------------------------ */

static int check_part(const char *b58, size_t b58_len,
                      const char *target, int target_len,
                      int at_start, int case_sensitive) {
    if (!target || target_len <= 0) return 1;
    if (b58_len < (size_t)target_len) return 0;
    if (at_start) {
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

static int check_match(const char *b58, size_t b58_len,
                       const char *prefix, int prefix_len,
                       const char *suffix, int suffix_len,
                       int case_sensitive, int address_length) {
    return (address_length == 0 || b58_len == (size_t)address_length)
        && check_part(b58, b58_len, prefix, prefix_len, 1, case_sensitive)
        && check_part(b58, b58_len, suffix, suffix_len, 0, case_sensitive);
}

/* ------------------------------------------------------------------ */
/* Exact odds                                                          */
/* ------------------------------------------------------------------ */

/* An address is base58 of a 256-bit number, so its first character is far
 * from uniform: a 44-char address can only start with 1-9, A-H or J, and
 * "R..." needs a 43-char address (1 in ~989, not 1 in 58). These return the
 * fraction of keys matching a prefix at a given length (0 = any), the same
 * model as expectedVanityAttempts in packages/core/src/validators.js. */
static const char B58_ALPHABET_STR[] =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

static long double prefix_fraction_exact(const char *prefix, int plen, int length) {
    const long double space = ldexpl(1.0L, 256);
    const long double floor_ = ldexpl(1.0L, 248); /* below: zero first byte, leading '1' */
    if (plen == 0 && length == 0) return 1.0L;
    if (plen > 0 && prefix[0] == '1') {
        long double f = powl(58.0L, -plen);
        return length ? f / 17.0L : f;
    }
    long double value = 0.0L;
    for (int i = 0; i < plen; i++) {
        const char *at = strchr(B58_ALPHABET_STR, prefix[i]);
        value = value * 58.0L + (long double)(at - B58_ALPHABET_STR);
    }
    long double count = 0.0L;
    for (int total = 32; total <= 44; total++) {
        if ((length && total != length) || total < plen) continue;
        long double lo, hi;
        if (plen) {
            long double scale = powl(58.0L, total - plen);
            lo = value * scale;
            hi = (value + 1.0L) * scale;
        } else {
            lo = powl(58.0L, total - 1);
            hi = powl(58.0L, total);
        }
        if (lo < floor_) lo = floor_;
        if (hi > space) hi = space;
        if (hi > lo) count += hi - lo;
    }
    return count / space;
}

/* Sum over every accepted case variant of the prefix. */
static long double prefix_fraction(const char *prefix, int plen, int length,
                                   int case_sensitive, char *buf, int pos) {
    if (pos == plen) return prefix_fraction_exact(buf, plen, length);
    char options[3] = { prefix[pos], 0, 0 };
    int n = 1;
    if (!case_sensitive) {
        char other = (char)(isupper((unsigned char)prefix[pos]) ? tolower((unsigned char)prefix[pos])
                                                                : toupper((unsigned char)prefix[pos]));
        if (other != prefix[pos] && strchr(B58_ALPHABET_STR, other)) options[n++] = other;
    }
    long double sum = 0.0L;
    for (int k = 0; k < n; k++) {
        buf[pos] = options[k];
        sum += prefix_fraction(prefix, plen, length, case_sensitive, buf, pos + 1);
    }
    return sum;
}

static long double suffix_fraction(const char *suffix, int slen, int case_sensitive) {
    long double f = 1.0L;
    for (int i = 0; i < slen; i++) {
        int variants = 1;
        if (!case_sensitive) {
            char other = (char)(isupper((unsigned char)suffix[i]) ? tolower((unsigned char)suffix[i])
                                                                  : toupper((unsigned char)suffix[i]));
            if (other != suffix[i] && strchr(B58_ALPHABET_STR, other)) variants = 2;
        }
        f *= (long double)variants / 58.0L;
    }
    return f;
}

/* CAS-guarded progress sample: encode pk for the display line */
static inline void progress_sample(grind_state_t *gs, const uint8_t pk[32]) {
    int expected_flag = 0;
    if (atomic_compare_exchange_strong(&gs->last_pk_ready,
                                       &expected_flag, 1)) {
        base58_encode(pk, 32, gs->last_pk, sizeof(gs->last_pk));
        atomic_store_explicit(&gs->last_pk_ready, 1, memory_order_release);
    }
}

/* ------------------------------------------------------------------ */
/* Split-key walk                                                      */
/* ------------------------------------------------------------------ */

/* The customer keeps a secret scalar a and gives us A = a*G. We search
 * offsets k until A + k*G encodes to the target, and report only k: the
 * mint's secret a + k never exists here. Each step is one mixed point
 * addition (P += G); SPLIT_BATCH points share one field inversion
 * (Montgomery's trick) for the affine encoding. */
#define SPLIT_BATCH 256

static void add_u64_le(uint8_t out[32], const uint8_t base[32], uint64_t add) {
    unsigned int carry = 0;
    for (int i = 0; i < 32; i++) {
        unsigned int sum = (unsigned int)base[i] + (unsigned int)(add & 0xFF) + carry;
        out[i] = (uint8_t)sum;
        carry = sum >> 8;
        add >>= 8;
    }
}

static void *split_walk_thread(void *arg) {
    thread_arg_t *ta = (thread_arg_t *)arg;
    grind_state_t *gs = ta->state;
    (void)base; /* precomp_data.h also defines the full base table */

    /* Independent random start per thread. k0 < 2^254 keeps k0 + index
     * below 2^255, as ge_scalarmult_base requires. */
    uint8_t k0[32];
    if (getentropy(k0, 32) != 0) {
        atomic_fetch_sub(&gs->running_threads, 1);
        return NULL;
    }
    k0[31] &= 0x3F;

    ge_p3 K, P;
    ge_cached kc;
    ge_p1p1 t;
    ge_scalarmult_base(&K, k0);
    ge_p3_to_cached(&kc, &K);
    ge_add(&t, &gs->split_A, &kc);
    ge_p1p1_to_p3(&P, &t);

    ge_p3 pts[SPLIT_BATCH];
    fe acc[SPLIT_BATCH];
    fe zinv, zj, x, y;
    uint8_t pk[32];
    char b58[48];
    uint64_t index = 0;
    uint64_t local_attempts = 0;
    int use_fast = gs->use_fast_match;

    while (!atomic_load_explicit(&gs->found, memory_order_relaxed)) {
        for (int j = 0; j < SPLIT_BATCH; j++) {
            pts[j] = P;
            ge_madd(&t, &P, &Bi[0]);
            ge_p1p1_to_p3(&P, &t);
        }
        fe_copy(acc[0], pts[0].Z);
        for (int j = 1; j < SPLIT_BATCH; j++) fe_mul(acc[j], acc[j - 1], pts[j].Z);
        fe_invert(zinv, acc[SPLIT_BATCH - 1]);

        for (int j = SPLIT_BATCH - 1; j >= 0; j--) {
            if (j > 0) {
                fe_mul(zj, zinv, acc[j - 1]);   /* 1 / Z_j */
                fe_mul(zinv, zinv, pts[j].Z);   /* 1 / (Z_0 ... Z_{j-1}) */
            } else {
                fe_copy(zj, zinv);
            }
            fe_mul(x, pts[j].X, zj);
            fe_mul(y, pts[j].Y, zj);
            fe_tobytes(pk, y);
            pk[31] ^= (uint8_t)(fe_isnegative(x) << 7);

            int matched = 0;
            if (use_fast) {
                uint64_t rem = pk_mod64(pk, gs->fast_mod);
                int hit = 0;
                for (int v = 0; v < gs->fast_num_variants; v++) {
                    if (rem == gs->fast_target_vals[v]) { hit = 1; break; }
                }
                if (hit) {
                    size_t b58_len = base58_encode(pk, 32, b58, sizeof(b58));
                    matched = b58_len > 0 && check_match(b58, b58_len, gs->prefix, gs->prefix_len,
                                                         gs->suffix, gs->suffix_len,
                                                         gs->case_sensitive, gs->address_length);
                }
            } else {
                size_t b58_len = base58_encode(pk, 32, b58, sizeof(b58));
                matched = b58_len > 0 && check_match(b58, b58_len, gs->prefix, gs->prefix_len,
                                                     gs->suffix, gs->suffix_len,
                                                     gs->case_sensitive, gs->address_length);
            }
            if (matched) {
                bool expected = false;
                if (atomic_compare_exchange_strong(&gs->found, &expected, true)) {
                    memcpy(gs->result_pk, pk, 32);
                    add_u64_le(gs->result_offset, k0, index + (uint64_t)j);
                    base58_encode(pk, 32, gs->result_b58, sizeof(gs->result_b58));
                }
                break;
            }
        }
        if ((index & 0xFFFF) == 0) progress_sample(gs, pk);
        index += SPLIT_BATCH;
        local_attempts += SPLIT_BATCH;
        if (local_attempts >= FLUSH_INTERVAL) {
            atomic_fetch_add(&gs->total_attempts, local_attempts);
            local_attempts = 0;
        }
    }
    if (local_attempts > 0) atomic_fetch_add(&gs->total_attempts, local_attempts);
    atomic_fetch_sub(&gs->running_threads, 1);
    return NULL;
}

static int hex_to_bytes32(const char *hex, uint8_t out[32]) {
    if (!hex || strlen(hex) != 64) return -1;
    for (int i = 0; i < 32; i++) {
        unsigned int v;
        if (sscanf(hex + 2 * i, "%2x", &v) != 1) return -1;
        out[i] = (uint8_t)v;
    }
    return 0;
}

static void *grind_thread(void *arg) {
    thread_arg_t *ta = (thread_arg_t *)arg;
    grind_state_t *gs = ta->state;
    uint64_t local_attempts = 0;
    uint64_t global_base = (uint64_t)ta->id * gs->attempts_per_thread;

    /* This thread's secret base: the master seed with the thread id in
     * bytes 0..7. Candidates add a counter in bytes 8..15, so every
     * (thread, counter) pair gets a distinct secret seed. Seeds are never
     * derived from public keys: an earlier version chained each seed from
     * the previous public key, so one observed key exposed the winner. */
    uint8_t base[32];
    memcpy(base, gs->master_seed, 32);
    uint64_t tid = (uint64_t)ta->id;
    for (int i = 0; i < 8; i++) base[i] ^= (uint8_t)(tid >> (i * 8));
    uint64_t counter = 0;

    uint8_t pk[32], sk[64];
    uint8_t seed[32];
    char    b58[48];

    int use_fast = gs->use_fast_match;

    while (!atomic_load_explicit(&gs->found, memory_order_relaxed)) {
        memcpy(seed, base, 32);
        for (int i = 0; i < 8; i++) seed[8 + i] ^= (uint8_t)(counter >> (i * 8));
        counter++;
        keypair_from_seed(pk, sk, seed);

        int matched = 0;

        if (use_fast) {
            /* Suffix fast-path: pk % 58^L in variant set.
             * Only do the full base58 encode + string match on a hit,
             * which happens ~1 in 58^target_len iterations. */
            uint64_t rem = pk_mod64(pk, gs->fast_mod);
            int hit = 0;
            for (int v = 0; v < gs->fast_num_variants; v++) {
                if (rem == gs->fast_target_vals[v]) { hit = 1; break; }
            }
            if (hit) {
                size_t b58_len = base58_encode(pk, 32, b58, sizeof(b58));
                if (b58_len > 0) {
                    matched = check_match(b58, b58_len,
                                          gs->prefix, gs->prefix_len,
                                          gs->suffix, gs->suffix_len,
                                          gs->case_sensitive, gs->address_length);
                }
            }
            if ((local_attempts & 0xFFF) == 0)
                progress_sample(gs, pk);

        } else {
            /* Full encode every iteration (prefix mode or long suffix) */
            size_t b58_len = base58_encode(pk, 32, b58, sizeof(b58));
            if (b58_len > 0) {
                if ((local_attempts & 0xFFF) == 0) {
                    int expected_flag = 0;
                    if (atomic_compare_exchange_strong(&gs->last_pk_ready,
                                                       &expected_flag, 1)) {
                        memcpy(gs->last_pk, b58, b58_len + 1);
                        atomic_store_explicit(&gs->last_pk_ready, 1,
                                              memory_order_release);
                    }
                }
                matched = check_match(b58, b58_len,
                                      gs->prefix, gs->prefix_len,
                                      gs->suffix, gs->suffix_len,
                                      gs->case_sensitive, gs->address_length);
            }
        }

        local_attempts++;

        if (matched) {
            bool expected = false;
            if (atomic_compare_exchange_strong(&gs->found, &expected, true)) {
                memcpy(gs->result_pk, pk, 32);
                memcpy(gs->result_sk, sk, 64);
                memcpy(gs->result_b58, b58, sizeof(b58));
                gs->result_attempt = global_base + local_attempts;
            }
            break;
        }

        if (local_attempts >= FLUSH_INTERVAL) {
            atomic_fetch_add(&gs->total_attempts, local_attempts);
            local_attempts = 0;
        }
    }

    if (local_attempts > 0)
        atomic_fetch_add(&gs->total_attempts, local_attempts);
    atomic_fetch_sub(&gs->running_threads, 1);
    return NULL;
}

/* ------------------------------------------------------------------ */
/* Rarity tier */
/* ------------------------------------------------------------------ */

typedef enum { RARITY_COMMON, RARITY_RARE, RARITY_LEGENDARY, RARITY_MYTHIC } rarity_tier_t;

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
        "Usage: %s [--prefix <PREFIX>] [--suffix <SUFFIX>] [--length <N>]\n"
        "       [--threads <N>] [--out <FILE>]\n"
        "       [--case-insensitive] [--quiet]\n"
        "\n"
        "  --prefix PREFIX       Match start of address\n"
        "  --suffix SUFFIX       Match end of address\n"
        "                         Provide both to match start and end\n"
        "  --threads N           Worker threads (default: CPU count)\n"
        "  --out FILE            Output JSON keypair file (default: stdout)\n"
        "  --case-insensitive    Case-insensitive matching\n"
        "  --length N            Only accept addresses of exactly N characters (32-44)\n"
        "  --split-point HEX     Split-key mode: search offsets k for the customer point\n"
        "                        A (64 hex chars); outputs k, never a secret key\n"
        "  --quiet               Suppress progress output\n"
        "\n"
        "Output JSON:\n"
        "  { secretKey, publicKey, attempts, rarity, expectedAttempts, ... }\n"
        "\n"
        "Examples:\n"
        "  %s --suffix RATi --threads 16 --out rati-ca.json\n"
        "  %s --prefix RAT --suffix i --threads 16\n",
        prog, prog, prog);
}

static int validate_base58_target(const char *label, const char *target,
                                  int case_sensitive) {
    int len = target ? (int)strlen(target) : 0;
    if (len == 0) return 0;
    for (int i = 0; i < len; i++) {
        int valid = 0;
        for (int j = 0; BASE58_ALPHABET[j]; j++) {
            char tc = case_sensitive ? target[i] : (char)(target[i] | 0x20);
            char ac = case_sensitive ? BASE58_ALPHABET[j] : (char)(BASE58_ALPHABET[j] | 0x20);
            if (tc == ac) { valid = 1; break; }
        }
        if (!valid) {
            fprintf(stderr, "Error: %s contains '%c', which is not valid base58\n",
                    label, target[i]);
            return -1;
        }
    }
    return len;
}

static void make_target_label(const char *prefix, const char *suffix,
                              char out[96]) {
    if (prefix && suffix)
        snprintf(out, 96, "%s...%s", prefix, suffix);
    else if (prefix)
        snprintf(out, 96, "%s", prefix);
    else if (suffix)
        snprintf(out, 96, "%s", suffix);
    else
        out[0] = '\0';
}

static int get_cpu_count(void) {
#if defined(_WIN32)
    /* Windows: <windows.h> is already included in the platform block
     * at the top of the file. GetSystemInfo reports the number of
     * logical processors, the same semantic sysconf returns on POSIX. */
    SYSTEM_INFO si;
    GetSystemInfo(&si);
    return (si.dwNumberOfProcessors > 0) ? (int)si.dwNumberOfProcessors : 4;
#else
    long n = sysconf(_SC_NPROCESSORS_ONLN);
    return (n > 0) ? (int)n : 4;
#endif
}

static void b58_of(const uint8_t bytes[32], char out[48]) {
    base58_encode(bytes, 32, out, 48);
}

int main(int argc, char **argv) {
#if defined(TREBUCHET_SODIUM)
    if (sodium_init() < 0) {
        fprintf(stderr, "libsodium failed to initialize\n");
        return 1;
    }
#endif
#if defined(_WIN32)
    /* Switch stdout to binary mode so the C runtime doesn't translate
     * \n into \r\n. Today's JSON output is single-line, so the Node
     * side's stdout.trim() forgives the trailing translation. But any
     * future multi-line value embedded in the JSON would silently
     * corrupt on Windows only — preempt that whole class of bug here. */
    _setmode(_fileno(stdout), _O_BINARY);
#endif

    const char *prefix_str = NULL;
    const char *suffix_str = NULL;
    const char *out_path = NULL;
    int thread_count = 0;
    int case_sensitive = 1;
    int address_length = 0;
    const char *split_point_hex = NULL;
    int quiet = 0;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--prefix") == 0 && i + 1 < argc) {
            prefix_str = argv[++i];
        } else if (strcmp(argv[i], "--suffix") == 0 && i + 1 < argc) {
            suffix_str = argv[++i];
        } else if (strcmp(argv[i], "--threads") == 0 && i + 1 < argc) {
            thread_count = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--out") == 0 && i + 1 < argc) {
            out_path = argv[++i];
        } else if (strcmp(argv[i], "--case-insensitive") == 0) {
            case_sensitive = 0;
        } else if (strcmp(argv[i], "--split-point") == 0 && i + 1 < argc) {
            split_point_hex = argv[++i];
        } else if (strcmp(argv[i], "--length") == 0 && i + 1 < argc) {
            address_length = atoi(argv[++i]);
            if (address_length < 32 || address_length > 44) {
                fprintf(stderr, "Error: --length must be between 32 and 44\n");
                return 1;
            }
        } else if (strcmp(argv[i], "--vrf-blockhash") == 0 && i + 1 < argc) {
            /* Retired: the VRF output was the grind seed and the proof
             * revealed it. Accepted and ignored so older callers still run. */
            ++i;
            fprintf(stderr, "Warning: --vrf-blockhash is retired and ignored; "
                            "the seed always comes from the system CSPRNG.\n");
        } else if (strcmp(argv[i], "--quiet") == 0) {
            quiet = 1;
        } else if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            print_usage(argv[0]); return 0;
        } else {
            fprintf(stderr, "Unknown option: %s\n", argv[i]);
            print_usage(argv[0]); return 1;
        }
    }

    if ((!prefix_str || prefix_str[0] == '\0') &&
        (!suffix_str || suffix_str[0] == '\0') && address_length == 0) {
        fprintf(stderr, "Error: --prefix, --suffix, or --length is required\n");
        print_usage(argv[0]); return 1;
    }

    if (prefix_str && prefix_str[0] == '\0') prefix_str = NULL;
    if (suffix_str && suffix_str[0] == '\0') suffix_str = NULL;

    int prefix_len = prefix_str ? validate_base58_target("prefix", prefix_str, case_sensitive) : 0;
    if (prefix_len < 0) return 1;
    int suffix_len = suffix_str ? validate_base58_target("suffix", suffix_str, case_sensitive) : 0;
    if (suffix_len < 0) return 1;
    int target_len = prefix_len + suffix_len;

    if (target_len > 44) {
        fprintf(stderr, "Error: combined prefix/suffix too long (max 44 chars)\n");
        return 1;
    }

    if (thread_count <= 0) thread_count = get_cpu_count();
    if (thread_count > 256) thread_count = 256;

    char variant_buf[48];
    long double prob = prefix_fraction(prefix_str, prefix_len, address_length,
                                       case_sensitive, variant_buf, 0)
                     * suffix_fraction(suffix_str, suffix_len, case_sensitive);
    if (prob <= 0.0L) {
        fprintf(stderr, "Error: no address of %d characters can start with \"%s\"\n",
                address_length, prefix_str ? prefix_str : "");
        return 1;
    }
    double expected = (double)(1.0L / prob);

    /* Precompute fast-match constants for suffix mode.
     * For case-sensitive: one numeric value.  For case-insensitive:
     * enumerate all 2^k case-variant values.  Falls back to full
     * encode if there are too many variants (> MAX_CASE_VARIANTS). */
    int use_fast_match = 0;
    uint64_t fast_mod = 0;
    int fast_num_variants = 0;
    uint64_t fast_target_vals[MAX_CASE_VARIANTS] = {0};

    if (suffix_len > 0 && suffix_len <= MAX_FAST_TARGET_LEN) {
        fast_mod = pow58(suffix_len);
        if (case_sensitive) {
            int ok = 0;
            fast_target_vals[0] = b58_to_u64(suffix_str, suffix_len, &ok);
            if (ok) { fast_num_variants = 1; use_fast_match = 1; }
        } else {
            fast_num_variants = gen_case_variants(suffix_str, suffix_len,
                                                   fast_target_vals,
                                                   MAX_CASE_VARIANTS);
            if (fast_num_variants > 0) use_fast_match = 1;
        }
    }

    uint8_t master_seed[32];
    if (getentropy(master_seed, 32) != 0) {
        fprintf(stderr, "Error: getentropy failed -- cannot generate secure seed\n");
        return 1;
    }

    char target_label[96];
    make_target_label(prefix_str, suffix_str, target_label);

    if (!quiet) {
        if (prefix_str && suffix_str)
            fprintf(stderr, "Vanity Keygen -- grinding for prefix \"%s\" and suffix \"%s\"\n",
                    prefix_str, suffix_str);
        else
            fprintf(stderr, "Vanity Keygen -- grinding for %s: \"%s\"\n",
                    prefix_str ? "prefix" : "suffix",
                    prefix_str ? prefix_str : suffix_str);
        fprintf(stderr, "  Threads: %d  Expected: %.0f attempts (first-character odds and length included)\n",
                thread_count, expected);
        if (address_length)
            fprintf(stderr, "  Address length: exactly %d characters\n", address_length);
        fprintf(stderr, "  Rarity tiers: Common <=%.0f  Rare <=%.0f  Legendary <=%.0f  Mythic >%.0f\n",
                expected, expected * 2, expected * 3, expected * 3);
        if (use_fast_match) {
            fprintf(stderr, "  Fast suffix check: pk %% 58^%d (%d case variant%s)\n",
                    suffix_len, fast_num_variants,
                    fast_num_variants == 1 ? "" : "s");
        }
        fprintf(stderr, "  Grinding...\n");
    }

    grind_state_t gs;
    memset(&gs, 0, sizeof(gs));
    atomic_init(&gs.found, false);
    atomic_init(&gs.total_attempts, 0);
    atomic_init(&gs.running_threads, thread_count);
    gs.prefix            = prefix_str;
    gs.prefix_len        = prefix_len;
    gs.address_length    = address_length;
    if (split_point_hex) {
        /* Decode A. ref10 decodes to -A; negate back. Reject anything that
         * does not round-trip to the same canonical encoding. */
        uint8_t a_bytes[32], check[32];
        ge_p3 neg;
        if (hex_to_bytes32(split_point_hex, a_bytes) != 0
            || ge_frombytes_negate_vartime(&neg, a_bytes) != 0) {
            fprintf(stderr, "Error: --split-point must be a 64-hex-char Ed25519 point\n");
            return 1;
        }
        fe_neg(gs.split_A.X, neg.X);
        fe_copy(gs.split_A.Y, neg.Y);
        fe_copy(gs.split_A.Z, neg.Z);
        fe_neg(gs.split_A.T, neg.T);
        ge_p3_tobytes(check, &gs.split_A);
        if (memcmp(check, a_bytes, 32) != 0) {
            fprintf(stderr, "Error: --split-point is not a canonical Ed25519 point\n");
            return 1;
        }
        gs.split_mode = 1;
    }
    gs.suffix            = suffix_str;
    gs.suffix_len        = suffix_len;
    gs.case_sensitive    = case_sensitive;
    gs.attempts_per_thread = (uint64_t)(expected * 4.0 / (double)thread_count) + 1000000;
    gs.use_fast_match    = use_fast_match;
    gs.fast_mod          = fast_mod;
    gs.fast_num_variants = fast_num_variants;
    memcpy(gs.fast_target_vals, fast_target_vals, sizeof(fast_target_vals));
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
        pthread_create(&threads[i], NULL, gs.split_mode ? split_walk_thread : grind_thread, &args[i]);
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
        if (atomic_exchange(&gs.last_pk_ready, 0))
            pk_str = gs.last_pk;
        fprintf(stderr, "\r  Attempts: %llu  Rate: %.1f K/s  Running: %d threads  Key: %s  ",
                (unsigned long long)total, rate / 1000.0,
                atomic_load(&gs.running_threads), pk_str);
        fflush(stderr);

        last_attempts = total;
        last_tv = now;
    }

    for (int i = 0; i < thread_count; i++)
        pthread_join(threads[i], NULL);

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

    char pk_b58_output[48];
    b58_of(gs.result_pk, pk_b58_output);

    char json_buf[8192];
    int off = 0;
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off, "{");
    if (gs.split_mode) {
        /* Only the offset: the key is a + k and a stays with the customer. */
        off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off, "\"splitPoint\":\"%s\",\"offset\":\"", split_point_hex);
        for (int i = 0; i < 32; i++)
            off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off, "%02x", gs.result_offset[i]);
        off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off, "\",\"publicKey\":\"%s\"", pk_b58_output);
    } else {
        off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off, "\"secretKey\":[");
        for (int i = 0; i < 64; i++)
            off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
                            "%s%d", i > 0 ? "," : "", gs.result_sk[i]);
        off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
            "],\"publicKey\":\"%s\"", pk_b58_output);
    }
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        ",\"attempts\":%llu", (unsigned long long)total_attempts);
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        ",\"rarity\":\"%s\"", rarity_name(rarity));
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        ",\"epochs\":%.4f", (double)total_attempts / expected);
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        ",\"expectedAttempts\":%.0f", expected);
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        ",\"target\":\"%s\"", target_label);
    if (prefix_str)
        off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
            ",\"prefix\":\"%s\"", prefix_str);
    if (suffix_str)
        off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
            ",\"suffix\":\"%s\"", suffix_str);
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        ",\"targetLen\":%d", target_len);
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        ",\"threads\":%d", thread_count);
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        ",\"elapsedSec\":%.3f", elapsed);
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off, "}");

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
