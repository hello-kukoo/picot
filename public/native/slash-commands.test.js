import { describe, expect, it } from "vitest";
import { buildCommandCatalog, resolveComposerInput } from "./slash-commands.js";

const catalog = buildCommandCatalog({
  builtIns: [{ name: "settings", description: "Open settings", action: "open_settings" }],
  nativeCommands: [
    {
      name: "review",
      description: "Review",
      source: "extension",
      sourceInfo: { path: "/global/review.ts", source: "local", scope: "user" },
    },
    {
      name: "fix",
      description: "Fix",
      source: "prompt",
      sourceInfo: { path: "/project/prompts/fix.md", source: "local", scope: "project" },
    },
    {
      name: "skill:test",
      description: "Test",
      source: "skill",
      sourceInfo: { path: "/skills/test/SKILL.md", source: "local", scope: "user" },
    },
  ],
});

describe("slash commands", () => {
  it("merges command source, scope, type, and capability state", () => {
    expect(catalog.get("settings")).toMatchObject({ type: "builtin", scope: "picot" });
    expect(catalog.get("review")).toMatchObject({ type: "extension", scope: "user" });
    expect(catalog.get("fix")).toMatchObject({ type: "prompt", scope: "project" });
    expect(catalog.get("skill:test")).toMatchObject({ type: "skill", scope: "user" });
  });

  it("falls back to global scope for commands without sourceInfo", () => {
    const legacy = buildCommandCatalog({
      nativeCommands: [{ name: "old", description: "Old", source: "extension" }],
    });
    expect(legacy.get("old")).toMatchObject({ type: "extension", scope: "global" });
  });

  it("treats // as a literal slash and rejects unknown commands", () => {
    expect(resolveComposerInput("//literal", catalog, { working: false })).toEqual({
      kind: "runtime",
      command: { type: "prompt", message: "/literal" },
    });
    expect(resolveComposerInput("/missing", catalog, { working: false })).toEqual({
      kind: "rejected",
      reason: "Unknown command: /missing",
    });
  });

  it("routes built-ins locally and native commands through prompt exactly once", () => {
    expect(resolveComposerInput("/settings", catalog, { working: false })).toEqual({
      kind: "builtin",
      action: "open_settings",
      arguments: "",
    });
    expect(resolveComposerInput("/review files", catalog, { working: true })).toEqual({
      kind: "runtime",
      command: { type: "prompt", message: "/review files" },
    });
    expect(resolveComposerInput("hello", catalog, { working: true, altKey: false })).toEqual({
      kind: "runtime",
      command: { type: "steer", message: "hello" },
    });
    expect(resolveComposerInput("later", catalog, { working: true, altKey: true })).toEqual({
      kind: "runtime",
      command: { type: "follow_up", message: "later" },
    });
  });
});
