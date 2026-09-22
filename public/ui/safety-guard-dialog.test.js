// ABOUTME: Verifies the safety-guard rich bash-approval card: marker
// ABOUTME: interception, graceful degradation, section/button rendering, and
// ABOUTME: the extension_ui_response contract.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMessages } from "../i18n.js";
import { SafetyGuardDialog } from "./safety-guard-dialog.js";

setMessages({
  settings: {
    safetyGuardDialog: {
      title: "Safety Guard: bash approval",
      hintOnce: "No approval is saved",
      hintSession: "Allowed for the current session",
      hintPermanent: "Saved permanently for this directory",
      hintEverywhere: "Permanent, EVERYWHERE — skips future prompts",
      hintRuleSession: "Operation types allowed this session",
      hintRulePermanent: "Operation types always allowed here",
    },
  },
});

function markerMessage(overrides = {}) {
  const payload = {
    __safetyGuardBash: 1,
    version: 1,
    sections: [
      { label: "Approval trigger", body: "rm -rf", warning: true },
      { label: "Command", body: "1 | rm -rf ./dist" },
      { label: "Risk excerpts", body: "line before\nline after" },
    ],
    command: "rm -rf ./dist",
    choices: [
      { label: "Block" },
      { label: "Allow once" },
      {
        label: "Allow the command for the current session",
        scope: "operation",
        lifetime: "session",
      },
      {
        label: "Always allow the command EVERYWHERE",
        scope: "operation-global",
        lifetime: "permanent",
      },
    ],
    ...overrides,
  };
  return `Safety Guard: bash approval\n${JSON.stringify(payload)}`;
}

function makeDialog() {
  const container = document.createElement("div");
  container.classList.add("hidden");
  // Attached: jsdom only moves document.activeElement for focus() on
  // connected elements.
  document.body.append(container);
  const sent = [];
  const dialog = new SafetyGuardDialog({
    container,
    send: (message) => sent.push(message),
  });
  return { container, sent, dialog };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("interception", () => {
  it("claims only marker-payload selects", () => {
    const { dialog } = makeDialog();
    expect(dialog.handleExtensionUIRequest({ method: "confirm", message: markerMessage() })).toBe(
      false,
    );
    expect(dialog.handleExtensionUIRequest({ method: "select", message: "plain long text" })).toBe(
      false,
    );
  });

  it("degrades to the generic dialog when the marker JSON is broken", () => {
    const { dialog } = makeDialog();
    const broken = `Safety Guard: bash approval\n{"__safetyGuardBash":1,"sections":[`;
    expect(dialog.handleExtensionUIRequest({ method: "select", message: broken })).toBe(false);
    expect(
      dialog.handleExtensionUIRequest({
        method: "select",
        message: markerMessage({ choices: "not-an-array" }),
      }),
    ).toBe(false);
  });

  it("renders sections and answers with the chosen label", async () => {
    const { container, sent, dialog } = makeDialog();
    const claimed = dialog.handleExtensionUIRequest({
      method: "select",
      id: "req-1",
      message: markerMessage(),
    });
    expect(claimed).toBe(true);
    expect(container.classList.contains("hidden")).toBe(false);
    // Sections render in order; Risk excerpts collapses behind details.
    const labels = [...container.querySelectorAll(".sg-section-label")].map((n) => n.textContent);
    expect(labels).toEqual(["Approval trigger", "Command", "Risk excerpts"]);
    expect(container.querySelector("details.sg-section[open]")).toBeNull();
    expect([...container.querySelectorAll(".sg-pre")][1].textContent).toContain("rm -rf ./dist");
    // Block is first and focused (the TUI default).
    const buttons = [...container.querySelectorAll(".sg-btn")];
    expect(buttons[0].textContent).toContain("Block");
    expect(document.activeElement).toBe(buttons[0]);
    // Every choice carries its scope hint.
    expect(buttons[2].textContent).toContain("session");
    expect(buttons[3].textContent).toContain("EVERYWHERE");
    buttons[2].click();
    expect(sent).toEqual([
      {
        type: "extension_ui_response",
        id: "req-1",
        value: "Allow the command for the current session",
      },
    ]);
    expect(container.classList.contains("hidden")).toBe(true);
  });

  it("Esc inside the card answers cancelled — the extension maps that to Block", () => {
    const { container, sent, dialog } = makeDialog();
    dialog.handleExtensionUIRequest({ method: "select", id: "req-2", message: markerMessage() });
    // Esc is card-scoped: a page-level Esc (composer draft, stop button) must
    // never be hijacked into a silent Block.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(sent).toEqual([]);
    container
      .querySelector(".sg-card")
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(sent).toEqual([{ type: "extension_ui_response", id: "req-2", cancelled: true }]);
    expect(container.classList.contains("hidden")).toBe(true);
  });

  it("a timeout answers cancelled and tears down", () => {
    vi.useFakeTimers();
    try {
      const { sent, dialog } = makeDialog();
      dialog.handleExtensionUIRequest({
        method: "select",
        id: "req-3",
        timeout: 5000,
        message: markerMessage(),
      });
      vi.advanceTimersByTime(5001);
      expect(sent).toEqual([{ type: "extension_ui_response", id: "req-3", cancelled: true }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("lifecycle", () => {
  it("destroy() removes the active listener and timer without answering", () => {
    vi.useFakeTimers();
    try {
      const { container, sent, dialog } = makeDialog();
      dialog.handleExtensionUIRequest({
        method: "select",
        id: "req-9",
        timeout: 5000,
        message: markerMessage(),
      });
      expect(container.classList.contains("hidden")).toBe(false);

      dialog.destroy();

      // Neither the Escape path nor the timeout path may answer afterwards.
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      vi.advanceTimersByTime(6000);
      expect(sent).toEqual([]);
      expect(container.classList.contains("hidden")).toBe(true);
      expect(
        dialog.handleExtensionUIRequest({
          method: "select",
          id: "req-10",
          message: markerMessage(),
        }),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("inline hosting", () => {
  function makeInlineDialog() {
    const built = makeDialog();
    const host = document.createElement("div");
    host.className = "turn-card-slot hidden";
    document.body.append(host);
    built.dialog.resolveHost = () => host;
    return { ...built, host };
  }

  it("renders into the resolved host and leaves the modal container alone", () => {
    const { container, host, sent, dialog } = makeInlineDialog();
    const claimed = dialog.handleExtensionUIRequest({
      method: "select",
      id: "req-inline",
      message: markerMessage(),
    });
    expect(claimed).toBe(true);
    expect(host.querySelector(".sg-card")).not.toBeNull();
    expect(host.classList.contains("hidden")).toBe(false);
    // Inline is not modal: the card is a group, not a dialog.
    expect(host.querySelector(".sg-card").getAttribute("role")).toBe("group");
    expect(container.querySelector(".sg-card")).toBeNull();
    expect(container.classList.contains("hidden")).toBe(true);

    host.querySelector(".sg-btn").click();
    expect(sent).toEqual([{ type: "extension_ui_response", id: "req-inline", value: "Block" }]);
    expect(host.querySelector(".sg-card")).toBeNull();
    expect(host.classList.contains("hidden")).toBe(true);
  });

  it("falls back to the modal container when no host is resolved", () => {
    const { container, dialog } = makeDialog();
    dialog.resolveHost = () => null;
    dialog.handleExtensionUIRequest({ method: "select", id: "req-fb", message: markerMessage() });
    expect(container.querySelector(".sg-card")).not.toBeNull();
    expect(container.querySelector(".sg-card").getAttribute("role")).toBe("dialog");
  });

  it("rehost() moves a pending card to the modal container without answering", () => {
    const { container, host, sent, dialog } = makeInlineDialog();
    dialog.handleExtensionUIRequest({ method: "select", id: "req-move", message: markerMessage() });

    dialog.rehost();

    expect(host.querySelector(".sg-card")).toBeNull();
    expect(host.classList.contains("hidden")).toBe(true);
    expect(container.querySelector(".sg-card")).not.toBeNull();
    expect(container.querySelector(".sg-card").getAttribute("role")).toBe("dialog");
    // Re-homing is not an answer: the runtime keeps waiting.
    expect(sent).toEqual([]);
    expect(dialog.currentId).toBe("req-move");
    // The moved card is still answerable.
    container.querySelector(".sg-btn").click();
    expect(sent).toEqual([{ type: "extension_ui_response", id: "req-move", value: "Block" }]);
  });

  it("rehost() is a no-op when nothing is pending", () => {
    const { container, sent, dialog } = makeInlineDialog();
    dialog.rehost();
    expect(container.classList.contains("hidden")).toBe(true);
    expect(sent).toEqual([]);
  });
});
