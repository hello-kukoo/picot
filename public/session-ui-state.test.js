// ABOUTME: Tests host-backed per-session profiles and temporary composer drafts.
// ABOUTME: Profiles never use browser storage; drafts stay in the current page instance.
import { describe, expect, test, vi } from "vitest";
import { SessionUiStateStore } from "./session-ui-state.js";

describe("SessionUiStateStore profiles", () => {
  test("stores model and thinking profile independently per session through the host client", async () => {
    const profile = { provider: "openai", modelId: "gpt-5", thinkingLevel: "off" };
    const profileClient = {
      load: vi.fn(async () => profile),
      save: vi.fn(async (savedProfile) => savedProfile),
    };
    const store = new SessionUiStateStore({ profileClient });

    await store.saveProfile({
      provider: "anthropic",
      modelId: "claude-sonnet",
      thinkingLevel: "high",
    });
    await store.saveProfile(profile);

    expect(await store.loadProfile()).toEqual({
      provider: "openai",
      modelId: "gpt-5",
      thinkingLevel: "off",
    });
    expect(profileClient.save).toHaveBeenCalledTimes(2);
  });

  test("does not use browser storage for profiles", async () => {
    const profileClient = {
      load: vi.fn(async () => null),
      save: vi.fn(async () => null),
    };
    const store = new SessionUiStateStore({ profileClient });
    await store.loadProfile();
    await store.saveProfile({
      provider: "p",
      modelId: "m",
      thinkingLevel: "off",
    });
    expect(profileClient.load).toHaveBeenCalledWith();
    expect(profileClient.save).toHaveBeenCalledWith({
      provider: "p",
      modelId: "m",
      thinkingLevel: "off",
    });
  });
});

describe("SessionUiStateStore drafts", () => {
  test("does not expose session-scoped draft persistence", () => {
    const store = new SessionUiStateStore();

    expect(store.loadDraft).toBeUndefined();
    expect(store.saveDraft).toBeUndefined();
    expect(store.clearDraft).toBeUndefined();
  });
});
