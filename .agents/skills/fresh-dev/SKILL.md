---
name: fresh-dev
description: Launch Picot with Bun in a unique, clean test home. Use to reproduce first-run or zero-configuration behavior without inherited Pi state, API keys, workspaces, or WebView data.
---

# Fresh Picot dev environment

## Purpose

Run `bun run dev` with a new HOME while retaining only the local build toolchains.
The child process receives no inherited API keys, `PI_*` variables, or existing
Picot state.

## Start

From the repository root, run:

```bash
bash .pi/skills/fresh-dev/fresh-dev.sh
```

The script prints the fresh HOME it created, starts `bun run dev`, and removes
that HOME when Picot exits (normal quit, Ctrl-C, or crash).

Useful variants:

```bash
# Inspect the isolated state after quitting: keep the HOME
KEEP_FRESH_HOME=1 bash .pi/skills/fresh-dev/fresh-dev.sh

# Resume a previously created scratch HOME (its path was printed at start)
bash .pi/skills/fresh-dev/fresh-dev.sh /tmp/picot-fresh.XXXXXX
```

`env -i` inside the script is intentional. Do not add API key or `PI_*`
variables to the environment; `CARGO_HOME`, `RUSTUP_HOME`, and `BUN_INSTALL`
are retained only so the existing Bun/Rust toolchains can build and run the
development app.

## Verify the environment

While Picot is running, its isolated state is under the printed directory:

```text
<FRESH_HOME>/.pi/agent/
<FRESH_HOME>/Library/Application Support/<Picot app identifier>/
```

For a first-run check, confirm that no pre-existing workspaces, credentials, or
models are present before interacting with the app.

## Clean up

Automatic on exit. When `KEEP_FRESH_HOME=1` was used, remove the printed
directory manually when done. Never use `rm -rf ~/.pi` for this test.

## Notes

- This isolates file and environment state. It does not alter machine-wide
  services such as the OS keychain, VPN, proxy, or npm registry configuration.
