/* suffix_match.h - fast base58 suffix filter for 32-byte public keys.
 *
 * A key's base58 address ends in the last L digits of the 256-bit big-endian
 * integer N = pk. Those digits are N mod 58^L written in base 58, so we get
 * them without encoding the whole address: reduce N mod 58^L once, then check
 * each digit against the set of characters allowed at that position. A
 * case-insensitive target allows both cases of every letter, which replaces
 * the old 2^k variant table (capped at 64 variants, so any-case "trebuchet"
 * with 512 variants never got the fast path).
 *
 * This is a necessary condition only. Callers confirm a hit with the full
 * encode and check_match, which also applies the address-length rule.
 */
#ifndef SUFFIX_MATCH_H
#define SUFFIX_MATCH_H

#include <stdint.h>
#include <string.h>

#define SUFFIX_MATCH_MAX_LEN 10   /* 58^10 < 2^59, so the 8 x 32-bit sums fit in 128 bits */

typedef struct {
    int      len;
    uint64_t mod;                         /* 58^len */
    uint64_t pow32[8];                    /* 2^(32*j) mod 58^len, j = 0 is least significant */
    uint64_t allowed[SUFFIX_MATCH_MAX_LEN]; /* bit d set: digit d allowed at that position */
} suffix_matcher_t;

/* Returns 0 on success, -1 if the suffix is empty, too long, or not base58. */
static inline int suffix_matcher_init(suffix_matcher_t *m, const char *alphabet,
                                      const char *suffix, int len, int case_sensitive) {
    if (len < 1 || len > SUFFIX_MATCH_MAX_LEN) return -1;
    memset(m, 0, sizeof(*m));
    m->len = len;
    m->mod = 1;
    for (int i = 0; i < len; i++) m->mod *= 58ULL;

    for (int i = 0; i < len; i++) {
        char ch = suffix[i];
        char other = ch;
        if (!case_sensitive) {
            if (ch >= 'a' && ch <= 'z') other = (char)(ch - 'a' + 'A');
            else if (ch >= 'A' && ch <= 'Z') other = (char)(ch - 'A' + 'a');
        }
        int found = 0;
        for (int d = 0; alphabet[d]; d++) {
            if (alphabet[d] == ch || alphabet[d] == other) {
                m->allowed[i] |= 1ULL << d;
                found = 1;
            }
        }
        if (!found) return -1;
    }

    unsigned __int128 p = 1;
    for (int j = 0; j < 8; j++) {
        m->pow32[j] = (uint64_t)p;
        p = (p << 32) % m->mod;
    }
    return 0;
}

/* True when the last `len` base58 digits of pk could match the target. */
static inline int suffix_matcher_check(const suffix_matcher_t *m, const uint8_t pk[32]) {
    unsigned __int128 sum = 0;
    for (int j = 0; j < 8; j++) {
        const uint8_t *b = pk + 28 - 4 * j;
        uint64_t limb = ((uint64_t)b[0] << 24) | ((uint64_t)b[1] << 16)
                      | ((uint64_t)b[2] << 8) | (uint64_t)b[3];
        sum += (unsigned __int128)limb * m->pow32[j];
    }
    uint64_t x = (uint64_t)(sum % m->mod);
    for (int pos = m->len - 1; pos >= 0; pos--) {
        uint64_t d = x % 58ULL;
        x /= 58ULL;
        if (!((m->allowed[pos] >> d) & 1ULL)) return 0;
    }
    return 1;
}

#endif
