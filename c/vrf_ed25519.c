/* Ed25519 VRF on top of TweetNaCl.
 *
 * vrf_prove: sign(msg) -> extract R from signature -> output = SHA-512(R)
 * vrf_verify: verify sig -> extract R -> output = SHA-512(R)
 *
 * Security: the proof (full signature) binds (sk, msg) to an unpredictable R.
 * Without sk, an adversary cannot forge a signature that verifies under pk,
 * so they cannot produce a valid proof for any output of their choosing.
 */

#include "vrf_ed25519.h"
#include "tweetnacl.h"
#include <string.h>

int vrf_keygen(uint8_t pk[VRF_PK_BYTES], uint8_t sk[VRF_SK_BYTES]) {
    return crypto_sign_keypair(pk, sk);
}

int vrf_keygen_from_seed(uint8_t pk[VRF_PK_BYTES], uint8_t sk[VRF_SK_BYTES],
                          const uint8_t seed[32]) {
    return crypto_sign_keypair_from_seed(pk, sk, seed);
}

int vrf_prove(uint8_t proof[VRF_PROOF_BYTES],
              uint8_t output[VRF_OUTPUT_BYTES],
              const uint8_t sk[VRF_SK_BYTES],
              const uint8_t *msg, unsigned long long mlen) {
    unsigned long long siglen = VRF_PROOF_BYTES;
    if (crypto_sign(proof, &siglen, msg, mlen, sk) != 0) return -1;
    /* proof[0..31] = R (compressed commitment point).
     * VRF output = SHA-512(R). */
    crypto_hash_sha512(output, proof, 32);
    return 0;
}

int vrf_verify(uint8_t output[VRF_OUTPUT_BYTES],
               const uint8_t pk[VRF_PK_BYTES],
               const uint8_t *msg, unsigned long long mlen,
               const uint8_t proof[VRF_PROOF_BYTES]) {
    /* Use a fixed-size stack buffer with a reasonable upper bound.
     * In practice the only caller passes a 32-byte Solana blockhash,
     * so a 256-byte buffer is generous. */
    unsigned char decoded[256];
    unsigned long long dlen = sizeof(decoded);
    if (mlen > sizeof(decoded)) return -1;
    if (crypto_sign_open(decoded, &dlen, proof, VRF_PROOF_BYTES, pk) != 0)
        return -1;
    if (dlen != mlen || memcmp(decoded, msg, mlen) != 0) return -1;
    crypto_hash_sha512(output, proof, 32);
    return 0;
}
