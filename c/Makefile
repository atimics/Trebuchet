CC       ?= cc
# Release builds use a portable baseline so the shipped binary doesn't crash
# on CPUs that lack the build host's ISA extensions.  -march=native is only
# used in the `dev` target (local development).
CFLAGS   ?= -O3 -flto -mtune=generic -Wall -Wextra -Wpedantic -Wno-sign-compare
# On Windows (mingw-w64), BCryptGenRandom needs -lbcrypt. The #pragma
# comment(lib, ...) in randombytes.c only works with MSVC.
LDLIBS   ?=
ifeq ($(OS),Windows_NT)
    LDLIBS += -lbcrypt
endif
BUILD_DIR = build

VENDOR_DIR = vendor
INCLUDES   = -I. -I$(VENDOR_DIR) -I$(VENDOR_DIR)/tweetnacl

TWEETNACL_SRCS = $(VENDOR_DIR)/tweetnacl/tweetnacl.c \
                 $(VENDOR_DIR)/tweetnacl/randombytes.c

VANITY_SRCS = vanity_keygen/vanity_keygen.c vrf_ed25519.c $(TWEETNACL_SRCS)
VANITY_BIN  = $(BUILD_DIR)/vanity_keygen

.PHONY: all clean dev

all: $(VANITY_BIN)

dev: CFLAGS = -O3 -flto -march=native -Wall -Wextra -Wpedantic -Wno-sign-compare
dev: $(VANITY_BIN)

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

$(VANITY_BIN): $(VANITY_SRCS) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(VANITY_SRCS) -o $@ $(INCLUDES) -lpthread $(LDLIBS)

clean:
	rm -rf $(BUILD_DIR)

