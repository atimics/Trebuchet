CC       ?= cc
CFLAGS   ?= -O3 -flto -march=native -Wall -Wextra -Wpedantic -Wno-sign-compare
BUILD_DIR = build

VENDOR_DIR = vendor
INCLUDES   = -I. -I$(VENDOR_DIR) -I$(VENDOR_DIR)/tweetnacl

TWEETNACL_SRCS = $(VENDOR_DIR)/tweetnacl/tweetnacl.c \
                 $(VENDOR_DIR)/tweetnacl/randombytes.c

VANITY_SRCS = vanity_keygen/vanity_keygen.c vrf_ed25519.c $(TWEETNACL_SRCS)
VANITY_BIN  = $(BUILD_DIR)/vanity_keygen

.PHONY: all clean

all: $(VANITY_BIN)

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

$(VANITY_BIN): $(VANITY_SRCS) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $(VANITY_SRCS) -o $@ $(INCLUDES) -lpthread

clean:
	rm -rf $(BUILD_DIR)
