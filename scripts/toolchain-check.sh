#!/usr/bin/env bash
#
# Reports the exact toolchain the Solana/Anchor build will use, and whether it can possibly
# compile the current dependency graph.
#
# Written because this error is easy to misdiagnose:
#
#   Caused by:
#     feature `edition2024` is required
#     ... not stabilized in this version of Cargo (1.79.0 (8d3d6ef09 2024-08-15))
#     See https://doc.rust-lang.org/nightly/cargo/reference/unstable.html#edition-2024
#
# `anchor build` does NOT use your rustup toolchain: it shells out to `cargo build-sbf`, which
# uses the Rust compiler bundled in Solana *platform-tools*. Upgrading rustup therefore does not
# fix an SBF build, and vice versa. This script reports both, plus which crates in the resolved
# graph actually demand edition 2024.
#
# Usage:  ./scripts/toolchain-check.sh
#
set -u

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m%s\033[0m\n' "$1"; }
warn() { printf '  \033[33m%s\033[0m\n' "$1"; }
bad()  { printf '  \033[31m%s\033[0m\n' "$1"; }

# edition 2024 was stabilized in Rust 1.85 (see the Rust 1.85.0 release notes).
EDITION_2024_MIN_RUST=1.85

# platform-tools release -> bundled Rust. Taken from the release notes of
# https://github.com/anza-xyz/platform-tools (each tag pins a `solana-tools-v*` tag in
# anza-xyz/rust). Extend this table as new releases appear.
platform_tools_rust_version() {
  case "$1" in
    v1.3*|v1.4[0-6]) echo "1.79.0" ;;
    v1.4[7-9]|v1.5[01]|v1.51.1) echo "1.84.1" ;;
    v1.5[2-9]|v1.[6-9]*|v[2-9]*) echo "1.89.0" ;;   # v1.52+ bundles Rust 1.89
    *) echo "unknown" ;;
  esac
}

version_ge() { # version_ge A B  -> true if A >= B
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

echo
bold "1. Host toolchain (used by: cargo test, cargo metadata, anchor cli itself)"
if command -v rustc >/dev/null 2>&1; then
  echo "  rustc : $(rustc --version)"
  echo "  cargo : $(cargo --version)"
  HOST_RUST=$(rustc --version | awk '{print $2}')
  if version_ge "$HOST_RUST" "$EDITION_2024_MIN_RUST"; then
    ok "host Rust ${HOST_RUST} >= ${EDITION_2024_MIN_RUST}: can build edition-2024 crates"
  else
    bad "host Rust ${HOST_RUST} < ${EDITION_2024_MIN_RUST}: cannot build edition-2024 crates"
    echo "        fix: rustup toolchain install stable && rustup default stable"
  fi
else
  warn "rustc not found - install Rust: https://rustup.rs"
fi

echo
bold "2. SBF toolchain (used by: anchor build / cargo build-sbf)"
SBF_BIN=$(command -v cargo-build-sbf 2>/dev/null || true)
if [ -n "$SBF_BIN" ]; then
  SBF_VERSION_LINE=$("$SBF_BIN" --version 2>/dev/null || true)
  echo "  ${SBF_VERSION_LINE:-<no --version output>}"
  PT=$(printf '%s' "$SBF_VERSION_LINE" | grep -o 'platform-tools[[:space:]]*v\?[0-9.]*' | sed 's/.*[[:space:]]//; s/^v//')
  if [ -n "$PT" ]; then
    PT_RUST=$(platform_tools_rust_version "v${PT}")
    echo "  platform-tools v${PT} bundles Rust ${PT_RUST}"
    if [ "$PT_RUST" = "unknown" ]; then
      warn "not in the lookup table - check https://github.com/anza-xyz/platform-tools/releases"
    elif version_ge "$PT_RUST" "$EDITION_2024_MIN_RUST"; then
      ok "SBF Rust ${PT_RUST} >= ${EDITION_2024_MIN_RUST}: edition 2024 is supported"
    else
      bad "SBF Rust ${PT_RUST} < ${EDITION_2024_MIN_RUST}: edition 2024 is NOT supported"
      echo "        fix: upgrade the Solana CLI so platform-tools is >= v1.52,"
      echo "             e.g. sh -c \"\$(curl -sSfL https://release.anza.xyz/stable/install)\""
    fi
  else
    warn "could not parse the platform-tools version from 'cargo-build-sbf --version'"
  fi
  echo "  solana: $(solana --version 2>/dev/null || echo 'not found')"
  echo "  anchor: $(anchor --version 2>/dev/null || echo 'not found')"
else
  warn "cargo-build-sbf not found (Solana CLI missing, or not on PATH)"
fi

echo
bold "3. Crates in the resolved graph that require edition 2024"
if ! command -v cargo >/dev/null 2>&1; then
  warn "cargo not found - skipping"
elif ! command -v python3 >/dev/null 2>&1; then
  warn "python3 not found - run: cargo metadata --format-version 1 | jq -r '.packages[] | select(.edition==\"2024\") | \"\\(.name) \\(.version)\"'"
else
  # `cargo metadata` resolves the whole graph and writes Cargo.lock if it is missing - which is
  # part of the fix (a committed lock stops a fresh resolve from picking newer crates).
  if cargo metadata --format-version 1 >/tmp/toolchain-check-metadata.json 2>/tmp/toolchain-check-metadata.err; then
    python3 - <<'PY'
import json
pkgs = json.load(open('/tmp/toolchain-check-metadata.json'))['packages']
offenders = sorted((p['name'], p['version']) for p in pkgs if p.get('edition') == '2024')
if not offenders:
    print("  none - the resolved graph is compatible with pre-1.85 toolchains")
else:
    print(f"  {len(offenders)} crate(s) require edition 2024:")
    for name, version in offenders:
        print(f"    - {name} {version}")
    print("\n  Pin them back with, for example:")
    for name, version in offenders[:3]:
        print(f"    cargo update -p {name} --precise <older-version>")
PY
  else
    warn "cargo metadata failed:"
    sed 's/^/        /' /tmp/toolchain-check-metadata.err | head -5
  fi
fi

echo
bold "4. Lockfile"
if [ -f Cargo.lock ]; then
  ok "Cargo.lock present - builds are reproducible (keep it committed)"
  echo "        verify it is tracked: git ls-files --error-unmatch Cargo.lock >/dev/null 2>&1 && echo '        tracked: yes' || echo '        tracked: NO -> git add Cargo.lock'"
else
  warn "no Cargo.lock: every build re-resolves dependencies and can pick up new"
  echo "        edition-2024 crates. Generate one and commit it:"
  echo "        cargo generate-lockfile && git add Cargo.lock"
fi

echo
bold "Summary"
echo "  * anchor build  -> uses platform-tools Rust (needs >= ${EDITION_2024_MIN_RUST} => platform-tools >= v1.52)"
echo "  * cargo test    -> uses your rustup toolchain (needs >= ${EDITION_2024_MIN_RUST})"
echo "  * no Cargo.lock -> fresh resolution picks the newest crates, which is how"
echo "                     edition-2024 dependencies appear in the first place"
echo
