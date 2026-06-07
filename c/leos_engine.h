#ifndef LEOS_ENGINE_H
#define LEOS_ENGINE_H

#include <stddef.h>
#include <stdint.h>
#include <complex.h>

/*
 * LeosEngine — pre-allocated holographic compute context.
 *
 * All hot-path operations use pre-allocated scratch buffers; zero malloc
 * after engine creation. The engine owns FFT twiddle-factor LUTs,
 * bit-reversal LUTs, and scratch space. Thread-unsafe by design:
 * create one engine per thread if needed.
 *
 * Dimension must be a power of 2.
 */

typedef struct LeosEngine LeosEngine;

/* Create an engine for dimension `dim` (must be power of 2). */
LeosEngine *leos_engine_create(size_t dim);

/* Free the engine and all owned buffers. */
void leos_engine_destroy(LeosEngine *eng);

/* Return the engine's configured dimension. */
size_t leos_engine_dim(LeosEngine *eng);

/* ---- Core VSA operations (all take pre-allocated output buffers) ---- */

/* Generate a flat-spectrum unit vector (deterministic from seed).
 * out must point to dim doubles. */
void leos_engine_keygen(LeosEngine *eng, uint64_t seed, double *out);

/* bind(k, v) = normalize(ifft(fft(k) * fft(v))).
 * k, v, out are each dim doubles. k and v must be normalized.
 * out may alias k or v. */
void leos_engine_bind(LeosEngine *eng,
                      const double *k, const double *v,
                      double *out);

/* unbind(S, k) = normalize(ifft(fft(S) * conj(fft(k)))).
 * out may alias S. */
void leos_engine_unbind(LeosEngine *eng,
                        const double *S, const double *k,
                        double *out);

/* Prepare key FFT: pre-compute FFT(k) into the key-spectrum cache (ck).
 * Subsequent unbind_cached calls reuse this, saving one FFT per unbind
 * when the same key queries many S matrices. */
void leos_engine_prepare_key_fft(LeosEngine *eng, const double *k);

/* unbind_cached(S) = normalize(ifft(fft(S) * conj(cached_key_fft))).
 * Requires prior prepare_key_fft. Skips the key FFT step. */
void leos_engine_unbind_cached(LeosEngine *eng,
                               const double *S,
                               double *out);


/* Batch bind: bind n (k_i, v_i) pairs into separate output vectors.
 * k_batch = [k_0 | k_1 | ... | k_{n-1}], dim doubles each, contiguous.
 * v_batch = same layout.
 * out_batch = same layout.
 *
 * This reuses the FFT(k_i) for all pairs, saving n FFT calls. */
void leos_engine_bind_batch(LeosEngine *eng,
                            const double *k_batch,
                            const double *v_batch,
                            size_t n,
                            double *out_batch);

/* ---- Vector ops (in-place or output-to-separate-buffer) ---- */

/* Normalize v in-place (dim doubles). */
void leos_engine_normalize(LeosEngine *eng, double *v);

/* Cosine similarity (dot product of unit vectors). */
double leos_engine_dot(LeosEngine *eng,
                       const double *a, const double *b);

/* out = a + b */
void leos_engine_add(LeosEngine *eng,
                     const double *a, const double *b,
                     double *out);

/* out = a - b */
void leos_engine_sub(LeosEngine *eng,
                     const double *a, const double *b,
                     double *out);

/* out = a + scale * b (in-place OK if out aliases b) */
void leos_engine_axpy(LeosEngine *eng,
                      double scale,
                      const double *a, const double *b,
                      double *out);

/* eml_bind(a, b) = normalize(ifft(exp(fft(a)) - log(fft(b))))
 * Complex exp/log applied elementwise in frequency space.
 * EML (exp(x) - ln(y)) is a universal primitive for continuous
 * mathematics; composed with FFT it becomes a new VSA binding operation.
 * out may alias a but must not alias b. */
void leos_engine_eml_bind(LeosEngine *eng,
                         const double *a, const double *b,
                         double *out);

/* Zero-fill a vector */
void leos_engine_zero(LeosEngine *eng, double *v);

/* Copy vector: dst = src */
void leos_engine_copy(LeosEngine *eng, double *dst, const double *src);

/* ---- Performance counters ---- */
uint64_t leos_engine_fft_count(LeosEngine *eng);
uint64_t leos_engine_bind_count(LeosEngine *eng);
void     leos_engine_reset_counters(LeosEngine *eng);

#endif /* LEOS_ENGINE_H */
