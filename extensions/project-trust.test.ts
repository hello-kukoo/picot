import { describe, expect, it } from "vitest";
import projectTrust from "./project-trust";

function setup(choice: string | undefined, hasUI = true) {
  let handler: ((event: { cwd: string }, context: unknown) => Promise<unknown>) | null = null;
  const pi = {
    on(event: string, callback: typeof handler) {
      if (event === "project_trust") handler = callback;
    },
  };
  projectTrust(pi as never);
  const context = {
    hasUI,
    ui: {
      select: async () => choice,
      notify: () => {},
    },
  };
  return () => handler?.({ cwd: "/workspace" }, context);
}

describe("Picot project trust bridge", () => {
  it.each([
    ["Trust once", { trusted: "yes" }],
    ["Trust and remember", { trusted: "yes", remember: true }],
    ["Open untrusted", { trusted: "no" }],
    ["Cancel workspace opening", { trusted: "no" }],
  ])("maps %s to a Pi-owned trust decision", async (choice, expected) => {
    await expect(setup(choice)()).resolves.toEqual(expected);
  });

  it("returns undecided when no UI is available so saved trust is honored", async () => {
    // Without a UI, defer to pi's saved trust.json / defaultProjectTrust
    // instead of returning a hard "no" that would override an already-trusted
    // project (e.g. one trusted in the web UI but not in the rpc session).
    await expect(setup("Trust once", false)()).resolves.toEqual({ trusted: "undecided" });
  });

  it("returns no when the user explicitly cancels the prompt", async () => {
    await expect(setup(undefined)()).resolves.toEqual({ trusted: "no" });
  });
});
