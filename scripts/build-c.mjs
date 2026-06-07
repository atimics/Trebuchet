// Cross-platform C build for the vanity_keygen binary.
// Replaces `make -C c` so Windows users don't need a Unix make installed
// just to compile this one small program. The Makefile still works for
// anyone who prefers it; this script is the universal entry point.
//
// What it does:
//   1. Detects an available C compiler (gcc or clang) in PATH.
//   2. Creates c/build/ if needed.
//   3. Invokes the compiler with the same flags as the Makefile.
//   4. On success, the binary lands at c/build/vanity_keygen (Unix)
//      or c/build/vanity_keygen.exe (Windows, where gcc/clang append
//      the .exe extension automatically).
//
// What it doesn't try to do:
//   - MSVC (cl.exe): flag syntax is completely different from gcc/clang,
//     and the C source uses pthread + unistd which need a Unix-ish
//     toolchain. Pointing Windows users at MinGW or LLVM is realistic.
//   - Cross-compilation: builds for the host platform only.

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, chmodSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const cDir = path.join(repoRoot, 'c');
const buildDir = path.join(cDir, 'build');

// Source files. Paths are relative to cDir because that's the working
// directory we'll cd into when spawning the compiler — keeps the
// compiler's diagnostic messages readable.
const sources = [
  path.join('vanity_keygen', 'vanity_keygen.c'),
  'vrf_ed25519.c'
];

// Include paths, same set as the Makefile's INCLUDES variable.
const includes = ['.', 'vendor'];


// Detect libsodium via pkg-config or Homebrew default paths.
let sodiumCflags = "";
try {
  const p = spawnSync("pkg-config", ["--cflags", "libsodium"], { stdio: "pipe" });
  if (p.status === 0) sodiumCflags = p.stdout.toString().trim();
} catch (_) {}
if (!sodiumCflags && process.platform === "darwin") {
  sodiumCflags = "-I/opt/homebrew/opt/libsodium/include -I/opt/homebrew/include";
}
let sodiumLibs = "-lsodium";
try {
  const p = spawnSync("pkg-config", ["--libs", "libsodium"], { stdio: "pipe" });
  if (p.status === 0) sodiumLibs = p.stdout.toString().trim();
} catch (_) {}
if (sodiumLibs === "-lsodium" && process.platform === "darwin") {
  sodiumLibs = "-L/opt/homebrew/opt/libsodium/lib -lsodium";
}

// Try a compiler by probing with --version. Returns the name if usable,
// null otherwise. Uses shell: true on Windows so the search obeys
// PATHEXT — without it, spawnSync('gcc', ...) on Windows would only
// find a literal `gcc` (no .exe), missing the actual `gcc.exe` that
// MinGW installs.
function probe(name) {
  try {
    const result = spawnSync(name, ['--version'], {
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
    return result.status === 0 ? name : null;
  } catch (_) {
    return null;
  }
}

function detectCompiler() {
  return probe('gcc') || probe('clang') || null;
}

function build(compiler) {
  // Output name. gcc/clang on Windows append .exe automatically when
  // the -o argument has no extension, so we can pass the bare name and
  // let the compiler handle it. We use the bare name in both places so
  // the same code path works on every platform.
  const outName = process.platform === 'win32' ? 'vanity_keygen.exe' : 'vanity_keygen';
  const outPath = path.join(buildDir, outName);

  // Platform/arch-aware flags.
  //
  // -mtune=generic is x86-only. On ARM (Apple Silicon arm64, ARM Linux
  // including Raspberry Pi), clang warns and some gcc versions error.
  // The default tune on ARM is already "generic enough" so we just omit
  // -mtune there entirely.
  //
  // Link libraries and link mode differ by platform:
  //
  // -pthread vs -lpthread: -pthread is the documented portable form on
  //   Unix (also sets _REENTRANT preprocessor flag). MinGW accepts both,
  //   but the proven-working configuration on Windows uses -lpthread, so
  //   we keep that there to avoid regressing the user's working build.
  //
  // -lbcrypt: Windows ONLY. randombytes.c (BCryptGenRandom for tweetnacl's
  //   RNG) and vanity_keygen.c's _WIN32 getentropy() shim both call
  //   bcrypt APIs. Each source file has a `#pragma comment(lib, "bcrypt.lib")`
  //   directive, but that's an MSVC-only convention — MinGW gcc IGNORES
  //   it with a -Wunknown-pragmas warning, so without an explicit
  //   -lbcrypt on the link line, the linker emits "undefined reference
  //   to BCryptGenRandom" on every call site. The pragma stays in the
  //   source as documentation and for any future MSVC-based build, but
  //   the build script is what actually wires up the dependency.
  //
  // -static-libgcc + -Wl,-Bstatic -lpthread -Wl,-Bdynamic (Windows only):
  //   Statically link the MinGW runtime so the resulting .exe doesn't
  //   depend on libgcc_s_seh-1.dll or libwinpthread-1.dll being on the
  //   end user's PATH. Those DLLs ship with MinGW but not with stock
  //   Windows. Without static linkage, a user without MinGW installed
  //   sees the binary die with STATUS_DLL_NOT_FOUND (0xC0000135 = decimal
  //   3221225781) before main() runs, because the OS loader can't
  //   resolve the runtime imports. The -Wl,-Bstatic / -Wl,-Bdynamic
  //   bracket around -lpthread tells ld to use winpthreads' static
  //   archive (libpthread.a) for that specific lib, then revert to
  //   dynamic for everything else (bcrypt, kernel32, etc. — which
  //   either don't ship a static archive or are always-present system
  //   DLLs that don't need bundling).
  const isX86 = process.arch === 'x64' || process.arch === 'ia32';
  const archFlags = isX86 ? ['-mtune=generic'] : [];

  // Platform-specific compile flags. Windows-only: force MinGW's C99
  // printf via __USE_MINGW_ANSI_STDIO=1. Modern MinGW-w64 defaults
  // this on, but older toolchains fall back to MSVC's runtime printf
  // where %llu doesn't format long long correctly — the binary would
  // emit garbage attempt counts and Node's JSON.parse would blow up.
  // Defensive flag; no-op on toolchains that already default it on.
  const platformDefines = process.platform === 'win32'
    ? ['-D__USE_MINGW_ANSI_STDIO=1']
    : [];

  const linkLibs = process.platform === 'win32'
    ? ['-static-libgcc', '-Wl,-Bstatic', '-lpthread', '-Wl,-Bdynamic', '-lsodium']
    : ['-pthread', '-lsodium'];

  const args = [
    '-O3', '-flto',
    ...archFlags,
    ...platformDefines,
    '-Wall', '-Wextra', '-Wpedantic', '-Wno-sign-compare',
    ...sources,
    '-o', outPath,
    ...includes.flatMap((i) => ['-I', i]),
    ...(sodiumCflags ? sodiumCflags.split(/\s+/).filter(f => f.startsWith('-I')) : []),
    ...(sodiumLibs ? sodiumLibs.split(/\s+/) : []),

    ...linkLibs,
  ];

  console.log(`Building vanity_keygen with ${compiler}`);
  console.log(`  platform: ${process.platform} / ${process.arch}`);
  console.log(`  output:   ${outPath}`);
  console.log('  sodiumCflags:', sodiumCflags);
  console.log('  sodiumLibs:', sodiumLibs);
  console.log('  linkLibs:', linkLibs);

  const result = spawnSync(compiler, args, {
    cwd: cDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(`\nFailed to invoke ${compiler}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\n${compiler} exited with status ${result.status}.`);
    process.exit(result.status || 1);
  }

  // On Unix, ensure the executable bit is set. The compiler sets it
  // automatically when -o targets a non-existent file, but on some
  // filesystems (network mounts, weird permissions umasks, rebuilding
  // over a non-executable file) the bit can be missing or get reset.
  // chmodSync is a no-op when bits are already correct, so just call
  // it unconditionally — cheaper than introspecting first.
  if (process.platform !== 'win32') {
    try {
      chmodSync(outPath, 0o755);
    } catch (e) {
      // Non-fatal — if chmod fails (unlikely), the binary still
      // exists and the user can chmod it themselves. Warn but
      // don't exit.
      console.warn(`  (warning: could not set executable bit on ${outPath}: ${e.message})`);
    }
  }

  console.log(`\nBuilt ${outPath}`);
}

// -- main --
if (!existsSync(buildDir)) {
  mkdirSync(buildDir, { recursive: true });
}

const compiler = detectCompiler();
if (!compiler) {
  // No compiler in PATH — print actionable install steps for every
  // common platform. Trying to be terse but complete: the user just
  // wants to know which command to run.
  console.error('No C compiler (gcc or clang) found in PATH.\n');
  console.error('To install a compiler:');
  console.error('');
  console.error('  Windows:');
  console.error('    Recommended: install MSYS2 from https://www.msys2.org/');
  console.error('    After install, open the "MSYS2 MinGW 64-bit" shell and run:');
  console.error('      pacman -S mingw-w64-x86_64-gcc');
  console.error('    Then add  C:\\msys64\\mingw64\\bin  to your Windows PATH and');
  console.error('    open a new terminal so `gcc` resolves.');
  console.error('');
  console.error('    Alternative: install LLVM from https://llvm.org/ (provides clang)');
  console.error('    and make sure the install dir\'s bin/ is on PATH.');
  console.error('');
  console.error('  macOS:');
  console.error('    xcode-select --install        # installs clang');
  console.error('');
  console.error('  Linux:');
  console.error('    sudo apt install build-essential    # Debian/Ubuntu');
  console.error('    sudo dnf install gcc                # Fedora/RHEL');
  console.error('    sudo pacman -S base-devel           # Arch');
  console.error('');
  console.error('After installing, re-run: npm run build:c');
  process.exit(1);
}

build(compiler);
