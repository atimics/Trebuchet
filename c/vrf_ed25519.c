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
#include <sodium.h>
#include <string.h>

int vrf_keygen(uint8_t pk[VRF_PK_BYTES], uint8_t sk[VRF_SK_BYTES]) {
    return crypto_sign_keypair(pk, sk);
}

int vrf_keygen_from_seed(uint8_t pk[VRF_PK_BYTES], uint8_t sk[VRF_SK_BYTES],
                          const uint8_t seed[32]) {
    return crypto_sign_seed_keypair(pk, sk, seed);
}

int vrf_prove(uint8_t proof[VRF_PROOF_BYTES],
              uint8_t output[VRF_OUTPUT_BYTES],
              const uint8_t sk[VRF_SK_BYTES],
              const uint8_t *msg, unsigned long long mlen) {
    /* tweetnacl's crypto_sign writes (64 + mlen) bytes into its
     * destination: a 64-byte signature followed by a copy of the
     * input message (this is the "attached" sign form — the only
     * sign API tweetnacl exposes). The caller only wants the 64-byte
     * signature, but we still must hand crypto_sign a buffer big
     * enough to hold the full sig+msg output or it will scribble
     * past the end of proof[] and corrupt adjacent stack frames.
     *
     * On Linux/glibc the overflow tends to land in a benign next-
     * local-variable slot and the binary "works." On Windows the
     * MinGW stack protector / NT page guards trip and the process
     * dies with STATUS_ACCESS_VIOLATION (exit code 0xC0000005).
     * Either way it's a real out-of-bounds write that gcc has been
     * flagging via -Wstringop-overflow.
     *
     * Use a scratch buffer here and memcpy out only the 64-byte
     * signature. The 256-byte message cap matches vrf_verify's
     * matching limit so the prove/verify pair agree on supported
     * message sizes. */
    if (mlen > 256) return -1;
    unsigned char signed_msg[VRF_PROOF_BYTES + 256];
    unsigned long long signed_len = sizeof(signed_msg);
    if (crypto_sign(signed_msg, &signed_len, msg, mlen, sk) != 0) return -1;
    memcpy(proof, signed_msg, VRF_PROOF_BYTES);
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
