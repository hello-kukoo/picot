#!/usr/bin/env bash
# ABOUTME: Starts Picot's Bun development app with isolated first-run state.
# ABOUTME: Keeps build toolchains while removing inherited credentials and Picot state.

set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
original_home="${HOME:?HOME must be set before starting this script}"
fresh_home="${FRESH_HOME:-${1:-$(mktemp -d "${TMPDIR:-/tmp}/picot-fresh.XXXXXX")}}"
keep_fresh_home="${KEEP_FRESH_HOME:-0}"

if [[ "$fresh_home" == "$original_home" ]]; then
  printf 'Refusing to use the current HOME as FRESH_HOME: %s\n' "$fresh_home" >&2
  exit 1
fi

mkdir -p "$fresh_home"
printf 'Fresh Picot HOME: %s\n' "$fresh_home"
printf 'Repository: %s\n' "$repo_root"
printf 'Cleanup mode: %s\n' "$([[ "$keep_fresh_home" == 1 ]] && echo keep || echo remove-on-exit)"

cleaned=0
cleanup() {
  [[ "$cleaned" == 1 ]] && return
  cleaned=1
  if [[ "$keep_fresh_home" == 1 ]]; then
    printf 'Keeping fresh HOME: %s\n' "$fresh_home"
  else
    rm -rf -- "$fresh_home"
    printf 'Removed fresh HOME: %s\n' "$fresh_home"
  fi
}
trap cleanup EXIT INT TERM

cd "$repo_root"
env -i \
  HOME="$fresh_home" \
  USER="${USER:-}" \
  PATH="$PATH" \
  TMPDIR="${TMPDIR:-/tmp}" \
  CARGO_HOME="${CARGO_HOME:-$original_home/.cargo}" \
  RUSTUP_HOME="${RUSTUP_HOME:-$original_home/.rustup}" \
  BUN_INSTALL="${BUN_INSTALL:-$original_home/.bun}" \
  bun run dev
