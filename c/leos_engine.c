#include "leos_engine.h"
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdio.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/* ---------------------------------------------------------------------------
 * Engine struct
 * ---------------------------------------------------------------------------*/

struct LeosEngine {
    size_t dim;
    size_t log2_dim;

    size_t         *bit_rev;
    double complex  *twiddle_fwd;
    double complex  *twiddle_inv;

    double complex  *c0;
    double complex  *c1;
    double complex  *ck;      /* key-spectrum cache for batch bind */
    double          *d0;
    double          *d1;

    uint64_t fft_count;
    uint64_t bind_count;
};

/* ---------------------------------------------------------------------------
 * Internal: log2
 * ---------------------------------------------------------------------------*/

static size_t ilog2(size_t n) {
    size_t r = 0;
    while (n >>= 1) r++;
    return r;
}

/* ---------------------------------------------------------------------------
 * Pre-compute twiddle factors (stored in canonical Cooley-Tukey order)
 * ---------------------------------------------------------------------------*/

static void build_twiddles(double complex *tw, size_t n, int sign) {
    for (size_t len = 2; len <= n; len <<= 1) {
        double angle = sign * 2.0 * M_PI / (double)len;
        double complex wlen = cos(angle) + I * sin(angle);
        double complex w = 1.0;
        size_t half = len >> 1;
        size_t base = half - 1;
        for (size_t j = 0; j < half; j++) {
            tw[base + j] = w;
            w *= wlen;
        }
    }
}

/* ---------------------------------------------------------------------------
 * In-place complex FFT using pre-computed twiddles and bit-rev LUT
 * ---------------------------------------------------------------------------*/

static void fft_c2c(double complex *data, size_t n,
                    const size_t *bit_rev, const double complex *tw) {
    for (size_t i = 0; i < n; i++) {
        size_t j = bit_rev[i];
        if (i < j) {
            double complex tmp = data[i];
            data[i] = data[j];
            data[j] = tmp;
        }
    }

    for (size_t len = 2; len <= n; len <<= 1) {
        size_t half = len >> 1;
        size_t tw_off = half - 1;
        for (size_t i = 0; i < n; i += len) {
            for (size_t j = 0; j < half; j++) {
                double complex u = data[i + j];
                double complex v = data[i + j + half] * tw[tw_off + j];
                data[i + j]        = u + v;
                data[i + j + half] = u - v;
            }
        }
    }
}

/* ---------------------------------------------------------------------------
 * Lifecycle
 * ---------------------------------------------------------------------------*/

LeosEngine *leos_engine_create(size_t dim) {
    if (dim == 0 || (dim & (dim - 1)) != 0) {
        fprintf(stderr, "leos_engine: dim=%zu not power of 2\n", dim);
        return NULL;
    }

    LeosEngine *eng = calloc(1, sizeof(LeosEngine));
    if (!eng) return NULL;

    eng->dim = dim;
    eng->log2_dim = ilog2(dim);

    eng->bit_rev     = malloc(dim * sizeof(size_t));
    eng->twiddle_fwd = malloc(dim * sizeof(double complex));
    eng->twiddle_inv = malloc(dim * sizeof(double complex));
    eng->c0          = malloc(dim * sizeof(double complex));
    eng->c1          = malloc(dim * sizeof(double complex));
    eng->ck          = malloc(dim * sizeof(double complex));
    eng->d0          = malloc(dim * sizeof(double));
    eng->d1          = malloc(dim * sizeof(double));

    if (!eng->bit_rev || !eng->twiddle_fwd || !eng->twiddle_inv ||
        !eng->c0 || !eng->c1 || !eng->ck || !eng->d0 || !eng->d1) {
        leos_engine_destroy(eng);
        return NULL;
    }

    for (size_t i = 0; i < dim; i++) {
        size_t j = 0;
        for (size_t b = 0; b < eng->log2_dim; b++)
            if (i & ((size_t)1 << b))
                j |= ((size_t)1 << (eng->log2_dim - 1 - b));
        eng->bit_rev[i] = j;
    }

    build_twiddles(eng->twiddle_fwd, dim, -1);
    build_twiddles(eng->twiddle_inv, dim, 1);

    return eng;
}

void leos_engine_destroy(LeosEngine *eng) {
    if (!eng) return;
    free(eng->bit_rev);
    free(eng->twiddle_fwd);
    free(eng->twiddle_inv);
    free(eng->c0); free(eng->c1); free(eng->ck);
    free(eng->d0); free(eng->d1);
    free(eng);
}

size_t leos_engine_dim(LeosEngine *eng) { return eng->dim; }

/* ---------------------------------------------------------------------------
 * Internal helpers — operate on engine scratch buffers
 * ---------------------------------------------------------------------------*/

/* Copy real vector to c0 as complex */
static void r2c0(LeosEngine *eng, const double *real) {
    for (size_t i = 0; i < eng->dim; i++)
        eng->c0[i] = real[i] + 0.0 * I;
}

/* Copy real vector to c1 as complex */
static void r2c1(LeosEngine *eng, const double *real) {
    for (size_t i = 0; i < eng->dim; i++)
        eng->c1[i] = real[i] + 0.0 * I;
}

/* Forward FFT on c0 */
static void fwd_c0(LeosEngine *eng) {
    fft_c2c(eng->c0, eng->dim, eng->bit_rev, eng->twiddle_fwd);
    eng->fft_count++;
}

/* Forward FFT on c1 */
static void fwd_c1(LeosEngine *eng) {
    fft_c2c(eng->c1, eng->dim, eng->bit_rev, eng->twiddle_fwd);
    eng->fft_count++;
}

/* Inverse FFT on c0, real result scaled into d0 */
static void inv_c0_to_d0(LeosEngine *eng) {
    fft_c2c(eng->c0, eng->dim, eng->bit_rev, eng->twiddle_inv);
    double scale = 1.0 / (double)eng->dim;
    for (size_t i = 0; i < eng->dim; i++)
        eng->d0[i] = creal(eng->c0[i]) * scale;
    eng->fft_count++;
}

/* Normalize d0 in-place (project onto hypersphere) */
static void norm_d0(LeosEngine *eng) {
    double sum = 0.0;
    for (size_t i = 0; i < eng->dim; i++)
        sum += eng->d0[i] * eng->d0[i];
    double inv = 1.0 / sqrt(sum);
    for (size_t i = 0; i < eng->dim; i++)
        eng->d0[i] *= inv;
}

/* ---------------------------------------------------------------------------
 * Public: keygen
 * ---------------------------------------------------------------------------*/

static uint64_t xorshift64(uint64_t *state) {
    uint64_t x = *state;
    x ^= x << 13; x ^= x >> 7; x ^= x << 17;
    *state = x;
    return x;
}

static double randu(uint64_t *state) {
    return (double)(xorshift64(state) >> 11) * 0x1.0p-53;
}

void leos_engine_keygen(LeosEngine *eng, uint64_t seed, double *out) {
    size_t dim = eng->dim, half = dim / 2;
    uint64_t rng = seed ? seed : 1;

    /* Build flat spectrum in c0 */
    eng->c0[0] = (randu(&rng) < 0.5) ? 1.0 : -1.0;
    for (size_t i = 1; i < half; i++) {
        double phase = randu(&rng) * 2.0 * M_PI;
        eng->c0[i] = cos(phase) + I * sin(phase);
        eng->c0[dim - i] = conj(eng->c0[i]);
    }
    if (dim % 2 == 0)
        eng->c0[half] = (randu(&rng) < 0.5) ? 1.0 : -1.0;

    inv_c0_to_d0(eng);
    norm_d0(eng);
    memcpy(out, eng->d0, dim * sizeof(double));
}

/* ---------------------------------------------------------------------------
 * Public: bind — bind(k, v) via frequency-domain multiply
 *   c0 = FFT(k), c1 = FFT(v), c0 *= c1, inv_FFT(c0) -> d0, normalize -> out
 * ---------------------------------------------------------------------------*/

void leos_engine_bind(LeosEngine *eng,
                      const double *k, const double *v,
                      double *out) {
    /* FFT(k) -> c0 */
    r2c0(eng, k);
    fwd_c0(eng);

    /* FFT(v) -> c1 */
    r2c1(eng, v);
    fwd_c1(eng);

    /* c0 *= c1 */
    for (size_t i = 0; i < eng->dim; i++)
        eng->c0[i] *= eng->c1[i];

    inv_c0_to_d0(eng);
    norm_d0(eng);
    memcpy(out, eng->d0, eng->dim * sizeof(double));
    eng->bind_count++;
}

/* ---------------------------------------------------------------------------
 * Public: unbind — unbind(S, k) via conjugate multiply
 *   c0 = FFT(S), ck = FFT(k), c0 *= conj(ck), inv_FFT(c0) -> d0, normalize
 * ---------------------------------------------------------------------------*/

void leos_engine_unbind(LeosEngine *eng,
                        const double *S, const double *k,
                        double *out) {
    /* FFT(S) -> c0 */
    r2c0(eng, S);
    fwd_c0(eng);

    /* FFT(k) -> c1 (we use c1 for the key spectrum; ck is for batch use) */
    r2c1(eng, k);
    fwd_c1(eng);

    /* c0 *= conj(c1) */
    for (size_t i = 0; i < eng->dim; i++)
        eng->c0[i] *= conj(eng->c1[i]);

    inv_c0_to_d0(eng);
    norm_d0(eng);
    memcpy(out, eng->d0, eng->dim * sizeof(double));
}

/* ---------------------------------------------------------------------------
 * Public: prepare_key_fft — pre-compute FFT(k) into ck cache.
 *   After calling this, unbind_cached uses the cached spectrum instead of
 *   re-FFTing the key. Saves one FFT per call when the same key is reused.
 * ---------------------------------------------------------------------------*/

void leos_engine_prepare_key_fft(LeosEngine *eng, const double *k) {
    /* FFT(k) -> ck */
    r2c1(eng, k);  /* reuse c1 as temp: copy k -> c1 */
    fwd_c1(eng);
    /* Move c1 spectrum to ck */
    memcpy(eng->ck, eng->c1, eng->dim * sizeof(double complex));
}

/* ---------------------------------------------------------------------------
 * Public: unbind_cached — unbind(S) using cached key spectrum in ck.
 *   Must be preceded by leos_engine_prepare_key_fft.
 *   Skips the key r2c and FFT, saving ~1/3 of the unbind cost.
 * ---------------------------------------------------------------------------*/

void leos_engine_unbind_cached(LeosEngine *eng,
                               const double *S,
                               double *out) {
    /* FFT(S) -> c0 */
    r2c0(eng, S);
    fwd_c0(eng);

    /* c0 *= conj(ck) — ck was populated by prepare_key_fft */
    for (size_t i = 0; i < eng->dim; i++)
        eng->c0[i] *= conj(eng->ck[i]);

    inv_c0_to_d0(eng);
    norm_d0(eng);
    memcpy(out, eng->d0, eng->dim * sizeof(double));
}
/* ---------------------------------------------------------------------------
 * Public: eml_bind — eml_bind(a, b) via complex exp/log in frequency domain
 *   c0 = FFT(a), c1 = FFT(b)
 *   c0 = exp(c0) - log(c1)   (elementwise, complex exp and complex log)
 *   inv_FFT(c0) -> d0, normalize -> out
 * ---------------------------------------------------------------------------*/

void leos_engine_eml_bind(LeosEngine *eng,
                          const double *a, const double *b,
                          double *out) {
    /* FFT(a) -> c0 */
    r2c0(eng, a);
    fwd_c0(eng);

    /* FFT(b) -> c1 */
    r2c1(eng, b);
    fwd_c1(eng);

    /*
     * c0 = exp(c0) - log(c1)  (complex, elementwise)
     *
     * Decomposed inline to avoid glibc cexp/clog branch overhead:
     *   cexp(a+bi)  = exp(a)*(cos b + i*sin b)
     *   clog(a+bi)  = 0.5*log(a*a+b*b) + i*atan2(b, a)
     *
     * Inputs are FFT of real unit-norm vectors: magnitudes bounded,
     * no infinities or NaNs, so we can skip special-case handling.
     */
    for (size_t i = 0; i < eng->dim; i++) {
        double ar = creal(eng->c0[i]), ai = cimag(eng->c0[i]);
        double br = creal(eng->c1[i]), bi = cimag(eng->c1[i]);

        /* cexp(ar + i*ai) */
        double ea = exp(ar);
        double exp_r = ea * cos(ai);
        double exp_i = ea * sin(ai);

        /* clog(br + i*bi) = 0.5*log(br*br + bi*bi) + i*atan2(bi, br) */
        double log_mag = 0.5 * log(br * br + bi * bi);
        double phase   = atan2(bi, br);

        eng->c0[i] = (exp_r - log_mag) + I * (exp_i - phase);
    }

    inv_c0_to_d0(eng);
    norm_d0(eng);
    memcpy(out, eng->d0, eng->dim * sizeof(double));
    eng->bind_count++;
}

/* ---------------------------------------------------------------------------
 * Public: bind_batch — bind n (k_i, v_i) pairs
 *
 * Strategy: FFT all v_i first into ck cache so we can reuse key FFTs.
 * Actually, since each (k_i, v_i) has a different key, we can't fully batch.
 * But we CAN batch when the same key binds to multiple values — useful for
 * the holographic store accumulation step.
 *
 * For now: sequential binds with shared scratch. Still zero malloc per call.
 * ---------------------------------------------------------------------------*/

void leos_engine_bind_batch(LeosEngine *eng,
                            const double *k_batch,
                            const double *v_batch,
                            size_t n,
                            double *out_batch) {
    for (size_t i = 0; i < n; i++) {
        leos_engine_bind(eng,
                         k_batch + i * eng->dim,
                         v_batch + i * eng->dim,
                         out_batch + i * eng->dim);
    }
}

/* ---------------------------------------------------------------------------
 * Public: vector ops
 * ---------------------------------------------------------------------------*/

void leos_engine_normalize(LeosEngine *eng, double *v) {
    double sum = 0.0;
    for (size_t i = 0; i < eng->dim; i++)
        sum += v[i] * v[i];
    double inv = 1.0 / sqrt(sum);
    for (size_t i = 0; i < eng->dim; i++)
        v[i] *= inv;
}

double leos_engine_dot(LeosEngine *eng,
                       const double *a, const double *b) {
    double sum = 0.0;
    for (size_t i = 0; i < eng->dim; i++)
        sum += a[i] * b[i];
    return sum;
}

void leos_engine_add(LeosEngine *eng,
                     const double *a, const double *b, double *out) {
    for (size_t i = 0; i < eng->dim; i++)
        out[i] = a[i] + b[i];
}

void leos_engine_sub(LeosEngine *eng,
                     const double *a, const double *b, double *out) {
    for (size_t i = 0; i < eng->dim; i++)
        out[i] = a[i] - b[i];
}

void leos_engine_axpy(LeosEngine *eng, double scale,
                      const double *a, const double *b, double *out) {
    for (size_t i = 0; i < eng->dim; i++)
        out[i] = a[i] + scale * b[i];
}

void leos_engine_zero(LeosEngine *eng, double *v) {
    memset(v, 0, eng->dim * sizeof(double));
}

void leos_engine_copy(LeosEngine *eng, double *dst, const double *src) {
    memcpy(dst, src, eng->dim * sizeof(double));
}

/* ---------------------------------------------------------------------------
 * Counters
 * ---------------------------------------------------------------------------*/

uint64_t leos_engine_fft_count(LeosEngine *eng)  { return eng->fft_count; }
uint64_t leos_engine_bind_count(LeosEngine *eng) { return eng->bind_count; }

void leos_engine_reset_counters(LeosEngine *eng) {
    eng->fft_count = 0;
    eng->bind_count = 0;
}
