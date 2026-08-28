// ABOUTME: Verifies Pi-formula session-directory resolution: deterministic
// encoding match, resolved-spelling variants, header-sampling fallback for
// pre-formula directories, and cache invalidation on directory-set changes.

import { describe, expect, test } from "vitest";
import {
  createWorkspaceDirNameResolver,
  decodeLossyDirName,
  encodeSessionDirName,
  pickMajorityValue,
} from "./workspace-dirnames.ts";

// Ground truth from pi coding-agent session-manager.ts:
// `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
test("encodes exactly like Pi's getDefaultSessionDirPath", () => {
  expect(encodeSessionDirName("/Users/lin/work/pi-code")).toBe("--Users-lin-work-pi-code--");
  // `:` and backslashes both collapse to `-`, so Windows roots double-dash.
  expect(encodeSessionDirName("C:\\Users\\lin\\app")).toBe("--C--Users-lin-app--");
  expect(encodeSessionDirName("/tmp/scratch:1")).toBe("--tmp-scratch-1--");
});

test("lossy decode stays display-only (information is not recoverable)", () => {
  expect(decodeLossyDirName("--users-lin-src--")).toBe("/users/lin/src");
  expect(decodeLossyDirName("plain")).toBe("plain");
});

test("majority picker prefers frequency then first-seen", () => {
  expect(pickMajorityValue(["/a", "/b", "/a"])).toBe("/a");
  expect(pickMajorityValue(["", "/a"])).toBe("/a");
  expect(pickMajorityValue([])).toBeNull();
});

function makeResolver(options: { names: string[]; samples?: Record<string, string | null> }) {
  const sampleCalls: string[] = [];
  const resolver = createWorkspaceDirNameResolver({
    sessionsDirKey: "/sessions-test",
    listDirNames: () => [...options.names],
    sampleProjectPath: async (dirName) => {
      sampleCalls.push(dirName);
      return options.samples?.[dirName] ?? null;
    },
  });
  return { resolver, sampleCalls };
}

describe("dirNamesForPath", () => {
  test("deterministic encoding match survives dashes in the original path", async () => {
    // The dash inside `pi-code` MUST NOT be interpreted as a separator.
    const { resolver } = makeResolver({
      names: [encodeSessionDirName("/Users/lin/work/pi-code")],
    });
    expect(await resolver.dirNamesForPath("/Users/lin/work/pi-code")).toEqual([
      encodeSessionDirName("/Users/lin/work/pi-code"),
    ]);
  });

  test("resolved-spelling variants match when canonicalization collapsed symlinks", async () => {
    // canonical /private/tmp/scratch; Pi encoded the resolve() form /tmp/scratch.
    const encoded = encodeSessionDirName("/tmp/scratch");
    const alternateSpellings = (canonicalPath: string) =>
      canonicalPath === "/private/tmp/scratch" ? ["/tmp/scratch"] : [];
    const resolver = createWorkspaceDirNameResolver({
      sessionsDirKey: "/sessions-test",
      listDirNames: () => [encoded],
      sampleProjectPath: async () => null,
      alternateSpellings,
    });
    expect(await resolver.dirNamesForPath("/private/tmp/scratch")).toEqual([encoded]);
  });

  test("header-cwd sampling claims pre-formula directories as fallback", async () => {
    const legacyDir = "--old-style--";
    const { resolver } = makeResolver({
      names: [legacyDir],
      samples: { [legacyDir]: "/work/legacy" },
    });
    expect(await resolver.dirNamesForPath("/work/legacy")).toEqual([legacyDir]);
  });

  test("unknown paths yield an empty bucket without errors", async () => {
    const { resolver } = makeResolver({
      names: ["--elsewhere--"],
      samples: { "--elsewhere--": "/elsewhere" },
    });
    expect(await resolver.dirNamesForPath("/ghost")).toEqual([]);
  });

  test("cache skips re-sampling until the directory set changes", async () => {
    let names = ["--a--"];
    const samples: Record<string, string | null> = { "--a--": "/live" };
    const sampleCalls: string[] = [];
    const resolver = createWorkspaceDirNameResolver({
      sessionsDirKey: "/cache-case",
      listDirNames: () => [...names],
      sampleProjectPath: async (dirName) => {
        sampleCalls.push(dirName);
        return samples[dirName] ?? null;
      },
    });

    await resolver.dirNamesForPath("/live");
    const afterFirst = sampleCalls.length;
    await resolver.dirNamesForPath("/live");
    expect(sampleCalls.length).toBe(afterFirst);

    names = ["--a--", "--b--"];
    samples["--b--"] = "/live";
    await resolver.dirNamesForPath("/live");
    expect(sampleCalls).toContain("--b--");
    // Both directories land in the same sampled bucket; sorted output.
    expect(await resolver.dirNamesForPath("/live")).toEqual(["--a--", "--b--"]);
  });
});

describe("lazy sampling semantics", () => {
  test("encode hit answers immediately; background backfill merges old buckets later", async () => {
    const encoded = encodeSessionDirName("/work/now");
    const legacy = "--legacy-bucket--";
    let release: ((value: string | null) => void) | null = null;
    const gated = new Promise<string | null>((resolve) => {
      release = resolve;
    });
    const sampled: string[] = [];
    const resolver = createWorkspaceDirNameResolver({
      sessionsDirKey: "/lazy-case",
      listDirNames: () => [encoded, legacy],
      sampleProjectPath: async (dirName) => {
        sampled.push(dirName);
        if (dirName === legacy) return gated;
        return "/work/now";
      },
    });

    // First call: encode hits, returns without waiting on the gated sample.
    const first = await resolver.dirNamesForPath("/work/now");
    expect(first).toEqual([encoded]);
    expect(sampled).toContain(encoded);

    // Release the background backfill and give the microtask queue a beat.
    release?.("/work/now");
    await gated;
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Second call merges the background-discovered legacy bucket.
    expect(await resolver.dirNamesForPath("/work/now")).toEqual(
      [encoded, legacy].sort((a, b) => a.localeCompare(b)),
    );
  });

  test("encode miss waits for the sample map synchronously", async () => {
    const legacy = "--old--";
    const { resolver } = makeResolver({ names: [legacy], samples: { [legacy]: "/old/path" } });
    expect(await resolver.dirNamesForPath("/old/path")).toEqual([legacy]);
  });
});
