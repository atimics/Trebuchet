/* Checks fe51.h and suffix_match.h against ref10 and the full base58 encode.
 * Build and run: make check */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include "ge.h"
#include "precomp_data.h"
#include "base58.h"
#include "fe51.h"
#include "suffix_match.h"

static int fails = 0;
#define CHECK(c, ...) do { if (!(c)) { fails++; fprintf(stderr, "FAIL: " __VA_ARGS__); fprintf(stderr, "\n"); } } while (0)

static void fe10_to_51(fe51 h, const fe f) { uint8_t b[32]; fe_tobytes(b, f); fe51_frombytes(h, b); }
static void rnd(void *p, size_t n) { if (getentropy(p, n) != 0) abort(); }

/* Affine encoding of an fe51 point: y/z with the sign bit of x/z, via ref10 inversion. */
static void encode51(uint8_t pk[32], const ge51_p3 *P) {
    uint8_t zb[32]; fe zf, zi, xf, yf; fe51 zi51, x, y;
    fe51_tobytes(zb, P->Z); fe_frombytes(zf, zb); fe_invert(zi, zf);
    uint8_t ib[32]; fe_tobytes(ib, zi); fe51_frombytes(zi51, ib);
    fe51_mul(x, P->X, zi51); fe51_mul(y, P->Y, zi51);
    uint8_t xb[32]; fe51_tobytes(xb, x); fe51_tobytes(pk, y);
    pk[31] ^= (uint8_t)((xb[0] & 1) << 7);
    (void)xf; (void)yf;
}

static void test_mul(void) {
    for (int i = 0; i < 20000; i++) {
        uint8_t a[32], b[32], r10[32], r51[32];
        rnd(a, 32); rnd(b, 32); a[31] &= 0x7f; b[31] &= 0x7f;
        fe fa, fb, fr; fe_frombytes(fa, a); fe_frombytes(fb, b); fe_mul(fr, fa, fb); fe_tobytes(r10, fr);
        fe51 xa, xb, xr; fe51_frombytes(xa, a); fe51_frombytes(xb, b); fe51_mul(xr, xa, xb); fe51_tobytes(r51, xr);
        CHECK(memcmp(r10, r51, 32) == 0, "mul mismatch at %d", i);
        /* add/sub feed mul */
        fe fs, fd, fp; fe_add(fs, fa, fb); fe_sub(fd, fa, fb); fe_mul(fp, fs, fd); fe_tobytes(r10, fp);
        fe51 xs, xd, xp; fe51_add(xs, xa, xb); fe51_sub(xd, xa, xb); fe51_mul(xp, xs, xd); fe51_tobytes(r51, xp);
        CHECK(memcmp(r10, r51, 32) == 0, "add/sub/mul mismatch at %d", i);
    }
    /* tobytes edge cases: 0, 1, p-1, p, p+1 (non-canonical input) */
    uint8_t edge[5][32]; memset(edge, 0, sizeof(edge));
    edge[1][0] = 1;
    for (int i = 0; i < 32; i++) { edge[2][i] = 0xff; edge[3][i] = 0xff; edge[4][i] = 0xff; }
    edge[2][31] = 0x7f; edge[2][0] = 0xec;            /* p-1 */
    edge[3][31] = 0x7f; edge[3][0] = 0xed;            /* p   -> 0 */
    edge[4][31] = 0x7f; edge[4][0] = 0xee;            /* p+1 -> 1 */
    for (int i = 0; i < 5; i++) {
        fe f; fe_frombytes(f, edge[i]); uint8_t want[32], got[32]; fe_tobytes(want, f);
        fe51 g; fe51_frombytes(g, edge[i]); fe51_tobytes(got, g);
        CHECK(memcmp(want, got, 32) == 0, "tobytes edge %d", i);
    }
}

static void test_walk(void) {
    ge51_precomp G51; fe10_to_51(G51.yplusx, Bi[0].yplusx); fe10_to_51(G51.yminusx, Bi[0].yminusx); fe10_to_51(G51.xy2d, Bi[0].xy2d);
    for (int trial = 0; trial < 4; trial++) {
        uint8_t k0[32]; rnd(k0, 32); k0[31] &= 0x3f;
        ge_p3 P10; ge_scalarmult_base(&P10, k0);
        ge51_p3 P51; fe10_to_51(P51.X, P10.X); fe10_to_51(P51.Y, P10.Y); fe10_to_51(P51.Z, P10.Z); fe10_to_51(P51.T, P10.T);
        for (int step = 0; step < 3000; step++) {
            uint8_t want[32], got[32];
            ge_p3_tobytes(want, &P10); encode51(got, &P51);
            if (memcmp(want, got, 32) != 0) { CHECK(0, "walk mismatch trial %d step %d", trial, step); return; }
            ge_p1p1 t; ge_madd(&t, &P10, &Bi[0]); ge_p1p1_to_p3(&P10, &t);
            ge51_madd(&P51, &G51);
        }
    }
}

static int slow_match(const uint8_t pk[32], const char *suffix, int len, int cs) {
    char b58[48]; size_t n = base58_encode(pk, 32, b58, sizeof(b58));
    if (n < (size_t)len) return 0;
    for (int i = 0; i < len; i++) {
        char a = b58[n - len + i], b = suffix[i];
        if (cs ? a != b : (a | 0x20) != (b | 0x20) || ((a | 0x20) < 'a' || (a | 0x20) > 'z' ? a != b : 0)) return 0;
    }
    return 1;
}

static void test_matcher(void) {
    const char *targets[] = { "t", "Te", "reB", "tReBUchet", "ebuchet", "9", "z9", "ZZ", "1" };
    for (size_t ti = 0; ti < sizeof(targets) / sizeof(*targets); ti++) {
        for (int cs = 0; cs < 2; cs++) {
            const char *s = targets[ti]; int len = (int)strlen(s);
            suffix_matcher_t m; CHECK(suffix_matcher_init(&m, BASE58_ALPHABET, s, len, cs) == 0, "init %s", s);
            long hits = 0, trials = len <= 3 ? 200000 : 40000;
            for (long i = 0; i < trials; i++) {
                uint8_t pk[32]; rnd(pk, 32);
                if (len <= 3 && (i & 7) == 0) { /* force frequent hits by edge-case high bytes */ pk[0] = 0; }
                int a = suffix_matcher_check(&m, pk), b = slow_match(pk, s, len, cs);
                if (a != b) { CHECK(0, "matcher %s cs=%d: fast=%d slow=%d", s, cs, a, b); break; }
                hits += b;
            }
            if (len <= 2) CHECK(hits > 0, "matcher %s cs=%d saw no hits to compare", s, cs);
        }
    }
    /* Forced positives: a key's own last L characters must always match, in both modes,
     * and flipping a letter's case must still match only when case-insensitive. */
    for (int i = 0; i < 20000; i++) {
        uint8_t pk[32]; rnd(pk, 32);
        char b58[48]; size_t n = base58_encode(pk, 32, b58, sizeof(b58));
        int len = 1 + (i % 10); char s[16]; memcpy(s, b58 + n - len, len); s[len] = 0;
        suffix_matcher_t a, b;
        CHECK(suffix_matcher_init(&a, BASE58_ALPHABET, s, len, 1) == 0 && suffix_matcher_check(&a, pk), "positive cs %s", s);
        for (int j = 0; j < len; j++) if (s[j] >= 'a' && s[j] <= 'z' && ((i + j) & 1)) s[j] -= 32;
        CHECK(suffix_matcher_init(&b, BASE58_ALPHABET, s, len, 0) == 0 && suffix_matcher_check(&b, pk), "positive any-case %s", s);
    }
    suffix_matcher_t m;
    CHECK(suffix_matcher_init(&m, BASE58_ALPHABET, "0", 1, 0) == -1, "init must reject '0'");
    CHECK(suffix_matcher_init(&m, BASE58_ALPHABET, "abcdefghijk", 11, 0) == -1, "init must reject 11 chars");
}

int main(void) {
    test_mul(); test_walk(); test_matcher();
    if (fails) { fprintf(stderr, "%d failure(s)\n", fails); return 1; }
    printf("fe51 + suffix_match: all checks passed\n");
    return 0;
}
