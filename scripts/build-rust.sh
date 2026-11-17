#!/bin/bash
# Release build of the Rust server (rust/target/release/ckanban-rs), signed on macOS with a fixed local certificate.
#
#   scripts/build-rust.sh [extra cargo args]     e.g. scripts/build-rust.sh --locked
#
# Why the signing: the linker only gives the binary an ad-hoc signature, and macOS privacy settings (Desktop,
# Documents, ...) remember an ad-hoc binary by its exact code hash. Every build then looks like a new app and macOS asks
# again ("ckanban-rs would like to access files in your Desktop folder"). Signed with one fixed certificate and a fixed
# identifier, the binary keeps the same designated requirement across builds, so one "Allow" sticks.
#
# The first run on a Mac creates the certificate "ckanban local signing" (self-signed, code signing only) in the login
# keychain; later runs reuse it. Signing never fails the build: if it can't be done, the ad-hoc build stays and a
# warning says why. Not on macOS: no signing at all.
#
# Settings:
#   CARGO                  the cargo command (default ~/.cargo/bin/cargo, else cargo on PATH)
#   CKANBAN_SIGN_IDENTITY  the certificate name (default "ckanban local signing")
#   CKANBAN_SIGN=0         skip signing
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$REPO/rust/target/release/ckanban-rs"
IDENTITY="${CKANBAN_SIGN_IDENTITY:-ckanban local signing}"
IDENTIFIER="io.ckanban.rs"

if [ -z "${CARGO:-}" ]; then
  if [ -x "$HOME/.cargo/bin/cargo" ]; then CARGO="$HOME/.cargo/bin/cargo"; else CARGO="cargo"; fi
fi

warn() { printf 'build-rust: warning: %s\n' "$*" >&2; }

# Is the identity in a keychain? Without -v: a self-signed certificate counts as untrusted, and -v hides those.
have_identity() {
  /usr/bin/security find-identity -p codesigning 2>/dev/null | grep -Fq "\"$IDENTITY\""
}

# One-time setup: a self-signed code signing certificate and key, imported into the login keychain so codesign may
# use the key without asking.
create_identity() {
  local tmp keychain pass
  tmp="$(mktemp -d)" || return 1
  keychain="$(/usr/bin/security default-keychain -d user 2>/dev/null | tr -d ' "')"
  [ -n "$keychain" ] || keychain="$HOME/Library/Keychains/login.keychain-db"
  pass="ckanban-$$-$RANDOM"
  cat >"$tmp/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $IDENTITY
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
EOF
  # macOS's openssl is LibreSSL; a Homebrew OpenSSL 3 needs -legacy so `security import` can read the p12.
  local legacy=""
  if openssl version 2>/dev/null | grep -q '^OpenSSL 3'; then legacy="-legacy"; fi
  if openssl req -x509 -newkey rsa:2048 -nodes -days 7300 -config "$tmp/cert.cnf" \
      -keyout "$tmp/key.pem" -out "$tmp/cert.pem" >/dev/null 2>&1 &&
    openssl pkcs12 -export $legacy -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -name "$IDENTITY" \
      -out "$tmp/id.p12" -passout "pass:$pass" >/dev/null 2>&1 &&
    /usr/bin/security import "$tmp/id.p12" -k "$keychain" -P "$pass" -T /usr/bin/codesign >/dev/null; then
    rm -rf "$tmp"
    return 0
  fi
  rm -rf "$tmp"
  return 1
}

sign() {
  [ "$(uname -s)" = "Darwin" ] || return 0
  [ "${CKANBAN_SIGN:-1}" = "0" ] && return 0
  if ! have_identity; then
    printf 'build-rust: creating the local signing certificate "%s" (once per Mac)...\n' "$IDENTITY"
    if ! command -v openssl >/dev/null 2>&1 || ! create_identity || ! have_identity; then
      warn "couldn't create the signing certificate \"$IDENTITY\"; $BIN keeps its ad-hoc signature, so macOS may ask for folder access again after each build."
      return 0
    fi
  fi
  if /usr/bin/codesign --force --sign "$IDENTITY" --identifier "$IDENTIFIER" "$BIN"; then
    printf 'build-rust: signed %s as %s with "%s"\n' "$BIN" "$IDENTIFIER" "$IDENTITY"
  else
    warn "codesign failed; $BIN keeps its ad-hoc signature, so macOS may ask for folder access again after each build."
    # A failed --force can leave the file unsigned; put the ad-hoc signature back so it still runs.
    /usr/bin/codesign --force --sign - "$BIN" >/dev/null 2>&1 || true
  fi
  return 0
}

(cd "$REPO/rust" && "$CARGO" build --release "$@") || exit $?
[ -f "$BIN" ] || exit 0  # e.g. `--help` or a build of another package only
sign
