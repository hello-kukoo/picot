// ABOUTME: Guards the embedded Pi version lock against silent drift.
// ABOUTME: The npm SDK pin must match the embedded version, and every platform asset must carry a sha256.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const lock = JSON.parse(read("scripts/pi-version.json"));

const PLATFORM_ASSETS = [
  "pi-darwin-arm64.tar.gz",
  "pi-darwin-x64.tar.gz",
  "pi-linux-x64.tar.gz",
  "pi-linux-arm64.tar.gz",
  "pi-windows-x64.zip",
  "pi-windows-arm64.zip",
];

describe("embedded Pi version lock", () => {
  test("npm SDK pin matches the embedded Pi version", () => {
    const manifest = JSON.parse(read("package.json"));
    const sdkPin =
      manifest.devDependencies?.["@earendil-works/pi-coding-agent"] ??
      manifest.dependencies?.["@earendil-works/pi-coding-agent"];

    // Drift does not fail on its own: the real-runtime OAuth seam asserts in
    // extensions/oauth-login-smoke.test.ts skip loudly when the pins differ,
    // which would quietly shrink coverage. Enforce the coupling here instead.
    expect(sdkPin).toBe(lock.version);
  });

  // Structure only: this guards that pins exist and look like digests. The
  // authoritative content check is `fetch:pi`, which aborts on a mismatch.
  test("every platform asset carries a sha256 pin", () => {
    for (const asset of PLATFORM_ASSETS) {
      expect(lock.sha256?.[asset], `missing sha256 pin for ${asset}`).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
