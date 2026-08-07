// @vitest-environment node

// ABOUTME: Tests the embedded-server skill command surface: normalization and
// ABOUTME: the owner-only skill-inventory RPC request parsers.

import { describe, expect, test } from "vitest";
import {
  assertNonEphemeralSkillCommand,
  authorizeSkillInstallInternalRequest,
  normalizeSkillCommands,
  parsePackageSkillInventoryRequest,
  parseSkillInstallLinksInternalRequest,
  parseSkillInstallScanInternalRequest,
  parseSkillInventoryMutation,
  parseSkillInventoryScope,
  preparePromptMessage,
} from "./embedded-server.ts";

describe("normalizeSkillCommands", () => {
  test("returns only invokable skills with canonical scope metadata", () => {
    expect(
      normalizeSkillCommands([
        {
          name: "skill:release-notes",
          description: "  Cut a release  ",
          source: "skill",
          sourceInfo: { scope: "project" },
        },
        {
          name: "skill:research",
          source: "skill",
          sourceInfo: { scope: "user" },
        },
        { name: "compact", source: "extension" },
      ]),
    ).toEqual([
      {
        command: "/skill:release-notes",
        name: "release-notes",
        description: "Cut a release",
        scope: "project",
      },
      {
        command: "/skill:research",
        name: "research",
        description: "",
        scope: "personal",
      },
    ]);
  });
});

describe("preparePromptMessage", () => {
  const skill = {
    name: "skill:review",
    source: "skill" as const,
    sourceInfo: { path: "/skills/review/SKILL.md", baseDir: "/skills/review" },
  };
  const template = {
    name: "brief",
    source: "prompt" as const,
    sourceInfo: { path: "/prompts/brief.md" },
  };

  test("prepares an expanded skill for the idle send path", () => {
    expect(
      preparePromptMessage(
        "/skill:review",
        [skill],
        () => `---
description: review
---
Do review`,
      ),
    ).toEqual({
      kind: "ready",
      text: `<skill name="review" location="/skills/review/SKILL.md">
References are relative to /skills/review.

Do review
</skill>`,
    });
  });

  test("prepares a template for a follow-up send path", () => {
    expect(
      preparePromptMessage(
        "/brief hello",
        [template],
        () => `---
description: brief
---
$1`,
      ),
    ).toEqual({ kind: "ready", text: "hello" });
  });

  test("keeps unknown slash commands ready with their original text", () => {
    expect(preparePromptMessage("/new", [], () => "")).toEqual({ kind: "ready", text: "/new" });
  });

  test("blocks a known source that cannot be expanded", () => {
    expect(
      preparePromptMessage("/skill:review", [skill], () => {
        throw new Error("ENOENT");
      }),
    ).toMatchObject({ kind: "error" });
  });
});

describe("parseSkillInventoryScope", () => {
  test("accepts the two known scopes", () => {
    expect(parseSkillInventoryScope("global")).toBe("global");
    expect(parseSkillInventoryScope("project")).toBe("project");
  });

  test.each([undefined, null, "local", 1, "Global"])("rejects %s", (value) => {
    expect(() => parseSkillInventoryScope(value)).toThrow("Invalid skill inventory scope");
  });
});

describe("parseSkillInventoryMutation", () => {
  test("round-trips a well-formed skill mutation", () => {
    expect(
      parseSkillInventoryMutation({
        scope: "project",
        target: { kind: "skill", id: "/tmp/a/SKILL.md" },
        enabled: false,
      }),
    ).toEqual({
      scope: "project",
      target: { kind: "skill", id: "/tmp/a/SKILL.md" },
      enabled: false,
    });
  });

  test("accepts a group target", () => {
    expect(
      parseSkillInventoryMutation({
        scope: "global",
        target: { kind: "group", id: "root::skills/foo" },
        enabled: true,
      }),
    ).toEqual({
      scope: "global",
      target: { kind: "group", id: "root::skills/foo" },
      enabled: true,
    });
  });

  test.each([
    null,
    { scope: "bad" },
    { scope: "global", target: { kind: "skill" } },
    { scope: "global", target: { kind: "skill", id: "" } },
    { scope: "global", target: { kind: "unknown", id: "x" }, enabled: true },
    { scope: "global", target: { kind: "skill", id: "x" }, enabled: "yes" },
    { scope: "project", target: { kind: "group", id: "g" } },
  ])("rejects malformed payload %j", (payload) => {
    expect(() => parseSkillInventoryMutation(payload)).toThrow(/Invalid skill inventory/);
  });
});

describe("parsePackageSkillInventoryRequest", () => {
  test("accepts the two exact scope strings", () => {
    expect(parsePackageSkillInventoryRequest({ scope: "global" })).toEqual({ scope: "global" });
    expect(parsePackageSkillInventoryRequest({ scope: "project" })).toEqual({ scope: "project" });
  });

  test.each([
    undefined,
    null,
    "global",
    1,
    [],
    { scope: "local" },
    { scope: "GLOBAL" },
    { scope: "global", path: "/etc/passwd" },
    { scope: "global", owner: "x" },
    { scope: "global", cwd: "/" },
    { scope: "global", port: 8080 },
    {},
  ])("rejects %j", (payload) => {
    expect(() => parsePackageSkillInventoryRequest(payload)).toThrow(
      /Invalid package skill inventory/,
    );
  });
});

describe("assertNonEphemeralSkillCommand", () => {
  test("throws when EPHEMERAL_ENV is set, regardless of command name", () => {
    // The helper reads the ephemeral env at call time; set the trusted
    // host-injected markers to simulate an ephemeral runtime and expect rejection.
    const prevKind = process.env.PI_STUDIO_EPHEMERAL_KIND;
    const prevId = process.env.PI_STUDIO_EPHEMERAL_INSTANCE_ID;
    const prevGen = process.env.PI_STUDIO_EPHEMERAL_GENERATION;
    process.env.PI_STUDIO_EPHEMERAL_KIND = "side-chat";
    process.env.PI_STUDIO_EPHEMERAL_INSTANCE_ID = "x";
    process.env.PI_STUDIO_EPHEMERAL_GENERATION = "1";
    try {
      expect(() => assertNonEphemeralSkillCommand("list_package_skill_inventory")).toThrow();
      expect(() => assertNonEphemeralSkillCommand("list_skill_inventory")).toThrow();
      expect(() => assertNonEphemeralSkillCommand("set_skill_enabled")).toThrow();
    } finally {
      for (const [k, v] of [
        ["PI_STUDIO_EPHEMERAL_KIND", prevKind],
        ["PI_STUDIO_EPHEMERAL_INSTANCE_ID", prevId],
        ["PI_STUDIO_EPHEMERAL_GENERATION", prevGen],
      ]) {
        if (v === undefined) delete process.env[k as string];
        else process.env[k as string] = v as string;
      }
    }
  });

  test("does not throw when not in an ephemeral runtime", () => {
    const prevKind = process.env.PI_STUDIO_EPHEMERAL_KIND;
    const prevId = process.env.PI_STUDIO_EPHEMERAL_INSTANCE_ID;
    delete process.env.PI_STUDIO_EPHEMERAL_KIND;
    delete process.env.PI_STUDIO_EPHEMERAL_INSTANCE_ID;
    try {
      expect(() => assertNonEphemeralSkillCommand("list_package_skill_inventory")).not.toThrow();
    } finally {
      if (prevKind !== undefined) process.env.PI_STUDIO_EPHEMERAL_KIND = prevKind;
      if (prevId !== undefined) process.env.PI_STUDIO_EPHEMERAL_INSTANCE_ID = prevId;
    }
  });
});

describe("skill install internal authorization", () => {
  test("accepts exact bearer and closed scan body", () => {
    const previous = process.env.PI_STUDIO_EPHEMERAL_KIND;
    delete process.env.PI_STUDIO_EPHEMERAL_KIND;
    try {
      expect(() =>
        authorizeSkillInstallInternalRequest({ authorization: "Bearer secret" }, "secret"),
      ).not.toThrow();
      expect(
        parseSkillInstallScanInternalRequest({ sourceId: "source", canonicalPath: "/tmp/skills" }),
      ).toEqual({
        sourceId: "source",
        canonicalPath: "/tmp/skills",
        candidateIdKey: "",
      });
    } finally {
      if (previous === undefined) delete process.env.PI_STUDIO_EPHEMERAL_KIND;
      else process.env.PI_STUDIO_EPHEMERAL_KIND = previous;
    }
  });

  test.each([
    [{}, "secret"],
    [{ authorization: "Basic secret" }, "secret"],
    [{ authorization: "Bearer wrong" }, "secret"],
    [{ authorization: "Bearer secret", "x-owner": "owner" }, "secret"],
  ])("rejects invalid authorization %j", (headers, secret) => {
    expect(() => authorizeSkillInstallInternalRequest(headers, secret)).toThrow(/authorization/);
  });

  test.each([
    null,
    { sourceId: "", canonicalPath: "/tmp/skills" },
    { sourceId: "source" },
    { sourceId: "source", canonicalPath: "" },
    { sourceId: "source", canonicalPath: "/tmp/skills", owner: "owner" },
    { sourceId: "source", canonicalPath: "/tmp/skills", candidateIdKey: "secret" },
  ])("rejects browser-shaped or malformed scan body %j", (body) => {
    expect(() => parseSkillInstallScanInternalRequest(body)).toThrow(/scan request/);
  });

  test("rejects even a valid-looking bearer in ephemeral runtime", () => {
    const previous = process.env.PI_STUDIO_EPHEMERAL_KIND;
    process.env.PI_STUDIO_EPHEMERAL_KIND = "side-chat";
    try {
      expect(() =>
        authorizeSkillInstallInternalRequest({ authorization: "Bearer secret" }, "secret"),
      ).toThrow(/temporary chat/);
    } finally {
      if (previous === undefined) delete process.env.PI_STUDIO_EPHEMERAL_KIND;
      else process.env.PI_STUDIO_EPHEMERAL_KIND = previous;
    }
  });
});

describe("parseSkillInstallLinksInternalRequest", () => {
  test("accepts closed host-only install payload", () => {
    expect(
      parseSkillInstallLinksInternalRequest({
        sourceId: "source",
        canonicalPath: "/tmp/skills",
        scope: "global",
        scanRevision: "revision",
        selection: [{ kind: "skill", id: "candidate" }],
      }),
    ).toMatchObject({ scope: "global", scanRevision: "revision" });
  });

  test.each([
    {
      sourceId: "source",
      canonicalPath: "/tmp/skills",
      scope: "global",
      scanRevision: "r",
      selection: [],
    },
    {
      sourceId: "source",
      canonicalPath: "/tmp/skills",
      scope: "user",
      scanRevision: "r",
      selection: [{ kind: "skill", id: "x" }],
    },
    {
      sourceId: "source",
      canonicalPath: "/tmp/skills",
      scope: "global",
      scanRevision: "r",
      selection: [{ kind: "bad", id: "x" }],
    },
    {
      sourceId: "source",
      canonicalPath: "/tmp/skills",
      scope: "global",
      scanRevision: "r",
      selection: [{ kind: "skill", id: "x" }],
      owner: "browser",
    },
  ])("rejects malformed or browser-authority install payload %j", (body) => {
    expect(() => parseSkillInstallLinksInternalRequest(body)).toThrow(/links request/);
  });
});
