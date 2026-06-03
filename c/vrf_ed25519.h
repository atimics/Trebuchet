/* Ed25519-based VRF: prove(master_seed, msg) -> {proof, output}
 *
 * Uses the Ed25519 signing nonce commitment R as the VRF core:
 *   R = deterministic nonce derived from (sk, msg) per RFC 8032
 *   output = SHA-512(R)
 *   proof  = full 64-byte Ed25519 signature on msg
 *
 * Verification: verify the signature, extract R, hash R to recover output.
 * This is not RFC 9381 ECVRF — it uses the standard Ed25519 challenge hash.
 * For our use case (proving honest seed derivation from a fresh ephemeral
 * keypair) the proof is unforgeable and the output is uniquely bound to
 * (sk, msg) with zero implementation risk beyond what TweetNaCl provides.
 */

#ifndef VRF_ED25519_H
#define VRF_ED25519_H

#include <stdint.h>

#define VRF_PROOF_BYTES   64
#define VRF_OUTPUT_BYTES  64
#define VRF_SEED_BYTES    32
#define VRF_SK_BYTES      64
#define VRF_PK_BYTES      32

int vrf_keygen(uint8_t pk[VRF_PK_BYTES], uint8_t sk[VRF_SK_BYTES]);
int vrf_keygen_from_seed(uint8_t pk[VRF_PK_BYTES], uint8_t sk[VRF_SK_BYTES],
                          const uint8_t seed[32]);
int vrf_prove(uint8_t proof[VRF_PROOF_BYTES],
              uint8_t output[VRF_OUTPUT_BYTES],
              const uint8_t sk[VRF_SK_BYTES],
              const uint8_t *msg, unsigned long long mlen);
int vrf_verify(uint8_t output[VRF_OUTPUT_BYTES],
               const uint8_t pk[VRF_PK_BYTES],
               const uint8_t *msg, unsigned long long mlen,
               const uint8_t proof[VRF_PROOF_BYTES]);

#endif
