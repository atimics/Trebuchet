/* fe51.h - radix-2^51 field arithmetic for the split-key walk hot loop.
 *
 * Same field as ref10 (GF(2^255 - 19)) but with 5 x 51-bit limbs and 128-bit
 * products, which is about twice as fast as ref10's 10 x 25.5-bit limbs on
 * 64-bit CPUs. Only the walk uses it; setup (A + k0*G, the base point, and
 * the one inversion per batch) stays on ref10 and crosses over as 32-byte
 * little-endian strings, so there is no second copy of the group logic to
 * keep in sync.
 *
 * Limb bounds: every function accepts limbs below 2^54 and fe51_mul/_sq
 * return limbs below 2^51 + 2^13. fe51_add and fe51_sub results stay below
 * 2^53, so they can feed fe51_mul directly.
 */
#ifndef FE51_H
#define FE51_H

#include <stdint.h>
#include <string.h>

typedef uint64_t fe51[5];
__extension__ typedef unsigned __int128 u128_t;

#define FE51_MASK ((1ULL << 51) - 1)

static inline void fe51_copy(fe51 h, const fe51 f) {
    h[0] = f[0]; h[1] = f[1]; h[2] = f[2]; h[3] = f[3]; h[4] = f[4];
}

static inline void fe51_add(fe51 h, const fe51 f, const fe51 g) {
    h[0] = f[0] + g[0]; h[1] = f[1] + g[1]; h[2] = f[2] + g[2];
    h[3] = f[3] + g[3]; h[4] = f[4] + g[4];
}

/* h = f - g + 2p, so every limb stays non-negative. */
static inline void fe51_sub(fe51 h, const fe51 f, const fe51 g) {
    h[0] = f[0] + 0xFFFFFFFFFFFDAULL - g[0];
    h[1] = f[1] + 0xFFFFFFFFFFFFEULL - g[1];
    h[2] = f[2] + 0xFFFFFFFFFFFFEULL - g[2];
    h[3] = f[3] + 0xFFFFFFFFFFFFEULL - g[3];
    h[4] = f[4] + 0xFFFFFFFFFFFFEULL - g[4];
}

static inline void fe51_mul(fe51 h, const fe51 f, const fe51 g) {
    const uint64_t f0 = f[0], f1 = f[1], f2 = f[2], f3 = f[3], f4 = f[4];
    const uint64_t g0 = g[0], g1 = g[1], g2 = g[2], g3 = g[3], g4 = g[4];
    const uint64_t g1_19 = 19 * g1, g2_19 = 19 * g2, g3_19 = 19 * g3, g4_19 = 19 * g4;

    u128_t r0 = (u128_t)f0 * g0 + (u128_t)f1 * g4_19 + (u128_t)f2 * g3_19
              + (u128_t)f3 * g2_19 + (u128_t)f4 * g1_19;
    u128_t r1 = (u128_t)f0 * g1 + (u128_t)f1 * g0 + (u128_t)f2 * g4_19
              + (u128_t)f3 * g3_19 + (u128_t)f4 * g2_19;
    u128_t r2 = (u128_t)f0 * g2 + (u128_t)f1 * g1 + (u128_t)f2 * g0
              + (u128_t)f3 * g4_19 + (u128_t)f4 * g3_19;
    u128_t r3 = (u128_t)f0 * g3 + (u128_t)f1 * g2 + (u128_t)f2 * g1
              + (u128_t)f3 * g0 + (u128_t)f4 * g4_19;
    u128_t r4 = (u128_t)f0 * g4 + (u128_t)f1 * g3 + (u128_t)f2 * g2
              + (u128_t)f3 * g1 + (u128_t)f4 * g0;

    uint64_t c;
    uint64_t o0 = (uint64_t)r0 & FE51_MASK; c = (uint64_t)(r0 >> 51);
    r1 += c; uint64_t o1 = (uint64_t)r1 & FE51_MASK; c = (uint64_t)(r1 >> 51);
    r2 += c; uint64_t o2 = (uint64_t)r2 & FE51_MASK; c = (uint64_t)(r2 >> 51);
    r3 += c; uint64_t o3 = (uint64_t)r3 & FE51_MASK; c = (uint64_t)(r3 >> 51);
    r4 += c; uint64_t o4 = (uint64_t)r4 & FE51_MASK; c = (uint64_t)(r4 >> 51);
    o0 += c * 19;
    o1 += o0 >> 51; o0 &= FE51_MASK;
    h[0] = o0; h[1] = o1; h[2] = o2; h[3] = o3; h[4] = o4;
}

/* Load 32 little-endian bytes; the top bit (bit 255) is ignored. */
static inline void fe51_frombytes(fe51 h, const uint8_t s[32]) {
    uint64_t w[4];
    for (int i = 0; i < 4; i++) {
        uint64_t v = 0;
        for (int j = 7; j >= 0; j--) v = (v << 8) | s[8 * i + j];
        w[i] = v;
    }
    h[0] = w[0] & FE51_MASK;
    h[1] = ((w[0] >> 51) | (w[1] << 13)) & FE51_MASK;
    h[2] = ((w[1] >> 38) | (w[2] << 26)) & FE51_MASK;
    h[3] = ((w[2] >> 25) | (w[3] << 39)) & FE51_MASK;
    h[4] = (w[3] >> 12) & FE51_MASK;
}

/* Fully reduce mod p and write 32 little-endian bytes. */
static inline void fe51_tobytes(uint8_t s[32], const fe51 f) {
    uint64_t t0 = f[0], t1 = f[1], t2 = f[2], t3 = f[3], t4 = f[4];
    for (int pass = 0; pass < 2; pass++) {
        t1 += t0 >> 51; t0 &= FE51_MASK;
        t2 += t1 >> 51; t1 &= FE51_MASK;
        t3 += t2 >> 51; t2 &= FE51_MASK;
        t4 += t3 >> 51; t3 &= FE51_MASK;
        t0 += 19 * (t4 >> 51); t4 &= FE51_MASK;
    }
    /* q = 1 when the value is >= p, else 0. */
    uint64_t q = (t0 + 19) >> 51;
    q = (t1 + q) >> 51;
    q = (t2 + q) >> 51;
    q = (t3 + q) >> 51;
    q = (t4 + q) >> 51;
    t0 += 19 * q;
    t1 += t0 >> 51; t0 &= FE51_MASK;
    t2 += t1 >> 51; t1 &= FE51_MASK;
    t3 += t2 >> 51; t2 &= FE51_MASK;
    t4 += t3 >> 51; t3 &= FE51_MASK;
    t4 &= FE51_MASK;

    uint64_t w[4];
    w[0] = t0 | (t1 << 51);
    w[1] = (t1 >> 13) | (t2 << 38);
    w[2] = (t2 >> 26) | (t3 << 25);
    w[3] = (t3 >> 39) | (t4 << 12);
    for (int i = 0; i < 4; i++)
        for (int j = 0; j < 8; j++) s[8 * i + j] = (uint8_t)(w[i] >> (8 * j));
}

/* Extended twisted-Edwards point, same layout as ref10's ge_p3. */
typedef struct { fe51 X, Y, Z, T; } ge51_p3;
/* Base point in precomputed (y+x, y-x, 2dxy) form. */
typedef struct { fe51 yplusx, yminusx, xy2d; } ge51_precomp;

/* P += Q for a precomputed Q (ref10's ge_madd followed by ge_p1p1_to_p3):
 * 7 field multiplications. */
static inline void ge51_madd(ge51_p3 *p, const ge51_precomp *q) {
    fe51 a, b, c, d, t0, X, Y, Z, T;
    fe51_add(a, p->Y, p->X);
    fe51_sub(b, p->Y, p->X);
    fe51_mul(c, a, q->yplusx);
    fe51_mul(d, b, q->yminusx);
    fe51_mul(T, q->xy2d, p->T);
    fe51_add(t0, p->Z, p->Z);
    fe51_sub(X, c, d);          /* p1p1 X */
    fe51_add(Y, c, d);          /* p1p1 Y */
    fe51_add(Z, t0, T);         /* p1p1 Z */
    fe51_sub(T, t0, T);         /* p1p1 T */
    fe51_mul(p->X, X, T);
    fe51_mul(p->Y, Y, Z);
    fe51_mul(p->Z, Z, T);
    fe51_mul(p->T, X, Y);
}

#endif
