// ABOUTME: Locks the Process-details collapsible group: collapsed-by-default
// ABOUTME: structure, toggle expand/collapse, and the localized summary line.

import { beforeEach, describe, expect, it } from "vitest";
import { setMessages } from "../i18n.js";
import { createProcessDetailsGroup, summarizeProcessGroup } from "./process-group.js";

describe("process-group", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    setMessages({
      messages: {
        processDetails: "Process details",
        processStep: "{count} step",
        processSteps: "{count} steps",
        processToolCall: "{count} tool call",
        processToolCalls: "{count} tool calls",
      },
    });
  });

  it("creates a collapsed-by-default group with toggle, body, and setLabel", () => {
    const group = createProcessDetailsGroup();
    document.body.appendChild(group.wrapper);

    const toggle = group.wrapper.querySelector(".process-details-toggle");
    const body = group.wrapper.querySelector(".process-details-body");
    expect(toggle).not.toBeNull();
    expect(body).not.toBeNull();
    expect(group.wrapper.classList.contains("expanded")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    group.setLabel("Process details · 2 steps");
    expect(toggle.textContent).toContain("Process details · 2 steps");
  });

  it("toggles expanded state on click", () => {
    const group = createProcessDetailsGroup();
    document.body.appendChild(group.wrapper);

    const toggle = group.wrapper.querySelector(".process-details-toggle");
    toggle.click();
    expect(group.wrapper.classList.contains("expanded")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    toggle.click();
    expect(group.wrapper.classList.contains("expanded")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("summarizeProcessGroup renders counts with correct pluralization", () => {
    expect(summarizeProcessGroup(1, 1)).toBe("Process details · 1 step · 1 tool call");
    expect(summarizeProcessGroup(2, 3)).toBe("Process details · 2 steps · 3 tool calls");
    expect(summarizeProcessGroup(5, 0)).toBe("Process details · 5 steps");
  });

  it("toggle exposes a chevron glyph for affordance", () => {
    const group = createProcessDetailsGroup();
    document.body.appendChild(group.wrapper);
    const chevron = group.wrapper.querySelector(".process-details-toggle .chevron");
    expect(chevron).not.toBeNull();
    expect(chevron.querySelector("svg")).not.toBeNull();
  });
});
