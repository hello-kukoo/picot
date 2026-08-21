// ABOUTME: Tests the header session-info popover open/close, data refresh, and copy actions.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "../i18n.js";
import englishMessages from "../locales/en.json";
import { setupSessionInfo } from "./session-info.js";

describe("session info", () => {
  beforeAll(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => englishMessages }),
    );
    await initI18n();
  });

  beforeEach(() => {
    document.body.innerHTML = `
      <button id="toggle" aria-expanded="false"></button>
      <section id="panel" class="hidden">
        <span class="session-info-value" id="file"></span>
        <button data-copy-session-field="file"></button>
      </section>`;
  });

  it("renders only the file row so the value cannot duplicate itself", () => {
    const toggle = document.getElementById("toggle");
    toggle.getBoundingClientRect = () => ({ bottom: 40, right: 900 });
    setupSessionInfo({
      toggle,
      panel: document.getElementById("panel"),
      fileValue: document.getElementById("file"),
      getFilePath: () => "/sessions/a.jsonl",
    });

    toggle.click();

    const panel = document.getElementById("panel");
    const valueRows = panel.querySelectorAll(".session-info-value");
    const copyButtons = panel.querySelectorAll("[data-copy-session-field]");
    expect(valueRows).toHaveLength(1);
    expect(copyButtons).toHaveLength(1);
    expect(valueRows[0].id).toBe("file");
    expect(copyButtons[0].dataset.copySessionField).toBe("file");
    expect(document.getElementById("file").textContent).toBe("/sessions/a.jsonl");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(panel.parentElement).toBe(document.body);
    expect(panel.style.position).toBe("fixed");
    expect(panel.style.top).toBe("48px");
  });

  it("uses an in-memory label before a session file exists", () => {
    setupSessionInfo({
      toggle: document.getElementById("toggle"),
      panel: document.getElementById("panel"),
      fileValue: document.getElementById("file"),
      getFilePath: () => "",
    });

    document.getElementById("toggle").click();
    expect(document.getElementById("file").textContent).toContain("not saved yet");
  });

  it("refresh() reflects state changes while the panel stays open", () => {
    let filePath = "/sessions/first.jsonl";
    const instance = setupSessionInfo({
      toggle: document.getElementById("toggle"),
      panel: document.getElementById("panel"),
      fileValue: document.getElementById("file"),
      getFilePath: () => filePath,
    });
    document.getElementById("toggle").click();
    expect(document.getElementById("file").textContent).toBe("/sessions/first.jsonl");

    filePath = "/sessions/second.jsonl";
    instance.refresh();
    expect(document.getElementById("file").textContent).toBe("/sessions/second.jsonl");
  });

  it("copies the active session file", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setupSessionInfo({
      toggle: document.getElementById("toggle"),
      panel: document.getElementById("panel"),
      fileValue: document.getElementById("file"),
      getFilePath: () => "/sessions/a.jsonl",
      writeText,
    });

    document.getElementById("toggle").click();
    document.querySelector('[data-copy-session-field="file"]').click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    expect(writeText).toHaveBeenCalledWith("/sessions/a.jsonl");
  });
});
