// ABOUTME: Follow-up send intent matrix (C5) — idle degrades to direct,
// ABOUTME: extension commands execute immediately, streaming queues.
import { describe, expect, test } from "vitest";
import { planFollowUpSend, planSteeringSend } from "./composer-follow-up.js";

describe("planFollowUpSend (shortcut + caret share this resolver)", () => {
  test("streaming + queueable text → follow_up", () => {
    expect(planFollowUpSend({ streaming: true, extensionCommand: false })).toBe("follow_up");
  });

  test("idle → degrade to direct send (never block the keypress/click)", () => {
    expect(planFollowUpSend({ streaming: false, extensionCommand: false })).toBe("direct");
  });

  test("extension command during streaming → prompt path (immediate execution)", () => {
    expect(planFollowUpSend({ streaming: true, extensionCommand: true })).toBe("direct");
  });

  test("idle + extension command → direct", () => {
    expect(planFollowUpSend({ streaming: false, extensionCommand: true })).toBe("direct");
  });
});

describe("planSteeringSend (streaming-Enter intent)", () => {
  test("streaming + plain text → steer (mid-run course correction)", () => {
    expect(planSteeringSend({ streaming: true, extensionCommand: false })).toBe("steer");
  });

  test("streaming + extension command → prompt-now (protocol executes immediately)", () => {
    expect(planSteeringSend({ streaming: true, extensionCommand: true })).toBe("prompt-now");
  });

  test("idle → direct (plain prompt path)", () => {
    expect(planSteeringSend({ streaming: false, extensionCommand: false })).toBe("direct");
    expect(planSteeringSend({ streaming: false, extensionCommand: true })).toBe("direct");
  });
});
