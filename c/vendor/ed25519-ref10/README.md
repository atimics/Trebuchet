# ed25519 ref10 field and group arithmetic

From orlp/ed25519 at commit b1f19fab4aebe607805620d25a5e42566ce46a0e (zlib license, see license.txt), which
packages the public-domain ref10 implementation from SUPERCOP.

Only the field (fe) and group (ge) arithmetic is used, by the split-key walk
in vanity_keygen. It is not used for key generation or signing.
