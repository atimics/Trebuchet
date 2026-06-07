CC       ?= cc
# Release builds use a portable baseline so the shipped binary doesn't crash
# on CPUs that lack the build host's ISA extensions.  -march=native is only
# used in the `dev` target (local development).
CFLAGS   ?= -O3 -flto -mtune=generic -Wall -Wextra -Wpedantic -Wno-sign-compare
BUILD_DIR = build

VENDOR_DIR = vendor
INCLUDES   = -I. -I$(VENDOR_DIR)

# libsodium provides Ed25519, SHA-512, and CSPRNG.  Find it via
# pkg-config; fall back to a hard-coded linker flag.
SODIUM_CFLAGS := $(shell pkg-config --cflags libsodium 2>/dev/null || echo)
SODIUM_LDLIBS := $(shell pkg-config --libs libsodium 2>/dev/null || echo -lsodium)

VANITY_SRCS = vanity_keygen/vanity_keygen.c vrf_ed25519.c
VANITY_BIN  = $(BUILD_DIR)/vanity_keygen

.PHONY: all clean dev

all: $(VANITY_BIN)

dev: CFLAGS = -O3 -flto -march=native -Wall -Wextra -Wpedantic -Wno-sign-compare
dev: $(VANITY_BIN)

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

$(VANITY_BIN): $(VANITY_SRCS) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(SODIUM_CFLAGS) $(VANITY_SRCS) -o $@ $(INCLUDES) -lpthread $(SODIUM_LDLIBS)

clean:
	rm -rf $(BUILD_DIR)
